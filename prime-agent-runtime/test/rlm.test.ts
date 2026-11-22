import { afterEach, describe, expect, test } from "bun:test";
import { registerReplBridge, setHostRequestOverride } from "../src/bridge.ts";
import { rlm } from "../src/rlm.ts";

afterEach(() => {
	setHostRequestOverride(null);
	registerReplBridge(null);
});

describe("rlm namespace", () => {
	test("rlm is non-callable and rlm.run throws rename guidance", () => {
		expect(typeof rlm).toBe("object");
		expect(() => (rlm as unknown as { run: unknown }).run).toThrow("rlm.run was renamed");
	});

	test("spawn, createSession, findModels, listSubagents, deleteSubagent, rename, collect, progressNote, endTurn", async () => {
		const calls: Array<{ type: string; payload?: Record<string, unknown> }> = [];
		setHostRequestOverride(async (type, payload) => {
			calls.push({ type, payload });
			switch (type) {
				case "rlm.run":
					return { rlm_child_id: "ch-1", name: "worker", session_dir: "/tmp/s1", model: "anthropic/claude" };
				case "rlm.create_session":
					return {
						active_session_id: "act-1",
						session_id: "sess-1",
						name: "main",
						session_file: "/tmp/main.jsonl",
						model: "anthropic/claude",
					};
				case "rlm.find_models":
					return { models: [{ provider: "anthropic", id: "claude", name: "Claude", selector: "anthropic/claude" }] };
				case "rlm.list_subagents":
					return {
						subagents: [
							{
								rlm_child_id: "ch-1",
								active_session_id: "act-1",
								session_id: "sess-1",
								session_name: "worker",
								session_dir: "/tmp/s1",
								status: "running",
								activity: { kind: "executing", tool_name: "javascript" },
								tool_use_count: 3,
							},
						],
					};
				case "rlm.collect":
					return {
						results: [
							{
								rlm_child_id: "ch-1",
								session_name: "worker",
								session_dir: "/tmp/s1",
								status: "done",
								settled: true,
								answer_preview: "short",
								answer_text: "full answer",
								duration_ms: 42,
							},
						],
					};
				case "rlm.rename":
					return { name: payload?.name };
				case "rlm.delete_subagent":
					return {
						subagent: {
							rlm_child_id: "ch-1",
							active_session_id: null,
							session_id: "sess-1",
							session_name: "worker",
							session_dir: "/tmp/s1",
							status: "cancelled",
						},
					};
				case "rlm.progress.note":
					return { accepted: true, retry_after_ms: null };
				case "rlm.end_turn":
					return { endedTurn: true };
				default:
					throw new Error(`unexpected ${type}`);
			}
		});

		const handle = await (rlm.spawn as typeof import("../src/rlm.ts").spawn)("do task", { name: "worker", thinking: "low" });
		expect(handle).toEqual({ rlmChildId: "ch-1", name: "worker", sessionDir: "/tmp/s1", model: "anthropic/claude" });

		const created = await (rlm.createSession as typeof import("../src/rlm.ts").createSession)("hello", { name: "main" });
		expect(created.sessionId).toBe("sess-1");

		const models = await (rlm.findModels as typeof import("../src/rlm.ts").findModels)("claude", 5);
		expect(models[0]?.selector).toBe("anthropic/claude");

		const subs = await (rlm.listSubagents as typeof import("../src/rlm.ts").listSubagents)();
		expect(subs[0]?.activity).toEqual({ kind: "executing", toolName: "javascript" });

		const collected = await (rlm.collect as typeof import("../src/rlm.ts").collect)(handle, { timeoutMs: 500 });
		expect(collected[0]?.answerText).toBe("full answer");

		const renamed = await (rlm.rename as typeof import("../src/rlm.ts").rename)("worker-2", { sessionId: handle });
		expect(renamed).toBe("worker-2");

		const deleted = await (rlm.deleteSubagent as typeof import("../src/rlm.ts").deleteSubagent)(handle);
		expect(deleted.status).toBe("cancelled");

		// Progress note enforces 512 UTF-16 code units
		const note = await (rlm.progressNote as typeof import("../src/rlm.ts").progressNote)("halfway done");
		expect(note.accepted).toBe(true);
		await expect((rlm.progressNote as typeof import("../src/rlm.ts").progressNote)("😀".repeat(257))).rejects.toThrow(
			"at most 512 characters",
		);

		const ended = await (rlm.endTurn as typeof import("../src/rlm.ts").endTurn)();
		expect(ended).toEqual({ endedTurn: true });
	});

	test("rlm.session.messages emits transcript-read display event and rlm.session.count returns total", async () => {
		const emitted: Array<Record<string, unknown>> = [];
		registerReplBridge({
			isActive: () => true,
			send: (evt) => emitted.push(evt),
			hostRequestRaw: async () => ({ status: "ok", result: {} }),
			currentCellId: () => "cell-1",
			currentCellExecution: () => null,
			activeCellId: () => "cell-1",
			writeStderr: () => undefined,
		});
		setHostRequestOverride(async (type) => {
			if (type === "rlm.session.messages") {
				return {
					total: 2,
					messages: [
						{ index: 0, id: "m1", message: { role: "user", content: "hi", timestamp: 1000 } },
						{
							index: 1,
							id: "m2",
							message: { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 2000 },
						},
					],
				};
			}
			throw new Error(`unexpected ${type}`);
		});

		const session = rlm.session as {
			messages: (start?: number, limit?: number) => Promise<Array<{ text: string; role: string }>>;
			count: () => Promise<number>;
		};
		const msgs = await session.messages(-2, 2);
		expect(msgs.length).toBe(2);
		expect(msgs[1]!.text).toBe("hello");
		expect(emitted.length).toBe(1);
		expect(emitted[0]!.event).toBe("display");
		const displayData = emitted[0]!.data as Record<string, unknown>;
		expect(displayData["application/vnd.prime-agent.transcript-read+json"]).toEqual({
			returned: 2,
			first: 0,
			total: 2,
			roles: ["*"],
		});

		expect(await session.count()).toBe(2);
	});
});
