import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarnessHostHandlers } from "../src/core/kernel/bun-harness-host.js";
import { type BunHostRequest, createBunRlmRuntime } from "../src/core/kernel/bun-rlm-runtime.js";

const tempDirectories: string[] = [];

function makeTempDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "prime-agent-bun-rlm-"));
	tempDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Bun RLM runtime", () => {
	it("is callable and converts spawn handles to JavaScript names", async () => {
		const request = vi.fn<BunHostRequest>(async () => ({
			model: "openai/gpt-5",
			name: "researcher",
			rlm_child_id: "child-1",
			session_dir: "/tmp/child-1",
		}));
		const rlm = createBunRlmRuntime(request);

		const handle = await rlm("study the parser", { model: "openai/gpt-5" });

		expect(handle).toEqual({
			model: "openai/gpt-5",
			name: "researcher",
			rlmChildId: "child-1",
			sessionDir: "/tmp/child-1",
		});
		expect(request).toHaveBeenCalledWith("rlm.run", {
			kwargs: { model: "openai/gpt-5" },
			prompt: "study the parser",
		});
	});

	it("exposes model and direct-child registry operations with strict validation", async () => {
		const request: BunHostRequest = async (type) => {
			if (type === "rlm.find_models") {
				return { models: [{ provider: "openai", id: "gpt-5", name: "GPT-5", selector: "openai/gpt-5" }] };
			}
			if (type === "rlm.list_subagents") {
				return {
					subagents: [
						{
							active_session_id: "active-1",
							rlm_child_id: "child-1",
							session_dir: "/tmp/child-1",
							session_id: "session-1",
							session_name: "researcher",
							status: "running",
						},
					],
				};
			}
			return {
				subagent: {
					active_session_id: null,
					rlm_child_id: "child-1",
					session_dir: "/tmp/child-1",
					session_id: "session-1",
					session_name: "researcher",
					status: "completed",
				},
			};
		};
		const rlm = createBunRlmRuntime(request);

		expect(await rlm.findModels("gpt", 2)).toEqual([
			{ provider: "openai", id: "gpt-5", name: "GPT-5", selector: "openai/gpt-5" },
		]);
		const children = await rlm.listSubagents();
		expect(children[0]).toMatchObject({
			activeSessionId: "active-1",
			rlmChildId: "child-1",
			sessionDir: "/tmp/child-1",
			sessionName: "researcher",
		});
		expect(await rlm.deleteSubagent(children[0]!)).toMatchObject({ status: "completed" });
		await expect(rlm("not valid", null as never)).rejects.toThrow(/options must be an object/);
		await expect(rlm.findModels("gpt", 0)).rejects.toThrow(/limit must be an integer from 1 to 20/);
	});

	it("preserves host errors", async () => {
		const rlm = createBunRlmRuntime(async () => {
			throw new Error("recursion depth exceeded");
		});

		await expect(rlm("go deeper")).rejects.toThrow("recursion depth exceeded");
	});
});

describe("Bun harness host", () => {
	it("persists local and global CRUD in the existing JSON schema", async () => {
		const root = makeTempDirectory();
		const localDirectory = join(root, "local");
		const globalDirectory = join(root, "global");
		const handlers = createHarnessHostHandlers({ globalDirectory, localDirectory });

		const local = await handlers["harness.create"]!({
			arguments: {},
			content: "session only",
			kind: "memory",
			metadata: {},
			path: "general",
			reference: {},
			title: "Local note",
		});
		const global = await handlers["harness.create"]!({
			arguments: {},
			content: "all sessions",
			global: true,
			id: "shared",
			kind: "memory",
			metadata: {},
			path: "general",
			reference: {},
			title: "Global note",
		});
		const updated = await handlers["harness.update"]!({
			content: "updated",
			id: "global:shared",
			kind: "memory",
			title: "Global note",
		});

		expect(local.entry).toMatchObject({ id: "local_note", scope: "local" });
		expect(global.entry).toMatchObject({ id: "shared", scope: "global" });
		expect(updated.entry).toMatchObject({ content: "updated", scope: "global", version: 2 });
		expect(JSON.parse(readFileSync(join(globalDirectory, "harness_state.json"), "utf8"))).toMatchObject({
			schema: 1,
			entries: { memory: { shared: { content: "updated" } } },
		});
	});

	it("validates JavaScript skill references", async () => {
		const directory = makeTempDirectory();
		const handlers = createHarnessHostHandlers({
			globalDirectory: join(directory, "global"),
			localDirectory: join(directory, "local"),
		});

		await expect(
			handlers["harness.create"]!({
				arguments: {},
				content: "call it",
				kind: "skill",
				metadata: {},
				path: "general",
				reference: { type: "python", import: "legacy", callable: "legacy" },
				title: "Legacy",
			}),
		).rejects.toThrow(/reference.type must be "javascript"/);

		await expect(
			handlers["harness.create"]!({
				arguments: { query: { type: "string" } },
				content: "call it",
				kind: "skill",
				metadata: {},
				path: "general",
				reference: { type: "javascript", global: "search", callPattern: "await search(query)" },
				title: "Search",
			}),
		).resolves.toMatchObject({ entry: { kind: "skill", reference: { type: "javascript" } } });
	});
});
