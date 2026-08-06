import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureKernelBun, getKernelBunDir, type KernelBunRuntime } from "../src/core/kernel/bootstrap.js";

let tempDir = "";
let originalEnv: NodeJS.ProcessEnv;

function writeExecutable(filePath: string, content: string): void {
	writeFileSync(filePath, content);
	chmodSync(filePath, 0o755);
}

function installFakeBun(version = "1.3.14"): { bun: string; logPath: string } {
	const binDir = join(tempDir, "bin");
	const bun = join(binDir, "bun");
	const logPath = join(tempDir, "bun.log");
	mkdirSync(binDir, { recursive: true });
	process.env.BUN_BOOTSTRAP_LOG = logPath;
	writeExecutable(
		bun,
		[
			"#!/bin/sh",
			'if [ "$1" = "--version" ]; then',
			`  printf '%s\\n' '${version}'`,
			"  exit 0",
			"fi",
			'printf "%s\\n" "$*" >> "$BUN_BOOTSTRAP_LOG"',
			'if [ "$1" = "install" ]; then',
			'  kernel_dir="$(pwd)"',
			'  /bin/mkdir -p "$kernel_dir/node_modules/acorn" "$kernel_dir/node_modules/@modelcontextprotocol/sdk"',
			'  printf "{}\\n" > "$kernel_dir/node_modules/acorn/package.json"',
			'  printf "{}\\n" > "$kernel_dir/node_modules/@modelcontextprotocol/sdk/package.json"',
			"  exit 0",
			"fi",
			"exit 2",
			"",
		].join("\n"),
	);
	process.env.PATH = `${binDir}${process.env.PATH ? `:${process.env.PATH}` : ""}`;
	return { bun, logPath };
}

function createRuntimeAssets(): string {
	const sourceDirectory = join(tempDir, "runtime-assets");
	mkdirSync(sourceDirectory, { recursive: true });
	for (const name of ["bun-worker", "bun-protocol", "bun-cell-transform", "bun-rlm-runtime", "state-snapshot"]) {
		writeFileSync(join(sourceDirectory, `${name}.ts`), `export const ${name.replaceAll("-", "_")} = true;\n`);
	}
	return sourceDirectory;
}

function expectProvisioned(runtime: KernelBunRuntime, kernelDirectory: string): void {
	expect(runtime.kernelDirectory).toBe(kernelDirectory);
	expect(runtime.workerPath).toBe(join(kernelDirectory, "bun-worker.ts"));
	expect(readFileSync(join(kernelDirectory, "package.json"), "utf8")).toContain('"acorn"');
	expect(readFileSync(join(kernelDirectory, ".bootstrap-version"), "utf8")).toContain('"schema":1');
	expect(readFileSync(runtime.workerPath, "utf8")).toContain("bun_worker");
}

