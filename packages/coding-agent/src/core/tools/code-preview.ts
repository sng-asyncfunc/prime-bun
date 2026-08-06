const DESCRIPTOR_MAX_WIDTH = 64;
const COMMENT_LINE_PATTERN = /^\s*(?:#|\/\/)/;
const CD_PREFIX_PATTERN = /^\s*cd\s+([^&;|]+)(?:&&|;)\s*/;
const BASH_SET_PATTERN = /^\s*set\s+[-+][A-Za-z]*(?:\s+[-+]?\w+)*(?:\s+pipefail)?\s*$/;
const BASH_SETUP_PATTERN = /^(?:export\s+\w+=|source\s+\S+|\.\s+\S+)/;
const HEREDOC_PATTERN = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/;
const JAVASCRIPT_IMPORT_PATTERN = /^\s*import\s+/;
const JAVASCRIPT_DEFINITION_PATTERN =
	/^\s*(?:export\s+)?(?:async\s+)?(?:function|class)\s+|^\s*(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\(/;
const JAVASCRIPT_CONTROL_PATTERN = /^\s*(?:if|else|for|while|switch|try|catch|finally)\b/;
const JAVASCRIPT_CALL_PATTERN = /^\s*(?:await\s+)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\(/;
const JAVASCRIPT_LOW_SIGNAL_CALL_PATTERN =
	/^\s*(?:await\s+)?(?:console\.(?:log|error|warn)|JSON\.(?:parse|stringify)|String|Number|Boolean|Array|Object)\s*\(/;
const JAVASCRIPT_ASSIGNMENT_CALL_PATTERN =
	/^\s*(?:const|let|var)\s+[A-Za-z_$][\w$]*(?:\s*:\s*[^=]+)?\s*=\s*(?:await\s+)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\(/;
const JAVASCRIPT_EFFECT_CALL_PATTERN =
	/^\s*(?:await\s+)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.(?:write|writeFile|mkdir|rm|unlink|rename|append|push|set|add|delete|close|commit|execute|run)\s*\(/;
const JAVASCRIPT_SHELL_TEMPLATE_PATTERN = /^\s*(?:await\s+)?\$`([\s\S]*)`\s*;?$/;
const JAVASCRIPT_SH_CALL_PATTERN = /^\s*(?:await\s+)?sh\(\s*["'`]([^"'`]+)["'`]/;

export type CodePreviewLanguage = "bash" | "javascript";

export interface CodePreview {
	language: CodePreviewLanguage;
	text: string;
}

interface PreviewCandidate {
	language: CodePreviewLanguage;
	text: string;
	score: number;
}

function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncateDescriptor(text: string): string {
	return text.length <= DESCRIPTOR_MAX_WIDTH ? text : `${text.slice(0, DESCRIPTOR_MAX_WIDTH - 1).trimEnd()}…`;
}

function redactNoise(text: string): string {
	return text
		.replace(/[A-Za-z0-9+/]{80,}={0,2}/g, "<blob>")
		.replace(/\b((?=\w*(?:token|key|secret|password))[A-Za-z_]\w*)\s*[:=]\s*(["'])[^"']*\2/gi, "$1=<redacted>")
		.replace(
			/\b((?=\w*(?:token|key|secret|password))[A-Za-z_]\w*)\s*[:=]\s*(?!<redacted>)(?!["'])\S+/gi,
			"$1=<redacted>",
		)
		.replace(/(["'])sk-[^"']+\1/g, "$1<redacted>$1")
		.replace(/(["']).{160,}\1/g, "$1…$1");
}

function descriptor(text: string): string {
	return truncateDescriptor(collapseWhitespace(redactNoise(text)));
}

function isSkippableBashLine(line: string): boolean {
	const trimmed = line.trim();
	return (
		!trimmed ||
		COMMENT_LINE_PATTERN.test(trimmed) ||
		BASH_SET_PATTERN.test(trimmed) ||
		BASH_SETUP_PATTERN.test(trimmed)
	);
}

function shellWords(line: string): string[] {
	const words: string[] = [];
	for (const match of line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
		words.push(match[1] ?? match[2] ?? match[3] ?? "");
	}
	return words;
}

function pathTail(path: string): string {
	return path.replace(/^\.\//, "");
}

function simplifyRunnerCommand(line: string): string | undefined {
	const words = shellWords(line);
	const joined = words.join(" ");
	const vitestIndex = words.findIndex((word) => /(?:^|\/)vitest\/dist\/cli\.js$/.test(word));
	if (words[0] === "npx" && words[1] === "tsx" && vitestIndex >= 2) {
		return `vitest ${words.slice(vitestIndex + 1).join(" ")}`.trim();
	}
	if (words[0] === "npm") {
		const prefixIndex = words.indexOf("--prefix");
		const cwd = prefixIndex >= 0 ? words[prefixIndex + 1] : undefined;
		const runIndex = words.indexOf("run");
		if (runIndex >= 0 && words[runIndex + 1]) {
			const command = `npm ${words[runIndex + 1]} ${words.slice(runIndex + 2).join(" ")}`.trim();
			return cwd ? `${command} (${pathTail(cwd)})` : command;
		}
	}
	if (words[0] === "pnpm" || words[0] === "bun") {
		const cwdIndex = words.findIndex((word) => word === "-C" || word === "--cwd" || word === "--dir");
		const cwd = cwdIndex >= 0 ? words[cwdIndex + 1] : undefined;
		const rest = words.filter((_, index) => index !== cwdIndex && index !== cwdIndex + 1);
		return cwd ? `${rest.join(" ")} (${pathTail(cwd)})` : undefined;
	}
	if (joined.includes("node_modules/.bin/")) return joined.replace(/\S*node_modules\/\.bin\//g, "");
	return undefined;
}

function simplifyMutationCommand(line: string): string | undefined {
	const words = shellWords(line);
	if (words.length === 0) return undefined;
	if (words[0] === "cat" && words[1] === ">" && words[2]) return `write ${pathTail(words[2])}`;
	if (words[0] === "tee" && words.at(-1)) {
		return `${words.includes("-a") ? "append" : "write"} ${pathTail(words.at(-1) ?? "")}`;
	}
	if (words[0] === "apply_patch") return "apply patch";
	if (["rm", "mv", "cp", "git", "npm", "bun"].includes(words[0] ?? "")) return line;
	if (
		(words[0] === "sed" && words.some((word) => word.startsWith("-i"))) ||
		(words[0] === "perl" && words.includes("-pi"))
	) {
		return line;
	}
	return undefined;
}

function simplifyBashCommandLine(line: string): string {
	return simplifyRunnerCommand(line) ?? simplifyMutationCommand(line) ?? line;
}

function splitCommandChain(line: string): string[] {
	return line
		.split(/\s*(?:&&|;)\s*/)
		.map((part) => part.trim())
		.filter(Boolean);
}

function heredocBody(lines: readonly string[], startIndex: number, delimiter: string): string | undefined {
	const body: string[] = [];
	for (let index = startIndex + 1; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (line.trim() === delimiter) return body.join("\n");
		body.push(line);
	}
	return body.length > 0 ? body.join("\n") : undefined;
}

function previewHeredoc(lines: readonly string[]): CodePreview | undefined {
	let fallback: CodePreview | undefined;
	for (let index = 0; index < lines.length; index += 1) {
		const line = (lines[index] ?? "").trim().replace(CD_PREFIX_PATTERN, "").trim();
		if (isSkippableBashLine(line)) continue;
		const delimiter = line.match(HEREDOC_PATTERN)?.[1];
		if (!delimiter) continue;
		const body = heredocBody(lines, index, delimiter);
		if (!body) continue;
		if (/\b(?:bun|node)\b/.test(line)) return previewJavaScriptCode(body);
		if (/(?<![\w.])(?:bash|sh)\b/.test(line)) return previewBashCommand(body);
		const catWrite = line.match(/\b(?:cat|tee)\b.*(?:>|\s)(\S+)\s*<<-?/);
		if (catWrite?.[1]) {
			return { language: "bash", text: `${line.includes("tee -a") ? "append" : "write"} ${pathTail(catWrite[1])}` };
		}
		if (/\bapply_patch\b/.test(line)) return { language: "bash", text: "apply patch" };
		fallback ??= { language: "bash", text: descriptor(body) };
	}
	return fallback;
}

function bashLineScore(line: string, index: number): number {
	const simplified = simplifyBashCommandLine(line);
	const words = shellWords(line);
	let score = 30;
	if (simplified !== line) score += 40;
	if (["rm", "mv", "cp", "git", "npm", "pnpm", "bun", "vitest"].includes(words[0] ?? "")) score += 20;
	if (
		/\b(?:rm|mv|cp|git\s+(?:add|commit)|npm\s+install|bun\s+add|sed\s+-i|perl\s+-pi|tee|cat\s*>|apply_patch)\b/.test(
			line,
		)
	)
		score += 40;
	return score + index;
}

export function previewBashCommand(command: string): CodePreview {
	const lines = command.split("\n");
	const heredoc = previewHeredoc(lines);
	if (heredoc?.text) return { language: heredoc.language, text: descriptor(heredoc.text) };
	let best: PreviewCandidate | undefined;
	let index = 0;
	for (const rawLine of lines) {
		for (const part of splitCommandChain(rawLine)) {
			const line = part.trim().replace(CD_PREFIX_PATTERN, "").trim();
			if (!line || isSkippableBashLine(line)) continue;
			const candidate = {
				language: "bash" as const,
				text: simplifyBashCommandLine(line),
				score: bashLineScore(line, index),
			};
			if (!best || candidate.score > best.score) best = candidate;
			index += 1;
		}
	}
	return { language: "bash", text: best ? descriptor(best.text) : "" };
}

function shellCommandFromJavaScript(line: string): string | undefined {
	const template = line.match(JAVASCRIPT_SHELL_TEMPLATE_PATTERN)?.[1];
	if (template) return simplifyBashCommandLine(template);
	const call = line.match(JAVASCRIPT_SH_CALL_PATTERN)?.[1];
	return call ? simplifyBashCommandLine(call) : undefined;
}

function javaScriptLineScore(line: string, index: number): number {
	const trimmed = line.trim();
	if (!trimmed || COMMENT_LINE_PATTERN.test(trimmed) || JAVASCRIPT_IMPORT_PATTERN.test(trimmed)) return -1;
	if (shellCommandFromJavaScript(trimmed)) return 100 + index;
	if (JAVASCRIPT_EFFECT_CALL_PATTERN.test(trimmed)) return 90 + index;
	if (JAVASCRIPT_CONTROL_PATTERN.test(trimmed)) return 65 + index;
	if (JAVASCRIPT_DEFINITION_PATTERN.test(trimmed)) return 50 + index;
	if (JAVASCRIPT_ASSIGNMENT_CALL_PATTERN.test(trimmed)) return 70 + index;
	if (JAVASCRIPT_CALL_PATTERN.test(trimmed) && !JAVASCRIPT_LOW_SIGNAL_CALL_PATTERN.test(trimmed)) return 75 + index;
	if (JAVASCRIPT_LOW_SIGNAL_CALL_PATTERN.test(trimmed)) return 20 + index;
	return 35 + index;
}

function simplifyJavaScriptLine(line: string): string {
	const trimmed = line.trim();
	const shell = shellCommandFromJavaScript(trimmed);
	if (shell) return shell;
	const consoleMatch = trimmed.match(/^console\.(?:log|error|warn)\((.*)\);?$/);
	return consoleMatch?.[1]?.trim() || trimmed;
}

export function previewJavaScriptCode(code: string): CodePreview {
	const lines = code.trimEnd().split("\n");
	let best: PreviewCandidate | undefined;
	for (const [index, line] of lines.entries()) {
		const score = javaScriptLineScore(line, index);
		if (score < 0) continue;
		const candidate = {
			language: shellCommandFromJavaScript(line) ? ("bash" as const) : ("javascript" as const),
			text: simplifyJavaScriptLine(line),
			score,
		};
		if (!best || candidate.score > best.score) best = candidate;
	}
	return {
		language: best?.language ?? "javascript",
		text: best ? descriptor(best.text) : "",
	};
}
