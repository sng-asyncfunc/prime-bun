import { performance } from "node:perf_hooks";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { AssistantMessageComponent, thinkingRecap } from "../src/modes/interactive/components/assistant-message.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("AssistantMessageComponent", () => {
	test("adds OSC 133 zone markers to assistant messages without tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(createAssistantMessage([{ type: "text", text: "hello" }]));
		const lines = component.render(40);

		expect(lines).not.toHaveLength(0);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[lines.length - 1].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
	});

	test("does not add OSC 133 zone markers when assistant message contains tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "calling tool" },
				{
					type: "toolCall",
					id: "tool-1",
					name: "javascript",
					arguments: { code: 'await Bun.file("file.txt").text()' },
				},
			]),
		);
		const rendered = component.render(60).join("\n");

		expect(rendered.includes(OSC133_ZONE_START)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_END)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_FINAL)).toBe(false);
	});

	test("renders an abort status for messages with tool calls", () => {
		initTheme("dark");

		const message = {
			...createAssistantMessage([
				{ type: "toolCall" as const, id: "tool-1", name: "javascript", arguments: { code: "while True: pass" } },
			]),
			stopReason: "aborted" as const,
			errorMessage: "Operation aborted",
		};
		const rendered = stripAnsi(new AssistantMessageComponent(message).render(80).join("\n"));

		expect(rendered).toContain("Operation aborted");
	});

	test("honors initial expansion for multiline assistant errors", () => {
		initTheme("dark");

		const message = {
			...createAssistantMessage([]),
			stopReason: "error" as const,
			errorMessage: [
				"Provider request failed",
				"Traceback (most recent call last):",
				'  File "/tmp/internal.py", line 12, in run',
				"RuntimeError: backend crashed",
			].join("\n"),
		};
		const component = new AssistantMessageComponent(message, false, undefined, "Thinking...", { expanded: true });
		const rendered = stripAnsi(component.render(100).join("\n"));

		expect(rendered).toContain("/tmp/internal.py");
		expect(rendered).not.toContain("Ctrl+O to expand");
	});

	test("renders auth recovery guidance inline for simple provider errors", () => {
		initTheme("dark");

		const message = {
			...createAssistantMessage([]),
			stopReason: "error" as const,
			errorMessage: "401 status code (no body)\n\nRun /login to update credentials.",
		};
		const component = new AssistantMessageComponent(message);
		const raw = component.render(120).join("\n");
		const rendered = stripAnsi(raw);

		expect(rendered).toContain("Error: 401 status code (no body) · Run /login to update credentials.");
		expect(rendered).not.toContain("Ctrl+O to expand");
		expect(raw).toContain(theme.getFgAnsi("error"));
	});

	test("renders collapsed multiline assistant errors as errors", () => {
		initTheme("dark");

		const message = {
			...createAssistantMessage([]),
			stopReason: "error" as const,
			errorMessage: [
				"Provider request failed",
				"Traceback (most recent call last):",
				'  File "/tmp/internal.py", line 12, in run',
				"RuntimeError: backend crashed",
			].join("\n"),
		};
		const component = new AssistantMessageComponent(message);
		const raw = component.render(100).join("\n");
		const rendered = stripAnsi(raw);

		expect(rendered).toContain("Error: Provider request failed");
		expect(rendered).toContain("to expand");
		expect(raw).toContain(theme.getFgAnsi("error"));
	});
});

