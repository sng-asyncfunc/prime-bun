import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBundledSkillsDir } from "../src/config.js";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import { ensureKernelBun } from "../src/core/kernel/bootstrap.js";
import { resolveBunRuntime } from "../src/core/kernel/bun-runtime.js";
import { type ExecuteResult, KernelManager, type KernelManagerStatus } from "../src/core/kernel/index.js";
import type { JavaScriptSkillRuntimeInfo } from "../src/core/skills.js";
import { BunKernelProvisioner, createJavaScriptToolDefinition } from "../src/core/tools/javascript.js";

let tempDir = "";
let originalKernelDirectory: string | undefined;

function executeResult(overrides: Partial<ExecuteResult> = {}): ExecuteResult {
	return { durationMs: 2, status: "ok", stderr: "", stdout: "output", ...overrides };
}

function createVersionedSkill(name: string, version: string): JavaScriptSkillRuntimeInfo {
	const packagePath = join(tempDir, "skills", name);
	const dependencyPath = join(packagePath, "vendor", "shared-dependency");
	mkdirSync(join(packagePath, "src"), { recursive: true });
	mkdirSync(dependencyPath, { recursive: true });
	writeFileSync(
		join(packagePath, "package.json"),
		`${JSON.stringify({ dependencies: { "shared-dependency": "file:./vendor/shared-dependency" }, private: true })}\n`,
	);
	writeFileSync(
		join(dependencyPath, "package.json"),
		`${JSON.stringify({ exports: "./index.js", name: "shared-dependency", type: "module", version })}\n`,
	);
	writeFileSync(join(dependencyPath, "index.js"), `export const version = ${JSON.stringify(version)};\n`);
	writeFileSync(
		join(packagePath, "src", "index.ts"),
		'import { version } from "shared-dependency";\nexport default { value: () => version };\n',
	);
	return {
		entryPath: join(packagePath, "src", "index.ts"),
		globalName: name.replaceAll("-", "_"),
		name,
		packageJsonPath: join(packagePath, "package.json"),
		packagePath,
	};
}

function copiedBundledSkill(skillsDirectory: string, name: string, globalName: string): JavaScriptSkillRuntimeInfo {
	const packagePath = join(skillsDirectory, name);
	return {
		entryPath: join(packagePath, "src", "index.ts"),
		globalName,
		name,
		packageJsonPath: join(packagePath, "package.json"),
		packagePath,
	};
}

