import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import { getShellConfig, killProcessTree } from "../../utils/shell.js";
import type { JavaScriptSkillRuntimeInfo } from "../skills.js";
import {
	ensureKernelBun,
	type KernelBootstrapProgressHandler,
	type PreparedJavaScriptSkillRuntimeInfo,
} from "./bootstrap.js";
import type { BunStructuredAction } from "./bun-actions.js";
import { createHarnessHostHandlers } from "./bun-harness-host.js";
import {
	BUN_WORKER_PROTOCOL_VERSION,
	type BunWorkerDisplayMessage,
	type BunWorkerHostRequestMessage,
	type BunWorkerStreamMessage,
	type BunWorkerToHostMessage,
	type HostToBunWorkerMessage,
} from "./bun-protocol.js";
import { resolveBunRuntime } from "./bun-runtime.js";
import {
	DEFAULT_SNAPSHOT_MAX_BYTES,
	manifestPathIn,
	type RestoreResult,
	type SnapshotResult,
	snapshotPathIn,
} from "./state-snapshot.js";

const DEFAULT_MAX_OUTPUT_CHARS = 65_536;
const DEFAULT_SNAPSHOT_DEBOUNCE_MS = 1_500;
const HOST_REQUEST_DISPOSE_TIMEOUT_MS = 5_000;
const SNAPSHOT_DISPOSE_TIMEOUT_MS = 5_000;
const DEFAULT_WORKER_READY_TIMEOUT_MS = 15_000;
const DEFAULT_SKILL_FACTORY_TIMEOUT_MS = 10_000;
const DEFAULT_CHECKPOINT_TIMEOUT_MS = 15_000;
const DEFAULT_STRUCTURED_SHELL_TIMEOUT_MS = 120_000;
const GRACEFUL_SHELL_KILL_DELAY_MS = 250;
const RECOVERY_CHECKPOINT_ABORT_GRACE_MS = 100;
const MAX_KERNEL_DIAGNOSTIC_CHARS = 16_384;
const MAX_KERNEL_STATUS_ENTRIES = 128;
const MAX_KERNEL_STATUS_DETAIL_CHARS = 512;
const MAX_LATE_SENT_AGENT_MESSAGE_HANDLERS = 256;
const MAX_ATTACHMENT_DATA_CHARS = 10_000_000;

export const HOST_COMM_TARGET = "host.request";
export const DIFF_DISPLAY_MIME = "application/vnd.prime-agent.diff+json";
export const ATTACHMENT_DISPLAY_MIME = "application/vnd.prime-agent.attachment+json";
export const AGENT_MESSAGE_DISPLAY_MIME = "application/vnd.prime-agent.agent-message+json";

const RUNTIME_NAMESPACE_NAMES = new Set([
	"$",
	"Bun",
	"console",
	"fetch",
	"process",
	"sh",
	"__primeDisplay",
	"__primeHostRequest",
]);

