import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import type { ExecuteResult, KernelManager } from "../src/core/kernel/index.js";
import { allToolNames, createAllToolDefinitions } from "../src/core/tools/index.js";
import type { BunKernelProvisioner } from "../src/core/tools/javascript.js";
import { createEditFileToolDefinition, createWriteFileToolDefinition } from "../src/core/tools/structured-file.js";

function executeResult(overrides: Partial<ExecuteResult> = {}): ExecuteResult {
	return { durationMs: 2, status: "ok", stderr: "", stdout: "", ...overrides };
}

describe("structured file tools", () => {
	let tempDir = "";

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-bun-file-tools-"));
	});

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { force: true, recursive: true });
	});

	it("registers the safe file tools beside javascript", () => {
		expect([...allToolNames]).toEqual(["javascript", "write_file", "edit_file"]);
		expect(Object.keys(createAllToolDefinitions(tempDir))).toEqual(["javascript", "write_file", "edit_file"]);
	});

	it("passes authored Markdown byte-exactly through the write action", async () => {
		const interpolation = "${" + "value}";
		const content = [
			"# Report",
			"```ts",
			`const interpolation = '${interpolation}';`,
			"```",
			"| Owner's role | **R** |",
			"Unicode: λ 🦊",
		].join("\n");
		const target = join(tempDir, "nested", "report.md");
		const executeActions = vi
			.fn<KernelManager["executeActions"]>()
			.mockResolvedValue(executeResult({ stdout: `[1/1 write ${target}]\nwrote 120 bytes` }));
		const manager = {
			executeActions,
			status: { diagnostics: "", recovery: { available: false, checkpoint: "clean" }, state: "running" },
		} as unknown as KernelManager;
		const provisioner = { ensure: vi.fn(async () => manager) } as unknown as BunKernelProvisioner;
		const tool = createWriteFileToolDefinition(tempDir, { provisioner });

		const result = await tool.execute(
			"write-1",
			{ path: target, content },
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(executeActions).toHaveBeenCalledWith(
			[{ op: "write", path: target, content }],
			expect.objectContaining({ onStream: expect.any(Function), signal: undefined }),
		);
		expect(result).toMatchObject({ details: { status: "ok" }, isError: false });
	});

	it("passes exact edit strings outside JavaScript syntax", async () => {
		const target = join(tempDir, "report.md");
		const oldStr = "| Owner | Pending |";
		const literal = "${" + "literal}";
		const newStr = `| Owner's role | \`${literal}\` |`;
		const executeActions = vi
			.fn<KernelManager["executeActions"]>()
			.mockResolvedValue(executeResult({ stdout: `[1/1 edit ${target}]\nreplaced 19 bytes with 31 bytes` }));
		const manager = {
			executeActions,
			status: { diagnostics: "", recovery: { available: false, checkpoint: "clean" }, state: "running" },
		} as unknown as KernelManager;
		const provisioner = { ensure: vi.fn(async () => manager) } as unknown as BunKernelProvisioner;
		const tool = createEditFileToolDefinition(tempDir, { provisioner });

		const result = await tool.execute(
			"edit-1",
			{ path: target, oldStr, newStr },
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(executeActions).toHaveBeenCalledWith(
			[{ op: "edit", path: target, oldStr, newStr }],
			expect.objectContaining({ onStream: expect.any(Function), signal: undefined }),
		);
		expect(result).toMatchObject({ details: { status: "ok" }, isError: false });
	});
});
