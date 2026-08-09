import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

	it("reports complete timings for queued executions with recovery checkpoints", async () => {
		const manager = createManager();
		await manager.execute("const stateForTiming = { value: 1 };");

		const result = await manager.execute("1;");

		expect(result.timings).toBeDefined();
		if (!result.timings) return;
		expect(Object.keys(result.timings).sort()).toEqual([
			"checkpointMs",
			"executionMs",
			"queueMs",
			"startupMs",
			"totalMs",
		]);
		for (const timing of Object.values(result.timings)) {
			expect(Number.isFinite(timing)).toBe(true);
			expect(timing).toBeGreaterThanOrEqual(0);
		}
		expect(result.durationMs).toBe(result.timings.totalMs);
		expect(result.timings.totalMs).toBeGreaterThanOrEqual(result.timings.executionMs);
		expect(result.timings.totalMs).toBeGreaterThanOrEqual(result.timings.checkpointMs);
	});

	it("coalesces debounced recovery and persistent snapshots", async () => {
		const recoveryPath = join(directory, "coalesced-recovery.bin");
		const persistentPath = join(directory, "coalesced-persistent.bin");
		const manager = createManager({
			recoverySnapshot: {
				manifestPath: join(directory, "coalesced-recovery.json"),
				path: recoveryPath,
			},
			snapshot: {
				debounceMs: 25,
				manifestPath: join(directory, "coalesced-persistent.json"),
				path: persistentPath,
			},
		});

		await manager.execute("const coalescedState = { count: 42 };");
		await expect.poll(() => manager.status.recovery.checkpoint, { timeout: 5_000 }).toBe("ready");

		expect(existsSync(recoveryPath)).toBe(true);
		expect(existsSync(persistentPath)).toBe(true);
		expect(manager.status.recovery.lastCheckpoint?.saved).toContain("coalescedState");
	});

	it("contains debounced recovery checkpoint timeouts without an unhandled rejection", async () => {
		const manager = createManager({
			checkpointTimeoutMs: 100,
			snapshot: {
				debounceMs: 25,
				manifestPath: join(directory, "timed-out-persistent.json"),
				path: join(directory, "timed-out-persistent.bin"),
			},
		});
		await manager.execute(`
const timedOutDebouncedCheckpoint = {};
Object.defineProperty(timedOutDebouncedCheckpoint, "value", {
  enumerable: true,
  get() { while (true) {} }
});
`);

		await expect.poll(() => manager.status.diagnostics, { timeout: 2_000 }).toMatch(/checkpoint.*timed out/i);
		await expect(manager.execute("42;")).rejects.toThrow(/recovery is blocked/i);
	}, 5_000);

	it("keeps a valid recovery checkpoint when its persistent mirror fails", async () => {
		const blockedParent = join(directory, "blocked-persistent-parent");
		const recoveryPath = join(directory, "mirror-failure-recovery.bin");
		await writeFile(blockedParent, "blocking file");
		const manager = createManager({
			recoverySnapshot: {
				manifestPath: join(directory, "mirror-failure-recovery.json"),
				path: recoveryPath,
			},
			snapshot: {
				debounceMs: 25,
				manifestPath: join(blockedParent, "persistent.json"),
				path: join(blockedParent, "persistent.bin"),
			},
		});

		await manager.execute("const recoverySurvivesMirrorFailure = 41;");
		await expect.poll(() => manager.status.recovery.checkpoint, { timeout: 5_000 }).toBe("ready");

		expect(existsSync(recoveryPath)).toBe(true);
		expect(manager.status.diagnostics).toMatch(/persistent state snapshot failed/i);
		await expect(manager.execute("recoverySurvivesMirrorFailure + 1;")).resolves.toMatchObject({
			result: "42",
			status: "ok",
		});
	});

	it("honors different recovery and persistent snapshot caps", async () => {
		const recoveryManifestPath = join(directory, "small-cap-recovery.json");
		const persistentManifestPath = join(directory, "large-cap-persistent.json");
		const manager = createManager({
			recoverySnapshot: {
				manifestPath: recoveryManifestPath,
				maxBytes: 512,
				path: join(directory, "small-cap-recovery.bin"),
			},
			snapshot: {
				debounceMs: 25,
				manifestPath: persistentManifestPath,
				maxBytes: 1024 * 1024,
				path: join(directory, "large-cap-persistent.bin"),
			},
		});

		await manager.execute('const stateBeyondRecoveryCap = "x".repeat(10_000);');
		await expect.poll(() => existsSync(persistentManifestPath), { timeout: 5_000 }).toBe(true);

		const recoveryManifest = JSON.parse(await readFile(recoveryManifestPath, "utf8")) as {
			savedNames: string[];
		};
		const persistentManifest = JSON.parse(await readFile(persistentManifestPath, "utf8")) as {
			savedNames: string[];
		};
		expect(recoveryManifest.savedNames).not.toContain("stateBeyondRecoveryCap");
		expect(persistentManifest.savedNames).toContain("stateBeyondRecoveryCap");
	});

	it("refuses to execute the next cell when its recovery checkpoint cannot be written", async () => {
		const blockedParent = join(directory, "not-a-directory");
		const sideEffectPath = join(directory, "must-not-run.txt");
		await writeFile(blockedParent, "blocking file");
		const manager = createManager({
			recoverySnapshot: {
				manifestPath: join(blockedParent, "recovery.json"),
				path: join(blockedParent, "recovery.bin"),
			},
		});

		await expect(manager.execute("const checkpointedValue = 41;")).resolves.toMatchObject({ status: "ok" });
		expect(manager.status.recovery.checkpoint).toBe("dirty");
		await expect(
			manager.execute(`await Bun.write(${JSON.stringify(sideEffectPath)}, "ran"); checkpointedValue + 1;`),
		).rejects.toThrow(/recovery checkpoint failed/i);

		expect(existsSync(sideEffectPath)).toBe(false);
		expect(manager.status.recovery.checkpoint).toBe("failed");
		expect(manager.status.diagnostics).toMatch(/state snapshot failed/i);
		expect(manager.status.diagnostics.length).toBeLessThanOrEqual(16_384);
	});

	it("times out a hanging recovery checkpoint, kills its worker tree, and blocks later cells", async () => {
		const escapedChildPath = join(directory, "escaped-checkpoint-child.txt");
		const sideEffectPath = join(directory, "must-not-run-after-checkpoint-timeout.txt");
		const manager = createManager({ checkpointTimeoutMs: 100 });
		await manager.execute(`
const hangingCheckpointValue = {};
Object.defineProperty(hangingCheckpointValue, "value", {
  enumerable: true,
  get() {
    Bun.spawn([process.execPath, "-e", ${JSON.stringify(`await Bun.sleep(600); await Bun.write(${JSON.stringify(escapedChildPath)}, "escaped");`)}]);
    while (true) {}
  }
});
`);

		const startedAt = performance.now();
		await expect(manager.execute(`await Bun.write(${JSON.stringify(sideEffectPath)}, "ran");`)).rejects.toThrow(
			/checkpoint.*timed out/i,
		);
		expect(performance.now() - startedAt).toBeLessThan(2_000);
		await new Promise((resolve) => setTimeout(resolve, 750));
		expect(existsSync(escapedChildPath)).toBe(false);
		expect(existsSync(sideEffectPath)).toBe(false);
		expect(manager.status).toMatchObject({
			recovery: { checkpoint: "failed" },
			state: "idle",
		});
		expect(manager.status.diagnostics).toMatch(/checkpoint.*timed out/i);
		await expect(manager.execute("42;")).rejects.toThrow(/recovery is blocked/i);
	}, 10_000);

	it("honors abort while a recovery checkpoint is hung and blocks the wedged worker", async () => {
		const manager = createManager({ checkpointTimeoutMs: 5_000 });
		await manager.execute(`
const abortableCheckpointValue = {};
Object.defineProperty(abortableCheckpointValue, "value", {
  enumerable: true,
  get() { while (true) {} }
});
`);
		const controller = new AbortController();
		const execution = manager.execute("throw new Error('must not execute');", { signal: controller.signal });
		setTimeout(() => controller.abort(), 100);

		await expect(execution).resolves.toMatchObject({ status: "aborted" });
		expect(manager.status).toMatchObject({ recovery: { checkpoint: "failed" }, state: "idle" });
		expect(manager.status.diagnostics).toMatch(/checkpoint.*aborted/i);
		await expect(manager.execute("42;")).rejects.toThrow(/recovery is blocked/i);
	}, 10_000);

	it("publishes bounded recovery checkpoint skip details", async () => {
		const manager = createManager();
		await manager.execute("const unsupportedRecoveryValue = new WeakMap();");

		await expect(manager.execute("21 * 2;")).resolves.toMatchObject({ status: "ok", result: "42" });

		expect(manager.status.recovery.checkpoint).toBe("dirty");
		expect(manager.status.recovery.lastCheckpoint?.skipped).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "unsupportedRecoveryValue" })]),
		);
		expect(manager.status.diagnostics).toMatch(/unsupportedRecoveryValue/);
		expect(manager.status.diagnostics.length).toBeLessThanOrEqual(16_384);
	});

	it.runIf(process.platform !== "win32")("uses the resolved custom shell arguments", async () => {
		const shellPath = join(directory, "recording-shell.sh");
		const argumentPath = join(directory, "shell-argument.txt");
		await writeFile(shellPath, `#!/bin/sh\nprintf %s "$1" > ${JSON.stringify(argumentPath)}\nexec /bin/sh "$@"\n`);
		await chmod(shellPath, 0o755);
		const manager = createManager({ shellPath });

		await expect(manager.execute(`await sh("printf shell-ok").text();`)).resolves.toMatchObject({
			result: '"shell-ok"',
			status: "ok",
		});
		expect(await readFile(argumentPath, "utf8")).toBe("-c");
	});

	it("preserves the exact result shape for an already aborted execution", async () => {
		const manager = createManager();
		const controller = new AbortController();
		controller.abort();

		const result = await manager.execute("1;", { signal: controller.signal });

		expect(result).toEqual({ durationMs: 0, status: "aborted", stderr: "", stdout: "" });
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
