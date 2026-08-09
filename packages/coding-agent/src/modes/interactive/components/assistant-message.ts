import { performance } from "node:perf_hooks";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type Component, Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import { LOGIN_RECOVERY_MESSAGE } from "../../../core/auth-guidance.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import {
	CollapsibleErrorComponent,
	normalizeErrorDetails,
	shouldCollapseErrorDetails,
	summarizeErrorDetails,
} from "./collapsible-error.js";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const LOGIN_RECOVERY_SUFFIX = `\n\n${LOGIN_RECOVERY_MESSAGE}`;
const STREAMING_RENDER_INTERVAL_MS = 50;

export interface AssistantMessageComponentOptions {
	expanded?: boolean;
	precededByToolActivity?: boolean;
}

function getThinkingMarkdownTheme(baseTheme: MarkdownTheme): MarkdownTheme {
	const quiet = (text: string) => theme.fg("thinkingText", text);
	return {
		...baseTheme,
		heading: quiet,
		link: quiet,
		linkUrl: quiet,
		code: quiet,
		codeBlock: quiet,
		codeBlockBorder: quiet,
		quote: quiet,
		quoteBorder: quiet,
		hr: quiet,
		listBullet: quiet,
		highlightCode: (code: string) => code.split("\n").map((line) => quiet(line)),
	};
}

function formatInlineLoginRecoveryMessage(message: string): string | undefined {
	const normalized = normalizeErrorDetails(message);
	if (!normalized.endsWith(LOGIN_RECOVERY_SUFFIX)) {
		return undefined;
	}
	const base = normalized.slice(0, -LOGIN_RECOVERY_SUFFIX.length).trimEnd();
	if (!base || shouldCollapseErrorDetails(base)) {
		return undefined;
	}
	return `${base} · ${LOGIN_RECOVERY_MESSAGE}`;
}