describe("BunKernelProvisioner", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-bun-provisioner-"));
		originalKernelDirectory = process.env.PRIME_AGENT_KERNEL_BUN_DIR;
		process.env.PRIME_AGENT_KERNEL_BUN_DIR = join(tempDir, "kernel-bun");
	});

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		if (originalKernelDirectory === undefined) delete process.env.PRIME_AGENT_KERNEL_BUN_DIR;
		else process.env.PRIME_AGENT_KERNEL_BUN_DIR = originalKernelDirectory;
		tempDir = "";
	});

	it("installs custom skill dependencies into the managed Bun cache", async () => {
		const runtime = await resolveBunRuntime();
		const packagePath = resolve(__dirname, "fixtures/skills/javascript-skill-dependency");
		const manager = new KernelManager({
			bun: runtime.path,
			cwd: tempDir,
			javascriptSkills: [
				{
					entryPath: join(packagePath, "src", "index.js"),
					globalName: "dependencySkill",
					name: "javascript-skill-dependency",
					packageJsonPath: join(packagePath, "package.json"),
					packagePath,
				},
			],
		});
		try {
			const result = await manager.execute("dependencySkill.value();");
			expect(result).toMatchObject({ status: "ok", result: '"managed-dependency-ok"' });
			expect(existsSync(join(packagePath, "node_modules"))).toBe(false);
			expect(existsSync(join(tempDir, "kernel-bun", "skill-deps"))).toBe(true);
		} finally {
			await manager.dispose();
		}
	}, 30_000);

	it("resolves incompatible dependency versions from each skill's own cache", async () => {
		const first = createVersionedSkill("first-version", "1.0.0");
		const second = createVersionedSkill("second-version", "2.0.0");
		const manager = new KernelManager({
			cwd: tempDir,
			env: { BUN_CONFIG_NO_INSTALL: "1" },
			javascriptSkills: [first, second],
		});
		try {
			const result = await manager.execute("[first_version.value(), second_version.value()];");

			expect(result).toMatchObject({ status: "ok" });
			expect(result.result).toContain('"1.0.0"');
			expect(result.result).toContain('"2.0.0"');
			expect(existsSync(join(first.packagePath, "node_modules"))).toBe(false);
			expect(existsSync(join(second.packagePath, "node_modules"))).toBe(false);
		} finally {
			await manager.dispose();
		}
	}, 30_000);

	it("loads copied built-in skill assets with Bun auto-install disabled", async () => {
		const copiedSkillsDirectory = join(tempDir, "standalone-assets", "skills");
		cpSync(getBundledSkillsDir(), copiedSkillsDirectory, { recursive: true });
		const javascriptSkills = [
			copiedBundledSkill(copiedSkillsDirectory, "attach-image", "attachImage"),
			copiedBundledSkill(copiedSkillsDirectory, "linear", "linear"),
			copiedBundledSkill(copiedSkillsDirectory, "notion", "notion"),
		];
		await ensureKernelBun({ javascriptSkills });
		const savedEnvironment = {
			cache: process.env.BUN_INSTALL_CACHE_DIR,
			global: process.env.BUN_GLOBAL_DIR,
			noInstall: process.env.BUN_CONFIG_NO_INSTALL,
			registry: process.env.BUN_CONFIG_REGISTRY,
		};
		process.env.BUN_INSTALL_CACHE_DIR = join(tempDir, "empty-bun-cache");
		process.env.BUN_GLOBAL_DIR = join(tempDir, "empty-bun-global");
		process.env.BUN_CONFIG_NO_INSTALL = "1";
		process.env.BUN_CONFIG_REGISTRY = "http://127.0.0.1:1";
		const manager = new KernelManager({
			cwd: tempDir,
			javascriptSkills,
		});
		try {
			const result = await manager.execute(`
console.log(typeof linear.callTool, typeof notion.callTool);
try { await attachImage(); } catch (error) { console.log(error instanceof Error ? error.message : String(error)); }
`);

			expect(result).toMatchObject({ status: "ok" });
			expect(result.stdout).toContain("function function");
			expect(result.stdout).toContain("attachImage requires at least one image path");
			expect(result.stderr).toBe("");
		} finally {
			await manager.dispose();
			for (const [name, value] of [
				["BUN_INSTALL_CACHE_DIR", savedEnvironment.cache],
				["BUN_GLOBAL_DIR", savedEnvironment.global],
				["BUN_CONFIG_NO_INSTALL", savedEnvironment.noInstall],
				["BUN_CONFIG_REGISTRY", savedEnvironment.registry],
			] as const) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	}, 60_000);

	it("memoizes concurrent startup and exposes the same running manager", async () => {
		const provisioner = new BunKernelProvisioner(tempDir);
		try {
			const [first, second] = await Promise.all([provisioner.ensure(), provisioner.ensure()]);
			expect(first).toBe(second);
			expect(provisioner.manager).toBe(first);
			expect(provisioner.hasRunningKernel).toBe(true);
		} finally {
			await provisioner.dispose();
		}
	});

	it("aborts before a ready gate without starting Bun", async () => {
		let release = (): void => {};
		const readyGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const provisioner = new BunKernelProvisioner(tempDir, { readyGate });
		const controller = new AbortController();

		const startup = provisioner.ensure(undefined, controller.signal);
		controller.abort();
		await expect(startup).rejects.toThrow("JavaScript execution aborted");
		release();
		await provisioner.dispose();
		expect(provisioner.manager).toBeUndefined();
	});

	it("returns no namespace when Bun has not started", async () => {
		const provisioner = new BunKernelProvisioner(tempDir);
		expect(await provisioner.listNamespaceNames()).toBeNull();
		await provisioner.dispose();
	});

	it("forwards JavaScript and preserves structured output", async () => {
		const execute = vi.fn<KernelManager["execute"]>().mockResolvedValue(
			executeResult({
				attachments: [{ data: "aGVsbG8=", mimeType: "image/png", path: "/tmp/image.png" }],
				diffs: [{ newStr: "new", oldStr: "old", path: "/tmp/file.ts", startLine: 4 }],
				durationMs: 2,
				result: "42",
				stderr: "warning",
				timings: { checkpointMs: 1, executionMs: 2, queueMs: 1, startupMs: 1, totalMs: 2 },
			}),
		);
		const kernelStatus: KernelManagerStatus = {
			diagnostics: "state snapshot skipped 1 binding(s): unsupportedRecoveryValue",
			recovery: {
				available: true,
				checkpoint: "dirty",
				lastCheckpoint: {
					bytes: 64,
					path: "/tmp/recovery.bin",
					saved: ["answer"],
					skipped: [{ name: "unsupportedRecoveryValue", reason: "unsupported" }],
				},
			},
			state: "running",
		};
		const manager = { execute, status: kernelStatus } as unknown as KernelManager;
		let releaseProvisioning = (): void => {};
		const provisioningGate = new Promise<void>((resolve) => {
			releaseProvisioning = resolve;
		});
		const ensure = vi.fn(async () => {
			await provisioningGate;
			return manager;
		});
		const provisioner = { ensure } as unknown as BunKernelProvisioner;
		const tool = createJavaScriptToolDefinition(tempDir, { provisioner });

		const pendingResult = tool.execute("call-1", { code: "const answer = 42; answer;" }, undefined, undefined, {
			ui: { setWorkingMessage: vi.fn() },
		} as unknown as ExtensionContext);
		await new Promise((resolve) => setTimeout(resolve, 10));
		releaseProvisioning();
		const result = await pendingResult;

		expect(execute).toHaveBeenCalledWith(
			"const answer = 42; answer;",
			expect.objectContaining({ onStream: expect.any(Function), signal: undefined }),
		);
		expect(result.details).toMatchObject({
			durationMs: expect.any(Number),
			status: "ok",
			stdout: "output",
			stderr: "warning",
			result: "42",
			diffs: [{ path: "/tmp/file.ts", startLine: 4 }],
			timings: {
				checkpointMs: 1,
				executionMs: 2,
				provisioningMs: expect.any(Number),
				queueMs: 1,
				startupMs: 1,
				totalMs: expect.any(Number),
			},
			kernelStatus,
		});
		expect(result.details.timings?.provisioningMs).toBeGreaterThan(0);
		expect(result.details.durationMs).toBe(result.details.timings?.totalMs);
		expect(result.details.durationMs).toBeGreaterThan(2);
		expect(result.content).toEqual([
			{ type: "text", text: "output\nwarning\n42" },
			{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
		]);
	});

	it("rejects invalid tool modes before provisioning the kernel", async () => {
		const ensure = vi.fn();
		const provisioner = { ensure } as unknown as BunKernelProvisioner;
		const tool = createJavaScriptToolDefinition(tempDir, { provisioner });
		const invalidInputs = [
			{},
			{ code: "42;", actions: [{ op: "read", path: "README.md" }] },
			{ actions: Array.from({ length: 9 }, () => ({ op: "search", path: "." })) },
			{
				actions: [
					{ op: "write", path: "a.md", content: "a" },
					{ op: "write", path: "b.md", content: "b" },
				],
			},
		];

		const results = await Promise.all(
			invalidInputs.map((input, index) =>
				tool.execute(`invalid-${index}`, input as never, undefined, undefined, {} as ExtensionContext),
			),
		);

		expect(results.every((result) => result.details?.status === "error")).toBe(true);
		expect(results[0]?.content[0]).toMatchObject({ text: expect.stringContaining("exactly one"), type: "text" });
		expect(results[1]?.content[0]).toMatchObject({ text: expect.stringContaining("exactly one"), type: "text" });
		expect(results[2]?.content[0]).toMatchObject({ text: expect.stringContaining("1 to 8 actions"), type: "text" });
		expect(results[3]?.content[0]).toMatchObject({
			text: expect.stringContaining("at most one write"),
			type: "text",
		});
		expect(ensure).not.toHaveBeenCalled();
	});

	it("routes validated structured actions through the existing kernel stream", async () => {
		const execute = vi.fn<KernelManager["execute"]>().mockResolvedValue(executeResult());
		const executeActions = vi
			.fn<KernelManager["executeActions"]>()
			.mockResolvedValue(executeResult({ stdout: "[1/1 read README.md lines 1-2]\n1: title" }));
		const manager = {
			execute,
			executeActions,
			status: { diagnostics: "", recovery: { available: false, checkpoint: "clean" }, state: "running" },
		} as unknown as KernelManager;
		const provisioner = { ensure: vi.fn(async () => manager) } as unknown as BunKernelProvisioner;
		const tool = createJavaScriptToolDefinition(tempDir, { provisioner });
		const actions = [{ op: "read", path: "README.md", offset: 1, limit: 2 }];

		const result = await tool.execute(
			"actions-call",
			{ actions } as never,
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(executeActions).toHaveBeenCalledWith(
			actions,
			expect.objectContaining({ onStream: expect.any(Function), signal: undefined }),
		);
		expect(execute).not.toHaveBeenCalled();
		expect(result).toMatchObject({ details: { status: "ok" } });
		expect(result.content).toEqual([{ type: "text", text: "[1/1 read README.md lines 1-2]\n1: title" }]);
	});

	it("keeps large output once in canonical content instead of duplicating raw details", async () => {
		const largeResult = "x".repeat(20_000);
		const manager = {
			execute: vi
				.fn<KernelManager["execute"]>()
				.mockResolvedValue(executeResult({ result: largeResult, stdout: "" })),
			status: { diagnostics: "", recovery: { available: false, checkpoint: "clean" }, state: "running" },
		} as unknown as KernelManager;
		const provisioner = { ensure: vi.fn(async () => manager) } as unknown as BunKernelProvisioner;
		const tool = createJavaScriptToolDefinition(tempDir, { provisioner });

		const result = await tool.execute(
			"large-output-call",
			{ code: "largeResult;" },
			undefined,
			undefined,
			{} as unknown as ExtensionContext,
		);

		expect(result.content).toEqual([{ type: "text", text: largeResult }]);
		expect(result.details).not.toHaveProperty("stdout");
		expect(result.details).not.toHaveProperty("stderr");
		expect(result.details).not.toHaveProperty("result");
		expect(result.details).toMatchObject({ status: "ok" });
	});

	it("returns bounded kernel status when execution is blocked by recovery", async () => {
		const execute = vi.fn<KernelManager["execute"]>().mockRejectedValue(new Error("Bun recovery checkpoint failed"));
		const kernelStatus: KernelManagerStatus = {
			diagnostics: "recovery checkpoint failed: snapshot timed out",
			recovery: { available: true, checkpoint: "failed" },
			state: "idle",
		};
		const manager = { execute, status: kernelStatus } as unknown as KernelManager;
		const provisioner = { ensure: vi.fn(async () => manager) } as unknown as BunKernelProvisioner;
		const tool = createJavaScriptToolDefinition(tempDir, { provisioner });

		const result = await tool.execute("blocked-call", { code: "42;" }, undefined, undefined, {
			ui: { setWorkingMessage: vi.fn() },
		} as unknown as ExtensionContext);

		expect(result).toMatchObject({
			content: [{ text: expect.stringMatching(/recovery checkpoint failed/i), type: "text" }],
			details: {
				error: {
					ename: "Error",
					evalue: "Bun recovery checkpoint failed",
					traceback: expect.any(Array),
				},
				errorEname: "Error",
				kernelStatus,
				status: "error",
			},
			isError: true,
		});
	});
});
