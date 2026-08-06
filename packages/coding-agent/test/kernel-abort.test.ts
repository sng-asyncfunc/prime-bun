import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveBunRuntime } from "../src/core/kernel/bun-runtime.js";
import { KernelManager } from "../src/core/kernel/index.js";

describe("Bun KernelManager abort and crash recovery", () => {
	let bunPath: string;
	let directory: string;
	let manager: KernelManager;

	beforeEach(async () => {
		bunPath = (await resolveBunRuntime()).path;
		directory = await mkdtemp(join(tmpdir(), "prime-bun-abort-"));
		manager = new KernelManager({
			bun: bunPath,
			cwd: directory,
			env: { PRIME_BUN_RECOVERY_DELETE: "initial" },
		});
	});

	afterEach(async () => {
		await manager.dispose();
		await rm(directory, { force: true, recursive: true });
	});

	it("kills synchronous infinite JavaScript and restores the last successful state", async () => {
		await mkdir(join(directory, "nested"));
		const nestedDirectory = await realpath(join(directory, "nested"));
		await manager.execute(`
const stable = { value: 7 };
globalThis.explicitStable = 8;
process.chdir(${JSON.stringify(nestedDirectory)});
process.env.PRIME_BUN_RECOVERY_SET = "retained";
delete process.env.PRIME_BUN_RECOVERY_DELETE;
stable.value;
`);
		const controller = new AbortController();
		const execution = manager.execute("while (true) {}", { signal: controller.signal });
		setTimeout(() => controller.abort(), 100);

		await expect(execution).resolves.toMatchObject({ status: "aborted" });
		const recovered = await manager.execute(`({
  stable: stable.value,
  explicitStable,
  cwd: process.cwd(),
  retained: process.env.PRIME_BUN_RECOVERY_SET,
  deleted: process.env.PRIME_BUN_RECOVERY_DELETE,
});`);
		expect(recovered).toMatchObject({ status: "ok" });
		expect(recovered.result).toContain("stable: 7");
		expect(recovered.result).toContain("explicitStable: 8");
		expect(recovered.result).toContain(`cwd: ${JSON.stringify(nestedDirectory)}`);
		expect(recovered.result).toContain('retained: "retained"');
		expect(recovered.result).toContain("deleted: undefined");
	}, 10_000);

	it("prevents delayed mutations from an aborted async cell", async () => {
		await manager.execute("const stable = { value: 11 }; stable.value;");
		const controller = new AbortController();
		const execution = manager.execute(
			`setTimeout(() => { stable.value = 99; }, 250); await new Promise((resolve) => setTimeout(resolve, 10_000));`,
			{ signal: controller.signal },
		);
		setTimeout(() => controller.abort(), 75);

		await expect(execution).resolves.toMatchObject({ status: "aborted" });
		await new Promise((resolve) => setTimeout(resolve, 350));
		await expect(manager.execute("stable.value;")).resolves.toMatchObject({ status: "ok", result: "11" });
	}, 10_000);

	it("terminates shell descendants when a cell is aborted", async () => {
		const orphanPath = join(directory, "orphan.txt");
		const controller = new AbortController();
		const execution = manager.execute(`await sh(${JSON.stringify(`sleep 0.6; printf orphan > ${orphanPath}`)});`, {
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 100);

		await expect(execution).resolves.toMatchObject({ status: "aborted" });
		await new Promise((resolve) => setTimeout(resolve, 800));
		expect(existsSync(orphanPath)).toBe(false);
	}, 10_000);

	it("restores the last successful state after an unexpected worker exit", async () => {
		await manager.execute("const stable = { value: 13 }; stable.value;");

		await expect(manager.execute("process.exit(23);")).rejects.toThrow(/Bun worker exited unexpectedly/);
		await expect(manager.execute("stable.value;")).resolves.toMatchObject({ status: "ok", result: "13" });
	}, 10_000);

	it("returns an aborted result without starting a worker for a pre-aborted signal", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(manager.execute("42;", { signal: controller.signal })).resolves.toEqual({
			durationMs: 0,
			status: "aborted",
			stderr: "",
			stdout: "",
		});
		expect(manager.isRunning).toBe(false);
	});
});
