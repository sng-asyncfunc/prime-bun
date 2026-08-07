import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { JavaScriptCellComponent } from "../src/modes/interactive/components/javascript-cell.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type CellState = ConstructorParameters<typeof JavaScriptCellComponent>[0];

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

// True when `line` ends with a foreground color still open (a leak into the padding).
function foregroundLeftOpen(line: string): boolean {
	let fg = false;
	for (const match of line.matchAll(/\x1b\[([0-9;]*)m/g)) {
		const params = match[1] === "" ? ["0"] : match[1].split(";");
		for (let i = 0; i < params.length; i++) {
			const code = Number(params[i]);
			if (code === 0 || code === 39) {
				fg = false;
			} else if (code === 38) {
				// Skip the color data of 38;5;n / 38;2;r;g;b so a component isn't read as a code.
				fg = true;
				const mode = Number(params[i + 1]);
				i += mode === 2 ? 4 : mode === 5 ? 2 : 1;
			} else if (code === 48) {
				const mode = Number(params[i + 1]);
				i += mode === 2 ? 4 : mode === 5 ? 2 : 1;
			} else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
				fg = true;
			}
		}
	}
	return fg;
}

const WRAPPING_STATE: CellState = {
	code: "const result = Array.from({ length: 50 }, (_, index) => index * 2)\nconsole.log('the first element is', result[0])",
	content: [
		{
			type: "text",
			text: "the first element of the linspace array is 0.0\nsecond line of output that is also fairly long and will wrap on a small terminal",
		},
	],
	details: {
		status: "ok",
		durationMs: 12,
		stdout:
			"the first element of the linspace array is 0.0\nsecond line of output that is also fairly long and will wrap on a small terminal",
	},
	executionStarted: true,
	argsComplete: true,
	expanded: true,
};

describe("JavaScriptCellComponent wrapping", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("never leaves a foreground color open at a wrapped line end", () => {
		for (let width = 20; width <= 60; width++) {
			const lines = new JavaScriptCellComponent(WRAPPING_STATE).render(width);
			const leaks = lines.filter(foregroundLeftOpen);
			expect(leaks, `width=${width} leaked foreground on ${leaks.length} line(s)`).toHaveLength(0);
		}
	});

	it("keeps every wrapped line within the available width", () => {
		for (const width of [20, 30, 40, 50]) {
			const lines = new JavaScriptCellComponent(WRAPPING_STATE).render(width);
			expect(
				lines.every((line) => visibleWidth(line) <= width),
				`width=${width}`,
			).toBe(true);
		}
	});

	it("renders the same after a resize as a fresh render at the target width", () => {
		const resized = new JavaScriptCellComponent(WRAPPING_STATE);
		resized.render(100);
		resized.invalidate();
		const afterResize = resized.render(34);

		const fresh = new JavaScriptCellComponent(WRAPPING_STATE).render(34);
		expect(afterResize).toEqual(fresh);
	});

	it("leaves non-wrapping (wide) output untouched", () => {
		const lines = new JavaScriptCellComponent(WRAPPING_STATE).render(100);
		expect(lines.some(foregroundLeftOpen)).toBe(false);
		expect(lines.every((line) => visibleWidth(line) <= 100)).toBe(true);
	});

	it("uses the compact js label and keeps short intent inline", () => {
		const state: CellState = {
			code: 'path.basename("/tmp/report.txt")',
			details: { status: "ok", durationMs: 4 },
			executionStarted: true,
			argsComplete: true,
			expanded: false,
			showExpandHint: false,
		};

		const lines = new JavaScriptCellComponent(state).render(100).map(stripAnsi);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain('✓ js · path.basename("/tmp/report.txt")');
		expect(lines[0]).not.toContain("javascript");
	});

	it("moves long JavaScript intent below stable status metadata", () => {
		const state: CellState = {
			code: 'await agentObserve.recentMessages("mechanics-auditor", { limit: 100, includeMetadata: true })',
			details: {
				status: "ok",
				durationMs: 39,
				stdout: Array.from({ length: 11 }, (_, index) => `message ${index + 1}`).join("\n"),
			},
			executionStarted: true,
			argsComplete: true,
			expanded: false,
			showExpandHint: false,
		};

		const lines = new JavaScriptCellComponent(state).render(80).map(stripAnsi);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("✓ js · ↑ 1 ↓ 11 lines · 39ms");
		expect(lines[0]).not.toContain("agentObserve");
		expect(lines[1]).toContain('agentObserve.recentMessages("mechanics-auditor", …)');
		expect(lines[1]).not.toContain("await ");
	});

	it("caps narrow JavaScript intent previews at two rows", () => {
		const state: CellState = {
			code: 'agentObserve.recentMessages("mechanics-auditor-with-a-much-longer-name")',
			details: { status: "ok", durationMs: 39 },
			executionStarted: true,
			argsComplete: true,
			expanded: false,
			showExpandHint: false,
		};

		const lines = new JavaScriptCellComponent(state).render(30).map(stripAnsi);
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain("✓ js");
		expect(lines.slice(1).every((line) => line.trim().length > 0)).toBe(true);
		expect(lines[2]?.trimEnd()).toMatch(/…$/);
		expect(lines[2]).not.toContain(")");
		expect(lines.every((line) => visibleWidth(line) <= 30)).toBe(true);
	});

	it("keeps expanded JavaScript source exact", () => {
		const code = 'await agentObserve.recentMessages("mechanics-auditor", { limit: 100, includeMetadata: true })';
		const state: CellState = {
			code,
			details: { status: "ok", durationMs: 39 },
			executionStarted: true,
			argsComplete: true,
			expanded: true,
			showExpandHint: false,
		};

		const lines = new JavaScriptCellComponent(state).render(160).map(stripAnsi);
		const codeLines = lines.filter((line) => line.trimStart().startsWith("› "));
		expect(codeLines).toEqual([` › ${code}`]);
		expect(codeLines[0]).not.toContain(", …)");
	});
});
