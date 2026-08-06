import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KernelManager } from "../src/core/kernel/index.js";

let tempDir = "";

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
				'if [ "$1" = "--version" ]; then echo "1.3.14"; exit 0; fi',
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
});