export type HostRequestHandler = (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface HostRequestContext {
	readonly requestId: string;
	readonly generation: number;
	readonly signal: AbortSignal;
	isCurrent(): boolean;
}

const hostRequestHandlerBrand = Symbol("hostRequestHandler");

export type HostRequestHandlerImplementation = (
	payload: Record<string, unknown>,
	context: HostRequestContext,
) => Promise<Record<string, unknown>>;

type HostRequestHandlerCapability = HostRequestHandlerImplementation & { readonly [hostRequestHandlerBrand]: true };

const factoryCreatedHostRequestHandlers = new WeakSet<object>();

function assertGenuineHostRequestContext(context: unknown): asserts context is HostRequestContext {
	if (
		typeof context !== "object" ||
		context === null ||
		typeof (context as HostRequestContext).requestId !== "string" ||
		!(context as HostRequestContext).requestId ||
		!Number.isSafeInteger((context as HostRequestContext).generation) ||
		typeof (context as HostRequestContext).isCurrent !== "function" ||
		typeof (context as HostRequestContext).signal !== "object" ||
		(context as HostRequestContext).signal === null ||
		typeof (context as HostRequestContext).signal.aborted !== "boolean" ||
		typeof (context as HostRequestContext).signal.addEventListener !== "function"
	) {
		throw new Error("host request context is invalid");
	}
}

export function createHostRequestHandler<T extends HostRequestHandlerImplementation>(
	implementation: T,
	..._unaryRejection: Parameters<T> extends [unknown, unknown, ...unknown[]]
		? []
		: ["host request handlers must accept payload and context"]
): HostRequestHandlerCapability {
	if (implementation.length < 2) throw new Error("host request handlers must accept payload and context");
	const handler = async (payload: Record<string, unknown>, context: HostRequestContext) => {
		assertGenuineHostRequestContext(context);
		return implementation(payload, context);
	};
	factoryCreatedHostRequestHandlers.add(handler);
	return Object.defineProperty(handler, hostRequestHandlerBrand, { value: true }) as HostRequestHandlerCapability;
}

export function assertHostRequestHandler(value: unknown): asserts value is HostRequestHandlerCapability {
	if (
		typeof value !== "function" ||
		(value as Partial<HostRequestHandlerCapability>)[hostRequestHandlerBrand] !== true ||
		!factoryCreatedHostRequestHandlers.has(value)
	) {
		throw new Error("host request handler is not a dispatcher-created capability");
	}
}

export type HostRequestHandlers = Record<string, HostRequestHandler>;

export interface KernelSnapshotConfig {
	path: string;
	manifestPath: string;
	maxBytes?: number;
	debounceMs?: number;
}

export interface KernelManagerOptions {
	bun?: string;
	cwd?: string;
	env?: Record<string, string>;
	sessionId?: string;
	hostHandlers?: HostRequestHandlers;
	snapshot?: KernelSnapshotConfig;
	recoverySnapshot?: KernelSnapshotConfig;
	workerPath?: string;
	kernelDirectory?: string;
	commandPrefix?: string;
	shellPath?: string;
	javascriptSkills?: readonly JavaScriptSkillRuntimeInfo[];
	smol?: boolean;
	readyTimeoutMs?: number;
	skillFactoryTimeoutMs?: number;
	checkpointTimeoutMs?: number;
	structuredShellTimeoutMs?: number;
}

export interface KernelStartOptions {
	onBootstrapProgress?: KernelBootstrapProgressHandler;
	signal?: AbortSignal;
}

export interface ExecuteOptions {
	signal?: AbortSignal;
	onStream?: (chunk: string, name: "stdout" | "stderr") => void;
	onLateSentAgentMessage?: (message: KernelSentAgentMessage) => void;
	maxOutputChars?: number;
	internal?: boolean;
}

type KernelExecutionInput =
	| { type: "execute"; code: string }
	| { type: "execute_actions"; actions: readonly BunStructuredAction[] };

export interface KernelDiffDisplay {
	path: string;
	oldStr: string;
	newStr: string;
	startLine?: number;
}

export interface KernelAttachment {
	mimeType: string;
	data: string;
	path?: string;
}

export interface KernelSentAgentMessage {
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

export interface KernelExecutionTimings {
	startupMs: number;
	queueMs: number;
	checkpointMs: number;
	executionMs: number;
	totalMs: number;
}

export type KernelManagerState = "idle" | "starting" | "running" | "recovering" | "shutdown";

export interface KernelManagerStatus {
	state: KernelManagerState;
	diagnostics: string;
	recovery: {
		available: boolean;
		checkpoint: "clean" | "dirty" | "ready" | "failed";
		lastCheckpoint?: SnapshotResult;
		lastRestore?: RestoreResult;
	};
}

export interface ExecuteResult {
	stdout: string;
	stderr: string;
	result?: string;
	diffs?: KernelDiffDisplay[];
	attachments?: KernelAttachment[];
	sentAgentMessages?: KernelSentAgentMessage[];
	status: "ok" | "error" | "aborted";
	error?: { ename: string; evalue: string; traceback: string[] };
	durationMs: number;
	timings?: KernelExecutionTimings;
}

type MessageType = BunWorkerToHostMessage["type"];
type MessageOfType<T extends MessageType> = Extract<BunWorkerToHostMessage, { type: T }>;

interface PendingProtocolRequest {
	expectedType: MessageType;
	resolve: (message: BunWorkerToHostMessage) => void;
	reject: (error: Error) => void;
}

interface ActiveExecution {
	requestId: string;
	cellId: string;
	code: string;
	startedAt: number;
	maxChars: number;
	opts: ExecuteOptions;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	diffs: KernelDiffDisplay[];
	attachments: KernelAttachment[];
	sentAgentMessages: KernelSentAgentMessage[];
	aborting: boolean;
	fatalDisplayError?: string;
}

interface KernelExecutionOutcome {
	result: ExecuteResult;
	stateChanged: boolean;
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
}

interface KernelRestoreOutcome extends RestoreResult {
	runtimeRestored: boolean;
}

interface KernelSnapshotOutcome {
	snapshot: SnapshotResult;
	persistentMirror?: {
		bytes: number;
		path: string;
		error?: string;
	};
}

function publicRestoreResult(result: KernelRestoreOutcome): RestoreResult {
	return { failed: result.failed, path: result.path, restored: result.restored };
}

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function elapsedMilliseconds(startedAt: number): number {
	const elapsed = performance.now() - startedAt;
	return Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
}

function roundMilliseconds(value: number): number {
	return Math.round(Number.isFinite(value) ? Math.max(0, value) : 0);
}

function positiveTimeout(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function descendantProcessIds(rootPid: number): number[] {
	const snapshot = spawnSync("ps", ["-axo", "pid=,ppid="], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 1_000,
		windowsHide: true,
	});
	if (snapshot.status !== 0 || typeof snapshot.stdout !== "string") return [];
	const childrenByParent = new Map<number, number[]>();
	for (const line of snapshot.stdout.split("\n")) {
		const [pidText, parentPidText] = line.trim().split(/\s+/, 2);
		const pid = Number(pidText);
		const parentPid = Number(parentPidText);
		if (!Number.isInteger(pid) || !Number.isInteger(parentPid) || pid <= 0 || parentPid <= 0) continue;
		const children = childrenByParent.get(parentPid) ?? [];
		children.push(pid);
		childrenByParent.set(parentPid, children);
	}
	const descendants: number[] = [];
	const pending = [...(childrenByParent.get(rootPid) ?? [])];
	while (pending.length > 0) {
		const pid = pending.shift();
		if (pid === undefined) break;
		descendants.push(pid);
		pending.push(...(childrenByParent.get(pid) ?? []));
	}
	return descendants;
}

function skillUnavailableReason(
	skill: JavaScriptSkillRuntimeInfo | PreparedJavaScriptSkillRuntimeInfo,
): string | undefined {
	return "unavailableReason" in skill ? skill.unavailableReason : undefined;
}

function createKernelStartupAbortError(): Error {
	return new Error("Kernel startup aborted");
}

function createRecoveryCheckpointAbortError(): Error {
	const error = new Error("Bun recovery checkpoint aborted");
	error.name = "AbortError";
	return error;
}

function raceRecoveryCheckpointWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(createRecoveryCheckpointAbortError());
	return new Promise<T>((resolve, reject) => {
		let abortTimer: ReturnType<typeof setTimeout> | undefined;
		const abort = () => {
			signal.removeEventListener("abort", abort);
			abortTimer = setTimeout(() => {
				abortTimer = undefined;
				reject(createRecoveryCheckpointAbortError());
			}, RECOVERY_CHECKPOINT_ABORT_GRACE_MS);
			abortTimer.unref?.();
		};
		const cleanup = () => {
			signal.removeEventListener("abort", abort);
			if (abortTimer) clearTimeout(abortTimer);
		};
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

function raceStartupWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(createKernelStartupAbortError());
	return new Promise<T>((resolve, reject) => {
		const abort = () => {
			cleanup();
			reject(createKernelStartupAbortError());
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

function parseDiffDisplay(payload: unknown): KernelDiffDisplay | undefined {
	if (!isRecord(payload)) return undefined;
	const path = payload.path;
	const oldStr = payload.old_str ?? payload.oldStr;
	const newStr = payload.new_str ?? payload.newStr;
	const startLine = payload.start_line ?? payload.startLine;
	if (typeof path !== "string" || typeof oldStr !== "string" || typeof newStr !== "string") return undefined;
	return { path, oldStr, newStr, ...(typeof startLine === "number" ? { startLine } : {}) };
}

function parseAttachmentDisplay(payload: unknown): KernelAttachment | "oversized" | undefined {
	if (!isRecord(payload)) return undefined;
	const mimeType = payload.mime_type ?? payload.mimeType;
	const data = payload.data;
	const path = payload.path;
	if (typeof mimeType !== "string" || typeof data !== "string") return undefined;
	if (data.length > MAX_ATTACHMENT_DATA_CHARS) return "oversized";
	return { mimeType, data, ...(typeof path === "string" ? { path } : {}) };
}

function parseSentAgentMessage(payload: unknown): KernelSentAgentMessage | undefined {
	if (!isRecord(payload) || !isRecord(payload.target)) return undefined;
	const { id, message, deliveryStatus, receiverRole, target } = payload;
	const { activeSessionId, sessionId, sessionName } = target;
	if (
		typeof id !== "string" ||
		typeof message !== "string" ||
		(deliveryStatus !== "delivered" && deliveryStatus !== "queued") ||
		typeof activeSessionId !== "string" ||
		typeof sessionId !== "string"
	) {
		return undefined;
	}
	return {
		id,
		message,
		deliveryStatus,
		...(receiverRole === "parent" || receiverRole === "sibling" || receiverRole === "child" ? { receiverRole } : {}),
		target: {
			activeSessionId,
			sessionId,
			...(typeof sessionName === "string" ? { sessionName } : {}),
		},
	};
}

function resolveWorkerPath(configuredPath: string | undefined): string {
	if (configuredPath) return configuredPath;
	const compiledPath = fileURLToPath(new URL("./bun-worker.js", import.meta.url));
	if (existsSync(compiledPath)) return compiledPath;
	return fileURLToPath(new URL("./bun-worker.ts", import.meta.url));
}

const liveKernels = new Set<KernelManager>();
let signalHandlersInstalled = false;

registerSessionResourceCleanup((sessionId) => {
	for (const manager of liveKernels) {
		if (!sessionId || manager.ownerSessionId === sessionId) void manager.dispose();
	}
});

function installSignalHandlersOnce(): void {
	if (signalHandlersInstalled) return;
	signalHandlersInstalled = true;
	const shutdown = async (): Promise<void> => {
		await Promise.allSettled([...liveKernels].map((manager) => manager.shutdown({ snapshot: true })));
	};
	process.on("beforeExit", () => void shutdown());
	process.on("SIGINT", () => void shutdown().finally(() => process.exit(130)));
	process.on("SIGTERM", () => void shutdown().finally(() => process.exit(143)));
	process.on("exit", () => {
		for (const manager of liveKernels) manager.disposeSync();
	});
}

export class KernelManager {
	private readonly options: KernelManagerOptions;
	private worker?: ChildProcess;
	private protocolInput?: Writable;
	private readonly protocolBuffers = new WeakMap<ChildProcess, string>();
	private state: KernelManagerState = "idle";
	private startPromise?: Promise<void>;
	private recoveryPromise?: Promise<void>;
	private recoveryFailure?: Error;
	private executionQueue: Promise<void> = Promise.resolve();
	private activeExecution?: ActiveExecution;
	private readonly pendingProtocolRequests = new Map<string, PendingProtocolRequest>();
	private readonly trackedShellChildPids = new Set<number>();
	private readonly inFlightHostRequests = new Set<Promise<void>>();
	private readonly lateSentAgentMessageHandlers = new Map<string, (message: KernelSentAgentMessage) => void>();
	private readonly harnessHostHandlers: HostRequestHandlers;
	private kernelDiagnostics = "";
	private snapshotTimer?: ReturnType<typeof globalThis.setTimeout>;
	private recoverySnapshotDirty = false;
	private persistentSnapshotDirty = false;
	private recoverySnapshotAvailable = false;
	private recoveryCheckpointStatus: KernelManagerStatus["recovery"]["checkpoint"] = "clean";
	private lastRecoveryCheckpoint?: SnapshotResult;
	private lastRecoveryRestore?: RestoreResult;
	private recoverySnapshotConfig?: KernelSnapshotConfig;
	private recoveryTempDir?: string;

	constructor(options: KernelManagerOptions = {}) {
		this.options = options;
		const environment = { ...process.env, ...options.env };
		this.harnessHostHandlers = environment.RLM_GLOBAL_HARNESS_STATE_DIR
			? createHarnessHostHandlers({
					globalDirectory: environment.RLM_GLOBAL_HARNESS_STATE_DIR,
					localDirectory: environment.RLM_HARNESS_STATE_DIR,
				})
			: {};
	}

	get ownerSessionId(): string | undefined {
		return this.options.sessionId;
	}

	get isRunning(): boolean {
		return this.state === "running";
	}

	get status(): KernelManagerStatus {
		return {
			diagnostics: this.kernelDiagnostics,
			recovery: {
				available: this.recoverySnapshotAvailable,
				checkpoint: this.recoveryCheckpointStatus,
				...(this.lastRecoveryCheckpoint
					? {
							lastCheckpoint: {
								...this.lastRecoveryCheckpoint,
								path: this.lastRecoveryCheckpoint.path.slice(0, MAX_KERNEL_STATUS_DETAIL_CHARS),
								saved: this.lastRecoveryCheckpoint.saved
									.slice(0, MAX_KERNEL_STATUS_ENTRIES)
									.map((name) => name.slice(0, MAX_KERNEL_STATUS_DETAIL_CHARS)),
								skipped: this.lastRecoveryCheckpoint.skipped
									.slice(0, MAX_KERNEL_STATUS_ENTRIES)
									.map(({ name, reason }) => ({
										name: name.slice(0, MAX_KERNEL_STATUS_DETAIL_CHARS),
										reason: reason.slice(0, MAX_KERNEL_STATUS_DETAIL_CHARS),
									})),
							},
						}
					: {}),
				...(this.lastRecoveryRestore
					? {
							lastRestore: {
								...this.lastRecoveryRestore,
								failed: this.lastRecoveryRestore.failed
									.slice(0, MAX_KERNEL_STATUS_ENTRIES)
									.map(({ name, reason }) => ({
										name: name.slice(0, MAX_KERNEL_STATUS_DETAIL_CHARS),
										reason: reason.slice(0, MAX_KERNEL_STATUS_DETAIL_CHARS),
									})),
								path: this.lastRecoveryRestore.path.slice(0, MAX_KERNEL_STATUS_DETAIL_CHARS),
								restored: this.lastRecoveryRestore.restored
									.slice(0, MAX_KERNEL_STATUS_ENTRIES)
									.map((name) => name.slice(0, MAX_KERNEL_STATUS_DETAIL_CHARS)),
							},
						}
					: {}),
			},
			state: this.state,
		};
	}

	async start(options: KernelStartOptions = {}): Promise<void> {
		if (options.signal?.aborted) throw createKernelStartupAbortError();
		if (this.recoveryPromise) await raceStartupWithAbort(this.recoveryPromise, options.signal);
		if (this.recoveryFailure) {
			throw new Error(`Bun kernel recovery is blocked: ${this.recoveryFailure.message}`, {
				cause: this.recoveryFailure,
			});
		}
		if (!this.startPromise) {
			this.startPromise = this.startWorker(options.onBootstrapProgress).catch((error) => {
				this.startPromise = undefined;
				throw error;
			});
		}
		return raceStartupWithAbort(this.startPromise, options.signal);
	}

	private async startWorker(onProgress?: KernelBootstrapProgressHandler): Promise<void> {
		if (this.state === "running") return;
		if (this.state === "shutdown") throw new Error("Kernel has been shut down");
		this.state = "starting";
		installSignalHandlersOnce();
		liveKernels.add(this);
		let spawnedWorker: ChildProcess | undefined;
		try {
			onProgress?.("Resolving Bun runtime");
			const javascriptSkills = this.options.javascriptSkills ?? [];
			const bootstrappedRuntime = this.options.workerPath
				? undefined
				: await ensureKernelBun({ javascriptSkills, onProgress });
			const runtime =
				bootstrappedRuntime ??
				(await resolveBunRuntime({
					env: this.options.bun ? { ...process.env, PRIME_AGENT_KERNEL_BUN: this.options.bun } : process.env,
				}));
			if ((this.state as KernelManagerState) === "shutdown") throw new Error("Kernel was disposed during startup");
			onProgress?.("Starting Bun worker");
			const workerPath = this.options.workerPath ?? bootstrappedRuntime?.workerPath;
			const kernelDirectory = this.options.kernelDirectory ?? bootstrappedRuntime?.kernelDirectory ?? process.cwd();
			for (const diagnostic of bootstrappedRuntime?.skillDiagnostics ?? []) {
				this.appendKernelDiagnostic(diagnostic.message);
			}
			const workerEnvironment: NodeJS.ProcessEnv = { ...process.env, ...this.options.env };
			const preparedSkills = bootstrappedRuntime?.preparedSkills ?? javascriptSkills;
			const shell = getShellConfig(this.options.shellPath);
			const workerArguments = [...(this.options.smol === false ? [] : ["--smol"]), resolveWorkerPath(workerPath)];
			const worker = spawn(runtime.path, workerArguments, {
				cwd: this.options.cwd,
				detached: process.platform !== "win32",
				env: workerEnvironment,
				stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
			});
			spawnedWorker = worker;
			const protocolInput = worker.stdio[3] as Writable | null;
			const protocolOutput = worker.stdio[4] as Readable | null;
			if (!protocolInput || !protocolOutput) throw new Error("Bun worker protocol pipes were not created");
			this.worker = worker;
			this.protocolInput = protocolInput;
			this.attachWorkerStreams(worker, protocolOutput);

			const ready = await this.sendRequest(
				{
					bunPath: runtime.path,
					commandPrefix: this.options.commandPrefix ?? "",
					cwd: this.options.cwd ?? process.cwd(),
					id: randomUUID(),
					kernelDirectory,
					protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
					shell: { args: [...shell.args], executable: shell.shell },
					skillFactoryTimeoutMs: positiveTimeout(
						this.options.skillFactoryTimeoutMs,
						DEFAULT_SKILL_FACTORY_TIMEOUT_MS,
					),
					structuredShellTimeoutMs: positiveTimeout(
						this.options.structuredShellTimeoutMs,
						DEFAULT_STRUCTURED_SHELL_TIMEOUT_MS,
					),
					skills: preparedSkills.map((skill) => ({
						entryPath: skill.entryPath,
						globalName: skill.globalName,
						name: skill.name,
						...(skillUnavailableReason(skill) !== undefined
							? { unavailableReason: skillUnavailableReason(skill) }
							: {}),
					})),
					type: "initialize",
				},
				"ready",
				positiveTimeout(this.options.readyTimeoutMs, DEFAULT_WORKER_READY_TIMEOUT_MS),
				"Bun worker readiness",
			);
			if (ready.bunVersion !== runtime.version) {
				throw new Error(`Bun worker version mismatch: resolved ${runtime.version}, started ${ready.bunVersion}`);
			}
			this.state = "running";
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			if (spawnedWorker && this.worker === spawnedWorker) {
				this.stopCurrentWorker("SIGKILL", failure);
			} else if (spawnedWorker) {
				this.terminateWorkerProcess(spawnedWorker, "SIGKILL");
			}
			if ((this.state as string) !== "shutdown") this.state = "idle";
			liveKernels.delete(this);
			throw failure;
		}
	}

	private attachWorkerStreams(worker: ChildProcess, protocolOutput: Readable): void {
		worker.stdout?.setEncoding("utf8");
		worker.stdout?.on("data", (chunk: string) => this.handleWorkerStream(worker, chunk, "stdout"));
		worker.stderr?.setEncoding("utf8");
		worker.stderr?.on("data", (chunk: string) => this.handleWorkerStream(worker, chunk, "stderr"));
		protocolOutput.setEncoding("utf8");
		protocolOutput.on("data", (chunk: string) => this.handleProtocolChunk(worker, chunk));
		worker.on("error", (error) => this.handleWorkerFailure(worker, error));
		worker.on("exit", (code, signal) => {
			this.handleWorkerFailure(
				worker,
				new Error(`Bun worker exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`),
			);
		});
	}

	private handleWorkerStream(worker: ChildProcess, chunk: string, name: "stdout" | "stderr"): void {
		if (this.worker !== worker) return;
		this.appendKernelDiagnostic(`${name}: ${chunk}`);
	}

	private handleCellStream(message: BunWorkerStreamMessage): void {
		const execution = this.activeExecution;
		if (!execution || execution.cellId !== message.cellId) return;
		if (message.name === "stdout") {
			if (execution.stdout.length < execution.maxChars) {
				execution.stdout += message.text;
				if (execution.stdout.length > execution.maxChars) {
					execution.stdout = execution.stdout.slice(0, execution.maxChars);
					execution.stdoutTruncated = true;
				}
			}
		} else if (execution.stderr.length < execution.maxChars) {
			execution.stderr += message.text;
			if (execution.stderr.length > execution.maxChars) {
				execution.stderr = execution.stderr.slice(0, execution.maxChars);
				execution.stderrTruncated = true;
			}
		}
		execution.opts.onStream?.(message.text, message.name);
	}

	private handleProtocolChunk(worker: ChildProcess, chunk: string): void {
		const lines = `${this.protocolBuffers.get(worker) ?? ""}${chunk}`.split("\n");
		this.protocolBuffers.set(worker, lines.pop() ?? "");
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const message = JSON.parse(line) as BunWorkerToHostMessage;
				if (this.worker === worker) {
					this.handleProtocolMessage(worker, message);
				} else if (message.type === "shell_child_started" && Number.isInteger(message.pid) && message.pid > 0) {
					killProcessTree(message.pid, "SIGKILL");
				}
			} catch (error) {
				if (this.worker === worker) {
					this.appendKernelDiagnostic(`invalid worker protocol message: ${errorMessage(error)}`);
				}
			}
		}
	}

	private handleProtocolMessage(worker: ChildProcess, message: BunWorkerToHostMessage): void {
		if (message.protocolVersion !== BUN_WORKER_PROTOCOL_VERSION) {
			const failure = new Error(
				`Bun worker protocol version ${message.protocolVersion} does not match host version ${BUN_WORKER_PROTOCOL_VERSION}`,
			);
			if (message.replyTo) {
				const pending = this.pendingProtocolRequests.get(message.replyTo);
				if (pending) {
					this.pendingProtocolRequests.delete(message.replyTo);
					pending.reject(failure);
					return;
				}
			}
			this.appendKernelDiagnostic(failure.message);
			return;
		}
		if (message.type === "host_request") {
			this.startHostRequest(message);
			return;
		}
		if (message.type === "stream") {
			this.handleCellStream(message);
			return;
		}
		if (message.type === "display") {
			this.handleDisplay(message);
			return;
		}
		if (message.type === "shell_child_started") {
			if (this.worker === worker) this.trackedShellChildPids.add(message.pid);
			return;
		}
		if (message.type === "shell_child_exited") {
			this.trackedShellChildPids.delete(message.pid);
			return;
		}
		if (message.type === "protocol_error" && message.replyTo) {
			const pending = this.pendingProtocolRequests.get(message.replyTo);
			if (pending) {
				this.pendingProtocolRequests.delete(message.replyTo);
				pending.reject(new Error(`${message.error.name}: ${message.error.message}`));
				return;
			}
		}
		if (message.type === "diagnostic" || message.type === "protocol_error") {
			this.appendKernelDiagnostic(`${message.error.name}: ${message.error.message}`);
			return;
		}
		if (!message.replyTo) return;
		const pending = this.pendingProtocolRequests.get(message.replyTo);
		if (!pending) return;
		if (pending.expectedType !== message.type) {
			pending.reject(new Error(`Expected ${pending.expectedType}, received ${message.type}`));
			this.pendingProtocolRequests.delete(message.replyTo);
			return;
		}
		this.pendingProtocolRequests.delete(message.replyTo);
		pending.resolve(message);
	}

	private send(message: HostToBunWorkerMessage): void {
		if (!this.protocolInput || this.protocolInput.destroyed || this.protocolInput.writableEnded) {
			throw new Error("Bun worker protocol input is not available");
		}
		this.protocolInput.write(`${JSON.stringify(message)}\n`);
	}

	private sendRequest<T extends MessageType>(
		message: HostToBunWorkerMessage,
		expectedType: T,
		timeoutMs?: number,
		timeoutLabel = `Bun worker ${expectedType} response`,
	): Promise<MessageOfType<T>> {
		return new Promise<BunWorkerToHostMessage>((resolve, reject) => {
			let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
			const clearTimer = () => {
				if (!timer) return;
				globalThis.clearTimeout(timer);
				timer = undefined;
			};
			const pending: PendingProtocolRequest = {
				expectedType,
				reject: (error) => {
					clearTimer();
					reject(error);
				},
				resolve: (response) => {
					clearTimer();
					resolve(response);
				},
			};
			this.pendingProtocolRequests.set(message.id, pending);
			if (timeoutMs !== undefined) {
				timer = globalThis.setTimeout(() => {
					if (this.pendingProtocolRequests.get(message.id) !== pending) return;
					this.pendingProtocolRequests.delete(message.id);
					pending.reject(new Error(`${timeoutLabel} timed out after ${timeoutMs} ms`));
				}, timeoutMs);
				timer.unref?.();
			}
			try {
				this.send(message);
			} catch (error) {
				this.pendingProtocolRequests.delete(message.id);
				pending.reject(error instanceof Error ? error : new Error(String(error)));
			}
		}).then((message) => message as MessageOfType<T>);
	}

	async execute(code: string, opts: ExecuteOptions = {}): Promise<ExecuteResult> {
		return this.executeInput({ code, type: "execute" }, opts);
	}

	async executeActions(actions: readonly BunStructuredAction[], opts: ExecuteOptions = {}): Promise<ExecuteResult> {
		return this.executeInput({ actions, type: "execute_actions" }, opts);
	}

	private async executeInput(input: KernelExecutionInput, opts: ExecuteOptions): Promise<ExecuteResult> {
		const totalStartedAt = performance.now();
		if (opts.signal?.aborted) return { stdout: "", stderr: "", status: "aborted", durationMs: 0 };
		const startupStartedAt = performance.now();
		await this.start({ signal: opts.signal });
		const startupMs = elapsedMilliseconds(startupStartedAt);
		const queueStartedAt = performance.now();
		let queueMs = 0;
		return this.withExecutionLock(
			async () => {
				if (opts.signal?.aborted) return { stdout: "", stderr: "", status: "aborted", durationMs: 0 };
				let checkpointMs = 0;
				let executionOutcome: KernelExecutionOutcome | undefined;
				if (this.recoverySnapshotDirty) {
					const checkpointStartedAt = performance.now();
					try {
						await this.requireRecoveryCheckpoint(opts.signal);
					} catch (error) {
						if (!opts.signal?.aborted) throw error;
						executionOutcome = {
							result: { durationMs: 0, status: "aborted", stderr: "", stdout: "" },
							stateChanged: false,
						};
					}
					checkpointMs = elapsedMilliseconds(checkpointStartedAt);
				}
				if (!executionOutcome && opts.signal?.aborted) {
					executionOutcome = {
						result: { durationMs: 0, status: "aborted", stderr: "", stdout: "" },
						stateChanged: false,
					};
				}
				executionOutcome ??= await this.executeInner(input, opts);
				const { result, stateChanged } = executionOutcome;
				if (stateChanged) {
					this.recoverySnapshotDirty = true;
					this.recoveryCheckpointStatus = "dirty";
					if (this.options.snapshot) this.persistentSnapshotDirty = true;
				}
				if (this.options.snapshot && this.persistentSnapshotDirty) this.scheduleSnapshot();
				const executionMs = Number.isFinite(result.durationMs) ? Math.max(0, result.durationMs) : 0;
				const totalMs = Math.max(
					elapsedMilliseconds(totalStartedAt),
					startupMs,
					queueMs,
					checkpointMs,
					executionMs,
				);
				const timings: KernelExecutionTimings = {
					checkpointMs: roundMilliseconds(checkpointMs),
					executionMs: roundMilliseconds(executionMs),
					queueMs: roundMilliseconds(queueMs),
					startupMs: roundMilliseconds(startupMs),
					totalMs: roundMilliseconds(totalMs),
				};
				return { ...result, durationMs: timings.totalMs, timings };
			},
			() => {
				queueMs = elapsedMilliseconds(queueStartedAt);
			},
		);
	}

	private async executeInner(input: KernelExecutionInput, opts: ExecuteOptions): Promise<KernelExecutionOutcome> {
		if (this.state !== "running") throw new Error("Bun kernel is not running");
		const requestId = randomUUID();
		const cellId = randomUUID();
		const execution: ActiveExecution = {
			aborting: false,
			attachments: [],
			cellId,
			code: input.type === "execute" ? input.code : "[structured actions]",
			diffs: [],
			maxChars: Math.max(0, Math.floor(opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS)),
			opts,
			requestId,
			sentAgentMessages: [],
			startedAt: performance.now(),
			stderr: "",
			stderrTruncated: false,
			stdout: "",
			stdoutTruncated: false,
		};
		this.activeExecution = execution;
		const aborted = createDeferred<void>();
		const onAbort = () => {
			if (execution.aborting) return;
			execution.aborting = true;
			void this.abortAndRecover(execution)
				.catch((error) => this.appendKernelDiagnostic(`worker recovery failed: ${errorMessage(error)}`))
				.finally(() => aborted.resolve());
		};
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		if (opts.signal?.aborted) onAbort();

		const request: HostToBunWorkerMessage =
			input.type === "execute"
				? {
						cellId,
						code: input.code,
						id: requestId,
						maxResultChars: execution.maxChars,
						protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
						type: "execute",
					}
				: {
						actions: [...input.actions],
						cellId,
						id: requestId,
						maxResultChars: execution.maxChars,
						protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
						type: "execute_actions",
					};
		const response = this.sendRequest(request, "result").then(
			(message) => ({ kind: "result" as const, message }),
			(error: unknown) => ({ kind: "error" as const, error }),
		);
		try {
			const outcome = await Promise.race([response, aborted.promise.then(() => ({ kind: "aborted" as const }))]);
			if (outcome.kind === "aborted") {
				return { result: this.executionResult(execution, "aborted"), stateChanged: false };
			}
			if (outcome.kind === "error") {
				if (execution.aborting) {
					await aborted.promise;
					return { result: this.executionResult(execution, "aborted"), stateChanged: false };
				}
				throw outcome.error;
			}
			await new Promise<void>((resolve) => setImmediate(resolve));
			if (execution.aborting) {
				await aborted.promise;
				return { result: this.executionResult(execution, "aborted"), stateChanged: false };
			}
			if (outcome.message.status === "error") {
				return {
					result: this.executionResult(
						execution,
						"error",
						{
							ename: outcome.message.error.name,
							evalue: outcome.message.error.message,
							traceback: outcome.message.error.stack?.split("\n") ?? [],
						},
						undefined,
						outcome.message.durationMs,
					),
					stateChanged: outcome.message.stateChanged,
				};
			}
			if (execution.fatalDisplayError) {
				return {
					result: this.executionResult(
						execution,
						"error",
						{
							ename: "AttachmentTooLargeError",
							evalue: execution.fatalDisplayError,
							traceback: [execution.fatalDisplayError],
						},
						outcome.message.value,
						outcome.message.durationMs,
					),
					stateChanged: outcome.message.stateChanged,
				};
			}
			return {
				result: this.executionResult(execution, "ok", undefined, outcome.message.value, outcome.message.durationMs),
				stateChanged: outcome.message.stateChanged,
			};
		} finally {
			opts.signal?.removeEventListener("abort", onAbort);
			if (this.activeExecution === execution) this.activeExecution = undefined;
			if (opts.onLateSentAgentMessage) this.registerLateSentAgentMessageHandler(cellId, opts.onLateSentAgentMessage);
		}
	}

	private executionResult(
		execution: ActiveExecution,
		status: ExecuteResult["status"],
		error?: ExecuteResult["error"],
		result?: string,
		executionDurationMs?: number,
	): ExecuteResult {
		let stdout = execution.stdout;
		let stderr = execution.stderr;
		let boundedResult = result;
		if (execution.stdoutTruncated) stdout += `\n[... output truncated at ${execution.maxChars} chars ...]`;
		if (execution.stderrTruncated) stderr += `\n[... output truncated at ${execution.maxChars} chars ...]`;
		if (boundedResult !== undefined && boundedResult.length > execution.maxChars) {
			boundedResult = `${boundedResult.slice(0, execution.maxChars)}\n[... output truncated at ${execution.maxChars} chars ...]`;
		}
		return {
			attachments: execution.attachments.length > 0 ? execution.attachments : undefined,
			diffs: execution.diffs.length > 0 ? execution.diffs : undefined,
			durationMs: executionDurationMs ?? elapsedMilliseconds(execution.startedAt),
			error,
			result: boundedResult,
			sentAgentMessages: execution.sentAgentMessages.length > 0 ? execution.sentAgentMessages : undefined,
			status,
			stderr,
			stdout,
		};
	}

	private handleDisplay(message: BunWorkerDisplayMessage): void {
		const execution = this.activeExecution;
		if (!execution || execution.cellId !== message.cellId) {
			const sentAgentMessage =
				message.mimeType === AGENT_MESSAGE_DISPLAY_MIME ? parseSentAgentMessage(message.data) : undefined;
			const handler = this.lateSentAgentMessageHandlers.get(message.cellId);
			if (sentAgentMessage && handler) handler(sentAgentMessage);
			return;
		}
		if (message.mimeType === DIFF_DISPLAY_MIME) {
			const diff = parseDiffDisplay(message.data);
			if (diff) execution.diffs.push(diff);
			return;
		}
		if (message.mimeType === ATTACHMENT_DISPLAY_MIME) {
			const attachment = parseAttachmentDisplay(message.data);
			if (attachment === "oversized") {
				const error = `attachment dropped: exceeds ${MAX_ATTACHMENT_DATA_CHARS} base64 chars`;
				execution.fatalDisplayError = error;
				execution.stderr += `${execution.stderr ? "\n" : ""}${error}`;
			} else if (attachment) {
				execution.attachments.push(attachment);
			}
			return;
		}
		if (message.mimeType === AGENT_MESSAGE_DISPLAY_MIME) {
			const sentAgentMessage = parseSentAgentMessage(message.data);
			if (sentAgentMessage) execution.sentAgentMessages.push(sentAgentMessage);
		}
	}

	private startHostRequest(message: BunWorkerHostRequestMessage): void {
		const task = (async () => {
			try {
				const handler =
					this.options.hostHandlers?.[message.requestType] ?? this.harnessHostHandlers[message.requestType];
				if (!handler)
					throw new Error(`host request type "${message.requestType}" is not available in this session`);
				const payload = isRecord(message.payload)
					? { ...message.payload, type: message.requestType, cellSourceCode: message.cellSource }
					: { type: message.requestType, payload: message.payload, cellSourceCode: message.cellSource };
				const value = await handler(payload);
				this.send({
					id: randomUUID(),
					protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
					requestId: message.requestId,
					type: "host_response",
					value,
				});
			} catch (error) {
				try {
					this.send({
						error: { message: errorMessage(error), name: error instanceof Error ? error.name : "Error" },
						id: randomUUID(),
						protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
						requestId: message.requestId,
						type: "host_response",
					});
				} catch (replyError) {
					this.appendKernelDiagnostic(`failed to send host error response: ${errorMessage(replyError)}`);
				}
			}
		})();
		this.inFlightHostRequests.add(task);
		void task.finally(() => this.inFlightHostRequests.delete(task));
	}

	private async abortAndRecover(execution: ActiveExecution): Promise<void> {
		if (this.activeExecution === execution) this.activeExecution = undefined;
		await this.recoverWorker(new Error("Bun cell aborted"));
	}

	private recoverWorker(reason: Error): Promise<void> {
		if (this.recoveryPromise) return this.recoveryPromise;
		this.recoveryFailure = undefined;
		this.state = "recovering";
		this.stopCurrentWorker("SIGKILL", reason);
		this.recoveryPromise = (async () => {
			this.state = "idle";
			this.startPromise = undefined;
			await this.startWorker();
			if (this.recoverySnapshotAvailable) await this.restoreRecoveryCheckpoint();
		})()
			.catch((error) => {
				const failure = error instanceof Error ? error : new Error(String(error));
				this.recoveryFailure = failure;
				this.recoveryCheckpointStatus = "failed";
				this.stopCurrentWorker("SIGKILL", failure);
				this.state = "idle";
				throw failure;
			})
			.finally(() => {
				this.recoveryPromise = undefined;
			});
		return this.recoveryPromise;
	}

	private handleWorkerFailure(worker: ChildProcess, reason: Error): void {
		if (this.worker !== worker || this.state === "shutdown") return;
		const failedDuringStartup = this.state === "starting";
		this.killTrackedShellChildren("SIGKILL");
		this.worker = undefined;
		this.protocolInput = undefined;
		this.startPromise = undefined;
		this.rejectPendingProtocolRequests(reason);
		this.appendKernelDiagnostic(reason.message);
		this.activeExecution = undefined;
		if (failedDuringStartup) {
			this.state = "idle";
			return;
		}
		if (!this.recoveryPromise) {
			this.recoveryFailure = undefined;
			this.state = "recovering";
			this.recoveryPromise = (async () => {
				this.state = "idle";
				await this.startWorker();
				if (this.recoverySnapshotAvailable) await this.restoreRecoveryCheckpoint();
			})()
				.catch((error) => {
					const failure = error instanceof Error ? error : new Error(String(error));
					this.recoveryFailure = failure;
					this.recoveryCheckpointStatus = "failed";
					this.stopCurrentWorker("SIGKILL", failure);
					this.state = "idle";
					this.appendKernelDiagnostic(`worker recovery failed: ${failure.message}`);
				})
				.finally(() => {
					this.recoveryPromise = undefined;
				});
		}
	}

	private stopCurrentWorker(signal: NodeJS.Signals, reason: Error): void {
		const worker = this.worker;
		this.worker = undefined;
		this.protocolInput = undefined;
		this.rejectPendingProtocolRequests(reason);
		this.killTrackedShellChildren(signal);
		if (!worker) return;
		this.terminateWorkerProcess(worker, signal);
	}

	private killTrackedShellChildren(signal: NodeJS.Signals): void {
		const pids = [...this.trackedShellChildPids];
		for (const pid of pids) killProcessTree(pid, signal);
		this.trackedShellChildPids.clear();
		if (signal !== "SIGTERM" || pids.length === 0) return;
		const forceKillTimer = setTimeout(() => {
			for (const pid of pids) killProcessTree(pid, "SIGKILL");
		}, GRACEFUL_SHELL_KILL_DELAY_MS);
		forceKillTimer.unref();
	}

	private terminateWorkerProcess(worker: ChildProcess, signal: NodeJS.Signals): void {
		if (worker.pid !== undefined) {
			if (process.platform !== "win32") {
				try {
					process.kill(worker.pid, "SIGSTOP");
				} catch {}
				const descendants = descendantProcessIds(worker.pid);
				for (const pid of descendants) killProcessTree(pid, signal);
				killProcessTree(worker.pid, signal);
				if (signal === "SIGTERM") {
					try {
						process.kill(worker.pid, "SIGCONT");
					} catch {}
					const forceKillTimer = setTimeout(() => {
						for (const pid of descendants) killProcessTree(pid, "SIGKILL");
						killProcessTree(worker.pid as number, "SIGKILL");
					}, GRACEFUL_SHELL_KILL_DELAY_MS);
					forceKillTimer.unref();
				}
				return;
			}
			killProcessTree(worker.pid, signal);
			return;
		}
		try {
			worker.kill(signal);
		} catch {}
	}

	private rejectPendingProtocolRequests(error: Error): void {
		for (const pending of this.pendingProtocolRequests.values()) pending.reject(error);
		this.pendingProtocolRequests.clear();
	}

	private getRecoverySnapshotConfig(): KernelSnapshotConfig {
		if (this.options.recoverySnapshot) return this.options.recoverySnapshot;
		if (!this.recoverySnapshotConfig) {
			this.recoveryTempDir = mkdtempSync(join(tmpdir(), "prime-agent-bun-recovery-"));
			this.recoverySnapshotConfig = {
				manifestPath: manifestPathIn(this.recoveryTempDir),
				path: snapshotPathIn(this.recoveryTempDir),
			};
		}
		return this.recoverySnapshotConfig;
	}

	private async flushRecoverySnapshot(signal?: AbortSignal): Promise<SnapshotResult | null> {
		const recoveryConfig = this.getRecoverySnapshotConfig();
		const persistentCandidate = this.persistentSnapshotDirty ? this.options.snapshot : undefined;
		const persistentMirror =
			persistentCandidate &&
			(persistentCandidate.maxBytes ?? DEFAULT_SNAPSHOT_MAX_BYTES) ===
				(recoveryConfig.maxBytes ?? DEFAULT_SNAPSHOT_MAX_BYTES)
				? persistentCandidate
				: undefined;
		const outcome = await this.snapshotTo(recoveryConfig, true, signal, persistentMirror);
		const result = outcome?.snapshot ?? null;
		if (result) {
			this.recoverySnapshotDirty = false;
			this.recoverySnapshotAvailable = true;
			this.recoveryCheckpointStatus = "ready";
			this.lastRecoveryCheckpoint = result;
			if (persistentMirror && outcome?.persistentMirror) {
				if (outcome.persistentMirror.error) {
					this.appendKernelDiagnostic(`persistent state snapshot failed: ${outcome.persistentMirror.error}`);
				} else {
					this.persistentSnapshotDirty = false;
				}
			}
		}
		return result;
	}

	private async requireRecoveryCheckpoint(signal?: AbortSignal): Promise<SnapshotResult> {
		try {
			const result = await this.flushRecoverySnapshot(signal);
			if (!result) throw new Error("the worker did not produce a recovery snapshot");
			return result;
		} catch (error) {
			const message = errorMessage(error);
			const failure = new Error(`Bun recovery checkpoint failed; refusing to execute the next cell: ${message}`, {
				cause: error,
			});
			this.recoveryCheckpointStatus = "failed";
			this.recoveryFailure = failure;
			this.appendKernelDiagnostic(`recovery checkpoint failed: ${message}`);
			this.stopCurrentWorker("SIGKILL", failure);
			if (this.state !== "shutdown") this.state = "idle";
			throw failure;
		}
	}

	private async restoreRecoveryCheckpoint(): Promise<RestoreResult> {
		const outcome = await this.restoreFrom(this.getRecoverySnapshotConfig(), true);
		if (!outcome) throw new Error("Bun recovery checkpoint could not be restored");
		const result = publicRestoreResult(outcome);
		this.lastRecoveryRestore = result;
		const restoredNames = new Set(outcome.restored);
		const missingNames = (this.lastRecoveryCheckpoint?.saved ?? []).filter((name) => !restoredNames.has(name));
		if (!outcome.runtimeRestored || outcome.failed.length > 0 || missingNames.length > 0) {
			const summary = [
				...(!outcome.runtimeRestored ? ["runtime cwd/environment was not restored"] : []),
				...(outcome.failed.length > 0 ? [`${outcome.failed.length} binding(s) failed`] : []),
				...(missingNames.length > 0
					? [
							`missing saved binding(s): ${missingNames
								.slice(0, MAX_KERNEL_STATUS_ENTRIES)
								.map((name) => name.slice(0, MAX_KERNEL_STATUS_DETAIL_CHARS))
								.join(", ")}`,
						]
					: []),
			].join("; ");
			this.appendKernelDiagnostic(`recovery checkpoint restore incomplete: ${summary}`);
			throw new Error(`Bun recovery checkpoint restore failed: ${summary}`);
		}
		this.recoveryCheckpointStatus = "ready";
		return result;
	}

	private async flushPersistentSnapshot(): Promise<SnapshotResult | null> {
		if (!this.options.snapshot) return null;
		const result = (await this.snapshotTo(this.options.snapshot, false))?.snapshot ?? null;
		if (result) this.persistentSnapshotDirty = false;
		return result;
	}

	private async snapshotTo(
		config: KernelSnapshotConfig,
		includeRuntimeState: boolean,
		signal?: AbortSignal,
		persistentMirror?: KernelSnapshotConfig,
	): Promise<KernelSnapshotOutcome | null> {
		if (this.state !== "running") return null;
		const request = this.sendRequest(
			{
				id: randomUUID(),
				includeRuntimeState,
				manifestPath: config.manifestPath,
				maxBytes: config.maxBytes ?? DEFAULT_SNAPSHOT_MAX_BYTES,
				path: config.path,
				...(persistentMirror
					? { persistentMirror: { manifestPath: persistentMirror.manifestPath, path: persistentMirror.path } }
					: {}),
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "snapshot",
			},
			"snapshot_result",
			includeRuntimeState
				? positiveTimeout(this.options.checkpointTimeoutMs, DEFAULT_CHECKPOINT_TIMEOUT_MS)
				: undefined,
			"Bun recovery checkpoint",
		);
		const result = includeRuntimeState ? await raceRecoveryCheckpointWithAbort(request, signal) : await request;
		if (result.error) {
			this.appendKernelDiagnostic(`state snapshot failed: ${result.error}`);
			return null;
		}
		const snapshot = { bytes: result.bytes, path: result.path, saved: result.saved, skipped: result.skipped };
		if (snapshot.skipped.length > 0) {
			this.appendKernelDiagnostic(
				`state snapshot skipped ${snapshot.skipped.length} binding(s): ${snapshot.skipped
					.slice(0, MAX_KERNEL_STATUS_ENTRIES)
					.map(
						({ name, reason }) =>
							`${name.slice(0, MAX_KERNEL_STATUS_DETAIL_CHARS)} (${reason.slice(0, MAX_KERNEL_STATUS_DETAIL_CHARS)})`,
					)
					.join("; ")}`,
			);
		}
		return { snapshot, ...(result.persistentMirror ? { persistentMirror: result.persistentMirror } : {}) };
	}

	private async restoreFrom(config: KernelSnapshotConfig, required = false): Promise<KernelRestoreOutcome | null> {
		if (this.state !== "running") return null;
		const result = await this.sendRequest(
			{
				id: randomUUID(),
				path: config.path,
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				required,
				type: "restore",
			},
			"restore_result",
		);
		if (result.error) {
			this.appendKernelDiagnostic(`state restore failed: ${result.error}`);
			return null;
		}
		const restore = {
			failed: result.failed,
			path: result.path,
			restored: result.restored,
			runtimeRestored: result.runtimeRestored,
		};
		if (restore.failed.length > 0) {
			this.appendKernelDiagnostic(
				`state restore failed for ${restore.failed.length} binding(s): ${restore.failed
					.slice(0, MAX_KERNEL_STATUS_ENTRIES)
					.map(
						({ name, reason }) =>
							`${name.slice(0, MAX_KERNEL_STATUS_DETAIL_CHARS)} (${reason.slice(0, MAX_KERNEL_STATUS_DETAIL_CHARS)})`,
					)
					.join("; ")}`,
			);
		}
		return restore;
	}

	async snapshotState(): Promise<SnapshotResult | null> {
		if (!this.options.snapshot) return null;
		await this.start();
		return this.withExecutionLock(async () => {
			return this.flushPersistentSnapshot();
		});
	}

	async restoreState(): Promise<RestoreResult | null> {
		if (!this.options.snapshot) return null;
		await this.start();
		return this.withExecutionLock(async () => {
			const result = await this.restoreFrom(this.options.snapshot as KernelSnapshotConfig);
			if (result) {
				this.recoverySnapshotDirty = true;
				this.recoveryCheckpointStatus = "dirty";
				this.persistentSnapshotDirty = false;
				await this.requireRecoveryCheckpoint();
			}
			return result ? publicRestoreResult(result) : result;
		});
	}

	async listNamespaceNames(signal?: AbortSignal): Promise<string[] | null> {
		if (!this.isRunning) return null;
		return this.withExecutionLock(async () => {
			if (signal?.aborted) return null;
			const result = await this.sendRequest(
				{
					id: randomUUID(),
					protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
					type: "list_names",
				},
				"list_names_result",
			);
			return result.names.filter((name) => !name.startsWith("_") && !RUNTIME_NAMESPACE_NAMES.has(name));
		});
	}

	private scheduleSnapshot(): void {
		if (!this.options.snapshot) return;
		if (this.snapshotTimer) globalThis.clearTimeout(this.snapshotTimer);
		this.snapshotTimer = globalThis.setTimeout(() => {
			this.snapshotTimer = undefined;
			void this.withExecutionLock(async () => {
				if (this.recoverySnapshotDirty) await this.requireRecoveryCheckpoint();
				if (this.persistentSnapshotDirty) await this.flushPersistentSnapshot();
			}).catch((error) => this.appendKernelDiagnostic(`background state snapshot failed: ${errorMessage(error)}`));
		}, this.options.snapshot.debounceMs ?? DEFAULT_SNAPSHOT_DEBOUNCE_MS);
		this.snapshotTimer.unref?.();
	}

	private async withExecutionLock<T>(operation: () => Promise<T>, onAcquired?: () => void): Promise<T> {
		const previous = this.executionQueue;
		let release: () => void = () => {};
		this.executionQueue = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			onAcquired?.();
			if (this.recoveryPromise) await this.recoveryPromise;
			return await operation();
		} finally {
			release();
		}
	}

	private async flushDirtySnapshots(): Promise<void> {
		if (this.recoverySnapshotDirty) await this.requireRecoveryCheckpoint();
		if (this.persistentSnapshotDirty) await this.flushPersistentSnapshot();
	}

	async restart(): Promise<void> {
		await this.withExecutionLock(async () => {
			if (this.recoverySnapshotDirty) await this.requireRecoveryCheckpoint();
			await this.recoverWorker(new Error("Bun worker restarted"));
		});
	}

	async kill(): Promise<void> {
		this.state = "shutdown";
		liveKernels.delete(this);
		this.stopCurrentWorker("SIGKILL", new Error("Kernel was killed"));
		this.cleanupTemporaryState();
	}

	async shutdown(options: { snapshot?: boolean } = {}): Promise<void> {
		if (this.state === "shutdown") return;
		if (options.snapshot && (this.recoverySnapshotDirty || this.persistentSnapshotDirty) && this.isRunning) {
			await this.withTimeout(
				this.withExecutionLock(() => this.flushDirtySnapshots()),
				SNAPSHOT_DISPOSE_TIMEOUT_MS,
			);
		}
		this.state = "shutdown";
		liveKernels.delete(this);
		try {
			this.send({ id: randomUUID(), protocolVersion: BUN_WORKER_PROTOCOL_VERSION, type: "shutdown" });
		} catch {}
		this.stopCurrentWorker("SIGTERM", new Error("Kernel has been shut down"));
		this.cleanupTemporaryState();
	}

	dispose(): Promise<void> {
		return (async () => {
			if ((this.recoverySnapshotDirty || this.persistentSnapshotDirty) && this.isRunning) {
				await this.withTimeout(
					this.withExecutionLock(() => this.flushDirtySnapshots()),
					SNAPSHOT_DISPOSE_TIMEOUT_MS,
				);
			}
			if (this.inFlightHostRequests.size > 0) {
				await this.withTimeout(
					Promise.allSettled([...this.inFlightHostRequests]).then(() => undefined),
					HOST_REQUEST_DISPOSE_TIMEOUT_MS,
				);
			}
			await this.shutdown();
		})();
	}

	disposeSync(): void {
		this.state = "shutdown";
		liveKernels.delete(this);
		this.stopCurrentWorker("SIGTERM", new Error("Kernel has been shut down"));
		this.cleanupTemporaryState();
	}

	private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
		return new Promise((resolve) => {
			const timer = globalThis.setTimeout(() => resolve(undefined), timeoutMs);
			timer.unref?.();
			promise.then(
				(value) => {
					globalThis.clearTimeout(timer);
					resolve(value);
				},
				() => {
					globalThis.clearTimeout(timer);
					resolve(undefined);
				},
			);
		});
	}

	private cleanupTemporaryState(): void {
		if (this.snapshotTimer) {
			globalThis.clearTimeout(this.snapshotTimer);
			this.snapshotTimer = undefined;
		}
		if (this.recoveryTempDir) {
			try {
				rmSync(this.recoveryTempDir, { force: true, recursive: true });
			} catch {}
			this.recoveryTempDir = undefined;
			this.recoverySnapshotConfig = undefined;
		}
	}

	private appendKernelDiagnostic(message: string): void {
		this.kernelDiagnostics = `${this.kernelDiagnostics}${message.endsWith("\n") ? message : `${message}\n`}`.slice(
			-MAX_KERNEL_DIAGNOSTIC_CHARS,
		);
	}

	private registerLateSentAgentMessageHandler(
		cellId: string,
		handler: (message: KernelSentAgentMessage) => void,
	): void {
		this.lateSentAgentMessageHandlers.set(cellId, handler);
		while (this.lateSentAgentMessageHandlers.size > MAX_LATE_SENT_AGENT_MESSAGE_HANDLERS) {
			const oldest = this.lateSentAgentMessageHandlers.keys().next().value;
			if (oldest === undefined) break;
			this.lateSentAgentMessageHandlers.delete(oldest);
		}
	}
}
