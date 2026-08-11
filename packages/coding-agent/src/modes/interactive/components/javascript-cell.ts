import { isAbsolute, relative } from "node:path";
import {
	type Component,
	truncateToWidth,
	VersionedRenderCache,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { formatAgentMessageParticipant } from "../../../core/agent-messages.js";
import type { BunStructuredAction } from "../../../core/kernel/bun-actions.js";
import { previewJavaScriptCode } from "../../../core/tools/code-preview.js";
import { generateDiffString } from "../../../core/tools/edit-diff.js";
import { shortenPath } from "../../../core/tools/render-utils.js";
import { getLanguageFromPath, highlightCode, theme } from "../theme/theme.js";
import { getWorkingPulseFrame, WORKING_ICON_FRAMES, workingIconFrame } from "../theme/working-icon.js";
import { agentMessageBodyLines, agentMessagePreview, agentMessageSummaryLine } from "./agent-message.js";
import { normalizeErrorDetails, summarizeErrorDetails } from "./collapsible-error.js";
import { renderDiffSeparator, renderRichDiff } from "./diff.js";
import { keyHint } from "./keybinding-hints.js";

export interface JavaScriptCellContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

export interface JavaScriptCellState {
	code: string;
	actions?: readonly BunStructuredAction[];
	content?: readonly JavaScriptCellContentBlock[];
	details?: unknown;
	isPartial?: boolean;
	isError?: boolean;
	expanded?: boolean;
	showExpandHint?: boolean;
	executionStarted?: boolean;
	argsComplete?: boolean;
	showImages?: boolean;
	/** Session cwd — edit paths nested under it render relative, else absolute. */
	cwd?: string;
}

interface DiffDisplay {
	path: string;
	oldStr: string;
	newStr: string;
	startLine?: number;
}

interface SentAgentMessageDisplay {
	id: string;
	message: string;
	deliveryStatus: "delivered" | "queued";
	receiverRole?: "parent" | "sibling" | "child";
	target: {
		activeSessionId: string;
		sessionId: string;
		sessionName?: string;
	};
}

interface JavaScriptDetails {
	durationMs?: number;
	status?: string;
	errorEname?: string;
	stdout?: string;
	stderr?: string;
	result?: string;
	diffs?: DiffDisplay[];
	sentAgentMessages?: SentAgentMessageDisplay[];
	error?: JavaScriptErrorDetails;
}

interface JavaScriptErrorDetails {
	ename: string;
	evalue: string;
	traceback: readonly string[];
}

interface TracebackParts {
	output: string;
	traceback: string;
	preview: string;
}

// Two columns, matching the code body's "› "/"  " gutter so output aligns under it.
const OUTPUT_INDENT = "  ";

const SGR_PATTERN = /\x1b\[([0-9;]*)m/g;

/**
 * Append `ESC[0m` when `line` ends with a foreground or background color still
 * open, so a span that wrapTextWithAnsi split across lines cannot bleed into the
 * trailing padding or the next line.
 */
function closeOpenSgr(line: string): string {
	let fgOpen = false;
	let bgOpen = false;
	for (const match of line.matchAll(SGR_PATTERN)) {
		const params = match[1] === "" ? ["0"] : match[1].split(";");
		for (let i = 0; i < params.length; i++) {
			const code = Number(params[i]);
			if (code === 0) {
				fgOpen = false;
				bgOpen = false;
			} else if (code === 38 || code === 48) {
				// Skip the color data of `38;5;n` / `38;2;r;g;b` so a component (e.g. 38) isn't read as a code.
				if (code === 38) fgOpen = true;
				else bgOpen = true;
				const mode = Number(params[i + 1]);
				i += mode === 2 ? 4 : mode === 5 ? 2 : 1;
			} else if (code === 39) {
				fgOpen = false;
			} else if (code === 49) {
				bgOpen = false;
			} else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
				fgOpen = true;
			} else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
				bgOpen = true;
			}
		}
	}
	return fgOpen || bgOpen ? `${line}\x1b[0m` : line;
}