describe("AssistantMessageComponent streaming identity", () => {
	// updateContent applied incrementally (as during daemon streaming) must render
	// byte-identical to a fresh component built from the final message. Guards the
	// reconcile-instead-of-rebuild optimization.
	function expectIdentity(component: AssistantMessageComponent, message: AssistantMessage, width = 90) {
		const incremental = component.render(width);
		const fresh = new AssistantMessageComponent(message).render(width);
		expect(incremental).toEqual(fresh);
	}

	test("growing text block renders identically", () => {
		initTheme("dark");
		const corpus =
			"## Heading\n\nSome paragraph text that wraps.\n\n- one\n- two\n\n```js\nconst a = 1;\n```\n\nEnd.";
		const component = new AssistantMessageComponent();
		let text = "";
		for (let offset = 0; offset < corpus.length; offset += 5) {
			text += corpus.slice(offset, offset + 5);
			const message = createAssistantMessage([{ type: "text", text }]);
			component.updateContent(message);
			expectIdentity(component, message);
		}
	});

	test("renders the latest skipped update at the trailing edge", () => {
		vi.useFakeTimers();
		const now = vi.spyOn(performance, "now").mockReturnValue(0);
		try {
			initTheme("dark");
			const component = new AssistantMessageComponent();
			const requestRender = vi.fn();
			const first = createAssistantMessage([{ type: "text", text: "first" }]);
			const latest = createAssistantMessage([{ type: "text", text: "latest" }]);

			expect(component.updateStreamingContent(first, requestRender)).toBe(true);
			expect(stripAnsi(component.render(90).join("\n"))).toContain("first");

			now.mockReturnValue(10);
			expect(component.updateStreamingContent(latest, requestRender)).toBe(false);
			const cached = stripAnsi(component.render(90).join("\n"));
			expect(cached).toContain("first");
			expect(cached).not.toContain("latest");

			vi.advanceTimersByTime(39);
			expect(requestRender).not.toHaveBeenCalled();
			now.mockReturnValue(50);
			vi.advanceTimersByTime(1);
			expect(requestRender).toHaveBeenCalledOnce();
			expect(stripAnsi(component.render(90).join("\n"))).toContain("latest");
		} finally {
			now.mockRestore();
			vi.useRealTimers();
		}
	});

	test("uses a bound targeted renderer for streaming frames", () => {
		vi.useFakeTimers();
		const now = vi.spyOn(performance, "now").mockReturnValue(0);
		try {
			initTheme("dark");
			const component = new AssistantMessageComponent();
			const requestTargetedRender = vi.fn();
			const requestFullRender = vi.fn();
			component.setRenderRequester(requestTargetedRender);

			const first = createAssistantMessage([{ type: "text", text: "first" }]);
			expect(component.updateStreamingContent(first, requestFullRender)).toBe(false);
			expect(requestTargetedRender).toHaveBeenCalledOnce();
			expect(requestFullRender).not.toHaveBeenCalled();
			component.render(90);

			now.mockReturnValue(10);
			const latest = createAssistantMessage([{ type: "text", text: "latest" }]);
			expect(component.updateStreamingContent(latest, requestFullRender)).toBe(false);
			now.mockReturnValue(50);
			vi.advanceTimersByTime(40);

			expect(requestTargetedRender).toHaveBeenCalledTimes(2);
			expect(requestFullRender).not.toHaveBeenCalled();
		} finally {
			now.mockRestore();
			vi.useRealTimers();
		}
	});

	test("cancels a trailing render when an immediate update finalizes the message", () => {
		vi.useFakeTimers();
		const now = vi.spyOn(performance, "now").mockReturnValue(0);
		try {
			initTheme("dark");
			const component = new AssistantMessageComponent();
			const requestRender = vi.fn();
			component.updateStreamingContent(createAssistantMessage([{ type: "text", text: "first" }]), requestRender);
			component.render(90);

			now.mockReturnValue(10);
			component.updateStreamingContent(createAssistantMessage([{ type: "text", text: "pending" }]), requestRender);
			component.updateContent(createAssistantMessage([{ type: "text", text: "final" }]));

			now.mockReturnValue(50);
			vi.advanceTimersByTime(40);
			expect(requestRender).not.toHaveBeenCalled();
			expect(stripAnsi(component.render(90).join("\n"))).toContain("final");
		} finally {
			now.mockRestore();
			vi.useRealTimers();
		}
	});

	test("thinking then text then tool call renders identically", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent();
		const steps: AssistantMessage["content"][] = [
			[{ type: "thinking", thinking: "Let me think" }],
			[{ type: "thinking", thinking: "Let me think about this more carefully." }],
			[
				{ type: "thinking", thinking: "Let me think about this more carefully." },
				{ type: "text", text: "Here is" },
			],
			[
				{ type: "thinking", thinking: "Let me think about this more carefully." },
				{ type: "text", text: "Here is the answer with **bold** text." },
			],
			[
				{ type: "thinking", thinking: "Let me think about this more carefully." },
				{ type: "text", text: "Here is the answer with **bold** text." },
				{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
			],
		];
		for (const content of steps) {
			const message = createAssistantMessage(content);
			component.updateContent(message);
			expectIdentity(component, message);
		}
	});

	test("aborted and error stop reasons render identically after streaming", () => {
		initTheme("dark");
		for (const final of [
			{ stopReason: "aborted" as const, errorMessage: undefined },
			{ stopReason: "error" as const, errorMessage: "Provider exploded" },
		]) {
			const component = new AssistantMessageComponent();
			component.updateContent(createAssistantMessage([{ type: "text", text: "Partial out" }]));
			component.render(90);
			const message = {
				...createAssistantMessage([{ type: "text", text: "Partial output" }]),
				...final,
			};
			component.updateContent(message);
			const incremental = component.render(90);
			const fresh = new AssistantMessageComponent(message).render(90);
			expect(incremental).toEqual(fresh);
		}
	});

	test("collapsed thinking shows a recap and a configurable expansion hint", () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());

		const thinking = [
			"**Weighing options**",
			"",
			"Some detail about the options.",
			"",
			"**Deciding the approach**",
			"",
			"More detail.",
		].join("\n");
		const message = createAssistantMessage([
			{ type: "thinking", thinking },
			{ type: "text", text: "Answer." },
		]);
		const rendered = stripAnsi(new AssistantMessageComponent(message, true).render(120).join("\n"));

		expect(rendered).toContain("Thinking... · Deciding the approach (Ctrl+T to expand)");
		expect(rendered).not.toContain("Some detail");

		const expanded = stripAnsi(new AssistantMessageComponent(message, false).render(120).join("\n"));
		expect(expanded).toContain("Thinking... (Ctrl+T to collapse)");
		expect(expanded).toContain("Some detail about the options.");
		expect(thinkingRecap("   \n\t\n", "Thinking...")).toBe("Thinking...");
	});

	test("recap text with delimiters cannot mask structural changes", () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());

		const component = new AssistantMessageComponent(undefined, true);
		component.updateContent(createAssistantMessage([{ type: "thinking", thinking: "X|1:text:1" }]));
		component.render(120);

		component.updateContent(
			createAssistantMessage([
				{ type: "thinking", thinking: "X" },
				{ type: "text", text: "Visible answer." },
			]),
		);
		const rendered = stripAnsi(component.render(120).join("\n"));

		expect(rendered).toContain("Visible answer.");
	});

	test("collapsed thinking row truncates instead of wrapping on narrow widths", () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());

		const thinking = `**${"A deliberately verbose reasoning summary header that keeps going ".repeat(3).trim()}**`;
		const message = createAssistantMessage([{ type: "thinking", thinking }]);
		const lines = new AssistantMessageComponent(message, true)
			.render(60)
			.map((line) => stripAnsi(line))
			.filter((line) => line.trim().length > 0);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("Thinking...");
		expect(lines[0]).toContain("to expand");
	});

	test("setHideThinkingBlock and setExpanded mid-stream render identically", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent();
		const content: AssistantMessage["content"] = [
			{ type: "thinking", thinking: "Deep thoughts here." },
			{ type: "text", text: "Visible answer." },
		];
		const message = createAssistantMessage(content);
		component.updateContent(message);
		component.render(90);

		component.setHideThinkingBlock(true);
		const hidden = component.render(90);
		const freshHidden = new AssistantMessageComponent(message, true).render(90);
		expect(hidden).toEqual(freshHidden);

		component.setHideThinkingBlock(false);
		const shown = component.render(90);
		const freshShown = new AssistantMessageComponent(message, false).render(90);
		expect(shown).toEqual(freshShown);
	});

	test("width change mid-stream renders identically", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent();
		const corpus = "A paragraph long enough to wrap at narrow widths with **style** and `code`.";
		let text = "";
		const widths = [40, 90, 60];
		for (let offset = 0, i = 0; offset < corpus.length; offset += 8, i++) {
			text += corpus.slice(offset, offset + 8);
			const message = createAssistantMessage([{ type: "text", text }]);
			component.updateContent(message);
			expectIdentity(component, message, widths[i % widths.length]);
		}
	});
});
