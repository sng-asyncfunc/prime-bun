import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ToolExecutionComponent } from "../../../src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "../harness.js";

const javaScriptTool: AgentTool = {
	name: "javascript",
	label: "Bun",
	description: "Execute a test Bun cell",
	parameters: Type.Object({ code: Type.String() }),
	execute: async () => ({
		content: [{ type: "text", text: "" }],
		details: { status: "ok" },
	}),
};

describe("ENG-4529 leading newline before a Bun Shell call", () => {
	let harness: Harness | undefined;

	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("renders a generated Bun Shell call with a leading newline as bash", async () => {
		const code = "\nawait $`cd /tmp && pwd`";
		harness = await createHarness({ tools: [javaScriptTool] });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("javascript", { code }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run the command");

		const start = harness.eventsOfType("tool_execution_start")[0];
		expect(start).toMatchObject({ toolName: "javascript", args: { code } });
		if (!start) throw new Error("Expected a JavaScript tool call");

		const component = new ToolExecutionComponent(
			start.toolName,
			start.toolCallId,
			start.args,
			{},
			undefined,
			{ requestRender: vi.fn() } as unknown as TUI,
			harness.tempDir,
		);
		component.markExecutionStarted();
		component.setArgsComplete();
		component.updateResult({ content: [], details: { status: "ok" }, isError: false });

		const rendered = stripAnsi(component.render(100).join("\n"));
		expect(rendered).toContain("✓ bash · cd /tmp && pwd · ↑ 1 lines");
		expect(rendered).not.toContain("✓ javascript");
	});
});