export function getJavaScriptCodeFromArgs(args: unknown): string {
	if (!args || typeof args !== "object" || !("code" in args)) {
		return "";
	}
	const code = (args as { code?: unknown }).code;
	return typeof code === "string" ? code : "";
}

const STRUCTURED_ACTION_OPERATIONS = new Set(["edit", "read", "search", "shell", "write"]);

export function getJavaScriptActionsFromArgs(args: unknown): BunStructuredAction[] {
	if (!args || typeof args !== "object" || !("actions" in args)) return [];
	const actions = (args as { actions?: unknown }).actions;
	if (!Array.isArray(actions)) return [];
	return actions.flatMap((candidate): BunStructuredAction[] => {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
		const record = candidate as Record<string, unknown>;
		if (typeof record.op !== "string" || !STRUCTURED_ACTION_OPERATIONS.has(record.op)) return [];
		const op = record.op as BunStructuredAction["op"];
		const pattern = typeof record.pattern === "string" && record.pattern !== "" ? record.pattern : undefined;
		const outputMode =
			pattern !== undefined &&
			(record.outputMode === "content" ||
				record.outputMode === "files_with_matches" ||
				record.outputMode === "count")
				? record.outputMode
				: undefined;
		return [
			{
				op,
				...(typeof record.path === "string" ? { path: record.path } : {}),
				...(typeof record.offset === "number" ? { offset: record.offset } : {}),
				...(typeof record.limit === "number" ? { limit: record.limit } : {}),
				...(pattern !== undefined ? { pattern } : {}),
				...(typeof record.glob === "string" ? { glob: record.glob } : {}),
				...(outputMode !== undefined ? { outputMode } : {}),
				...(typeof record.command === "string" ? { command: record.command } : {}),
				...(typeof record.content === "string" ? { content: record.content } : {}),
				...(typeof record.oldStr === "string" ? { oldStr: record.oldStr } : {}),
				...(typeof record.newStr === "string" ? { newStr: record.newStr } : {}),
			},
		];
	});
}

function summarizeStructuredActions(actions: readonly BunStructuredAction[]): string {
	const counts = new Map<BunStructuredAction["op"], number>();
	for (const action of actions) counts.set(action.op, (counts.get(action.op) ?? 0) + 1);
	return [...counts].map(([op, count]) => (count > 1 ? `${op}×${count}` : op)).join(" ");
}

function structuredActionIntent(action: BunStructuredAction): string {
	switch (action.op) {
		case "edit": {
			const oldBytes = action.oldStr === undefined ? undefined : Buffer.byteLength(action.oldStr);
			const newBytes = action.newStr === undefined ? undefined : Buffer.byteLength(action.newStr);
			const sizes = oldBytes === undefined || newBytes === undefined ? "" : ` (${oldBytes}→${newBytes} bytes)`;
			return `edit ${action.path ?? ""}${sizes}`;
		}
		case "read": {
			const offset = action.offset ?? 1;
			const limit = action.limit ?? 200;
			return `read ${action.path ?? ""} lines ${offset}-${offset + limit - 1}`;
		}
		case "search": {
			const scope = action.path ?? ".";
			const query = action.pattern === undefined ? "list files" : `search ${JSON.stringify(action.pattern)}`;
			const glob = action.glob === undefined ? "" : ` glob ${JSON.stringify(action.glob)}`;
			const mode =
				action.outputMode === "files_with_matches" ? " files only" : action.outputMode === "count" ? " count" : "";
			return `${query} in ${scope}${glob}${mode}`;
		}
		case "shell":
			return `shell ${action.command ?? ""}`;
		case "write": {
			const bytes = action.content === undefined ? undefined : Buffer.byteLength(action.content);
			return `write ${action.path ?? ""}${bytes === undefined ? "" : ` (${bytes} bytes)`}`;
		}
	}
}

