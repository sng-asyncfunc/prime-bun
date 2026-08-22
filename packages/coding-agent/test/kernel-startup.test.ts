import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUN_WORKER_PROTOCOL_VERSION } from "../src/core/kernel/bun-protocol.js";
import { resolveBunRuntime } from "../src/core/kernel/bun-runtime.js";
import { KernelManager } from "../src/core/kernel/index.js";
import type { JavaScriptSkillRuntimeInfo } from "../src/core/skills.js";

let tempDir = "";

function writeJavaScriptSkill(name: string, source: string): JavaScriptSkillRuntimeInfo {
	const packagePath = join(tempDir, name);
	const entryPath = join(packagePath, "index.ts");
	const packageJsonPath = join(packagePath, "package.json");
	mkdirSync(packagePath);
	writeFileSync(packageJsonPath, `${JSON.stringify({ name, private: true })}\n`);
	writeFileSync(entryPath, source);
	return { entryPath, globalName: name.replaceAll("-", "_"), name, packageJsonPath, packagePath };
}

function writeExecutable(filePath: string, content: string): void {
	writeFileSync(filePath, content);
	chmodSync(filePath, 0o755);
}

describe("KernelManager startup", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-startup-"));
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("surfaces Bun workers that exit before initialization", async () => {
		const bun = join(tempDir, "bun");
		writeExecutable(
			bun,
			[
				"#!/bin/sh",
				'if [ "$1" = "--version" ]; then echo "1.4.0"; exit 0; fi',
				'echo "fake Bun worker died before initialization" >&2',
				"exit 42",
				"",
			].join("\n"),
		);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new KernelManager({ bun, cwd: tempDir, workerPath: join(tempDir, "worker.ts") });

		try {
			await expect(manager.execute("console.log(1)")).rejects.toThrow(/Bun worker exited unexpectedly/);
		} finally {
			errorSpy.mockRestore();
			await manager.dispose();
		}
	});

	it("times out readiness and kills the spawned worker tree", async () => {
		const runtime = await resolveBunRuntime();
		const workerPath = join(tempDir, "slow-worker.ts");
		const escapedChildPath = join(tempDir, "escaped-readiness-child.txt");
		writeFileSync(
			workerPath,
			[
				'import { createReadStream, createWriteStream } from "node:fs";',
				'import { createInterface } from "node:readline";',
				'const input = createReadStream("", { autoClose: false, fd: 3 });',
				'const output = createWriteStream("", { autoClose: false, fd: 4 });',
				"const reader = createInterface({ input });",
				'reader.once("line", async (line) => {',
				"  const message = JSON.parse(line);",
				`  Bun.spawn([process.execPath, "-e", ${JSON.stringify(`await Bun.sleep(600); await Bun.write(${JSON.stringify(escapedChildPath)}, "escaped");`)}]);`,
				"  await Bun.sleep(250);",
				`  output.write(JSON.stringify({ bunVersion: Bun.version, id: "ready", protocolVersion: ${BUN_WORKER_PROTOCOL_VERSION}, replyTo: message.id, type: "ready" }) + "\\n");`,
				"});",
				"await new Promise(() => {});",
				"",
			].join("\n"),
		);
		const manager = new KernelManager({
			bun: runtime.path,
			cwd: tempDir,
			readyTimeoutMs: 50,
			workerPath,
		});

		try {
			const outcome = await manager.start().then(
				() => "started" as const,
				(error: unknown) => error,
			);
			await new Promise((resolve) => setTimeout(resolve, 750));
			expect({ escaped: existsSync(escapedChildPath), failed: outcome instanceof Error }).toEqual({
				escaped: false,
				failed: true,
			});
			expect(outcome).toBeInstanceOf(Error);
			if (outcome instanceof Error) expect(outcome.message).toMatch(/readiness timed out/i);
			expect(manager.status.state).toBe("idle");
		} finally {
			await manager.dispose();
		}
	}, 5_000);

	it("rejects a mismatched worker protocol and kills its spawned tree", async () => {
		const runtime = await resolveBunRuntime();
		const workerPath = join(tempDir, "mismatched-worker.ts");
		const escapedChildPath = join(tempDir, "escaped-protocol-child.txt");
		writeFileSync(
			workerPath,
			[
				'import { createReadStream, createWriteStream } from "node:fs";',
				'import { createInterface } from "node:readline";',
				'const input = createReadStream("", { autoClose: false, fd: 3 });',
				'const output = createWriteStream("", { autoClose: false, fd: 4 });',
				"const reader = createInterface({ input });",
				'reader.once("line", (line) => {',
				"  const message = JSON.parse(line);",
				`  Bun.spawn([process.execPath, "-e", ${JSON.stringify(`await Bun.sleep(600); await Bun.write(${JSON.stringify(escapedChildPath)}, "escaped");`)}]);`,
				`  output.write(JSON.stringify({ bunVersion: Bun.version, id: "ready", protocolVersion: ${BUN_WORKER_PROTOCOL_VERSION - 1}, replyTo: message.id, type: "ready" }) + "\\n");`,
				"});",
				"await new Promise(() => {});",
				"",
			].join("\n"),
		);
		const manager = new KernelManager({
			bun: runtime.path,
			cwd: tempDir,
			readyTimeoutMs: 1_000,
			workerPath,
		});

		try {
			const outcome = await manager.start().then(
				() => "started" as const,
				(error: unknown) => error,
			);
			await new Promise((resolve) => setTimeout(resolve, 750));
			expect({ escaped: existsSync(escapedChildPath), failed: outcome instanceof Error }).toEqual({
				escaped: false,
				failed: true,
			});
			expect(outcome).toBeInstanceOf(Error);
			if (outcome instanceof Error) expect(outcome.message).toMatch(/protocol version/i);
			expect(manager.status.state).toBe("idle");
		} finally {
			await manager.dispose();
		}
	}, 5_000);

	it("fails startup on an async skill factory timeout and kills its late side effects", async () => {
		const runtime = await resolveBunRuntime();
		const escapedChildPath = join(tempDir, "escaped-async-factory-child.txt");
		const slowSkill = writeJavaScriptSkill(
			"slow-skill",
			`export function createSkill(): Promise<never> {
  Bun.spawn([process.execPath, "-e", ${JSON.stringify(`await Bun.sleep(600); await Bun.write(${JSON.stringify(escapedChildPath)}, "escaped");`)}]);
  return new Promise(() => {});
}
`,
		);
		const workerPath = fileURLToPath(new URL("../src/core/kernel/bun-worker.ts", import.meta.url));
		const manager = new KernelManager({
			bun: runtime.path,
			cwd: tempDir,
			javascriptSkills: [slowSkill],
			kernelDirectory: tempDir,
			readyTimeoutMs: 1_000,
			skillFactoryTimeoutMs: 50,
			workerPath,
		});

		try {
			await expect(manager.start()).rejects.toThrow(/slow-skill.*timed out/i);
			await new Promise((resolve) => setTimeout(resolve, 750));
			expect(existsSync(escapedChildPath)).toBe(false);
			expect(manager.status.state).toBe("idle");
		} finally {
			await manager.dispose();
		}
	}, 5_000);

	it("keeps healthy skills available when a sibling factory rejects immediately", async () => {
		const runtime = await resolveBunRuntime();
		const brokenSkill = writeJavaScriptSkill(
			"broken-skill",
			'export function createSkill(): never { throw new Error("broken factory"); }\n',
		);
		const healthySkill = writeJavaScriptSkill(
			"healthy-skill",
			'export function createSkill(): () => string { return () => "healthy"; }\n',
		);
		const manager = new KernelManager({
			bun: runtime.path,
			cwd: tempDir,
			javascriptSkills: [brokenSkill, healthySkill],
			kernelDirectory: tempDir,
			workerPath: fileURLToPath(new URL("../src/core/kernel/bun-worker.ts", import.meta.url)),
		});

		try {
			await expect(manager.start()).resolves.toBeUndefined();
			await expect(manager.execute("await healthy_skill();")).resolves.toMatchObject({
				result: '"healthy"',
				status: "ok",
			});
			await expect(manager.execute("await broken_skill();")).resolves.toMatchObject({
				error: { evalue: expect.stringMatching(/broken factory/i) },
				status: "error",
			});
			expect(manager.status.diagnostics).toMatch(/broken factory/i);
			expect(manager.status.state).toBe("running");
		} finally {
			await manager.dispose();
		}
	}, 5_000);

	it("bounds a synchronous infinite skill factory with the readiness watchdog", async () => {
		const runtime = await resolveBunRuntime();
		const escapedChildPath = join(tempDir, "escaped-sync-factory-child.txt");
		const blockingSkill = writeJavaScriptSkill(
			"blocking-skill",
			`export function createSkill(): never {
  Bun.spawn([process.execPath, "-e", ${JSON.stringify(`await Bun.sleep(600); await Bun.write(${JSON.stringify(escapedChildPath)}, "escaped");`)}]);
  while (true) {}
}
`,
		);
		const manager = new KernelManager({
			bun: runtime.path,
			cwd: tempDir,
			javascriptSkills: [blockingSkill],
			kernelDirectory: tempDir,
			readyTimeoutMs: 100,
			skillFactoryTimeoutMs: 50,
			workerPath: fileURLToPath(new URL("../src/core/kernel/bun-worker.ts", import.meta.url)),
		});

		try {
			await expect(manager.start()).rejects.toThrow(/readiness timed out/i);
			await new Promise((resolve) => setTimeout(resolve, 750));
			expect(existsSync(escapedChildPath)).toBe(false);
			expect(manager.status.state).toBe("idle");
		} finally {
			await manager.dispose();
		}
	}, 5_000);
});
