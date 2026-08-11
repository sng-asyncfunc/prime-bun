import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUN_WORKER_PROTOCOL_VERSION } from "../src/core/kernel/bun-protocol.js";
import { resolveBunRuntime } from "../src/core/kernel/bun-runtime.js";
import {
	AGENT_MESSAGE_DISPLAY_MIME,
	ATTACHMENT_DISPLAY_MIME,
	DIFF_DISPLAY_MIME,
	KernelManager,
} from "../src/core/kernel/index.js";

function processIsRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

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

	it("executes an exact structured write without adding notebook bindings", async () => {
		const manager = createManager();
		const target = join(directory, "fenced.md");
		const interpolation = "${" + "value}";
		const content = ["# Example", "", "```ts", `const template = \`${interpolation}\`;`, "```", ""].join("\n");

		const result = await manager.executeActions([{ op: "write", path: target, content }]);

		expect(result).toMatchObject({ status: "ok" });
		expect(await readFile(target, "utf8")).toBe(content);
		expect(result.diffs).toEqual([{ path: target, oldStr: "", newStr: content, startLine: 1 }]);
		expect(await manager.listNamespaceNames()).toEqual([]);
	});

	it("keeps search misses and non-zero shell exits out of the cell-error path", async () => {
		const manager = createManager();
		await writeFile(join(directory, "present.txt"), "present\n", "utf8");

		const result = await manager.executeActions([
			{ op: "search", path: directory, pattern: "definitely-absent-pattern" },
			{ op: "shell", command: `${JSON.stringify(process.execPath)} -e "process.exit(7)"` },
		]);

		expect(result.status).toBe("ok");
		expect(result.error).toBeUndefined();
		expect(result.stdout).toContain("0 matches");
		expect(result.stdout).toContain("exitCode: 7");
		expect(result.stdout).toContain("stopped after shell exit 7");
	});

	it.runIf(process.platform !== "win32")("reports configured-shell signal exits as failures", async () => {
		const manager = createManager();

		const result = await manager.executeActions([{ op: "shell", command: "kill -TERM $$" }]);

		expect(result).toMatchObject({ status: "ok" });
		expect(result.stdout).toContain("exitCode: 143");
		expect(result.stdout).toContain("stopped after shell exit 143");
	});

	it("closes stdin for structured shell actions", async () => {
		const manager = createManager();
		const controller = new AbortController();
		const abortTimer = setTimeout(() => controller.abort(), 1_000);

		const result = await manager.executeActions([{ op: "shell", command: "cat" }], {
			signal: controller.signal,
		});
		clearTimeout(abortTimer);

		expect(result).toMatchObject({ status: "ok" });
		expect(result.stdout).toContain("exitCode: 0");
	});

	it("closes stdin for sh calls in code cells", async () => {
		const manager = createManager();
		const controller = new AbortController();
		const abortTimer = setTimeout(() => controller.abort(), 1_000);

		const result = await manager.execute('await sh("cat").text();', { signal: controller.signal });
		clearTimeout(abortTimer);

		expect(result).toMatchObject({ result: '""', status: "ok" });
	});

	it("times out structured shell actions without restarting the worker", async () => {
		const manager = createManager({
			structuredShellTimeoutMs: 100,
		} as ConstructorParameters<typeof KernelManager>[0]);
		const controller = new AbortController();
		const abortTimer = setTimeout(() => controller.abort(), 1_500);
		const command = `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 5000)"`;

		const result = await manager.executeActions([{ op: "shell", command }], { signal: controller.signal });
		clearTimeout(abortTimer);

		expect(result).toMatchObject({ status: "ok" });
		expect(result.stdout).toContain("timed out after 100ms");
		expect(manager.isRunning).toBe(true);
		await expect(manager.execute("40 + 2;")).resolves.toMatchObject({ result: "42", status: "ok" });
	}, 5_000);

	it("honors a structured shell action timeout override", async () => {
		const manager = createManager({
			structuredShellTimeoutMs: 100,
		} as ConstructorParameters<typeof KernelManager>[0]);
		const command = `${JSON.stringify(process.execPath)} -e "setTimeout(() => console.log('override-ok'), 250)"`;

		const result = await manager.executeActions([{ op: "shell", command, timeoutSeconds: 1 }]);

		expect(result).toMatchObject({ status: "ok" });
		expect(result.stdout).toContain("exitCode: 0");
		expect(result.stdout).toContain("override-ok");
		expect(result.stdout).not.toContain("timed out");
	});

	it("supports explicit sh timeouts in code cells", async () => {
		const manager = createManager();
		const controller = new AbortController();
		const abortTimer = setTimeout(() => controller.abort(), 1_500);
		const command = `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 5000)"`;

		const result = await manager.execute(`(await sh(${JSON.stringify(command)}, { timeoutMs: 100 })).exitCode;`, {
			signal: controller.signal,
		});
		clearTimeout(abortTimer);

		expect(result).toMatchObject({ result: "124", status: "ok" });
	});

	it.runIf(process.platform !== "win32")(
		"kills a structured shell action's descendants on timeout",
		async () => {
			const manager = createManager({
				structuredShellTimeoutMs: 200,
			} as ConstructorParameters<typeof KernelManager>[0]);
			const childPidPath = join(directory, "timed-out-shell-child.pid");
			const childScript = "setTimeout(() => {}, 10000)";
			const parentScript = [
				'const { spawn } = require("node:child_process");',
				'const { writeFileSync } = require("node:fs");',
				`const child = spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], { stdio: "ignore" });`,
				"child.unref();",
				`writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
				"setTimeout(() => {}, 10000);",
			].join(" ");
			const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(parentScript)}`;
			const controller = new AbortController();
			const abortTimer = setTimeout(() => controller.abort(), 1_500);

			const result = await manager.executeActions([{ op: "shell", command }], { signal: controller.signal });
			clearTimeout(abortTimer);

			expect(result.stdout).toContain("timed out after 200ms");
			const childPid = Number.parseInt(await readFile(childPidPath, "utf8"), 10);
			await expect.poll(() => processIsRunning(childPid), { timeout: 2_000 }).toBe(false);
		},
		5_000,
	);

	it.runIf(process.platform !== "win32")(
		"does not leave background descendants after shell completion",
		async () => {
			const manager = createManager();
			const childPidPath = join(directory, "completed-shell-child.pid");
			const childScript = "setTimeout(() => {}, 10000)";
			const parentScript = [
				'const { spawn } = require("node:child_process");',
				'const { writeFileSync } = require("node:fs");',
				`const child = spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], { stdio: "ignore" });`,
				"child.unref();",
				`writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
			].join(" ");
			const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(parentScript)}`;
			let childPid: number | undefined;

			try {
				await expect(manager.executeActions([{ op: "shell", command }])).resolves.toMatchObject({ status: "ok" });
				childPid = Number.parseInt(await readFile(childPidPath, "utf8"), 10);
				await expect.poll(() => processIsRunning(childPid as number), { timeout: 1_000 }).toBe(false);
			} finally {
				if (childPid !== undefined && processIsRunning(childPid)) process.kill(childPid, "SIGKILL");
			}
		},
		5_000,
	);

	it("aborts a structured batch, recovers the worker, and skips later actions", async () => {
		const manager = createManager();
		const target = join(directory, "must-not-run-after-action-abort.txt");
		const controller = new AbortController();
		const execution = manager.executeActions(
			[
				{ op: "shell", command: `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 10000)"` },
				{ op: "write", path: target, content: "unexpected" },
			],
			{ signal: controller.signal },
		);
		setTimeout(() => controller.abort(), 100);

		await expect(execution).resolves.toMatchObject({ status: "aborted" });
		expect(existsSync(target)).toBe(false);
		await expect(manager.execute("40 + 2;")).resolves.toMatchObject({ result: "42", status: "ok" });
	}, 10_000);

	it.runIf(process.platform !== "win32")(
		"kills detached shell descendants when a cell is aborted",
		async () => {
			const manager = createManager();
			const escapedPath = join(directory, "must-not-escape-shell-abort.txt");
			const script = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(escapedPath)}, "escaped"), 750)`;
			const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
			const controller = new AbortController();
			const execution = manager.executeActions([{ op: "shell", command }], { signal: controller.signal });
			setTimeout(() => controller.abort(), 100);

			await expect(execution).resolves.toMatchObject({ status: "aborted" });
			await new Promise((resolve) => setTimeout(resolve, 900));
			expect(existsSync(escapedPath)).toBe(false);
		},
		5_000,
	);

	it.runIf(process.platform !== "win32")(
		"kills a detached shell reported after its worker became stale",
		async () => {
			const manager = createManager();
			await manager.execute("1;");
			const escapedPath = join(directory, "must-not-escape-stale-worker.txt");
			const script = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(escapedPath)}, "escaped"), 500)`;
			const child = spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore" });
			if (child.pid === undefined) throw new Error("Detached test shell did not start");
			child.unref();
			const message = `${JSON.stringify({
				id: "late-shell-start",
				pid: child.pid,
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "shell_child_started",
			})}\n`;
			const protocolManager = manager as unknown as {
				handleProtocolChunk(worker: ChildProcess, chunk: string): void;
			};

			try {
				const splitAt = Math.floor(message.length / 2);
				protocolManager.handleProtocolChunk(child, message.slice(0, splitAt));
				protocolManager.handleProtocolChunk(child, message.slice(splitAt));
				await new Promise((resolve) => setTimeout(resolve, 650));
				expect(existsSync(escapedPath)).toBe(false);
			} finally {
				if (processIsRunning(child.pid)) process.kill(-child.pid, "SIGKILL");
			}
		},
		5_000,
	);

	it.runIf(process.platform !== "win32")(
		"kills an unreported detached shell when its worker is force-stopped",
		async () => {
			const manager = createManager();
			const childPidPath = join(directory, "unreported-shell-child.pid");
			const escapedPath = join(directory, "must-not-escape-unreported-shell.txt");
			const childScript = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(escapedPath)}, "escaped"), 500)`;
			const workerScript = [
				'const { spawn } = require("node:child_process");',
				'const { writeFileSync } = require("node:fs");',
				`const child = spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], { detached: true, stdio: "ignore" });`,
				"child.unref();",
				`writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
				"setInterval(() => {}, 1000);",
			].join(" ");
			const worker = spawn(process.execPath, ["-e", workerScript], { detached: true, stdio: "ignore" });
			if (worker.pid === undefined) throw new Error("Detached test worker did not start");
			worker.unref();
			let childPid: number | undefined;

			try {
				await expect.poll(() => existsSync(childPidPath), { timeout: 1_000 }).toBe(true);
				childPid = Number.parseInt(await readFile(childPidPath, "utf8"), 10);
				const processManager = manager as unknown as {
					terminateWorkerProcess(worker: ChildProcess, signal: NodeJS.Signals): void;
				};
				processManager.terminateWorkerProcess(worker, "SIGKILL");

				await new Promise((resolve) => setTimeout(resolve, 650));
				expect(existsSync(escapedPath)).toBe(false);
				expect(processIsRunning(childPid)).toBe(false);
			} finally {
				if (processIsRunning(worker.pid)) process.kill(-worker.pid, "SIGKILL");
				if (childPid !== undefined && processIsRunning(childPid)) process.kill(-childPid, "SIGKILL");
			}
		},
		5_000,
	);

	it.runIf(process.platform !== "win32")(
		"force-kills shell descendants that ignore graceful notebook shutdown",
		async () => {
			const manager = createManager();
			const childPidPath = join(directory, "shutdown-resistant-shell-child.pid");
			const script = [
				'process.on("SIGTERM", () => {});',
				`require("node:fs").writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
				"setInterval(() => {}, 1000);",
			].join(" ");
			const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
			let childPid: number | undefined;

			try {
				const execution = manager.executeActions([{ op: "shell", command }]).catch(() => undefined);
				await expect.poll(() => existsSync(childPidPath), { timeout: 1_000 }).toBe(true);
				childPid = Number.parseInt(await readFile(childPidPath, "utf8"), 10);

				await manager.shutdown();
				await execution;

				await expect.poll(() => processIsRunning(childPid as number), { timeout: 1_000 }).toBe(false);
			} finally {
				if (childPid !== undefined && processIsRunning(childPid)) process.kill(childPid, "SIGKILL");
			}
		},
		5_000,
	);

	it("streams a completed structured action before a later action finishes", async () => {
		const manager = createManager();
		const target = join(directory, "stream-first.txt");
		await writeFile(target, "first-action-evidence\n", "utf8");
		await manager.execute("1;");
		let resolveFirstAction!: () => void;
		const firstActionStreamed = new Promise<void>((resolve) => {
			resolveFirstAction = resolve;
		});
		const command = `${JSON.stringify(process.execPath)} -e "setTimeout(() => console.log('second-done'), 750)"`;
		const execution = manager.executeActions(
			[
				{ op: "read", path: target },
				{ op: "shell", command },
			],
			{
				onStream: (chunk) => {
					if (chunk.includes("first-action-evidence")) resolveFirstAction();
				},
			},
		);

		const streamedBeforeSecondFinished = await Promise.race([
			firstActionStreamed.then(() => true),
			new Promise<false>((resolve) => setTimeout(() => resolve(false), 300)),
		]);

		await expect(execution).resolves.toMatchObject({ status: "ok" });
		expect(streamedBeforeSecondFinished).toBe(true);
	}, 5_000);

	it("starts the isolated Bun worker in compact heap mode by default", async () => {
		const manager = createManager();

		await expect(manager.execute('process.execArgv.includes("--smol");')).resolves.toMatchObject({
			result: "true",
			status: "ok",
		});
	});

	it("allows throughput-sensitive embedders to disable compact heap mode", async () => {
		const manager = createManager({ smol: false });

		await expect(manager.execute('process.execArgv.includes("--smol");')).resolves.toMatchObject({
			result: "false",
			status: "ok",
		});
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

	it("keeps the notebook usable when an ordinary recovery checkpoint is interrupted", async () => {
		const manager = createManager();
		await manager.execute("const retainedAfterCheckpointAbort = 42;");
		const controller = new AbortController();
		const execution = manager.execute("throw new Error('must not execute');", { signal: controller.signal });
		setTimeout(() => controller.abort(), 0);

		await expect(execution).resolves.toMatchObject({ status: "aborted" });
		await expect(manager.execute("retainedAfterCheckpointAbort;")).resolves.toMatchObject({
			result: "42",
			status: "ok",
		});
	}, 5_000);

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

	it("checkpoints mutations made before a failed cell for abort recovery", async () => {
		const manager = createManager({
			snapshot: {
				debounceMs: 25,
				manifestPath: join(directory, "failed-cell-persistent.json"),
				path: join(directory, "failed-cell-persistent.bin"),
			},
		});
		await manager.execute("let durableErrorState = 1;");
		await expect.poll(() => manager.status.recovery.checkpoint, { timeout: 5_000 }).toBe("ready");

		await expect(manager.execute('durableErrorState = 2; throw new Error("after mutation");')).resolves.toMatchObject(
			{ status: "error" },
		);
		const controller = new AbortController();
		const execution = manager.execute("while (true) {}", { signal: controller.signal });
		setTimeout(() => controller.abort(), 100);
		await expect(execution).resolves.toMatchObject({ status: "aborted" });

		await expect(manager.execute("durableErrorState;")).resolves.toMatchObject({
			result: "2",
			status: "ok",
		});
	});

	it("keeps a ready recovery checkpoint clean after a parse failure", async () => {
		const manager = createManager({
			snapshot: {
				debounceMs: 25,
				manifestPath: join(directory, "parse-error-persistent.json"),
				path: join(directory, "parse-error-persistent.bin"),
			},
		});
		await manager.execute("const parseErrorBaseline = 1;");
		await expect.poll(() => manager.status.recovery.checkpoint, { timeout: 5_000 }).toBe("ready");

		await expect(manager.execute("const broken = ;")).resolves.toMatchObject({ status: "error" });

		expect(manager.status.recovery.checkpoint).toBe("ready");
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
