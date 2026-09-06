import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KernelManager } from "../src/core/kernel/index.js";
import { KernelStderrLog } from "../src/core/kernel/stderr-log.js";

let tempDir = "";

describe("KernelStderrLog", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-bun-kernel-stderr-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("appends worker diagnostics in order", async () => {
		const path = join(tempDir, "kernel-stderr.log");
		const log = new KernelStderrLog(path);

		log.append("alpha\n");
		log.append("beta\n");
		await log.close();

		expect(readFileSync(path, "utf8")).toBe("alpha\nbeta\n");
	});

	it("rotates a full log before appending", async () => {
		const path = join(tempDir, "kernel-stderr.log");
		writeFileSync(path, "12345678");
		const log = new KernelStderrLog(path, { maxBytes: 8 });

		log.append("new");
		await log.close();

		expect(readFileSync(`${path}.old`, "utf8")).toBe("12345678");
		expect(readFileSync(path, "utf8")).toBe("new");
	});

	it("keeps only the newest bytes from a chunk larger than its budget", async () => {
		const path = join(tempDir, "kernel-stderr.log");
		const log = new KernelStderrLog(path, { maxBytes: 8 });

		log.append("0123456789");
		await log.close();

		expect(readFileSync(path, "utf8")).toBe("23456789");
		expect(existsSync(`${path}.old`)).toBe(false);
	});

	it("persists raw stderr from a Bun worker that dies during startup", async () => {
		const bun = join(tempDir, "bun");
		writeFileSync(
			bun,
			[
				"#!/bin/sh",
				'if [ "$1" = "--version" ]; then echo "1.4.0"; exit 0; fi',
				'echo "fake Bun worker died before initialization" >&2',
				"exit 42",
				"",
			].join("\n"),
		);
		chmodSync(bun, 0o755);
		const stderrLogPath = join(tempDir, "kernel-stderr.log");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new KernelManager({
			bun,
			cwd: tempDir,
			stderrLogPath,
			workerPath: join(tempDir, "worker.ts"),
		});

		try {
			await expect(manager.execute("console.log(1)")).rejects.toThrow(/Bun worker exited unexpectedly/);
		} finally {
			errorSpy.mockRestore();
			await manager.dispose();
		}

		expect(readFileSync(stderrLogPath, "utf8")).toContain("fake Bun worker died before initialization");
	});
});
