import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import type { TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { KEYBINDINGS } from "../src/core/keybindings.js";
import { buildConversationComponents } from "../src/modes/interactive/components/conversation-components.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function fakeTui(): TUI {
	return { requestRender: vi.fn() } as unknown as TUI;
}

describe("v0.7.3 expansion controls", () => {
	beforeAll(() => initTheme("dark"));

	test("reserves configurable Ctrl+J for edit diffs", () => {
		expect(KEYBINDINGS["app.edits.expand"].defaultKeys).toBe("ctrl+j");
		expect(KEYBINDINGS["app.edits.expand"].defaultKeyScope).toBe("editor");
	});

	test("toggles tools, sent messages, and edit diffs independently", () => {
		const child = {
			setExpanded: vi.fn(),
			setAgentMessagesExpanded: vi.fn(),
			setEditDiffsExpanded: vi.fn(),
		};
		const fake: Record<string, unknown> & {
			toolOutputExpanded: boolean;
			agentMessagesExpanded: boolean;
			editDiffsExpanded: boolean;
		} = {
			toolOutputExpanded: false,
			agentMessagesExpanded: false,
			editDiffsExpanded: false,
			customHeader: undefined,
			builtInHeader: undefined,
			chatContainer: { children: [child] },
			ui: {
				isFullscreen: () => false,
				requestRender: vi.fn(),
				requestRenderPreservingViewport: vi.fn(),
			},
		};
		const prototype = InteractiveMode.prototype as unknown as Record<string, (this: typeof fake) => void>;
		fake.applyChatExpansion = prototype.applyChatExpansion.bind(fake);
		fake.expansionStateFor = prototype.expansionStateFor.bind(fake);

		prototype.toggleAgentMessageExpansion.call(fake);
		expect(fake.agentMessagesExpanded).toBe(true);
		expect(fake.toolOutputExpanded).toBe(false);
		expect(fake.editDiffsExpanded).toBe(false);
		expect(child.setAgentMessagesExpanded).toHaveBeenLastCalledWith(true);
		expect(child.setExpanded).toHaveBeenLastCalledWith(false);
		expect(child.setEditDiffsExpanded).toHaveBeenLastCalledWith(false);

		prototype.toggleEditDiffExpansion.call(fake);
		expect(fake.editDiffsExpanded).toBe(true);
		expect(fake.toolOutputExpanded).toBe(false);
		expect(fake.agentMessagesExpanded).toBe(true);
		expect(child.setEditDiffsExpanded).toHaveBeenLastCalledWith(true);
	});

	test("restores sent-message bodies and edit diffs when replaying history", () => {
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "javascript-v073",
					name: "javascript",
					arguments: { code: 'await edit({ path: "a.ts", oldStr: "old", newStr: "NEW" })' },
				},
			],
			api: "test",
			provider: "test",
			model: "test",
			usage,
			stopReason: "toolUse",
			timestamp: 1,
		};
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "javascript-v073",
			toolName: "javascript",
			content: [],
			details: {
				status: "ok",
				diffs: [{ path: "a.ts", oldStr: "old", newStr: "NEW", startLine: 3 }],
				sentAgentMessages: [
					{
						id: "message-v073",
						message: "Full handoff body",
						deliveryStatus: "delivered",
						receiverRole: "parent",
						target: { activeSessionId: "parent-active", sessionId: "parent", sessionName: "Parent" },
					},
				],
			},
			isError: false,
			timestamp: 2,
		};
		const components = buildConversationComponents([assistant, result], {
			ui: fakeTui(),
			cwd: process.cwd(),
			toolOptions: {},
			getToolDefinition: () => undefined,
			toolsExpanded: false,
			agentMessagesExpanded: true,
			editDiffsExpanded: true,
		});
		const tool = components.find((component) => component instanceof ToolExecutionComponent);
		expect(tool).toBeInstanceOf(ToolExecutionComponent);
		const rendered = stripAnsi(tool?.render(120).join("\n") ?? "");
		expect(rendered).toContain("╰─ Full handoff body");
		expect(rendered).toMatch(/3 - .*old/);
		expect(rendered).toMatch(/3 \+ .*NEW/);
	});
});