function readDetails(details: unknown): JavaScriptDetails {
	if (!details || typeof details !== "object") {
		return {};
	}
	const record = details as Record<string, unknown>;
	const error = readErrorDetails(record.error);
	return {
		durationMs: typeof record.durationMs === "number" ? record.durationMs : undefined,
		status: typeof record.status === "string" ? record.status : undefined,
		errorEname: error?.ename ?? (typeof record.errorEname === "string" ? record.errorEname : undefined),
		stdout: typeof record.stdout === "string" ? record.stdout : undefined,
		stderr: typeof record.stderr === "string" ? record.stderr : undefined,
		result: typeof record.result === "string" ? record.result : undefined,
		diffs: readDiffDisplays(record.diffs),
		sentAgentMessages: readSentAgentMessages(record.sentAgentMessages),
		error,
	};
}

function readSentAgentMessages(value: unknown): SentAgentMessageDisplay[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const messages = value.flatMap((entry): SentAgentMessageDisplay[] => {
		if (!entry || typeof entry !== "object") {
			return [];
		}
		const record = entry as Record<string, unknown>;
		const target = record.target;
		if (!target || typeof target !== "object") {
			return [];
		}
		const targetRecord = target as Record<string, unknown>;
		if (
			typeof record.id !== "string" ||
			typeof record.message !== "string" ||
			(record.deliveryStatus !== "delivered" && record.deliveryStatus !== "queued") ||
			typeof targetRecord.activeSessionId !== "string" ||
			typeof targetRecord.sessionId !== "string"
		) {
			return [];
		}
		return [
			{
				id: record.id,
				message: record.message,
				deliveryStatus: record.deliveryStatus,
				...(record.receiverRole === "parent" || record.receiverRole === "sibling" || record.receiverRole === "child"
					? { receiverRole: record.receiverRole }
					: {}),
				target: {
					activeSessionId: targetRecord.activeSessionId,
					sessionId: targetRecord.sessionId,
					...(typeof targetRecord.sessionName === "string" ? { sessionName: targetRecord.sessionName } : {}),
				},
			},
		];
	});
	return messages.length > 0 ? messages : undefined;
}

function readDiffDisplays(value: unknown): DiffDisplay[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const diffs = value.flatMap((entry): DiffDisplay[] => {
		if (!entry || typeof entry !== "object") {
			return [];
		}
		const record = entry as Record<string, unknown>;
		if (typeof record.path !== "string" || typeof record.oldStr !== "string" || typeof record.newStr !== "string") {
			return [];
		}
		return [
			{
				path: record.path,
				oldStr: record.oldStr,
				newStr: record.newStr,
				startLine: typeof record.startLine === "number" ? record.startLine : undefined,
			},
		];
	});
	return diffs.length > 0 ? diffs : undefined;
}

