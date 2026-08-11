import { existsSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { IMAGE_MIME_TYPES } from "../../utils/mime.js";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.js";
import { withKernelBootPermit } from "../kernel/boot-gate.js";
import type { KernelBootstrapProgressHandler } from "../kernel/bootstrap.js";
import { type BunStructuredAction, validateBunStructuredActions } from "../kernel/bun-actions.js";
import {
	type ExecuteOptions,
	type ExecuteResult,
	type HostRequestHandlers,
	type KernelAttachment,
	type KernelDiffDisplay,
	type KernelExecutionTimings,
	KernelManager,
	type KernelManagerStatus,
	type KernelSentAgentMessage,
} from "../kernel/index.js";
import { manifestPathIn, type RestoreResult, snapshotPathIn } from "../kernel/state-snapshot.js";
import type { JavaScriptSkillRuntimeInfo } from "../skills.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const MAX_STRUCTURED_OUTPUT_DETAIL_CHARS = 16 * 1024;
const MAX_CALL_OUTPUT_CHARS = 24 * 1024;
const CALL_OUTPUT_TRUNCATION_MARKER =
	"\n[... output truncated at 24 KiB — use actions for routine reads/searches; keep large results in variables and print slices ...]\n";

const javascriptActionSchema = Type.Object(
	{
		op: Type.Union(
			[
				Type.Literal("edit"),
				Type.Literal("read"),
				Type.Literal("search"),
				Type.Literal("shell"),
				Type.Literal("write"),
			],
			{
				description: "Routine operation to execute without generating JavaScript source.",
			},
		),
		path: Type.Optional(Type.String({ description: "File path for edit/read/write, or search scope directory." })),
		offset: Type.Optional(Type.Integer({ description: "One-based first line for read.", minimum: 1 })),
		limit: Type.Optional(Type.Integer({ description: "Maximum lines for read (up to 2000).", minimum: 1 })),
		pattern: Type.Optional(Type.String({ description: "Search pattern. Omit to list files." })),
		glob: Type.Optional(Type.String({ description: "Optional search glob such as *.ts." })),
		outputMode: Type.Optional(
			Type.Union([Type.Literal("content"), Type.Literal("files_with_matches"), Type.Literal("count")], {
				description: "Search output shape: matching lines, matching file paths, or per-file matching-line counts.",
			}),
		),
		command: Type.Optional(Type.String({ description: "Configured-shell command for shell." })),
		timeoutSeconds: Type.Optional(
			Type.Integer({
				description: "Wall timeout for a shell action in seconds; defaults to 120 and may be at most 86400.",
				maximum: 86_400,
				minimum: 1,
			}),
		),
		content: Type.Optional(Type.String({ description: "Exact UTF-8 file content for write." })),
		oldStr: Type.Optional(
			Type.String({ description: "Exact, unique existing text to replace for edit; include enough context." }),
		),
		newStr: Type.Optional(Type.String({ description: "Exact replacement text for edit; may be empty." })),
	},
	{ additionalProperties: false },
);

const javascriptSchema = Type.Object({
	actions: Type.Optional(
		Type.Array(javascriptActionSchema, {
			description:
				"DEFAULT JAVASCRIPT MODE for independent routine work and batching; do not generate JavaScript for operations this covers. Batch edit (path/oldStr/newStr), read (path/offset/limit), search (optional path/pattern/glob/outputMode; use files_with_matches or count to keep broad searches compact; omit pattern to list files), shell (command/optional timeoutSeconds; 120-second default), and write (path/content). Shell stdin is closed, so pass explicit file, path, or revision operands. Write creates missing parent directories. Exact content fields stay outside JavaScript syntax. A failed edit/write or non-zero shell exit stops later actions. Use code only for dependencies or operations outside this surface.",
			maxItems: 8,
			minItems: 1,
		}),
	),
	code: Type.Optional(
		Type.String({
			description:
				"Use JavaScript or TypeScript only for computation, branching, dependent operations, prepared JavaScript skills, or persistent notebook state. Top-level bindings persist between cells; put large one-shot intermediates in an explicit `{ ... }` block. Values not needed in a later cell must be block-scoped, even when named. Authored document content must not be embedded in JavaScript string literals or assembled as quoted source lines; use write_file or a structured write action. Filesystem APIs remain available for computed values already held in variables. Do not import child_process or call execSync; use actions or sh for commands. Configured-shell stdin is closed; sh has no default timeout and accepts an optional `{ timeoutMs }`. Top-level await works. Preloaded globals include fs, path, os, util, $, sh, require, and rlm; use them directly without redeclaring them. Keep printed output bounded and run target-project commands through that project's own environment.",
		}),
	),
});

function createAbortError(): Error {
	return new Error("JavaScript execution aborted");
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(createAbortError());
	return new Promise<T>((resolve, reject) => {
		const abort = () => {
			cleanup();
			reject(createAbortError());
		};
		const cleanup = () => signal.removeEventListener("abort", abort);
		signal.addEventListener("abort", abort, { once: true });
		promise.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				cleanup();
				reject(error);
			},
		);
	});
}

