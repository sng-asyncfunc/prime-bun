import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const MAX_ACTIONS = 8;
const MAX_WRITES = 1;
const MAX_READ_LINES = 2_000;
const MAX_WRITE_CONTENT_CHARS = 1_000_000;
const MAX_ACTION_OUTPUT_CHARS = 8_192;
const MAX_ACTION_TARGET_CHARS = 240;
const MAX_SEARCH_BUFFER_BYTES = 16 * 1024 * 1024;

const ACTION_OPERATIONS = new Set(["read", "search", "shell", "write"]);

export type BunStructuredAction = {
	op: "read" | "search" | "shell" | "write";
	path?: string;
	offset?: number;
	limit?: number;
	pattern?: string;
	glob?: string;
	command?: string;
	content?: string;
};

export type BunStructuredActionValidation =
	| { ok: true; actions: BunStructuredAction[] }
	| { ok: false; message: string };

export interface BunActionDiff {
	path: string;
	oldStr: string;
	newStr: string;
	startLine: number;
}

export interface BunActionBatchResult {
	output: string;
	diffs: BunActionDiff[];
}

export interface BunActionExecutionOptions {
	runShell(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

interface ExecutableResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	missing: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function actionFromRecord(record: Record<string, unknown>, op: BunStructuredAction["op"]): BunStructuredAction {
	return {
		op,
		...(optionalString(record, "path") !== undefined ? { path: optionalString(record, "path") } : {}),
		...(positiveInteger(record.offset) ? { offset: record.offset } : {}),
		...(positiveInteger(record.limit) ? { limit: record.limit } : {}),
		...(optionalString(record, "pattern") !== undefined ? { pattern: optionalString(record, "pattern") } : {}),
		...(optionalString(record, "glob") !== undefined ? { glob: optionalString(record, "glob") } : {}),
		...(optionalString(record, "command") !== undefined ? { command: optionalString(record, "command") } : {}),
		...(optionalString(record, "content") !== undefined ? { content: optionalString(record, "content") } : {}),
	};
}

export function validateBunStructuredActions(value: unknown): BunStructuredActionValidation {
	if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ACTIONS) {
		const count = Array.isArray(value) ? value.length : 0;
		return {
			ok: false,
			message: `Structured action batches support 1 to ${MAX_ACTIONS} actions; received ${count}.`,
		};
	}

	const actions: BunStructuredAction[] = [];
	let writes = 0;
	for (const [index, candidate] of value.entries()) {
		const number = index + 1;
		if (!isRecord(candidate)) {
			return { ok: false, message: `Action ${number} must be an object.` };
		}
		const op = candidate.op;
		if (typeof op !== "string" || !ACTION_OPERATIONS.has(op)) {
			return {
				ok: false,
				message: `Action ${number} has unknown op ${JSON.stringify(op)}; expected read, search, shell, or write.`,
			};
		}
		const typedOp = op as BunStructuredAction["op"];
		if ((typedOp === "read" || typedOp === "write") && !optionalString(candidate, "path")?.trim()) {
			return { ok: false, message: `Action ${number} (${typedOp}) requires a non-empty "path".` };
		}
		if (typedOp === "shell" && !optionalString(candidate, "command")?.trim()) {
			return { ok: false, message: `Action ${number} (shell) requires a non-empty "command".` };
		}
		if (typedOp === "write" && typeof candidate.content !== "string") {
			return { ok: false, message: `Action ${number} (write) requires string "content".` };
		}
		if (candidate.offset !== undefined && !positiveInteger(candidate.offset)) {
			return { ok: false, message: `Action ${number} (${typedOp}) "offset" must be a positive integer.` };
		}
		if (candidate.limit !== undefined && (!positiveInteger(candidate.limit) || candidate.limit > MAX_READ_LINES)) {
			return {
				ok: false,
				message: `Action ${number} (${typedOp}) "limit" must be between 1 and ${MAX_READ_LINES}.`,
			};
		}
		for (const key of ["path", "pattern", "glob", "command"] as const) {
			if (candidate[key] !== undefined && typeof candidate[key] !== "string") {
				return { ok: false, message: `Action ${number} (${typedOp}) "${key}" must be a string.` };
			}
		}
		if (typedOp === "write") {
			writes += 1;
			if ((candidate.content as string).length > MAX_WRITE_CONTENT_CHARS) {
				return {
					ok: false,
					message: `Action ${number} (write) "content" exceeds the ${MAX_WRITE_CONTENT_CHARS}-character structured-write limit; use code.`,
				};
			}
		}
		actions.push(actionFromRecord(candidate, typedOp));
	}

	if (writes > MAX_WRITES) {
		return {
			ok: false,
			message: `Structured action batches support at most one write; received ${writes}.`,
		};
	}
	return { ok: true, actions };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | number | undefined {
	if (!isRecord(error)) return undefined;
	const code = error.code;
	return typeof code === "string" || typeof code === "number" ? code : undefined;
}

function compactTarget(value: string): string {
	if (value.length <= MAX_ACTION_TARGET_CHARS) return value;
	return `${value.slice(0, MAX_ACTION_TARGET_CHARS - 1)}…`;
}

function boundActionOutput(value: string): string {
	if (value.length <= MAX_ACTION_OUTPUT_CHARS) return value;
	const marker = `\n[... action output truncated at ${MAX_ACTION_OUTPUT_CHARS} chars ...]\n`;
	const available = MAX_ACTION_OUTPUT_CHARS - marker.length;
	const headChars = Math.ceil(available / 2);
	const tailChars = available - headChars;
	return `${value.slice(0, headChars)}${marker}${value.slice(-tailChars)}`;
}

function actionHeader(action: BunStructuredAction, index: number, total: number): string {
	switch (action.op) {
		case "read": {
			const offset = action.offset ?? 1;
			const limit = action.limit ?? 200;
			return `[${index}/${total} read ${compactTarget(action.path ?? "")} lines ${offset}-${offset + limit - 1}]`;
		}
		case "search": {
			const scope = action.path ?? ".";
			const query = action.pattern ? `pattern ${JSON.stringify(action.pattern)}` : "files";
			const glob = action.glob ? ` glob ${JSON.stringify(action.glob)}` : "";
			return `[${index}/${total} search ${compactTarget(`${query}${glob} in ${scope}`)}]`;
		}
		case "shell":
			return `[${index}/${total} shell ${compactTarget(action.command ?? "")}]`;
		case "write":
			return `[${index}/${total} write ${compactTarget(action.path ?? "")}]`;
	}
}

function actionSection(action: BunStructuredAction, index: number, total: number, body: string): string {
	const bounded = boundActionOutput(body.trimEnd());
	return bounded ? `${actionHeader(action, index, total)}\n${bounded}` : actionHeader(action, index, total);
}

async function readLines(path: string, offset: number, limit: number): Promise<string> {
	const input = createReadStream(path, { encoding: "utf8" });
	const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
	const selected: string[] = [];
	let lineNumber = 0;
	try {
		for await (const line of lines) {
			lineNumber += 1;
			if (lineNumber < offset) continue;
			selected.push(`${lineNumber}: ${line}`);
			if (selected.length >= limit) break;
		}
	} finally {
		lines.close();
		input.destroy();
	}
	return selected.join("\n");
}

function executeFile(command: string, args: readonly string[]): Promise<ExecutableResult> {
	return new Promise((resolve) => {
		execFile(
			command,
			[...args],
			{ encoding: "utf8", maxBuffer: MAX_SEARCH_BUFFER_BYTES },
			(error, stdout, stderr) => {
				const code = errorCode(error);
				resolve({
					exitCode: typeof code === "number" ? code : error ? 1 : 0,
					missing: code === "ENOENT",
					stderr: String(stderr),
					stdout: String(stdout),
				});
			},
		);
	});
}

async function runSearch(action: BunStructuredAction): Promise<string> {
	const scope = action.path ?? ".";
	const rgArgs = action.glob ? ["--glob", action.glob] : [];
	if (action.pattern === undefined) {
		rgArgs.push("--files", "--", scope);
	} else {
		rgArgs.push("-n", "--no-heading", "--color=never", "-e", action.pattern, "--", scope);
	}
	let result = await executeFile("rg", rgArgs);
	if (result.missing) {
		const gitArgs =
			action.pattern === undefined ? ["ls-files", "--", scope] : ["grep", "-n", "-e", action.pattern, "--", scope];
		result = await executeFile("git", gitArgs);
	}
	if (result.missing) throw new Error("Neither ripgrep nor git is available for structured search");
	if (result.exitCode === 1 && action.pattern !== undefined && !result.stdout.trim()) return "0 matches";
	if (result.exitCode !== 0) {
		throw new Error(`search exited with code ${result.exitCode}: ${result.stderr.trim() || "no stderr"}`);
	}
	const output = result.stdout.trimEnd();
	if (output) return output;
	return action.pattern === undefined ? "0 files" : "0 matches";
}

async function oldFileContent(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return "";
		throw error;
	}
}

export async function executeBunStructuredActions(
	actions: readonly BunStructuredAction[],
	options: BunActionExecutionOptions,
): Promise<BunActionBatchResult> {
	const validation = validateBunStructuredActions(actions);
	if (!validation.ok) throw new Error(validation.message);

	const sections: string[] = [];
	const diffs: BunActionDiff[] = [];
	for (const [zeroBasedIndex, action] of validation.actions.entries()) {
		const index = zeroBasedIndex + 1;
		try {
			switch (action.op) {
				case "read": {
					const body = await readLines(action.path as string, action.offset ?? 1, action.limit ?? 200);
					sections.push(actionSection(action, index, validation.actions.length, body || "0 lines"));
					break;
				}
				case "search": {
					sections.push(actionSection(action, index, validation.actions.length, await runSearch(action)));
					break;
				}
				case "shell": {
					const result = await options.runShell(action.command as string);
					const body = [
						`exitCode: ${result.exitCode}`,
						...(result.stdout.trimEnd() ? ["stdout:", result.stdout.trimEnd()] : []),
						...(result.stderr.trimEnd() ? ["stderr:", result.stderr.trimEnd()] : []),
					].join("\n");
					sections.push(actionSection(action, index, validation.actions.length, body));
					if (result.exitCode !== 0) {
						sections.push(`[batch stopped after shell exit ${result.exitCode}]`);
						return { diffs, output: sections.join("\n\n") };
					}
					break;
				}
				case "write": {
					const path = action.path as string;
					const content = action.content as string;
					const oldStr = await oldFileContent(path);
					await writeFile(path, content, "utf8");
					diffs.push({ newStr: content, oldStr, path, startLine: 1 });
					sections.push(
						actionSection(action, index, validation.actions.length, `wrote ${Buffer.byteLength(content)} bytes`),
					);
					break;
				}
			}
		} catch (error) {
			sections.push(actionSection(action, index, validation.actions.length, `ERROR: ${errorMessage(error)}`));
			if (action.op === "write") {
				sections.push("[batch stopped after write failure]");
				break;
			}
		}
	}
	return { diffs, output: sections.join("\n\n") };
}