/** Strip one layer of repr quotes so an `execute_result` string compares cleanly. */
function stripReprQuotes(text: string): string {
	const trimmed = text.trim();
	if (
		trimmed.length >= 2 &&
		((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"')))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

/** True when `text` is just the edit skill's "Edited <path>" confirmation for one of `diffs`. */
function isEditConfirmation(text: string | undefined, diffs: readonly DiffDisplay[]): boolean {
	if (!text) {
		return false;
	}
	const stripped = stripReprQuotes(text);
	return diffs.some((diff) => stripped === `Edited ${diff.path}`);
}

/** True only for a single Bun/JSON agent-message receipt whose first property is a known message id. */
function isAgentMessageReceipt(text: string | undefined, messages: readonly SentAgentMessageDisplay[]): boolean {
	if (!text || messages.length === 0) {
		return false;
	}
	const stripped = stripReprQuotes(text);
	const receiptId = /^\{\s*(?:id|"id"|'id')\s*:\s*(["'])([^"'\\]+)\1\s*(?:,|\})/s.exec(stripped)?.[2];
	return receiptId !== undefined && messages.some((message) => message.id === receiptId);
}

function readErrorDetails(value: unknown): JavaScriptErrorDetails | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	if (typeof record.ename !== "string") {
		return undefined;
	}
	return {
		ename: record.ename,
		evalue: typeof record.evalue === "string" ? record.evalue : "",
		traceback: Array.isArray(record.traceback)
			? record.traceback.filter((line): line is string => typeof line === "string")
			: [],
	};
}

function formatDuration(durationMs: number | undefined): string | undefined {
	if (durationMs === undefined) {
		return undefined;
	}
	if (durationMs < 1000) {
		return `${Math.round(durationMs)}ms`;
	}
	return `${(durationMs / 1000).toFixed(1)}s`;
}

function compactJavaScriptIntent(text: string): string {
	const compact = text.replace(/^await\s+/, "");
	const call = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(/.exec(compact);
	if (!call) {
		return compact;
	}

	let quote: "'" | '"' | "`" | undefined;
	let escaped = false;
	let depth = 0;
	for (let index = call[0].length; index < compact.length; index++) {
		const character = compact[index];
		if (quote) {
			if (escaped) {
				escaped = false;
			} else if (character === "\\") {
				escaped = true;
			} else if (character === quote) {
				quote = undefined;
			}
			continue;
		}

		if (character === "'" || character === '"' || character === "`") {
			quote = character;
		} else if (character === "(" || character === "[" || character === "{") {
			depth += 1;
		} else if (character === ")" || character === "]" || character === "}") {
			depth = Math.max(0, depth - 1);
		} else if (character === "," && depth === 0) {
			return `${compact.slice(0, index).trimEnd()}, …)`;
		}
	}

	return compact;
}

// Relative to the session cwd when nested under it, else the absolute path.
function displayEditPath(path: string, cwd: string | undefined): string {
	if (cwd && isAbsolute(path)) {
		const rel = relative(cwd, path);
		if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
			return rel;
		}
		return shortenPath(path);
	}
	return path;
}

function isImageBlock(block: JavaScriptCellContentBlock): boolean {
	return block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string";
}

function textFromBlocks(blocks: readonly JavaScriptCellContentBlock[] | undefined): string {
	if (!blocks) {
		return "";
	}
	return blocks
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text ?? "")
		.join("\n");
}

function splitTraceback(text: string, errorName: string | undefined): TracebackParts | undefined {
	const normalized = normalizeErrorDetails(text);
	if (!normalized.trim()) {
		return undefined;
	}

	const lines = normalized.split("\n");
	let tracebackIndex = lines.findIndex((line) => line.includes("Traceback (most recent call last):"));
	if (tracebackIndex < 0 && errorName) {
		tracebackIndex = lines.findIndex((line) => line.trim().startsWith(`${errorName}:`));
	}
	if (tracebackIndex < 0) {
		return undefined;
	}

	const output = lines.slice(0, tracebackIndex).join("\n").trimEnd();
	const traceback = lines.slice(tracebackIndex).join("\n").trim();
	const preview = summarizeErrorDetails(traceback);
	return { output, traceback, preview: preview === "Error" && errorName ? errorName : preview };
}

function formatJavaScriptErrorSummary(error: JavaScriptErrorDetails): string {
	const normalizedValue = normalizeErrorDetails(error.evalue);
	if (!normalizedValue.trim()) {
		return error.ename;
	}
	const value = summarizeErrorDetails(normalizedValue);
	if (value === "Error") {
		return error.ename;
	}
	return visibleWidth(value) <= 48 ? `${error.ename}: ${value}` : error.ename;
}

export class JavaScriptCellComponent implements Component {
	private readonly renderCache = new VersionedRenderCache();
	private state: JavaScriptCellState;
	private stateVersion = 0;

	constructor(state: JavaScriptCellState) {
		this.state = state;
	}

	update(state: JavaScriptCellState): void {
		this.state = state;
		this.stateVersion += 1;
	}

	invalidate(): void {
		this.renderCache.invalidate();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const details = readDetails(this.state.details);
		// Fold the animation frame into the cache key while running (offset within
		// a stateVersion slot so it never collides with another version).
		const frames = WORKING_ICON_FRAMES.length;
		const cacheVersion =
			this.statusKind(details) === "running"
				? this.stateVersion * frames + (getWorkingPulseFrame() % frames)
				: this.stateVersion * frames;
		const cached = this.renderCache.get(safeWidth, cacheVersion);
		if (cached) {
			return cached;
		}

		// The summary is identical whether collapsed or expanded, so toggling never
		// shifts its layout; expanding only attaches exact code and output below it.
		// Cached by state version so unrelated repaints don't re-render (flicker).
		const lines = this.collapsedLines(details, safeWidth);

		const hasCode = this.state.expanded ? this.renderCode(lines, safeWidth) : false;
		if ((details.diffs?.length ?? 0) > 0 && this.state.expanded) {
			this.renderDiffs(lines, safeWidth, details.diffs ?? [], this.marker(details));
		}
		if ((details.sentAgentMessages?.length ?? 0) > 0) {
			this.renderSentAgentMessages(lines, safeWidth, details.sentAgentMessages ?? []);
		}

		if (!this.state.expanded) {
			return this.renderCache.set(safeWidth, cacheVersion, lines);
		}

		this.renderOutput(lines, safeWidth, details, hasCode);
		return this.renderCache.set(safeWidth, cacheVersion, lines);
	}

	private collapsedLines(details: JavaScriptDetails, width: number): string[] {
		const code = this.state.code.trimEnd();
		const actions = this.state.actions ?? [];
		const hasActions = actions.length > 0;
		const preview = hasActions
			? { language: "javascript" as const, text: summarizeStructuredActions(actions) }
			: previewJavaScriptCode(code);
		const label = preview.language === "javascript" ? "js" : preview.language;
		const heading = `${this.marker(details)} ${theme.fg("muted", label)}`;
		const intent = preview.text
			? hasActions
				? theme.fg("mdCodeBlock", preview.text)
				: preview.language === "bash"
					? theme.fg("bashMode", preview.text)
					: this.highlightInputLine(compactJavaScriptIntent(preview.text))
			: !this.state.executionStarted
				? theme.fg("muted", "waiting for code")
				: undefined;
		const metadata: string[] = [];

		const counts = this.lineCounts(details);
		if (counts) {
			metadata.push(theme.fg("muted", counts));
		}

		const duration = formatDuration(details.durationMs);
		if (duration) {
			metadata.push(theme.fg("muted", duration));
		}

		const errorName = !this.state.isPartial ? (details.error?.ename ?? details.errorEname) : undefined;
		if (errorName) {
			metadata.push(theme.fg("error", errorName));
		}

		if (this.state.showExpandHint !== false) {
			metadata.push(keyHint("app.tools.expand", this.state.expanded ? "to collapse" : "to expand"));
		}

		const separator = theme.fg("dim", " · ");
		const inline = [heading, intent, ...metadata]
			.filter((part): part is string => part !== undefined)
			.join(separator);
		if (preview.language !== "javascript" || !preview.text || visibleWidth(` ${inline}`) <= width) {
			return [truncateToWidth(` ${inline}`, width, "")];
		}

		const status = [heading, ...metadata].join(separator);
		const lines = [truncateToWidth(` ${status}`, width, "")];
		this.addWrappedLimited(lines, OUTPUT_INDENT, intent ?? "", width, 2);
		return lines;
	}

	/** Status marker — color carries running/done/error; ✓/✗ once finished. */
	private marker(details: JavaScriptDetails): string {
		switch (this.statusKind(details)) {
			case "error":
				return theme.fg("error", "✗");
			case "aborted":
				return theme.fg("warning", "✗");
			case "done":
				return theme.fg("success", "✓");
			case "running":
				return theme.fg("bashMode", workingIconFrame(getWorkingPulseFrame()));
			default: // queued
				return theme.fg("muted", "◇");
		}
	}

	// `↑in ↓out lines` — the "lines" unit disambiguates from the token counts on
	// the activity line. Output is omitted for edits (the diff shows on expand).
	private lineCounts(details: JavaScriptDetails): string | undefined {
		const body = this.state.code.split(/\r?\n/);
		const input =
			(this.state.actions?.length ?? 0) > 0
				? (this.state.actions?.length ?? 0)
				: body.filter((line) => line.trim().length > 0).length;

		const hasDiffs = (details.diffs?.length ?? 0) > 0;
		const sentMessages = details.sentAgentMessages ?? [];
		const result = isAgentMessageReceipt(details.result, sentMessages) ? undefined : details.result;
		const structured = [details.stdout, details.stderr, result]
			.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
			.join("\n");
		const blocksText = textFromBlocks(this.state.content);
		const fallback = isAgentMessageReceipt(blocksText, sentMessages) ? "" : blocksText;
		const outputText = (structured || fallback).trim();
		const output = hasDiffs || !outputText ? 0 : outputText.split("\n").length;

		const segments: string[] = [];
		if (input > 0) {
			segments.push(`↑ ${input}`);
		}
		if (output > 0) {
			segments.push(`↓ ${output}`);
		}
		return segments.length > 0 ? `${segments.join(" ")} lines` : undefined;
	}

	private statusKind(details: JavaScriptDetails): "error" | "aborted" | "running" | "queued" | "done" {
		const status = details.status;
		if (this.state.isError || status === "error") {
			return "error";
		}
		if (status === "aborted") {
			return "aborted";
		}
		// Keyed off the result, not executionStarted, so calls rehydrated from a
		// past session (which never saw the live start) render done, not running.
		if (!this.state.isPartial && (status !== undefined || this.state.executionStarted || this.hasResult(details))) {
			return "done";
		}
		if (this.state.isPartial || this.state.executionStarted) {
			return "running";
		}
		return "queued";
	}

	private hasResult(details: JavaScriptDetails): boolean {
		return (
			details.stdout !== undefined ||
			details.stderr !== undefined ||
			details.result !== undefined ||
			details.error !== undefined ||
			(details.diffs?.length ?? 0) > 0 ||
			(details.sentAgentMessages?.length ?? 0) > 0 ||
			(this.state.content?.length ?? 0) > 0
		);
	}

	// Only runs when expanded — shows the full source below the fixed top line.
	private renderCode(lines: string[], width: number): boolean {
		const actions = this.state.actions ?? [];
		if (actions.length > 0) {
			this.addBlank(lines, width);
			for (const [index, action] of actions.entries()) {
				const prefix = index === 0 ? theme.fg("dim", "› ") : theme.fg("dim", "  ");
				const intent = structuredActionIntent(action);
				const renderedIntent =
					action.op === "shell" ? theme.fg("bashMode", intent) : theme.fg("mdCodeBlock", intent);
				this.addWrapped(lines, prefix, renderedIntent, width);
				if (action.op === "write" && action.content !== undefined) {
					const language = getLanguageFromPath(action.path ?? "");
					for (const contentLine of action.content.split("\n")) {
						const highlighted = highlightCode(contentLine, language)[0] ?? theme.fg("mdCodeBlock", contentLine);
						this.addWrapped(lines, theme.fg("dim", "  "), highlighted || " ", width);
					}
				}
			}
			return true;
		}
		const code = this.state.code.trimEnd();
		if (!code) {
			this.addBlank(lines, width);
			this.addWrapped(lines, OUTPUT_INDENT, theme.fg("muted", "waiting for code"), width);
			return false;
		}

		this.addBlank(lines, width);
		const rawLines = code.split("\n");
		for (const [index, rawLine] of rawLines.entries()) {
			const prefix = index === 0 ? theme.fg("dim", "› ") : theme.fg("dim", "  ");
			const highlighted = this.highlightInputLine(rawLine);
			this.addWrapped(lines, prefix, highlighted || " ", width);
		}

		return true;
	}

	private highlightInputLine(line: string): string {
		const highlighted = highlightCode(line, "typescript");
		return highlighted[0] ?? theme.fg("mdCodeBlock", line);
	}

	// Only runs when expanded — shows full output below the code, no previews.
	private renderOutput(lines: string[], width: number, details: JavaScriptDetails, hasCode: boolean): void {
		const blocks = this.state.content ?? [];
		const text = textFromBlocks(blocks);
		const imageCount = blocks.filter(isImageBlock).length;
		const hasStructuredOutput =
			details.stdout !== undefined ||
			details.stderr !== undefined ||
			details.result !== undefined ||
			details.error !== undefined;
		const traceback =
			!hasStructuredOutput && (this.state.isError || details.status === "error")
				? splitTraceback(text, details.errorEname)
				: undefined;
		let outputStarted = false;
		let renderedTextOutput = false;

		const diffs = details.diffs ?? [];
		const sentMessages = details.sentAgentMessages ?? [];

		const startOutput = (): void => {
			if (outputStarted) {
				return;
			}
			outputStarted = true;
			if (hasCode) {
				this.addBlank(lines, width);
			}
		};

		if (hasStructuredOutput) {
			if (details.stdout?.trim() && !isEditConfirmation(details.stdout, diffs)) {
				startOutput();
				renderedTextOutput = true;
				this.renderOutputText(lines, width, normalizeErrorDetails(details.stdout), "out");
			}
			if (details.stderr?.trim()) {
				startOutput();
				renderedTextOutput = true;
				this.renderOutputText(lines, width, normalizeErrorDetails(details.stderr), "err");
			}
			if (
				details.result?.trim() &&
				!isEditConfirmation(details.result, diffs) &&
				!isAgentMessageReceipt(details.result, sentMessages)
			) {
				startOutput();
				renderedTextOutput = true;
				this.renderOutputText(lines, width, normalizeErrorDetails(details.result), "out");
			}
		} else if (traceback) {
			if (traceback.output) {
				startOutput();
				renderedTextOutput = true;
				this.renderOutputText(lines, width, traceback.output, "out");
			}
		} else if (text.trim() && !isAgentMessageReceipt(text, sentMessages)) {
			startOutput();
			renderedTextOutput = true;
			this.renderOutputText(lines, width, normalizeErrorDetails(text), this.state.isError ? "err" : "out");
		}

		if (!renderedTextOutput && this.state.isPartial) {
			startOutput();
			this.addWrapped(lines, OUTPUT_INDENT, theme.fg("muted", "waiting for output..."), width);
		} else if (!renderedTextOutput && this.state.executionStarted && !this.state.argsComplete) {
			startOutput();
			this.addWrapped(lines, OUTPUT_INDENT, theme.fg("muted", "waiting for output..."), width);
		} else if (
			!renderedTextOutput &&
			!traceback &&
			!details.error &&
			diffs.length === 0 &&
			(details.sentAgentMessages?.length ?? 0) === 0 &&
			this.state.executionStarted &&
			imageCount === 0
		) {
			startOutput();
			this.addWrapped(lines, OUTPUT_INDENT, theme.fg("muted", "no output"), width);
		}

		if (details.error) {
			startOutput();
			this.renderTraceback(
				lines,
				width,
				details.error.traceback.join("\n") || formatJavaScriptErrorSummary(details.error),
			);
		} else if (traceback) {
			startOutput();
			this.renderTraceback(lines, width, traceback.traceback);
		}

		if (imageCount > 0) {
			startOutput();
			const text = this.state.showImages
				? `${imageCount} image${imageCount === 1 ? "" : "s"} rendered below`
				: `${imageCount} image${imageCount === 1 ? "" : "s"} hidden`;
			this.addWrapped(lines, OUTPUT_INDENT, theme.fg("muted", text), width);
		}
	}

	private renderSentAgentMessages(lines: string[], width: number, messages: readonly SentAgentMessageDisplay[]): void {
		for (const message of messages) {
			const label = message.deliveryStatus === "delivered" ? "Agent message sent" : "Agent message queued";
			const recipient = formatAgentMessageParticipant("sent", message.receiverRole, message.target);
			if (this.state.expanded) {
				this.addBlank(lines, width);
				this.addPlain(
					lines,
					truncateToWidth(agentMessageSummaryLine(label, recipient), Math.max(1, width - 1), "…"),
				);
				for (const bodyLine of agentMessageBodyLines(message.message, width)) {
					lines.push(bodyLine);
				}
				continue;
			}
			const prefixWidth = visibleWidth(`◆ ${label} · ${recipient} · `);
			const preview = agentMessagePreview(prefixWidth, message.message);
			this.addPlain(
				lines,
				truncateToWidth(agentMessageSummaryLine(label, recipient, preview), Math.max(1, width - 1), "…"),
			);
		}
	}

	private renderDiffs(lines: string[], width: number, diffs: readonly DiffDisplay[], marker: string): void {
		const diffsByPath = new Map<string, DiffDisplay[]>();
		for (const diff of diffs) {
			const existing = diffsByPath.get(diff.path);
			if (existing) existing.push(diff);
			else diffsByPath.set(diff.path, [diff]);
		}
		for (const [path, edits] of diffsByPath) {
			this.addPlain(lines, "");
			this.renderFileDiff(lines, width, path, edits, marker);
		}
	}

	private renderFileDiff(
		lines: string[],
		width: number,
		path: string,
		edits: readonly DiffDisplay[],
		marker: string,
	): void {
		const language = getLanguageFromPath(path);
		let added = 0;
		let removed = 0;
		const rows: string[] = [];
		edits.forEach((edit, index) => {
			const { diff: diffText } = generateDiffString(edit.oldStr, edit.newStr, 4, edit.startLine ?? 1);
			for (const row of diffText.split("\n")) {
				if (row.startsWith("+")) added++;
				else if (row.startsWith("-")) removed++;
			}
			if (index > 0) {
				rows.push(renderDiffSeparator(width));
			}
			// Append, not spread: a huge edit's diff can exceed the JS arg-count limit.
			for (const row of renderRichDiff(diffText, width, { language })) {
				rows.push(row);
			}
		});

		const counts = `${theme.fg("toolDiffAdded", `+${added}`)} ${theme.fg("toolDiffRemoved", `-${removed}`)}`;
		const displayPath = displayEditPath(path, this.state.cwd);
		// Truncate the path (not the counts) so it can't push the header past width.
		const fixed = visibleWidth(marker) + 1 + 2 + visibleWidth(counts);
		const shownPath = truncateToWidth(displayPath, Math.max(1, width - 1 - fixed), "…");
		this.addPlain(lines, `${marker} ${shownPath}  ${counts}`);

		for (const row of rows) {
			lines.push(row);
		}
	}

	private renderOutputText(lines: string[], width: number, text: string, label: "out" | "err"): void {
		const color = label === "err" ? "muted" : "toolOutput";
		for (const line of text.split("\n")) {
			this.addWrapped(lines, OUTPUT_INDENT, theme.fg(color, line || " "), width);
		}
	}

	private renderTraceback(lines: string[], width: number, traceback: string): void {
		for (const line of traceback.split("\n")) {
			this.addWrapped(lines, OUTPUT_INDENT, theme.fg("muted", line || " "), width);
		}
	}

	// Backgroundless line, indented one space to align under the fixed top line.
	private addWrapped(lines: string[], prefix: string, text: string, width: number): void {
		const available = Math.max(1, width - 1 - visibleWidth(prefix));
		const wrapped = wrapTextWithAnsi(text, available);
		for (const [index, line] of (wrapped.length > 0 ? wrapped : [""]).entries()) {
			const linePrefix = index === 0 ? prefix : " ".repeat(visibleWidth(prefix));
			// Truncate the composed line so a narrow pane can't exceed width (fatal in the renderer).
			lines.push(truncateToWidth(` ${linePrefix}${closeOpenSgr(line)}`, width, ""));
		}
	}

	private addWrappedLimited(lines: string[], prefix: string, text: string, width: number, maxLines: number): void {
		const available = Math.max(1, width - 1 - visibleWidth(prefix));
		const wrapped = wrapTextWithAnsi(text, available);
		const visibleLines = (wrapped.length > 0 ? wrapped : [""]).slice(0, maxLines);
		for (const [index, wrappedLine] of visibleLines.entries()) {
			const linePrefix = index === 0 ? prefix : " ".repeat(visibleWidth(prefix));
			const line =
				index === maxLines - 1 && wrapped.length > maxLines
					? truncateToWidth(`${wrappedLine}…`, available, "…")
					: wrappedLine;
			lines.push(truncateToWidth(` ${linePrefix}${closeOpenSgr(line)}`, width, ""));
		}
	}

	private addBlank(lines: string[], _width: number): void {
		lines.push("");
	}

	// No-background line, indented one space to align with the summary line above.
	private addPlain(lines: string[], text: string): void {
		lines.push(` ${text}`);
	}
}