function createLinkedAbortSignal(sources: readonly (AbortSignal | undefined)[]): {
	signal: AbortSignal;
	cleanup: () => void;
} {
	const controller = new AbortController();
	const cleanups: Array<() => void> = [];
	for (const source of sources) {
		if (!source) continue;
		if (source.aborted) {
			controller.abort();
			continue;
		}
		const listener = () => controller.abort();
		source.addEventListener("abort", listener, { once: true });
		cleanups.push(() => source.removeEventListener("abort", listener));
	}
	return {
		signal: controller.signal,
		cleanup: () => {
			for (const cleanup of cleanups) cleanup();
		},
	};
}

function setWorkingMessage(ctx: ExtensionContext | undefined, message?: string): void {
	try {
		ctx?.ui.setWorkingMessage(message);
	} catch {}
}

function executionFailure(error: unknown): NonNullable<ExecuteResult["error"]> {
	const ename = error instanceof Error ? error.name || "Error" : "Error";
	const evalue = (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
	const traceback = (error instanceof Error && error.stack ? error.stack : `${ename}: ${evalue}`)
		.slice(0, 16_384)
		.split("\n");
	return { ename, evalue, traceback };
}

function boundCodeOutput(value: string): string {
	if (value.length <= MAX_CALL_OUTPUT_CHARS) return value;
	const available = MAX_CALL_OUTPUT_CHARS - CALL_OUTPUT_TRUNCATION_MARKER.length;
	const headChars = Math.ceil(available / 2);
	const tailChars = available - headChars;
	return `${value.slice(0, headChars)}${CALL_OUTPUT_TRUNCATION_MARKER}${value.slice(-tailChars)}`;
}

type ResolvedJavaScriptToolInput =
	| { mode: "code"; code: string }
	| { mode: "actions"; actions: BunStructuredAction[] }
	| { mode: "error"; message: string };

function resolveJavaScriptToolInput(params: JavaScriptToolInput): ResolvedJavaScriptToolInput {
	const hasCode = typeof params.code === "string";
	const hasActions = params.actions !== undefined;
	if (Number(hasCode) + Number(hasActions) !== 1) {
		return {
			mode: "error",
			message:
				'Invalid JavaScript tool input: provide exactly one of "code" or "actions". Use "code" for computation or operations outside the structured action surface.',
		};
	}
	if (hasCode) return { code: params.code as string, mode: "code" };
	const validation = validateBunStructuredActions(params.actions);
	return validation.ok
		? { actions: validation.actions, mode: "actions" }
		: { mode: "error", message: `Invalid JavaScript tool input: ${validation.message}` };
}

export type JavaScriptToolInput = Static<typeof javascriptSchema>;

interface AliasField<T> {
	ok: boolean;
	value?: T;
}

function aliasRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function inferStructuredActionOp(record: Record<string, unknown>): BunStructuredAction["op"] | undefined {
	if (Object.hasOwn(record, "op")) return undefined;
	const candidates: BunStructuredAction["op"][] = [];
	if (Object.hasOwn(record, "command")) candidates.push("shell");
	if (Object.hasOwn(record, "oldStr") || Object.hasOwn(record, "newStr")) candidates.push("edit");
	if (Object.hasOwn(record, "content")) candidates.push("write");
	if (Object.hasOwn(record, "pattern") || Object.hasOwn(record, "glob") || Object.hasOwn(record, "outputMode")) {
		candidates.push("search");
	}
	if (candidates.length === 0 && ["path", "offset", "limit"].some((key) => Object.hasOwn(record, key))) {
		candidates.push("read");
	}
	return candidates.length === 1 ? candidates[0] : undefined;
}

function prepareJavaScriptArguments(args: unknown): JavaScriptToolInput {
	const record = aliasRecord(args);
	if (!record || !Array.isArray(record.actions)) return args as JavaScriptToolInput;
	let changed = false;
	const actions = record.actions.map((candidate) => {
		const action = aliasRecord(candidate);
		if (!action) return candidate;
		const op = inferStructuredActionOp(action);
		if (!op) return candidate;
		changed = true;
		return { ...action, op };
	});
	return (changed ? { ...record, actions } : args) as JavaScriptToolInput;
}

function aliasStringField(
	record: Record<string, unknown>,
	keys: readonly string[],
	options: { allowEmpty?: boolean; required?: boolean } = {},
): AliasField<string> {
	let resolved: string | undefined;
	for (const key of keys) {
		if (!Object.hasOwn(record, key)) continue;
		const value = record[key];
		if (typeof value !== "string" || (!options.allowEmpty && !value.trim())) return { ok: false };
		if (resolved !== undefined && resolved !== value) return { ok: false };
		resolved = value;
	}
	return options.required && resolved === undefined ? { ok: false } : { ok: true, value: resolved };
}

function aliasPositiveIntegerField(record: Record<string, unknown>, key: string): AliasField<number> {
	if (!Object.hasOwn(record, key)) return { ok: true };
	const value = record[key];
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? { ok: true, value } : { ok: false };
}

function actionAlias(action: BunStructuredAction): Record<string, unknown> {
	return { actions: [action] };
}

function editAlias(args: unknown): Record<string, unknown> | undefined {
	const record = aliasRecord(args);
	if (!record) return undefined;
	const path = aliasStringField(record, ["path", "file_path", "filePath"], { required: true });
	const oldStr = aliasStringField(record, ["oldStr", "old_string", "oldText", "old_text"], { required: true });
	const newStr = aliasStringField(record, ["newStr", "new_string", "newText", "new_text"], {
		allowEmpty: true,
		required: true,
	});
	if (!path.ok || !path.value || !oldStr.ok || !oldStr.value || !newStr.ok || newStr.value === undefined) {
		return undefined;
	}
	return actionAlias({ op: "edit", path: path.value, oldStr: oldStr.value, newStr: newStr.value });
}

function shellAlias(args: unknown): Record<string, unknown> | undefined {
	const record = aliasRecord(args);
	if (!record) return undefined;
	const command = aliasStringField(record, ["command", "cmd"], { required: true });
	return command.ok && command.value ? actionAlias({ op: "shell", command: command.value }) : undefined;
}

function readAlias(args: unknown): Record<string, unknown> | undefined {
	const record = aliasRecord(args);
	if (!record) return undefined;
	const path = aliasStringField(record, ["path", "file_path", "filePath"], { required: true });
	const offset = aliasPositiveIntegerField(record, "offset");
	const limit = aliasPositiveIntegerField(record, "limit");
	if (!path.ok || !path.value || !offset.ok || !limit.ok) return undefined;
	return actionAlias({
		op: "read",
		path: path.value,
		...(offset.value !== undefined ? { offset: offset.value } : {}),
		...(limit.value !== undefined ? { limit: limit.value } : {}),
	});
}

function searchAlias(args: unknown): Record<string, unknown> | undefined {
	const record = aliasRecord(args);
	if (!record) return undefined;
	const pattern = aliasStringField(record, ["pattern", "query"]);
	const path = aliasStringField(record, ["path"]);
	const glob = aliasStringField(record, ["glob"]);
	const outputMode = aliasStringField(record, ["outputMode", "output_mode"]);
	if (!pattern.ok || !path.ok || !glob.ok || !outputMode.ok) return undefined;
	if (
		outputMode.value !== undefined &&
		outputMode.value !== "content" &&
		outputMode.value !== "files_with_matches" &&
		outputMode.value !== "count"
	) {
		return undefined;
	}
	if (
		pattern.value === undefined &&
		path.value === undefined &&
		glob.value === undefined &&
		outputMode.value === undefined
	) {
		return undefined;
	}
	return actionAlias({
		op: "search",
		...(pattern.value !== undefined ? { pattern: pattern.value } : {}),
		...(path.value !== undefined ? { path: path.value } : {}),
		...(glob.value !== undefined ? { glob: glob.value } : {}),
		...(outputMode.value !== undefined ? { outputMode: outputMode.value } : {}),
	});
}

function writeAlias(args: unknown): Record<string, unknown> | undefined {
	const record = aliasRecord(args);
	if (!record) return undefined;
	const path = aliasStringField(record, ["path", "file_path", "filePath"], { required: true });
	const content = aliasStringField(record, ["content"], { allowEmpty: true, required: true });
	if (!path.ok || !path.value || !content.ok || content.value === undefined) return undefined;
	return actionAlias({ op: "write", path: path.value, content: content.value });
}

const javascriptCompatibilityAliases: NonNullable<ToolDefinition<typeof javascriptSchema>["compatibilityAliases"]> = {
	bash: shellAlias,
	edit: editAlias,
	grep: searchAlias,
	read: readAlias,
	read_file: readAlias,
	search: searchAlias,
	shell: shellAlias,
	write: writeAlias,
	write_file: writeAlias,
};

export interface JavaScriptToolTimings extends KernelExecutionTimings {
	provisioningMs: number;
}

export interface JavaScriptToolDetails {
	durationMs?: number;
	timings?: JavaScriptToolTimings;
	status?: "ok" | "error" | "aborted" | "starting";
	errorEname?: string;
	kernelStatus?: KernelManagerStatus;
	stdout?: string;
	stderr?: string;
	result?: string;
	diffs?: KernelDiffDisplay[];
	attachments?: KernelAttachment[];
	sentAgentMessages?: KernelSentAgentMessage[];
	error?: {
		ename: string;
		evalue: string;
		traceback: string[];
	};
}

export interface JavaScriptToolOptions {
	bun?: string;
	env?: Record<string, string>;
	commandPrefix?: string;
	shellPath?: string;
	sessionId?: string;
	hostHandlers?: HostRequestHandlers;
	javascriptSkills?: readonly JavaScriptSkillRuntimeInfo[];
	snapshotDir?: string;
	readyGate?: Promise<unknown>;
	kernelManagerRef?: { current?: KernelManager };
	onRestore?: (result: RestoreResult) => void;
	onLateSentAgentMessage?: (toolCallId: string, message: KernelSentAgentMessage) => void;
	provisioner?: BunKernelProvisioner;
}

function structuredOutputDetails(result: ExecuteResult): Pick<JavaScriptToolDetails, "result" | "stderr" | "stdout"> {
	const outputChars = result.stdout.length + result.stderr.length + (result.result?.length ?? 0);
	if (result.status === "ok" && outputChars > MAX_STRUCTURED_OUTPUT_DETAIL_CHARS) return {};
	return { result: result.result, stderr: result.stderr, stdout: result.stdout };
}

export class BunKernelProvisioner {
	private managerPromise?: Promise<KernelManager>;
	private startedManager?: KernelManager;
	private readonly startupListeners = new Set<KernelBootstrapProgressHandler>();
	private lastStartupMessage?: string;
	private _lastRestore?: RestoreResult;
	private readonly disposeController = new AbortController();

	constructor(
		private readonly cwd: string,
		private readonly options?: Omit<JavaScriptToolOptions, "provisioner">,
	) {
		if (options?.kernelManagerRef) options.kernelManagerRef.current = undefined;
	}

	get manager(): KernelManager | undefined {
		return this.startedManager;
	}

	get lastRestore(): RestoreResult | undefined {
		return this._lastRestore;
	}

	get hasRunningKernel(): boolean {
		return this.startedManager?.isRunning ?? false;
	}

	prewarm(): void {
		void this.ensure().catch(() => undefined);
	}

	async listNamespaceNames(signal?: AbortSignal): Promise<string[] | null> {
		const manager = this.startedManager ?? (await this.managerPromise?.catch(() => undefined));
		return (await manager?.listNamespaceNames(signal)) ?? null;
	}

	async dispose(): Promise<void> {
		this.disposeController.abort();
		const pending = this.managerPromise;
		this.managerPromise = undefined;
		this.startedManager = undefined;
		if (this.options?.kernelManagerRef) this.options.kernelManagerRef.current = undefined;
		if (!pending) return;
		try {
			await (await pending).dispose();
		} catch {}
	}

	async kill(): Promise<void> {
		const pending = this.managerPromise;
		this.managerPromise = undefined;
		this.startedManager = undefined;
		if (this.options?.kernelManagerRef) this.options.kernelManagerRef.current = undefined;
		if (!pending) return;
		try {
			await (await pending).kill();
		} catch {}
	}

	ensure(onProgress?: KernelBootstrapProgressHandler, signal?: AbortSignal): Promise<KernelManager> {
		if (signal?.aborted) return Promise.reject(createAbortError());
		let cleanupProgressListener: (() => void) | undefined;
		if (onProgress && !this.startedManager) {
			this.startupListeners.add(onProgress);
			cleanupProgressListener = () => this.startupListeners.delete(onProgress);
			if (this.managerPromise && this.lastStartupMessage) onProgress(this.lastStartupMessage);
		}
		if (!this.managerPromise) {
			const startup = this.startKernel(signal);
			this.managerPromise = startup;
			startup.then(
				(manager) => {
					if (this.managerPromise === startup) this.startedManager = manager;
					this.settleStartup();
				},
				() => {
					if (this.managerPromise === startup) this.managerPromise = undefined;
					this.settleStartup();
				},
			);
		}
		return raceWithAbort(this.managerPromise, signal).finally(() => cleanupProgressListener?.());
	}

	private settleStartup(): void {
		this.startupListeners.clear();
		this.lastStartupMessage = undefined;
	}

	private emitStartupProgress(message: string): void {
		this.lastStartupMessage = message;
		for (const listener of this.startupListeners) listener(message);
	}

	private async startKernel(signal?: AbortSignal): Promise<KernelManager> {
		const startupAbort = createLinkedAbortSignal([this.disposeController.signal, signal]);
		try {
			if (this.options?.readyGate)
				await raceWithAbort(
					this.options.readyGate.catch(() => undefined),
					startupAbort.signal,
				);
			const snapshotDir = this.options?.snapshotDir;
			const manager = new KernelManager({
				bun: this.options?.bun,
				commandPrefix: this.options?.commandPrefix,
				cwd: this.cwd,
				env: this.options?.env,
				hostHandlers: this.options?.hostHandlers,
				javascriptSkills: this.options?.javascriptSkills,
				sessionId: this.options?.sessionId,
				shellPath: this.options?.shellPath,
				snapshot: snapshotDir
					? { manifestPath: manifestPathIn(snapshotDir), path: snapshotPathIn(snapshotDir) }
					: undefined,
			});
			let pendingRestore: RestoreResult | undefined;
			try {
				this.emitStartupProgress("Starting Bun notebook...");
				await withKernelBootPermit(() => {
					if (startupAbort.signal.aborted) throw new Error("Bun provisioner disposed before start");
					return manager.start({
						onBootstrapProgress: (message) => this.emitStartupProgress(message),
						signal: startupAbort.signal,
					});
				}, startupAbort.signal);
				if (snapshotDir) {
					const snapshotExisted = existsSync(snapshotPathIn(snapshotDir));
					this.emitStartupProgress("Restoring JavaScript state...");
					const restored = await raceWithAbort(manager.restoreState(), startupAbort.signal);
					if (snapshotExisted) {
						pendingRestore = restored ?? { failed: [], path: snapshotPathIn(snapshotDir), restored: [] };
					}
				}
			} catch (error) {
				void manager.dispose();
				throw error;
			}
			if (pendingRestore) {
				this._lastRestore = pendingRestore;
				this.options?.onRestore?.(pendingRestore);
			}
			if (this.options?.kernelManagerRef) this.options.kernelManagerRef.current = manager;
			return manager;
		} finally {
			startupAbort.cleanup();
		}
	}
}

export function imageBlocksFromAttachments(attachments: readonly KernelAttachment[] | undefined): ImageContent[] {
	if (!attachments) return [];
	return attachments
		.filter((attachment) => IMAGE_MIME_TYPES.has(attachment.mimeType))
		.map((attachment) => ({ type: "image", data: attachment.data, mimeType: attachment.mimeType }));
}

export function createJavaScriptToolDefinition(
	cwd: string,
	options?: JavaScriptToolOptions,
): ToolDefinition<typeof javascriptSchema, JavaScriptToolDetails> {
	const provisioner = options?.provisioner ?? new BunKernelProvisioner(cwd, options);
	return {
		name: "javascript",
		label: "Bun",
		compatibilityAliases: javascriptCompatibilityAliases,
		description:
			"Execute work in a persistent Bun notebook with two input modes. The tool name is `javascript`; `code` is only an input field, never a tool name. Default to `actions` for independent routine reads, searches, shell commands, and batched work. Batch one to eight actions. Structured shell actions close stdin, default to a 120-second wall timeout, and accept `timeoutSeconds`. Exact edit/write fields carry literal content outside JavaScript syntax, and structured writes create missing parent directories. Authored document content belongs in `write_file` or a structured write action. Use `code` for computation, branching, dependent operations, prepared JavaScript skills, persistent notebook state, and filesystem writes of computed values already held in variables. Top-level bindings persist between cells; put large one-shot intermediates in an explicit `{ ... }` block. Values not needed in a later cell must be block-scoped, even when named. Both modes share the notebook cwd, configured shell, output bounds, abort recovery, and file diffs. Run target-project commands through the target project's own environment.",
		promptSnippet:
			"javascript - persistent Bun notebook with structured actions for routine work and code for computation",
		promptGuidelines: [
			"For read-only repository exploration and audits, plan first, batch independent actions, and stop after at most 12 JavaScript calls; answer from collected evidence instead of pursuing exhaustive coverage.",
		],
		prepareArguments: prepareJavaScriptArguments,
		executionMode: "sequential",
		parameters: javascriptSchema,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			const toolStartedAt = performance.now();
			const input = resolveJavaScriptToolInput(params);
			if (input.mode === "error") {
				const failure = new Error(input.message);
				failure.name = "InvalidToolInputError";
				const normalized = executionFailure(failure);
				return {
					content: [{ type: "text", text: input.message }],
					details: {
						durationMs: Math.round(Math.max(0, performance.now() - toolStartedAt)),
						error: normalized,
						errorEname: normalized.ename,
						status: "error" as const,
					},
					isError: true,
				};
			}
			let hasWorkingMessage = false;
			const setToolWorkingMessage = (message?: string) => {
				setWorkingMessage(ctx, message);
				hasWorkingMessage = message !== undefined;
			};
			const reportStartupProgress: KernelBootstrapProgressHandler = (message) => {
				setToolWorkingMessage(message);
				onUpdate?.({ content: [{ type: "text", text: message }], details: { status: "starting" } });
			};
			try {
				const provisioningStartedAt = performance.now();
				const manager = await provisioner.ensure(reportStartupProgress, signal);
				const rawProvisioningMs = Math.max(0, performance.now() - provisioningStartedAt);
				let result: ExecuteResult;
				try {
					const executionOptions: ExecuteOptions = {
						onLateSentAgentMessage: options?.onLateSentAgentMessage
							? (message) => options.onLateSentAgentMessage?.(toolCallId, message)
							: undefined,
						onStream: (chunk) => {
							onUpdate?.({ content: [{ type: "text", text: chunk }], details: { status: "ok" } });
						},
						signal,
					};
					result =
						input.mode === "code"
							? await manager.execute(input.code, executionOptions)
							: await manager.executeActions(input.actions, executionOptions);
				} catch (error) {
					const failure = executionFailure(error);
					const status = signal?.aborted || failure.ename === "AbortError" ? "aborted" : "error";
					const durationMs = Math.round(Math.max(0, performance.now() - toolStartedAt));
					return {
						content: [{ type: "text", text: failure.traceback.join("\n") }],
						details: {
							durationMs,
							error: failure,
							errorEname: failure.ename,
							kernelStatus: manager.status,
							status,
						},
						isError: true,
					};
				}
				let text = result.stdout;
				if (result.stderr) text += `${text ? "\n" : ""}${result.stderr}`;
				if (result.result) text += `${text ? "\n" : ""}${result.result}`;
				if (input.mode === "code") text = boundCodeOutput(text);
				if (result.status === "error" && result.error) {
					text += `${text ? "\n" : ""}${result.error.traceback.join("\n")}`;
				}
				const content: (TextContent | ImageContent)[] = [
					{ type: "text", text: text || "" },
					...imageBlocksFromAttachments(result.attachments),
				];
				const rawToolTotalMs = Math.max(
					0,
					performance.now() - toolStartedAt,
					rawProvisioningMs,
					result.durationMs,
					...(result.timings ? Object.values(result.timings) : []),
				);
				const durationMs = Math.round(Number.isFinite(rawToolTotalMs) ? rawToolTotalMs : 0);
				const timings: JavaScriptToolTimings | undefined = result.timings
					? {
							checkpointMs: result.timings.checkpointMs,
							executionMs: result.timings.executionMs,
							provisioningMs: Math.round(Number.isFinite(rawProvisioningMs) ? rawProvisioningMs : 0),
							queueMs: result.timings.queueMs,
							startupMs: result.timings.startupMs,
							totalMs: durationMs,
						}
					: undefined;
				return {
					content,
					details: {
						attachments: result.attachments,
						diffs: result.diffs,
						durationMs,
						error: result.error,
						errorEname: result.error?.ename,
						kernelStatus: manager.status,
						sentAgentMessages: result.sentAgentMessages,
						status: result.status,
						...structuredOutputDetails(result),
						timings,
					},
					isError: result.status === "error" || result.status === "aborted",
				};
			} finally {
				if (hasWorkingMessage) setToolWorkingMessage();
			}
		},
	};
}

export function createJavaScriptTool(cwd: string, options?: JavaScriptToolOptions): AgentTool<typeof javascriptSchema> {
	return wrapToolDefinition(createJavaScriptToolDefinition(cwd, options));
}
