import { mkdtemp, rm } from "node:fs/promises";
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
		manager = new KernelManager({ bun: bunPath, cwd: directory });
	});

	afterEach(async () => {
		await manager.dispose();
		await rm(directory, { force: true, recursive: true });
	});

	it("kills synchronous infinite JavaScript and restores the last successful state", async () => {
		await manager.execute("const stable = { value: 7 }; stable.value;");
		const controller = new AbortController();
		const execution = manager.execute("while (true) {}", { signal: controller.signal });
		setTimeout(() => controller.abort(), 100);

		await expect(execution).resolves.toMatchObject({ status: "aborted" });
		await expect(manager.execute("stable.value;")).resolves.toMatchObject({ status: "ok", result: "7" });
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
