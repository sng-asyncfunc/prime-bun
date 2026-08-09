import { existsSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { IMAGE_MIME_TYPES } from "../../utils/mime.js";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.js";
import { withKernelBootPermit } from "../kernel/boot-gate.js";
import type { KernelBootstrapProgressHandler } from "../kernel/bootstrap.js";
import {
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

const javascriptSchema = Type.Object({
	code: Type.String({
		description:
			"JavaScript or TypeScript scratchpad code to execute in the persistent Bun notebook. TypeScript syntax is transpiled without type-checking, and top-level await is supported. Bun Shell `$` is preloaded. Do not import `$` from `bun`; use it directly. Run target-project commands through that project's own environment. For repository search, prefer `rg -n` or `rg --files` with traversal-time globs and exclusions; avoid repeated recursive `grep` scans with post-pipe filters.",
	}),
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
			"Execute JavaScript or TypeScript in a persistent Bun notebook. TypeScript syntax is transpiled without type-checking. Variables and loaded data persist across calls and are restored on a best-effort basis when a session resumes. Top-level await, Bun APIs, `sh`, Bun Shell, RLM, and prepared JavaScript skills are available as globals. Do not import `$` from `bun`; use the preloaded global directly. Run target-project commands through the target project's own environment. For repository search, prefer `rg -n` or `rg --files` with traversal-time globs and exclusions; avoid repeated recursive `grep` scans with post-pipe filters.",
		promptSnippet: "javascript - persistent Bun notebook for JavaScript, TypeScript, shell orchestration, and RLM",
		executionMode: "sequential",
		parameters: javascriptSchema,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			const toolStartedAt = performance.now();
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
					result = await manager.execute(params.code, {
						onLateSentAgentMessage: options?.onLateSentAgentMessage
							? (message) => options.onLateSentAgentMessage?.(toolCallId, message)
							: undefined,
						onStream: (chunk) => {
							onUpdate?.({ content: [{ type: "text", text: chunk }], details: { status: "ok" } });
						},
						signal,
					});
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
						result: result.result,
						sentAgentMessages: result.sentAgentMessages,
						status: result.status,
						stderr: result.stderr,
						stdout: result.stdout,
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
