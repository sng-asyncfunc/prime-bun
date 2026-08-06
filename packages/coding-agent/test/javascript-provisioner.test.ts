import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import type { ExecuteResult, KernelManager } from "../src/core/kernel/index.js";
import { BunKernelProvisioner, createJavaScriptToolDefinition } from "../src/core/tools/javascript.js";

let tempDir = "";

function executeResult(overrides: Partial<ExecuteResult> = {}): ExecuteResult {
	return { durationMs: 2, status: "ok", stderr: "", stdout: "output", ...overrides };
}

describe("BunKernelProvisioner", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-bun-provisioner-"));
	});

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		tempDir = "";
	});

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
				result: "42",
				stderr: "warning",
			}),
		);
		const manager = { execute } as unknown as KernelManager;
		const ensure = vi.fn(async () => manager);
		const provisioner = { ensure } as unknown as BunKernelProvisioner;
		const tool = createJavaScriptToolDefinition(tempDir, { provisioner });

		const result = await tool.execute("call-1", { code: "const answer = 42; answer;" }, undefined, undefined, {
			ui: { setWorkingMessage: vi.fn() },
		} as unknown as ExtensionContext);

		expect(execute).toHaveBeenCalledWith(
			"const answer = 42; answer;",
			expect.objectContaining({ onStream: expect.any(Function), signal: undefined }),
		);
		expect(result.details).toMatchObject({
			status: "ok",
			stdout: "output",
			stderr: "warning",
			result: "42",
			diffs: [{ path: "/tmp/file.ts", startLine: 4 }],
		});
		expect(result.content).toEqual([
			{ type: "text", text: "output\nwarning\n42" },
			{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
		]);
	});
});
