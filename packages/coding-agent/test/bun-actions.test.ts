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
			message: 'Action 1 has unknown op "remove"; expected read, search, shell, or write.',
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

	it("allows at most one write per batch", () => {
		const result = validateBunStructuredActions([
			{ op: "write", path: "a.md", content: "a" },
			{ op: "write", path: "b.md", content: "b" },
		]);

		expect(result).toEqual({
			ok: false,
			message: "Structured action batches support at most one write; received 2.",
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
});