/**
 * Component that renders a complete assistant message.
 *
 * Streaming updates are admitted at a bounded cadence, then reconciled lazily
 * at render time. When the block structure is unchanged, only changed block
 * text is updated in place, preserving each Markdown child's render cache.
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private expanded = false;
	private dirty = false;
	private lastSignature?: string;
	private blockMarkdowns = new Map<number, Markdown>();
	private lastBlockTexts = new Map<number, string>();
	private precededByToolActivity: boolean;
	private lastStreamingRenderAt = Number.NEGATIVE_INFINITY;
	private streamingRenderTimer: NodeJS.Timeout | undefined;
	private requestTargetedRender?: () => void;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		options: AssistantMessageComponentOptions = {},
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.expanded = options.expanded ?? false;
		this.precededByToolActivity = options.precededByToolActivity ?? false;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		// Force a full rebuild so theme-dependent children are recreated.
		this.lastSignature = undefined;
		this.dirty = true;
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		this.dirty = true;
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		this.dirty = true;
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded !== expanded) {
			this.expanded = expanded;
			this.dirty = true;
		}
	}

	override render(width: number): string[] {
		if (this.dirty) {
			if (this.lastMessage) {
				this.reconcile(this.lastMessage);
			}
			this.dirty = false;
		}
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	updateContent(message: AssistantMessage): void {
		this.cancelStreamingRender();
		this.lastMessage = message;
		this.dirty = true;
	}

	setRenderRequester(requestRender: () => void): void {
		this.requestTargetedRender = requestRender;
	}

	/** Keep the latest snapshot, but only admit expensive transcript frames at 20 fps. */
	updateStreamingContent(message: AssistantMessage, requestRender: () => void): boolean {
		this.lastMessage = message;
		const now = performance.now();
		const elapsed = now - this.lastStreamingRenderAt;
		if (elapsed < STREAMING_RENDER_INTERVAL_MS) {
			if (!this.streamingRenderTimer) {
				this.streamingRenderTimer = setTimeout(() => {
					this.streamingRenderTimer = undefined;
					this.lastStreamingRenderAt = performance.now();
					this.dirty = true;
					(this.requestTargetedRender ?? requestRender)();
				}, STREAMING_RENDER_INTERVAL_MS - elapsed);
				this.streamingRenderTimer.unref?.();
			}
			return false;
		}
		this.cancelStreamingRender();
		this.lastStreamingRenderAt = now;
		this.dirty = true;
		if (this.requestTargetedRender) {
			this.requestTargetedRender();
			return false;
		}
		return true;
	}

	dispose(): void {
		this.cancelStreamingRender();
	}

	private cancelStreamingRender(): void {
		if (this.streamingRenderTimer) {
			clearTimeout(this.streamingRenderTimer);
			this.streamingRenderTimer = undefined;
		}
	}

	/**
	 * Everything that affects child component identity/order, but not the text
	 * inside a block. While the signature is stable, updates reduce to setText()
	 * on changed blocks; any structural change triggers a full rebuild.
	 */
	private computeSignature(message: AssistantMessage): string {
		const parts: string[] = [];
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text") {
				parts.push(`${i}:text:${content.text.trim() ? 1 : 0}`);
			} else if (content.type === "thinking") {
				parts.push(`${i}:thinking:${content.thinking.trim() ? 1 : 0}`);
			} else {
				parts.push(`${i}:${content.type}`);
			}
		}
		parts.push(
			`hide:${this.hideThinkingBlock}`,
			`label:${this.hiddenThinkingLabel}`,
			`expanded:${this.expanded}`,
			`stop:${message.stopReason ?? ""}`,
			`error:${message.errorMessage ?? ""}`,
		);
		return parts.join("|");
	}

	private reconcile(message: AssistantMessage): void {
		const signature = this.computeSignature(message);
		if (signature !== this.lastSignature) {
			this.lastSignature = signature;
			this.rebuild(message);
			return;
		}

		// Structure unchanged: update only blocks whose text changed (during
		// streaming that is just the final block).
		for (let i = 0; i < message.content.length; i++) {
			const markdown = this.blockMarkdowns.get(i);
			if (!markdown) {
				continue;
			}
			const content = message.content[i];
			const text =
				content.type === "text" ? content.text.trim() : content.type === "thinking" ? content.thinking.trim() : "";
			if (this.lastBlockTexts.get(i) !== text) {
				markdown.setText(text);
				this.lastBlockTexts.set(i, text);
			}
		}
	}

	private rebuild(message: AssistantMessage): void {
		// Clear content container
		this.contentContainer.clear();
		this.blockMarkdowns.clear();
		this.lastBlockTexts.clear();

		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render content in order
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				const markdown = new Markdown(content.text.trim(), 1, 0, this.markdownTheme);
				this.blockMarkdowns.set(i, markdown);
				this.lastBlockTexts.set(i, content.text.trim());
				this.contentContainer.addChild(markdown);
			} else if (content.type === "thinking" && content.thinking.trim()) {
				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				if (this.hideThinkingBlock) {
					// Show static thinking label when hidden
					this.contentContainer.addChild(
						new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), 1, 0),
					);
					if (hasVisibleContentAfter) {
						this.contentContainer.addChild(new Spacer(1));
					}
				} else {
					// Thinking traces keep Markdown structure but stay visually quiet.
					const markdown = new Markdown(
						content.thinking.trim(),
						1,
						0,
						getThinkingMarkdownTheme(this.markdownTheme),
						{
							color: (text: string) => theme.fg("thinkingText", text),
						},
					);
					this.blockMarkdowns.set(i, markdown);
					this.lastBlockTexts.set(i, content.thinking.trim());
					this.contentContainer.addChild(markdown);
					if (hasVisibleContentAfter) {
						this.contentContainer.addChild(new Spacer(1));
					}
				}
			}
		}

		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "aborted") {
			const abortMessage =
				message.errorMessage && message.errorMessage !== "Request was aborted"
					? message.errorMessage
					: "Operation aborted";
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(this.createErrorComponent(abortMessage));
		} else if (!hasToolCalls && message.stopReason === "error") {
			const errorMsg = message.errorMessage || "Unknown error";
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(this.createErrorComponent(errorMsg, "Error"));
		}

		if (hasToolCalls && (hasVisibleContent || message.stopReason === "aborted" || !this.precededByToolActivity)) {
			this.contentContainer.addChild(new Spacer(1));
		}
	}

	private createErrorComponent(message: string, prefix?: string): Component {
		const inlineLoginRecovery = formatInlineLoginRecoveryMessage(message);
		if (inlineLoginRecovery) {
			const text = prefix ? `${prefix}: ${inlineLoginRecovery}` : inlineLoginRecovery;
			return new Text(theme.fg("error", text), 1, 0);
		}

		if (!shouldCollapseErrorDetails(message)) {
			const text = prefix ? `${prefix}: ${message}` : message;
			return new Text(theme.fg("error", text), 1, 0);
		}

		const text = prefix ? `${prefix}: ${message}` : message;
		const summary = prefix ? `${prefix}: ${summarizeErrorDetails(message)}` : summarizeErrorDetails(message);
		return new CollapsibleErrorComponent({
			text,
			summary,
			expanded: this.expanded,
		});
	}
}
