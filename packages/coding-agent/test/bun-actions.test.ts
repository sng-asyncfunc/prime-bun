import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeBunStructuredActions, validateBunStructuredActions } from "../src/core/kernel/bun-actions.js";

describe("Bun structured actions", () => {
	const temporaryDirectories: string[] = [];

	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
		);
	});

	async function temporaryDirectory(): Promise<string> {
		const directory = await mkdtemp(join(tmpdir(), "prime-bun-actions-"));
		temporaryDirectories.push(directory);
		return directory;
	}

	it("rejects an unknown operation before execution", () => {
		const result = validateBunStructuredActions([{ op: "remove", path: "README.md" }]);

		expect(result).toEqual({
			ok: false,
			message: 'Action 1 has unknown op "remove"; expected edit, read, search, shell, or write.',
		});
	});

	it.each([
		{
			name: "a read without a path",
			actions: [{ op: "read" }],
			message: 'Action 1 (read) requires a non-empty "path".',
		},
		{
			name: "a shell without a command",
			actions: [{ op: "shell", command: "  " }],
			message: 'Action 1 (shell) requires a non-empty "command".',
		},
		{
			name: "a write without content",
			actions: [{ op: "write", path: "out.md" }],
			message: 'Action 1 (write) requires string "content".',
		},
		{
			name: "an edit without old text",
			actions: [{ op: "edit", path: "out.md", newStr: "replacement" }],
			message: 'Action 1 (edit) requires non-empty string "oldStr".',
		},
		{
			name: "an edit without new text",
			actions: [{ op: "edit", path: "out.md", oldStr: "target" }],
			message: 'Action 1 (edit) requires string "newStr".',
		},
		{
			name: "a fractional offset",
			actions: [{ op: "read", path: "README.md", offset: 1.5 }],
			message: 'Action 1 (read) "offset" must be a positive integer.',
		},
		{
			name: "a zero limit",
			actions: [{ op: "read", path: "README.md", limit: 0 }],
			message: 'Action 1 (read) "limit" must be between 1 and 2000.',
		},
	])("rejects $name", ({ actions, message }) => {
		expect(validateBunStructuredActions(actions)).toEqual({ ok: false, message });
	});

	it("caps batches at eight actions", () => {
		const actions = Array.from({ length: 9 }, () => ({ op: "search", path: "." }));

		expect(validateBunStructuredActions(actions)).toEqual({
			ok: false,
			message: "Structured action batches support 1 to 8 actions; received 9.",
		});
	});

	it("allows multiple independent writes in one batch", () => {
		const result = validateBunStructuredActions([
			{ op: "write", path: "a.md", content: "a" },
			{ op: "write", path: "b.md", content: "b" },
		]);

		expect(result).toEqual({
			ok: true,
			actions: [
				{ op: "write", path: "a.md", content: "a" },
				{ op: "write", path: "b.md", content: "b" },
			],
		});
	});

	it("accepts exact structured edits without embedding them in JavaScript", () => {
		const inputInterpolation = "${" + "input}";
		const outputInterpolation = "${" + "output}";
		const oldStr = `\`\`\`ts\nconst value = \`${inputInterpolation}\`;\n\`\`\``;
		const newStr = `\`\`\`ts\nconst value = \`${outputInterpolation}\`;\n\`\`\``;
		const result = validateBunStructuredActions([
			{
				op: "edit",
				path: "README.md",
				oldStr,
				newStr,
			},
		]);

		expect(result).toEqual({
			ok: true,
			actions: [
				{
					op: "edit",
					path: "README.md",
					oldStr,
					newStr,
				},
			],
		});
	});

	it("caps structured write content at one million characters", () => {
		const result = validateBunStructuredActions([{ op: "write", path: "large.txt", content: "x".repeat(1_000_001) }]);

		expect(result).toEqual({
			ok: false,
			message: 'Action 1 (write) "content" exceeds the 1000000-character structured-write limit; use code.',
		});
	});

	it("reads a bounded numbered line window", async () => {
		const directory = await temporaryDirectory();
		const file = join(directory, "sample.txt");
		await writeFile(file, "alpha\nbeta\ngamma\ndelta\n", "utf8");

		const result = await executeBunStructuredActions([{ op: "read", path: file, offset: 2, limit: 2 }], {
			runShell: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
		});

		expect(result.output).toBe(`[1/1 read ${file} lines 2-3]\n2: beta\n3: gamma`);
		expect(result.diffs).toEqual([]);
	});

	it("reports a search miss as a normal zero-match result", async () => {
		const directory = await temporaryDirectory();
		await writeFile(join(directory, "sample.txt"), "present\n", "utf8");

		const result = await executeBunStructuredActions(
			[{ op: "search", path: directory, pattern: "definitely-absent-pattern" }],
			{ runShell: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
		);

		expect(result.output).toContain("0 matches");
		expect(result.output).not.toContain("ERROR");
	});

	it("reports an empty file listing as a normal zero-file result", async () => {
		const directory = await temporaryDirectory();

		const result = await executeBunStructuredActions([{ op: "search", path: directory }], {
			runShell: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
		});

		expect(result.output).toContain("0 files");
		expect(result.output).not.toContain("ERROR");
	});

	it("reports non-zero shell output normally and stops later actions", async () => {
		const directory = await temporaryDirectory();
		const target = join(directory, "should-not-exist.txt");

		const result = await executeBunStructuredActions(
			[
				{ op: "shell", command: "project-command" },
				{ op: "write", path: target, content: "unexpected" },
			],
			{ runShell: async () => ({ exitCode: 7, stdout: "partial output\n", stderr: "failed\n" }) },
		);

		expect(result.output).toContain("exitCode: 7");
		expect(result.output).toContain("partial output");
		expect(result.output).toContain("failed");
		expect(result.output).toContain("stopped after shell exit 7");
		await expect(readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("writes fenced Markdown byte-for-byte and returns a diff", async () => {
		const directory = await temporaryDirectory();
		const target = join(directory, "fenced.md");
		const interpolation = "${" + "value}";
		const content = [
			"# Example",
			"",
			"```ts",
			`const template = \`${interpolation}\`;`,
			"```",
			'He said "quoted".',
			"",
		].join("\n");
		await writeFile(target, "before\n", "utf8");

		const result = await executeBunStructuredActions([{ op: "write", path: target, content }], {
			runShell: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
		});

		expect(await readFile(target, "utf8")).toBe(content);
		expect(result.diffs).toEqual([{ path: target, oldStr: "before\n", newStr: content, startLine: 1 }]);
		expect(result.output).toContain(`wrote ${Buffer.byteLength(content)} bytes`);
	});

	it("edits one exact fenced block and returns a targeted diff", async () => {
		const directory = await temporaryDirectory();
		const target = join(directory, "fenced.md");
		const oldStr = "Duplicate anchor.\nChange only this second copy.";
		const newStr = "Duplicate anchor.\nSecond copy changed exactly.";
		const original = `# Fixture\n\n\`\`\`ts\nconst message = \`\${value}\`;\n\`\`\`\n\n${oldStr}\n`;
		await writeFile(target, original, "utf8");

		const result = await executeBunStructuredActions([{ op: "edit", path: target, oldStr, newStr }], {
			runShell: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
		});

		expect(await readFile(target, "utf8")).toBe(original.replace(oldStr, newStr));
		expect(result.diffs).toEqual([{ path: target, oldStr, newStr, startLine: 7 }]);
		expect(result.output).toContain(
			`replaced ${Buffer.byteLength(oldStr)} bytes with ${Buffer.byteLength(newStr)} bytes`,
		);
	});

	it("stops the batch when an exact edit target is ambiguous", async () => {
		const directory = await temporaryDirectory();
		const target = join(directory, "duplicate.txt");
		const later = join(directory, "later.txt");
		await writeFile(target, "same\nsame\n", "utf8");

		const result = await executeBunStructuredActions(
			[
				{ op: "edit", path: target, oldStr: "same", newStr: "changed" },
				{ op: "write", path: later, content: "must not run\n" },
			],
			{ runShell: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
		);

		expect(result.output).toContain("appears more than once");
		expect(result.output).toContain("batch stopped after edit failure");
		await expect(readFile(later, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("writes multiple files and returns one diff per file", async () => {
		const directory = await temporaryDirectory();
		const first = join(directory, "first.txt");
		const second = join(directory, "second.txt");

		const result = await executeBunStructuredActions(
			[
				{ op: "write", path: first, content: "first\n" },
				{ op: "write", path: second, content: "second\n" },
			],
			{ runShell: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
		);

		expect(await readFile(first, "utf8")).toBe("first\n");
		expect(await readFile(second, "utf8")).toBe("second\n");
		expect(result.diffs).toEqual([
			{ path: first, oldStr: "", newStr: "first\n", startLine: 1 },
			{ path: second, oldStr: "", newStr: "second\n", startLine: 1 },
		]);
	});

	it("creates missing parent directories for an exact write", async () => {
		const directory = await temporaryDirectory();
		const target = join(directory, "nested", "deeper", "result.txt");

		const result = await executeBunStructuredActions([{ op: "write", path: target, content: "created\n" }], {
			runShell: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
		});

		expect(await readFile(target, "utf8")).toBe("created\n");
		expect(result.diffs).toEqual([{ path: target, oldStr: "", newStr: "created\n", startLine: 1 }]);
	});

	it("omits persisted diff content for a large replacement", async () => {
		const directory = await temporaryDirectory();
		const target = join(directory, "large.txt");
		const oldContent = `OLD-${"a".repeat(40_000)}`;
		const newContent = `NEW-${"b".repeat(40_000)}`;
		await writeFile(target, oldContent, "utf8");

		const result = await executeBunStructuredActions([{ op: "write", path: target, content: newContent }], {
			runShell: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
		});

		expect(await readFile(target, "utf8")).toBe(newContent);
		expect(result.diffs).toEqual([]);
		expect(result.output).toContain("diff omitted");
		expect(result.output).toContain("replaced 40004 bytes with 40004 bytes");
	});

	it("continues independent reads after a read failure", async () => {
		const directory = await temporaryDirectory();
		const present = join(directory, "present.txt");
		await writeFile(present, "kept\n", "utf8");

		const result = await executeBunStructuredActions(
			[
				{ op: "read", path: join(directory, "missing.txt") },
				{ op: "read", path: present },
			],
			{ runShell: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
		);

		expect(result.output).toContain("ERROR: ENOENT");
		expect(result.output).toContain("1: kept");
	});

	it("bounds each action body with a head and tail marker", async () => {
		const directory = await temporaryDirectory();
		const file = join(directory, "large.txt");
		await writeFile(file, `HEAD-${"x".repeat(10_000)}-TAIL\n`, "utf8");

		const result = await executeBunStructuredActions([{ op: "read", path: file }], {
			runShell: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
		});

		expect(result.output).toContain("HEAD-");
		expect(result.output).toContain("-TAIL");
		expect(result.output).toContain("action output truncated at 8192 chars");
		expect(result.output.length).toBeLessThan(8_500);
	});

	it("bounds the whole batch while preserving every action header", async () => {
		const actions = Array.from({ length: 8 }, (_, index) => ({
			command: `probe-${index + 1}`,
			op: "shell" as const,
		}));

		const result = await executeBunStructuredActions(actions, {
			runShell: async (command) => ({
				exitCode: 0,
				stderr: "",
				stdout: `HEAD-${command}-${"x".repeat(12_000)}-TAIL-${command}`,
			}),
		});

		for (const [index, action] of actions.entries()) {
			expect(result.output).toContain(`[${index + 1}/8 shell ${action.command}]`);
		}
		expect(result.output).toContain("24 KiB call output budget");
		expect(result.output.length).toBeLessThanOrEqual(24_576);
	});
});
