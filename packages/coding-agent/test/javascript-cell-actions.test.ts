import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import {
	getJavaScriptActionsFromArgs,
	JavaScriptCellComponent,
} from "../src/modes/interactive/components/javascript-cell.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type CellState = ConstructorParameters<typeof JavaScriptCellComponent>[0];

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

const ACTIONS = [
	{ op: "read" as const, path: "README.md", offset: 3, limit: 5 },
	{ op: "read" as const, path: "package.json" },
	{
		op: "search" as const,
		path: "src",
		pattern: "KernelManager",
		glob: "*.ts",
		outputMode: "files_with_matches" as const,
	},
	{ op: "shell" as const, command: "npm run check" },
];

function actionState(overrides: Partial<CellState> = {}): CellState {
	return {
		actions: ACTIONS,
		argsComplete: true,
		code: "",
		details: { durationMs: 320, status: "ok", stdout: "first\nsecond" },
		executionStarted: true,
		expanded: false,
		showExpandHint: false,
		...overrides,
	};
}

describe("JavaScriptCellComponent structured actions", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("groups routine operations in one compact collapsed summary", () => {
		const lines = new JavaScriptCellComponent(actionState()).render(120).map(stripAnsi);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("✓ js · read×2 search shell · ↑ 4 ↓ 2 lines · 320ms");
		expect(lines[0]).not.toContain("README.md");
	});

	it("keeps the summary line stable when expanded", () => {
		const collapsed = new JavaScriptCellComponent(actionState({ expanded: false })).render(120).map(stripAnsi);
		const expanded = new JavaScriptCellComponent(actionState({ expanded: true })).render(120).map(stripAnsi);

		expect(expanded[0]).toBe(collapsed[0]);
		expect(expanded.length).toBeGreaterThan(collapsed.length);
	});

	it("renders operation targets and exact shell commands when expanded", () => {
		const output = new JavaScriptCellComponent(actionState({ expanded: true })).render(120).map(stripAnsi).join("\n");

		expect(output).toContain("› read README.md lines 3-7");
		expect(output).toContain("read package.json lines 1-200");
		expect(output).toContain('search "KernelManager" in src glob "*.ts" files only');
		expect(output).toContain("shell npm run check");
	});

	it("keeps every action row within the terminal width", () => {
		const state = actionState({
			actions: [
				{ op: "read", path: `src/${"deep-directory/".repeat(20)}file.ts` },
				{ op: "search", path: ".", pattern: "x".repeat(500) },
				{ op: "shell", command: `printf ${"argument ".repeat(100)}` },
			],
			expanded: true,
		});

		for (const width of [24, 40, 72]) {
			const lines = new JavaScriptCellComponent(state).render(width);
			expect(
				lines.every((line) => visibleWidth(line) <= width),
				`width=${width}`,
			).toBe(true);
		}
	});

	it("shows exact write content only on explicit expansion", () => {
		const content = ["# Example", "", "```ts", "const value = 42;", "```", ""].join("\n");
		const state = actionState({ actions: [{ op: "write", path: "notes.md", content }] });
		const collapsed = new JavaScriptCellComponent(state).render(100).map(stripAnsi).join("\n");
		const expanded = new JavaScriptCellComponent({ ...state, expanded: true }).render(100).map(stripAnsi).join("\n");

		expect(collapsed).toContain("write");
		expect(collapsed).not.toContain("```ts");
		expect(expanded).toContain(`write notes.md (${Buffer.byteLength(content)} bytes)`);
		expect(expanded).toContain("```ts");
		expect(expanded).toContain("const value = 42;");
	});

	it("reuses the existing diff display for completed structured writes", () => {
		const output = new JavaScriptCellComponent(
			actionState({
				actions: [{ op: "write", path: "notes.md", content: "after\n" }],
				details: {
					durationMs: 12,
					status: "ok",
					diffs: [{ path: "notes.md", oldStr: "before\n", newStr: "after\n", startLine: 1 }],
				},
				expanded: true,
			}),
		)
			.render(100)
			.map(stripAnsi)
			.join("\n");

		expect(output).toContain("notes.md");
		expect(output).toMatch(/\+1\s+-1/);
		expect(output).toContain("after");
	});

	it("renders structured edits and their completed diff", () => {
		const output = new JavaScriptCellComponent(
			actionState({
				actions: [{ op: "edit", path: "notes.md", oldStr: "before", newStr: "after" }],
				details: {
					durationMs: 12,
					status: "ok",
					diffs: [{ path: "notes.md", oldStr: "before", newStr: "after", startLine: 3 }],
				},
				expanded: true,
			}),
		)
			.render(100)
			.map(stripAnsi)
			.join("\n");

		expect(output).toContain("edit notes.md (6→5 bytes)");
		expect(output).toMatch(/\+1\s+-1/);
		expect(output).toContain("after");
	});

	it("parses recognized partial action arguments without throwing", () => {
		expect(
			getJavaScriptActionsFromArgs({
				actions: [
					{ op: "read", path: "README.md", offset: 2 },
					{ op: "search", path: "src", pattern: "KernelManager", outputMode: "files_with_matches" },
					{ op: "search", path: "src", pattern: "", outputMode: "files_with_matches" },
					{ op: "edit", path: "README.md", oldStr: "before", newStr: "after" },
					{ op: "unknown", path: "ignored" },
					"partial",
					{ op: "write", path: "notes.md" },
				],
			}),
		).toEqual([
			{ op: "read", path: "README.md", offset: 2 },
			{ op: "search", path: "src", pattern: "KernelManager", outputMode: "files_with_matches" },
			{ op: "search", path: "src" },
			{ op: "edit", path: "README.md", oldStr: "before", newStr: "after" },
			{ op: "write", path: "notes.md" },
		]);
		expect(getJavaScriptActionsFromArgs({ actions: "streaming" })).toEqual([]);
		expect(getJavaScriptActionsFromArgs(undefined)).toEqual([]);
	});
});
