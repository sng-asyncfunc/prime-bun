import { describe, expect, it } from "vitest";
import { createJavaScriptTool, createJavaScriptToolDefinition } from "../src/core/tools/javascript.js";

describe("JavaScript tool compatibility aliases", () => {
	it("maps safe legacy tool calls onto one bounded structured action", () => {
		const aliases = createJavaScriptToolDefinition(process.cwd()).compatibilityAliases;
		expect(aliases).toBeDefined();
		if (!aliases) return;

		expect(aliases.shell?.({ command: "pwd" })).toEqual({ actions: [{ op: "shell", command: "pwd" }] });
		expect(aliases.bash?.({ cmd: "git status --short" })).toEqual({
			actions: [{ op: "shell", command: "git status --short" }],
		});
		expect(aliases.read?.({ path: "README.md", offset: 2, limit: 10 })).toEqual({
			actions: [{ op: "read", path: "README.md", offset: 2, limit: 10 }],
		});
		expect(aliases.read_file?.({ file_path: "package.json" })).toEqual({
			actions: [{ op: "read", path: "package.json" }],
		});
		expect(aliases.search?.({ query: "needle", path: "src", glob: "*.ts" })).toEqual({
			actions: [{ op: "search", pattern: "needle", path: "src", glob: "*.ts" }],
		});
		expect(aliases.grep?.({ pattern: "needle" })).toEqual({
			actions: [{ op: "search", pattern: "needle" }],
		});
		expect(aliases.write?.({ path: "out.md", content: "```ts\n42\n```\n" })).toEqual({
			actions: [{ op: "write", path: "out.md", content: "```ts\n42\n```\n" }],
		});
		expect(aliases.write_file?.({ file_path: "out.txt", content: "exact\n" })).toEqual({
			actions: [{ op: "write", path: "out.txt", content: "exact\n" }],
		});
		expect(aliases.edit?.({ file_path: "README.md", old_string: "before", new_string: "```ts\nafter\n```" })).toEqual(
			{
				actions: [{ op: "edit", path: "README.md", oldStr: "before", newStr: "```ts\nafter\n```" }],
			},
		);
	});

	it("rejects ambiguous alias shapes", () => {
		const aliases = createJavaScriptToolDefinition(process.cwd()).compatibilityAliases;
		expect(aliases?.shell?.({ command: "" })).toBeUndefined();
		expect(aliases?.read?.({})).toBeUndefined();
		expect(aliases?.search?.({ query: 42 })).toBeUndefined();
		expect(aliases?.write?.({ path: "out", content: 42 })).toBeUndefined();
		expect(aliases?.edit?.({ path: "out", oldStr: "same", old_string: "different", newStr: "next" })).toBeUndefined();
	});

	it("preserves aliases when wrapping a tool definition for the agent runtime", () => {
		const tool = createJavaScriptTool(process.cwd());
		expect(tool.compatibilityAliases?.shell?.({ command: "pwd" })).toEqual({
			actions: [{ op: "shell", command: "pwd" }],
		});
	});

	it("infers unambiguous structured action ops before schema validation", () => {
		const prepare = createJavaScriptToolDefinition(process.cwd()).prepareArguments;
		expect(prepare).toBeDefined();
		if (!prepare) return;

		expect(
			prepare({
				actions: [
					{ path: "README.md", limit: 20 },
					{ command: "pwd" },
					{ path: "README.md", oldStr: "before", newStr: "after" },
					{ path: "out.md", content: "```ts\n42\n```\n" },
					{ path: "src", pattern: "TODO" },
				],
			}),
		).toEqual({
			actions: [
				{ op: "read", path: "README.md", limit: 20 },
				{ op: "shell", command: "pwd" },
				{ op: "edit", path: "README.md", oldStr: "before", newStr: "after" },
				{ op: "write", path: "out.md", content: "```ts\n42\n```\n" },
				{ op: "search", path: "src", pattern: "TODO" },
			],
		});
	});

	it("does not guess between conflicting action shapes", () => {
		const prepare = createJavaScriptToolDefinition(process.cwd()).prepareArguments;
		if (!prepare) return;
		const input = { actions: [{ path: "out.md", command: "pwd", content: "text" }] };

		expect(prepare(input)).toEqual(input);
	});
});
