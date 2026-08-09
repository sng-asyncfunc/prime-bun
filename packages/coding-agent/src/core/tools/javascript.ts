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

const javascriptActionSchema = Type.Object(
	{
		op: Type.Union([Type.Literal("read"), Type.Literal("search"), Type.Literal("shell"), Type.Literal("write")], {
			description: "Routine operation to execute without generating JavaScript source.",
		}),
		path: Type.Optional(Type.String({ description: "File path for read/write, or search scope directory." })),
		offset: Type.Optional(Type.Integer({ description: "One-based first line for read.", minimum: 1 })),
		limit: Type.Optional(Type.Integer({ description: "Maximum lines for read (up to 2000).", minimum: 1 })),
		pattern: Type.Optional(Type.String({ description: "Search pattern. Omit to list files." })),
		glob: Type.Optional(Type.String({ description: "Optional search glob such as *.ts." })),
		command: Type.Optional(Type.String({ description: "Configured-shell command for shell." })),
		content: Type.Optional(Type.String({ description: "Exact UTF-8 file content for write." })),
	},
	{ additionalProperties: false },
);

const javascriptSchema = Type.Object({
	code: Type.Optional(
		Type.String({
			description:
				"JavaScript or TypeScript for computation, branching, dependent operations, prepared JavaScript skills, or persistent notebook state. Top-level await works. Preloaded globals include fs, path, os, util, $, sh, require, and rlm; use them directly without redeclaring them. Keep printed output bounded and run target-project commands through that project's own environment.",
		}),
	),
	actions: Type.Optional(
		Type.Array(javascriptActionSchema, {
			description:
				"Batch independent routine work without JavaScript syntax. read uses path/offset/limit; search uses optional path/pattern/glob and lists files when pattern is omitted; shell uses command; write uses path/content. A non-zero shell exit is returned normally and stops later actions. Use code for dependencies or operations outside this surface.",
			maxItems: 8,
			minItems: 1,
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
		description:
			"Execute work in a persistent Bun notebook with two input modes. Batch independent routine reads, searches, shell commands, and exact writes as one to eight actions; direct `content` safely carries Markdown fences and backticks. Use `code` for computation, branching, dependent operations, prepared JavaScript skills, and persistent notebook state. Both modes share the notebook cwd, configured shell, output bounds, abort recovery, and file diffs. Run target-project commands through the target project's own environment.",
		promptSnippet:
			"javascript - persistent Bun notebook with structured actions for routine work and code for computation",
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
