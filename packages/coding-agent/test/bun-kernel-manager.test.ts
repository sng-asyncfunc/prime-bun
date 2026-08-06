import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveBunRuntime } from "../src/core/kernel/bun-runtime.js";
import {
	AGENT_MESSAGE_DISPLAY_MIME,
	ATTACHMENT_DISPLAY_MIME,
	DIFF_DISPLAY_MIME,
	KernelManager,
} from "../src/core/kernel/index.js";

describe("Bun KernelManager", () => {
	let bunPath: string;
	let directory: string;
	const managers: KernelManager[] = [];

	beforeEach(async () => {
		bunPath = (await resolveBunRuntime()).path;
		directory = await mkdtemp(join(tmpdir(), "prime-bun-manager-"));
	});

	afterEach(async () => {
		await Promise.all(managers.map((manager) => manager.dispose()));
		await rm(directory, { force: true, recursive: true });
	});

	function createManager(options: ConstructorParameters<typeof KernelManager>[0] = {}): KernelManager {
		const manager = new KernelManager({ bun: bunPath, cwd: directory, ...options });
		managers.push(manager);
		return manager;
	}

	it("executes JavaScript sequentially and lists persistent names", async () => {
		const manager = createManager();
		const first = await manager.execute("const counter = { value: 1 }; counter.value;");
		const second = await manager.execute("counter.value += 2; counter.value;");

		expect(first).toMatchObject({ status: "ok", result: "1" });
		expect(second).toMatchObject({ status: "ok", result: "3" });
		expect(await manager.listNamespaceNames()).toEqual(["counter"]);
		expect(manager.isRunning).toBe(true);
	});

	it("streams bounded stdout and stderr", async () => {
		const manager = createManager();
		const streamed: Array<{ chunk: string; name: "stdout" | "stderr" }> = [];
		const result = await manager.execute(
			`process.stdout.write("123456"); process.stderr.write("abcdef"); "result-value";`,
			{
				maxOutputChars: 4,
				onStream: (chunk, name) => streamed.push({ chunk, name }),
			},
		);

		expect(streamed).toEqual(
			expect.arrayContaining([
				{ chunk: "123456", name: "stdout" },
				{ chunk: "abcdef", name: "stderr" },
			]),
		);
		expect(result.stdout).toContain("1234\n[... output truncated at 4 chars ...]");
		expect(result.stderr).toContain("abcd\n[... output truncated at 4 chars ...]");
		expect(result.result).toBe('"res\n[... output truncated at 4 chars ...]');
	});

	it("does not attribute delayed output from a completed cell to the next cell", async () => {
		const manager = createManager();
		const first = await manager.execute(`setTimeout(() => console.log("late-first"), 100); "scheduled";`);
		const streamed: Array<{ chunk: string; name: "stdout" | "stderr" }> = [];
		const second = await manager.execute(`await Bun.sleep(250); console.log("second-cell"); "done";`, {
			onStream: (chunk, name) => streamed.push({ chunk, name }),
		});

		expect(first).toMatchObject({ status: "ok", result: '"scheduled"' });
		expect(second.stdout).toContain("second-cell");
		expect(second.stdout).not.toContain("late-first");
		expect(streamed.map(({ chunk }) => chunk).join("")).not.toContain("late-first");
	});

	it("round-trips host requests with cell-source attribution", async () => {
		const handler = vi.fn(async (payload: Record<string, unknown>) => ({ answer: payload.value }));
		const manager = createManager({ hostHandlers: { "test.echo": handler } });
		const source = `const response = await __primeHostRequest("test.echo", { value: 42 }); response.answer;`;

		const result = await manager.execute(source);

		expect(result).toMatchObject({ status: "ok", result: "42" });
		expect(handler).toHaveBeenCalledWith({
			cellSourceCode: source,
			type: "test.echo",
			value: 42,
		});
	});

	it("collects structured diffs, attachments, and agent messages", async () => {
		const manager = createManager();
		const result = await manager.execute(`
__primeDisplay(${JSON.stringify(DIFF_DISPLAY_MIME)}, {
  path: "/tmp/file.ts", old_str: "old", new_str: "new", start_line: 7
});
__primeDisplay(${JSON.stringify(ATTACHMENT_DISPLAY_MIME)}, {
  mime_type: "image/png", data: "cG5n", path: "/tmp/image.png"
});
__primeDisplay(${JSON.stringify(AGENT_MESSAGE_DISPLAY_MIME)}, {
  id: "message-1",
  message: "sent",
  deliveryStatus: "delivered",
  receiverRole: "child",
  target: { activeSessionId: "active-1", sessionId: "session-1", sessionName: "child" }
});
`);

		expect(result.diffs).toEqual([{ path: "/tmp/file.ts", oldStr: "old", newStr: "new", startLine: 7 }]);
		expect(result.attachments).toEqual([{ mimeType: "image/png", data: "cG5n", path: "/tmp/image.png" }]);
		expect(result.sentAgentMessages).toEqual([
			{
				id: "message-1",
				message: "sent",
				deliveryStatus: "delivered",
				receiverRole: "child",
				target: { activeSessionId: "active-1", sessionId: "session-1", sessionName: "child" },
			},
		]);
	});

	it("remains usable after a JavaScript error", async () => {
		const manager = createManager();
		const failed = await manager.execute('throw new RangeError("bad range");');
		const recovered = await manager.execute("6 * 7;");

		expect(failed).toMatchObject({
			error: { ename: "RangeError", evalue: "bad range" },
			status: "error",
		});
		expect(recovered).toMatchObject({ status: "ok", result: "42" });
	});

	it("keeps skill path resolution aligned with the worker's current directory", async () => {
		const firstDirectory = join(directory, "first");
		const secondDirectory = join(directory, "second");
		await mkdir(firstDirectory);
		await mkdir(secondDirectory);
		await writeFile(join(firstDirectory, "same.txt"), "old");
		await writeFile(join(secondDirectory, "same.txt"), "old");
		const editSkillRoot = join(process.cwd(), "skills", "edit");
		const manager = createManager({
			javascriptSkills: [
				{
					entryPath: join(editSkillRoot, "src", "index.ts"),
					globalName: "edit",
					name: "edit",
					packageJsonPath: join(editSkillRoot, "package.json"),
					packagePath: editSkillRoot,
				},
			],
		});

		const first = await manager.execute(
			`process.chdir("first"); await edit({ path: "same.txt", oldStr: "old", newStr: "new" });`,
		);
		const second = await manager.execute(
			`process.chdir("../second"); await edit({ path: "same.txt", oldStr: "old", newStr: "new" });`,
		);

		expect(first.diffs?.[0]?.path).toBe(realpathSync(join(firstDirectory, "same.txt")));
		expect(second.diffs?.[0]?.path).toBe(realpathSync(join(secondDirectory, "same.txt")));
		expect(first.diffs?.[0]?.path).not.toBe(second.diffs?.[0]?.path);
	});
});