describe("Bun kernel bootstrap", () => {
	beforeEach(() => {
		originalEnv = { ...process.env };
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-bun-bootstrap-"));
		process.env.HOME = tempDir;
		process.env.PATH = "";
		delete process.env.PRIME_AGENT_INSTALL_BUN;
		delete process.env.PRIME_AGENT_KERNEL_BUN;
		delete process.env.PRIME_AGENT_KERNEL_BUN_DIR;
		delete process.env.XDG_DATA_HOME;
	});

	afterEach(() => {
		process.env = originalEnv;
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		tempDir = "";
	});

	it("returns the configured Bun kernel directory", () => {
		const configured = join(tempDir, "custom-bun-kernel");
		process.env.PRIME_AGENT_KERNEL_BUN_DIR = configured;

		expect(getKernelBunDir()).toBe(configured);
	});

	it("provisions Bun worker assets and dependencies", async () => {
		const { bun, logPath } = installFakeBun();
		const kernelDirectory = join(tempDir, "kernel-bun");
		process.env.PRIME_AGENT_KERNEL_BUN_DIR = kernelDirectory;

		const runtime = await ensureKernelBun({ runtimeSourceDirectory: createRuntimeAssets() });

		expect(runtime).toMatchObject({ path: bun, version: "1.3.14" });
		expectProvisioned(runtime, kernelDirectory);
		expect(readFileSync(logPath, "utf8")).toBe("install --production\n");
	});

	it("routes setup progress through the provided callback", async () => {
		installFakeBun();
		const progress: string[] = [];
		const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		try {
			await ensureKernelBun({
				onProgress: (message) => progress.push(message),
				runtimeSourceDirectory: createRuntimeAssets(),
			});
		} finally {
			stderrWrite.mockRestore();
		}

		expect(progress).toEqual(["› preparing Bun runtime (one-time)…", "✓ Bun runtime ready"]);
		expect(stderrWrite).not.toHaveBeenCalled();
	});

	it("reuses a current warm runtime without reinstalling packages", async () => {
		const { logPath } = installFakeBun();
		const options = { runtimeSourceDirectory: createRuntimeAssets() };

		const first = await ensureKernelBun(options);
		expect(readFileSync(join(first.kernelDirectory, ".bootstrap-version"), "utf8")).toContain('"schema":1');
		expect(readFileSync(join(first.kernelDirectory, "node_modules", "acorn", "package.json"), "utf8")).toBe("{}\n");
		expect(
			readFileSync(
				join(first.kernelDirectory, "node_modules", "@modelcontextprotocol", "sdk", "package.json"),
				"utf8",
			),
		).toBe("{}\n");
		await ensureKernelBun(options);

		expect(readFileSync(logPath, "utf8").trim().split("\n")).toHaveLength(1);
	});

	it("shares concurrent provisioning work", async () => {
		const { logPath } = installFakeBun();
		const options = { runtimeSourceDirectory: createRuntimeAssets() };

		const [first, second] = await Promise.all([ensureKernelBun(options), ensureKernelBun(options)]);

		expect(first).toEqual(second);
		expect(readFileSync(logPath, "utf8").trim().split("\n")).toHaveLength(1);
	});

	it("refreshes provisioned assets when the bundled worker changes", async () => {
		const { logPath } = installFakeBun();
		const runtimeSourceDirectory = createRuntimeAssets();
		const first = await ensureKernelBun({ runtimeSourceDirectory });
		writeFileSync(join(runtimeSourceDirectory, "bun-worker.ts"), "export const changed = true;\n");

		const second = await ensureKernelBun({ runtimeSourceDirectory });

		expect(readFileSync(second.workerPath, "utf8")).toContain("changed");
		expect(readFileSync(logPath, "utf8").trim().split("\n")).toHaveLength(2);
		expect(first.workerPath).toBe(second.workerPath);
	});

	it("rejects Bun versions older than the supported baseline", async () => {
		installFakeBun("1.3.13");

		await expect(ensureKernelBun({ runtimeSourceDirectory: createRuntimeAssets() })).rejects.toThrow(
			/requires Bun 1\.3\.14 or newer/,
		);
	});

	it("reports the official installer when Bun is unavailable", async () => {
		await expect(ensureKernelBun({ runtimeSourceDirectory: createRuntimeAssets() })).rejects.toThrow(
			/curl -fsSL https:\/\/bun\.sh\/install \| bash/,
		);
	});

	it("installs Bun when explicitly authorized", async () => {
		const installRuntime = vi.fn(async () => {
			const { bun } = installFakeBun();
			process.env.PRIME_AGENT_KERNEL_BUN = bun;
		});
		process.env.PRIME_AGENT_INSTALL_BUN = "1";

		const runtime = await ensureKernelBun({ installRuntime, runtimeSourceDirectory: createRuntimeAssets() });

		expect(installRuntime).toHaveBeenCalledOnce();
		expect(runtime.version).toBe("1.3.14");
	});
});
