import { deserialize, serialize } from "bun:jsc";
import { AsyncLocalStorage } from "node:async_hooks";
import { Console } from "node:console";
import { randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import { type FileHandle, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import {
	activityRequest,
	bash,
	capBashActivityFrame,
	InterruptError,
	killLiveHandles,
	rehydratePersistentShells,
	setCompletionNoticesWired,
	sh,
} from "./bash.ts";
import {
	type CellExecutionContext,
	emit,
	hostRequest,
	PROTOCOL_VERSION,
	registerReplBridge,
	RESULT_TEXT_CAP,
	RESULT_TRUNCATION_MARKER,
} from "./bridge.ts";
import { type ModuleBindingRecipe, transformJavaScriptCell } from "./cell-transform.ts";
import { ACTIVITY_ACTIONS, ACTIVITY_TIMEOUT_MS_CAP, scheduleFactoryActivity } from "./factory.ts";
import { close as closeMcp, mcpNamespace, status as mcpStatus } from "./mcp.ts";
import { rlm } from "./rlm.ts";
import {
	$,
	BUN_RUNTIME_GLOBAL_NAMES,
	createKernelRequire,
	createSkillLoader,
	installPackage,
	osModule,
	pathModule,
	primeFileSystem,
	skillDisplay,
	utilModule,
} from "./runtime-globals.ts";
import {
	decodeSnapshotPayload,
	DEFAULT_SNAPSHOT_MAX_BYTES,
	DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES,
	encodeSnapshotPayloadParts,
	SNAPSHOT_FORMAT_VERSION,
	type SnapshotPayloadEntry,
	snapshotValueSkipReason,
} from "./state-snapshot.ts";

// ---------------------------------------------------------------------------
// Capture raw stdio handles BEFORE any interception
// ---------------------------------------------------------------------------

type StreamWriteCallback = (error?: Error | null) => void;

const rawStdoutWrite = process.stdout.write.bind(process.stdout) as (
	chunk: string,
	callback?: StreamWriteCallback,
) => boolean;
const rawStderrWrite = process.stderr.write.bind(process.stderr) as (
	chunk: string,
	callback?: StreamWriteCallback,
) => boolean;
const nativeBunWrite = Bun.write.bind(Bun);

const RUNTIME_FILE_PATH = new URL(import.meta.url).pathname;
const RUNTIME_STATE_ENTRY_NAME = "\0prime:runtime";
const MAX_CELL_STREAM_BYTES = 32 * 1024;
const STREAM_FRAME_TEXT_CAP = 64 * 1024;
const MAX_RESULT_PROJECTION_DEPTH = 8;
const MAX_RESULT_PROJECTION_ENTRIES = 256;
const MAX_RESULT_PROJECTION_KEY_CHARS = 256;
const MAX_WRITEV_BUFFERS = 1024;

// ---------------------------------------------------------------------------
// Types & State
// ---------------------------------------------------------------------------

interface ActiveCell {
	cellId: string;
	source: string;
	abortController: AbortController;
	finished: Promise<void>;
	resolveFinished: () => void;
	active: boolean;
}

interface PendingHostRequest {
	resolve: (value: Record<string, unknown>) => void;
	reject: (error: Error) => void;
}

interface BindingRecipeState {
	recipe: ModuleBindingRecipe;
	value: unknown;
}

interface RuntimeSnapshotState {
	cwd: string;
	environment: {
		deleted: string[];
		set: Record<string, string>;
	};
}

interface CellStreamState {
	stdout: string;
	stdoutBytes: number;
	stdoutScheduled: boolean;
	stderr: string;
	stderrBytes: number;
	stderrScheduled: boolean;
}

interface SnapshotTarget {
	path: string;
	manifestPath: string;
	maxBytes: number;
	maxVariableBytes: number;
}

type PersistBinding = (name: string, value: unknown, recipe?: ModuleBindingRecipe) => void;
type AsyncExecutable = (...args: unknown[]) => Promise<unknown>;

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
	...args: string[]
) => AsyncExecutable;
const restoreFunctionValue = new AsyncFunction("__primeSource", 'return (0, eval)("(" + __primeSource + "\\n)");');
const restoreImportedValue = new AsyncFunction("__primeSpecifier", "return import(__primeSpecifier);");

const cellContext = new AsyncLocalStorage<ActiveCell>();
const bindings = new Set<string>();
const bindingRecipes = new Map<string, BindingRecipeState>();
const runtimeBindingNames = new Set<string>(BUN_RUNTIME_GLOBAL_NAMES);
const pendingHostRequests = new Map<string, PendingHostRequest>();
const cellStreams = new Map<string, CellStreamState>();
const inflightIds = new Set<string>();
const pendingInterruptIds = new Set<string>();
const mcpStatusTasks = new Set<Promise<void>>();
const requestQueue: Array<Record<string, unknown>> = [];

let pendingInterruptAny = false;
let activeCell: ActiveCell | null = null;
let activeRequestId: string | null = null;
let hostClosed = false;
let shuttingDown = false;
let servingQueue = false;
let lastSnapshotTarget: SnapshotTarget | null = null;
let baselineGlobalNames = new Set<string>();
const initialEnvironment: Record<string, string | undefined> = { ...process.env };
const requireModule = createKernelRequire();

// ---------------------------------------------------------------------------
// Wire framing & stream interception
// ---------------------------------------------------------------------------

function sendEvent(event: Record<string, unknown>): void {
	try {
		rawStdoutWrite(`${JSON.stringify(event)}\n`);
	} catch (error) {
		try {
			rawStderrWrite(`prime-agent-runtime: dropped protocol frame: ${String(error)}\n`);
		} catch {
			// ignore
		}
	}
}

function protocolError(message: string): void {
	sendEvent({
		event: "error",
		id: null,
		ename: "ProtocolError",
		evalue: message,
		traceback: [],
	});
}

function sendStreamFrames(cellId: string | null, stream: "stdout" | "stderr", text: string): void {
	if (!text) return;
	for (let i = 0; i < text.length; i += STREAM_FRAME_TEXT_CAP) {
		sendEvent({
			event: stream,
			id: cellId,
			text: text.slice(i, i + STREAM_FRAME_TEXT_CAP),
		});
	}
}

function cellStreamState(cellId: string): CellStreamState {
	let state = cellStreams.get(cellId);
	if (!state) {
		state = {
			stdout: "",
			stdoutBytes: 0,
			stdoutScheduled: false,
			stderr: "",
			stderrBytes: 0,
			stderrScheduled: false,
		};
		cellStreams.set(cellId, state);
	}
	return state;
}

function cleanupStreamState(cellId: string, state: CellStreamState): void {
	if (!state.stdout && !state.stderr && !state.stdoutScheduled && !state.stderrScheduled) {
		if (cellStreams.get(cellId) === state) cellStreams.delete(cellId);
	}
}

function flushCellStream(cellId: string, name: "stdout" | "stderr"): void {
	const state = cellStreams.get(cellId);
	if (!state) return;
	if (name === "stdout") state.stdoutScheduled = false;
	else state.stderrScheduled = false;
	const text = state[name];
	if (!text) {
		cleanupStreamState(cellId, state);
		return;
	}
	state[name] = "";
	if (name === "stdout") state.stdoutBytes = 0;
	else state.stderrBytes = 0;
	sendStreamFrames(cellId, name, text);
	cleanupStreamState(cellId, state);
}

function flushCellStreams(cellId: string): void {
	flushCellStream(cellId, "stdout");
	flushCellStream(cellId, "stderr");
}

function emitStream(name: "stdout" | "stderr", text: string): void {
	if (!text) return;
	const sourceCell = cellContext.getStore();
	if (!sourceCell) {
		sendStreamFrames(null, name, text);
		return;
	}
	const state = cellStreamState(sourceCell.cellId);
	state[name] += text;
	const bytes = Buffer.byteLength(text);
	if (name === "stdout") state.stdoutBytes += bytes;
	else state.stderrBytes += bytes;

	const totalBytes = name === "stdout" ? state.stdoutBytes : state.stderrBytes;
	if (totalBytes >= MAX_CELL_STREAM_BYTES) {
		flushCellStream(sourceCell.cellId, name);
		return;
	}
	const scheduled = name === "stdout" ? state.stdoutScheduled : state.stderrScheduled;
	if (!scheduled) {
		if (name === "stdout") state.stdoutScheduled = true;
		else state.stderrScheduled = true;
		queueMicrotask(() => {
			if (cellStreams.get(sourceCell.cellId) === state) {
				flushCellStream(sourceCell.cellId, name);
			}
		});
	}
}

function streamChunkText(chunk: string | Uint8Array, encoding?: BufferEncoding): string {
	return typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(encoding);
}

function createProcessStreamWrite(name: "stdout" | "stderr"): typeof process.stdout.write {
	const write = (
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | StreamWriteCallback,
		callback?: StreamWriteCallback,
	): boolean => {
		const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
		const completed = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
		const text = streamChunkText(chunk, encoding);
		emitStream(name, text);
		if (completed) queueMicrotask(() => completed());
		return true;
	};
	return write as typeof process.stdout.write;
}

function createConsoleSink(name: "stdout" | "stderr"): Writable {
	return new Writable({
		write(chunk: Buffer, _encoding: BufferEncoding, callback: StreamWriteCallback): void {
			emitStream(name, chunk.toString());
			callback();
		},
	});
}

async function bunWriteDataText(data: unknown): Promise<string> {
	if (typeof data === "string") return data;
	if (data instanceof Blob || data instanceof Response) return data.text();
	if (data instanceof ArrayBuffer || data instanceof SharedArrayBuffer) return Buffer.from(data).toString();
	if (ArrayBuffer.isView(data)) {
		return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString();
	}
	return String(data);
}

async function taggedBunWrite(destination: unknown, data: unknown, options?: unknown): Promise<number> {
	const name = destination === Bun.stdout ? "stdout" : destination === Bun.stderr ? "stderr" : undefined;
	if (!name) return nativeBunWrite(destination as Parameters<typeof Bun.write>[0], data as Parameters<typeof Bun.write>[1], options as Parameters<typeof Bun.write>[2]);
	const text = await bunWriteDataText(data);
	emitStream(name, text);
	return Buffer.byteLength(text);
}

// ---------------------------------------------------------------------------
// Host request bridge
// ---------------------------------------------------------------------------

function failPendingHostRequests(): void {
	hostClosed = true;
	for (const pending of pendingHostRequests.values()) {
		pending.reject(new Error("host connection closed; host_request cannot be answered"));
	}
	pendingHostRequests.clear();
}

function resolveHostReply(rid: string, data: Record<string, unknown>): void {
	const pending = pendingHostRequests.get(rid);
	if (!pending) return;
	pendingHostRequests.delete(rid);
	pending.resolve(data);
}

function sendHostRequestRaw(data: Record<string, unknown>): Promise<Record<string, unknown>> {
	if (hostClosed) {
		return Promise.reject(new Error("host connection closed; host_request cannot be answered"));
	}
	const rid = randomUUID().replace(/-/g, "");
	const abortSignal = cellContext.getStore()?.abortController.signal;
	if (abortSignal?.aborted) {
		return Promise.reject(new InterruptError());
	}
	return new Promise<Record<string, unknown>>((resolvePromise, rejectPromise) => {
		const cleanup = () => {
			abortSignal?.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			pendingHostRequests.delete(rid);
			cleanup();
			rejectPromise(new InterruptError());
		};
		if (abortSignal) abortSignal.addEventListener("abort", onAbort, { once: true });
		pendingHostRequests.set(rid, {
			resolve: (value) => {
				cleanup();
				resolvePromise(value);
			},
			reject: (err) => {
				cleanup();
				rejectPromise(err);
			},
		});
		sendEvent({ event: "host_request", id: rid, data });
	});
}

registerReplBridge({
	isActive: () => !shuttingDown,
	send: sendEvent,
	hostRequestRaw: sendHostRequestRaw,
	currentCellId: () => cellContext.getStore()?.cellId ?? null,
	currentCellExecution: (): CellExecutionContext | null => {
		const cell = cellContext.getStore();
		if (!cell) return null;
		return {
			cellId: cell.cellId,
			finished: cell.finished,
			abortSignal: cell.abortController.signal,
			isActive: () => cell.active,
		};
	},
	activeCellId: () => activeCell?.cellId ?? null,
	writeStderr: (text) => emitStream("stderr", text),
});

// ---------------------------------------------------------------------------
// Inspection & Error formatting
// ---------------------------------------------------------------------------

function capText(text: string): string {
	if (text.length > RESULT_TEXT_CAP) {
		return `${text.slice(0, RESULT_TEXT_CAP)}${RESULT_TRUNCATION_MARKER}`;
	}
	return text;
}

interface InspectProjectionBudget {
	charsRemaining: number;
	entriesRemaining: number;
	seen: WeakSet<object>;
}

function projectedString(value: string, budget: InspectProjectionBudget): string {
	const retainedLength = Math.min(value.length, Math.max(0, budget.charsRemaining));
	budget.charsRemaining -= retainedLength;
	const retained = value.slice(0, retainedLength);
	return retainedLength < value.length ? `${retained}[... string truncated ...]` : retained;
}

function defineProjectedProperty(target: Record<string, unknown>, key: string, value: unknown): void {
	Object.defineProperty(target, key, { configurable: true, enumerable: true, value, writable: true });
}

function projectForInspect(value: unknown, budget: InspectProjectionBudget, depth: number): unknown {
	if (typeof value === "string") return projectedString(value, budget);
	if (
		value === null ||
		typeof value === "undefined" ||
		typeof value === "boolean" ||
		typeof value === "number" ||
		typeof value === "bigint"
	) {
		return value;
	}
	if (typeof value === "symbol") return `[Symbol ${projectedString(value.description ?? "", budget)}]`;
	if (typeof value === "function") return `[Function ${projectedString(value.name || "anonymous", budget)}]`;
	if (typeof value !== "object") return projectedString(String(value), budget);
	if (budget.seen.has(value)) return "[Circular]";
	if (depth >= MAX_RESULT_PROJECTION_DEPTH) return "[Max depth reached]";
	budget.seen.add(value);

	if (value instanceof Date || value instanceof RegExp) return value;
	if (value instanceof Error) {
		return {
			message: projectedString(value.message, budget),
			name: projectedString(value.name, budget),
			...(value.stack ? { stack: projectedString(value.stack, budget) } : {}),
		};
	}
	if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
		return `[${value.constructor.name} ${value.byteLength} bytes]`;
	}
	if (ArrayBuffer.isView(value)) {
		const ctorName = Object.getPrototypeOf(value)?.constructor?.name ?? "ArrayBufferView";
		return `[${ctorName} ${value.byteLength} bytes]`;
	}
	if (Array.isArray(value)) {
		const projected: unknown[] = [];
		const entryCount = Math.min(value.length, Math.max(0, budget.entriesRemaining));
		for (let i = 0; i < entryCount; i += 1) {
			budget.entriesRemaining -= 1;
			const desc = Object.getOwnPropertyDescriptor(value, String(i));
			if (!desc) projected.push("[Empty]");
			else if ("value" in desc) projected.push(projectForInspect(desc.value, budget, depth + 1));
			else projected.push(desc.get ? "[Getter]" : "[Setter]");
		}
		if (entryCount < value.length) projected.push(`[... ${value.length - entryCount} entries truncated ...]`);
		return projected;
	}
	if (value instanceof Map) {
		const projected = new Map<unknown, unknown>();
		let retained = 0;
		for (const [k, v] of value) {
			if (budget.entriesRemaining <= 0) break;
			budget.entriesRemaining -= 1;
			retained += 1;
			projected.set(projectForInspect(k, budget, depth + 1), projectForInspect(v, budget, depth + 1));
		}
		if (retained < value.size) projected.set(`[... ${value.size - retained} entries truncated ...]`, "");
		return projected;
	}
	if (value instanceof Set) {
		const projected = new Set<unknown>();
		let retained = 0;
		for (const v of value) {
			if (budget.entriesRemaining <= 0) break;
			budget.entriesRemaining -= 1;
			retained += 1;
			projected.add(projectForInspect(v, budget, depth + 1));
		}
		if (retained < value.size) projected.add(`[... ${value.size - retained} entries truncated ...]`);
		return projected;
	}

	const projected: Record<string, unknown> = {};
	let truncated = false;
	for (const key in value) {
		if (!Object.hasOwn(value, key)) continue;
		if (budget.entriesRemaining <= 0) {
			truncated = true;
			break;
		}
		budget.entriesRemaining -= 1;
		const projectedKey = projectedString(key.slice(0, MAX_RESULT_PROJECTION_KEY_CHARS), budget);
		let projectedValue: unknown;
		try {
			const desc = Object.getOwnPropertyDescriptor(value, key);
			if (!desc) continue;
			projectedValue =
				"value" in desc
					? projectForInspect(desc.value, budget, depth + 1)
					: desc.get
						? "[Getter]"
						: "[Setter]";
		} catch (error) {
			projectedValue = `[Property inspection failed: ${String(error).slice(0, 128)}]`;
		}
		defineProjectedProperty(projected, projectedKey, projectedValue);
	}
	if (truncated) defineProjectedProperty(projected, "[... properties truncated ...]", true);
	return projected;
}

function boundedInspect(value: unknown, maxChars = RESULT_TEXT_CAP): string {
	const bounded = Math.min(RESULT_TEXT_CAP, Math.max(0, Math.floor(maxChars)));
	const projected = projectForInspect(
		value,
		{ charsRemaining: bounded, entriesRemaining: MAX_RESULT_PROJECTION_ENTRIES, seen: new WeakSet<object>() },
		0,
	);
	const inspected = Bun.inspect(projected, { colors: false, depth: MAX_RESULT_PROJECTION_DEPTH });
	return capText(inspected);
}

function formatErrorEvent(cellId: string | null, error: unknown): Record<string, unknown> {
	let ename = "Error";
	let evalue = "";
	let traceback: string[] = [];

	if (error instanceof Error) {
		ename = error.name || "Error";
		try {
			evalue = capText(error.message || "");
		} catch {
			evalue = "<exception message failed>";
		}
		if (error.stack) {
			const lines = error.stack
				.split("\n")
				.filter((line) => !line.includes(RUNTIME_FILE_PATH))
				.map((line) => `${capText(line)}\n`);
			traceback = lines;
		}
	} else {
		try {
			evalue = capText(String(error));
		} catch {
			evalue = "<exception stringification failed>";
		}
	}
	if (traceback.length === 0) {
		traceback = [`${ename}${evalue ? `: ${evalue}` : ""}\n`];
	}
	return { event: "error", id: cellId, ename, evalue, traceback };
}

// ---------------------------------------------------------------------------
// Namespace bindings & Snapshot / Restore
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const persistBinding: PersistBinding = (name, value, recipe) => {
	bindings.add(name);
	if (recipe) bindingRecipes.set(name, { recipe, value });
	else bindingRecipes.delete(name);
	Object.defineProperty(globalThis, name, {
		configurable: true,
		enumerable: true,
		value,
		writable: true,
	});
};

function reconcileBindings(): void {
	for (const name of [...bindings]) {
		if (Object.hasOwn(globalThis, name)) continue;
		bindings.delete(name);
		bindingRecipes.delete(name);
	}
	for (const name of Object.getOwnPropertyNames(globalThis)) {
		if (baselineGlobalNames.has(name) || runtimeBindingNames.has(name) || name.startsWith("_")) continue;
		bindings.add(name);
	}
	for (const [name, state] of bindingRecipes) {
		if (!Object.hasOwn(globalThis, name) || Reflect.get(globalThis, name) !== state.value) {
			bindingRecipes.delete(name);
		}
	}
}

function listUserNames(): string[] {
	reconcileBindings();
	return [...bindings]
		.filter((name) => !name.startsWith("_") && !runtimeBindingNames.has(name))
		.sort();
}

function captureRuntimeState(): RuntimeSnapshotState {
	const environment: RuntimeSnapshotState["environment"] = { deleted: [], set: {} };
	for (const name of new Set([...Object.keys(initialEnvironment), ...Object.keys(process.env)])) {
		const initialValue = initialEnvironment[name];
		const currentValue = process.env[name];
		if (currentValue === undefined) {
			if (initialValue !== undefined) environment.deleted.push(name);
			continue;
		}
		if (currentValue !== initialValue) environment.set[name] = currentValue;
	}
	return { cwd: process.cwd(), environment };
}

function parseRuntimeState(data: Uint8Array): RuntimeSnapshotState {
	const value: unknown = JSON.parse(Buffer.from(data).toString("utf8"));
	if (!isRecord(value) || typeof value.cwd !== "string" || !isRecord(value.environment)) {
		throw new Error("runtime snapshot state is invalid");
	}
	const { deleted, set } = value.environment;
	if (!Array.isArray(deleted) || deleted.some((name) => typeof name !== "string") || !isRecord(set)) {
		throw new Error("runtime snapshot environment is invalid");
	}
	const normalizedSet: Record<string, string> = {};
	for (const [name, envValue] of Object.entries(set)) {
		if (typeof envValue !== "string") throw new Error(`runtime environment value ${name} is invalid`);
		normalizedSet[name] = envValue;
	}
	return { cwd: value.cwd, environment: { deleted: deleted as string[], set: normalizedSet } };
}

function restoreRuntimeState(data: Uint8Array): void {
	const state = parseRuntimeState(data);
	process.chdir(state.cwd);
	for (const name of state.environment.deleted) delete process.env[name];
	for (const [name, value] of Object.entries(state.environment.set)) process.env[name] = value;
}

function parseModuleBindingRecipe(data: Uint8Array): ModuleBindingRecipe {
	const value: unknown = JSON.parse(Buffer.from(data).toString("utf8"));
	if (
		!isRecord(value) ||
		value.type !== "module" ||
		(value.loader !== "import" && value.loader !== "require") ||
		typeof value.specifier !== "string" ||
		value.specifier.length === 0 ||
		(value.exportName !== undefined && typeof value.exportName !== "string")
	) {
		throw new Error("module recipe is invalid");
	}
	return {
		...(value.exportName !== undefined ? { exportName: value.exportName } : {}),
		loader: value.loader,
		specifier: value.specifier,
		type: "module",
	};
}

async function restoreModuleBinding(recipe: ModuleBindingRecipe): Promise<unknown> {
	const loaded =
		recipe.loader === "require" ? requireModule(recipe.specifier) : await restoreImportedValue(recipe.specifier);
	if (recipe.exportName === undefined) return loaded;
	if (
		((typeof loaded !== "object" || loaded === null) && typeof loaded !== "function") ||
		!Reflect.has(loaded, recipe.exportName)
	) {
		throw new Error(`Module ${recipe.specifier} does not export ${recipe.exportName}`);
	}
	return Reflect.get(loaded, recipe.exportName);
}

async function writeAtomic(filePath: string, data: Uint8Array | string): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(tempPath, data);
		await rename(tempPath, filePath);
	} catch (error) {
		await rm(tempPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

async function writeSnapshotParts(handle: FileHandle, parts: readonly Uint8Array[]): Promise<void> {
	let partIndex = 0;
	let partOffset = 0;
	let position = 0;
	while (partIndex < parts.length) {
		while (partIndex < parts.length && partOffset === parts[partIndex]!.byteLength) {
			partIndex += 1;
			partOffset = 0;
		}
		if (partIndex === parts.length) return;
		const buffers: Uint8Array[] = [];
		let batchBytes = 0;
		for (let i = partIndex; i < parts.length && buffers.length < MAX_WRITEV_BUFFERS; i += 1) {
			const part = parts[i]!;
			const offset = i === partIndex ? partOffset : 0;
			if (offset === part.byteLength) continue;
			const buf = offset === 0 ? part : part.subarray(offset);
			buffers.push(buf);
			batchBytes += buf.byteLength;
		}
		const { bytesWritten } = await handle.writev(buffers, position);
		if (bytesWritten <= 0 || bytesWritten > batchBytes) {
			throw new Error(`Unable to write Bun snapshot: writev wrote ${bytesWritten} of ${batchBytes} bytes`);
		}
		position += bytesWritten;
		let remaining = bytesWritten;
		while (remaining > 0) {
			const part = parts[partIndex]!;
			const available = part.byteLength - partOffset;
			if (remaining < available) {
				partOffset += remaining;
				remaining = 0;
				continue;
			}
			remaining -= available;
			partIndex += 1;
			partOffset = 0;
		}
	}
}

async function writeBinaryAtomic(filePath: string, parts: readonly Uint8Array[]): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	let handle: FileHandle | undefined;
	try {
		handle = await open(tempPath, "w");
		await writeSnapshotParts(handle, parts);
		await handle.close();
		handle = undefined;
		await rename(tempPath, filePath);
	} catch (error) {
		await handle?.close().catch(() => undefined);
		await rm(tempPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

async function performSnapshot(opts: {
	path: string;
	manifestPath: string;
	maxBytes: number;
	maxVariableBytes: number;
	pruneOversized: boolean;
}): Promise<
	| { saved: string[]; skipped: Array<{ name: string; reason: string }>; pruned: string[]; bytes: number }
	| { error: string }
> {
	reconcileBindings();
	const savedEntries: SnapshotPayloadEntry[] = [];
	const skipped: Array<{ name: string; reason: string }> = [];
	const oversized: string[] = [];
	let serializedBytes = 0;

	const tryAddEntry = (entry: SnapshotPayloadEntry, isRuntime = false): boolean => {
		if (!isRuntime && entry.data.byteLength > opts.maxVariableBytes) {
			skipped.push({ name: entry.name, reason: "exceeds per-variable snapshot size cap" });
			oversized.push(entry.name);
			return false;
		}
		if (serializedBytes + entry.data.byteLength > opts.maxBytes) {
			if (!isRuntime) {
				skipped.push({ name: entry.name, reason: "exceeds aggregate snapshot size cap" });
			}
			return false;
		}
		savedEntries.push(entry);
		serializedBytes += entry.data.byteLength;
		return true;
	};

	const runtimeEntry: SnapshotPayloadEntry = {
		name: RUNTIME_STATE_ENTRY_NAME,
		kind: "runtime",
		data: Buffer.from(JSON.stringify(captureRuntimeState()), "utf8"),
	};
	if (runtimeEntry.data.byteLength <= opts.maxBytes) {
		tryAddEntry(runtimeEntry, true);
	}

	for (const name of [...bindings].sort()) {
		if (name.startsWith("_") || runtimeBindingNames.has(name)) {
			continue;
		}
		let value: unknown;
		try {
			value = Reflect.get(globalThis, name);
		} catch (error) {
			skipped.push({ name, reason: `binding read failed: ${error instanceof Error ? error.message : String(error)}` });
			continue;
		}
		const recipe = bindingRecipes.get(name)?.recipe;
		if (recipe) {
			tryAddEntry({ name, kind: "module", data: Buffer.from(JSON.stringify(recipe), "utf8") });
			continue;
		}
		if (typeof value === "function") {
			try {
				const source = Function.prototype.toString.call(value);
				if (source.includes("[native code]")) {
					skipped.push({ name, reason: "native function source is not restorable" });
					continue;
				}
				tryAddEntry({ name, kind: "function", data: Buffer.from(source, "utf8") });
			} catch (error) {
				skipped.push({
					name,
					reason: `function source read failed: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
			continue;
		}
		const skipReason = snapshotValueSkipReason(value);
		if (skipReason) {
			skipped.push({ name, reason: skipReason });
			continue;
		}
		try {
			const data = new Uint8Array(serialize(value));
			tryAddEntry({ name, data });
		} catch (error) {
			skipped.push({
				name,
				reason: `serialization failed: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}

	const payload = encodeSnapshotPayloadParts(savedEntries);
	if (payload.byteLength > opts.maxBytes) {
		return { error: "write failed: snapshot exceeds aggregate snapshot size cap" };
	}
	const savedNames = savedEntries
		.filter((entry) => entry.kind !== "runtime")
		.map((entry) => entry.name)
		.sort();
	const pruned = opts.pruneOversized ? oversized.filter((name) => Object.hasOwn(globalThis, name)).sort() : [];

	const manifest = {
		version: SNAPSHOT_FORMAT_VERSION,
		savedNames,
		skipped,
		pruned,
		bytes: payload.byteLength,
		bunVersion: Bun.version,
		timestamp: new Date().toISOString(),
	};

	try {
		await writeBinaryAtomic(opts.path, payload.parts);
	} catch (error) {
		return { error: `write failed: ${error instanceof Error ? error.message : String(error)}` };
	}
	try {
		await writeAtomic(opts.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	} catch (error) {
		return { error: `manifest write failed: ${error instanceof Error ? error.message : String(error)}` };
	}

	// Only prune from namespace after both payload and manifest are durably committed.
	for (const name of pruned) {
		try {
			Reflect.deleteProperty(globalThis, name);
		} catch {
			// ignore
		}
		bindings.delete(name);
		bindingRecipes.delete(name);
	}

	return { saved: savedNames, skipped, pruned, bytes: payload.byteLength };
}

async function performRestore(opts: {
	path: string;
	maxBytes: number;
	maxVariableBytes: number;
}): Promise<
	| { restored: string[]; failed: Array<{ name: string; reason: string }>; reason?: string }
	| { error: string }
> {
	let payload: Buffer;
	try {
		const info = await stat(opts.path);
		if (info.size > opts.maxBytes) {
			return { error: "load failed: snapshot payload exceeds the aggregate byte cap" };
		}
		payload = await readFile(opts.path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
			return { restored: [], failed: [], reason: "snapshot not found" };
		}
		return { error: `load failed: ${error instanceof Error ? error.message : String(error)}` };
	}

	let entries: SnapshotPayloadEntry[];
	try {
		entries = decodeSnapshotPayload(payload, {
			maxBytes: opts.maxBytes,
			maxVariableBytes: opts.maxVariableBytes,
		});
	} catch (error) {
		return { error: `load failed: ${error instanceof Error ? error.message : String(error)}` };
	}

	const restored: string[] = [];
	const failed: Array<{ name: string; reason: string }> = [];

	for (const entry of entries.filter((c) => c.kind === "runtime")) {
		try {
			restoreRuntimeState(entry.data);
		} catch (error) {
			failed.push({ name: RUNTIME_STATE_ENTRY_NAME, reason: error instanceof Error ? error.message : String(error) });
		}
	}

	for (const entry of entries.filter((c) => c.kind === undefined)) {
		if (runtimeBindingNames.has(entry.name)) {
			failed.push({ name: entry.name, reason: "runtime binding was not restored" });
			continue;
		}
		try {
			persistBinding(entry.name, deserialize(entry.data));
			restored.push(entry.name);
		} catch (error) {
			failed.push({ name: entry.name, reason: error instanceof Error ? error.message : String(error) });
		}
	}

	for (const entry of entries.filter((c) => c.kind === "function" || c.kind === "import" || c.kind === "module")) {
		if (runtimeBindingNames.has(entry.name)) {
			failed.push({ name: entry.name, reason: "runtime binding was not restored" });
			continue;
		}
		try {
			const source = Buffer.from(entry.data).toString("utf8");
			if (entry.kind === "function") {
				const value = await restoreFunctionValue(source);
				if (typeof value !== "function") throw new Error("function recipe did not restore a function");
				persistBinding(entry.name, value);
			} else if (entry.kind === "import") {
				if (!source) throw new Error("import recipe has an empty specifier");
				const value = await restoreImportedValue(source);
				persistBinding(entry.name, value, { loader: "import", specifier: source, type: "module" });
			} else {
				const recipe = parseModuleBindingRecipe(entry.data);
				persistBinding(entry.name, await restoreModuleBinding(recipe), recipe);
			}
			restored.push(entry.name);
		} catch (error) {
			failed.push({ name: entry.name, reason: error instanceof Error ? error.message : String(error) });
		}
	}

	restored.sort();
	return { restored, failed };
}

// ---------------------------------------------------------------------------
// Cell compilation & execution
// ---------------------------------------------------------------------------

const cellTranspiler = new Bun.Transpiler({ deadCodeElimination: false, loader: "ts", target: "bun" });
const BUN_REQUIRE_SHIM = "var {require}=import.meta;";

function transpileCell(source: string): string {
	const transpiled = cellTranspiler.transformSync(source);
	return transpiled.startsWith(BUN_REQUIRE_SHIM) ? transpiled.slice(BUN_REQUIRE_SHIM.length) : transpiled;
}

function consumePendingInterrupt(rid: string): boolean {
	const hit = pendingInterruptAny || pendingInterruptIds.has(rid);
	pendingInterruptAny = false;
	pendingInterruptIds.delete(rid);
	return hit;
}

function finishInflight(rid: string): void {
	inflightIds.delete(rid);
	pendingInterruptIds.delete(rid);
	if (inflightIds.size === 0) pendingInterruptAny = false;
}

function requestInterrupt(targetId?: string): void {
	if (activeRequestId !== null && (targetId === undefined || targetId === activeRequestId)) {
		if (activeCell && !activeCell.abortController.signal.aborted) {
			activeCell.abortController.abort(new InterruptError());
		}
		return;
	}
	if (targetId !== undefined) {
		if (inflightIds.has(targetId)) pendingInterruptIds.add(targetId);
		return;
	}
	if (inflightIds.size > 0) {
		pendingInterruptAny = true;
	}
}

async function handleExecute(req: Record<string, unknown>): Promise<void> {
	const cellId = String(req.id);
	const code = String(req.code);
	let resolveFinished!: () => void;
	const finished = new Promise<void>((resolvePromise) => {
		resolveFinished = resolvePromise;
	});
	const cell: ActiveCell = {
		cellId,
		source: code,
		abortController: new AbortController(),
		finished,
		resolveFinished,
		active: true,
	};

	activeCell = cell;
	activeRequestId = cellId;

	if (consumePendingInterrupt(cellId)) {
		cell.abortController.abort(new InterruptError());
	}

	let status: "ok" | "error" = "ok";
	let resultText: string | null = null;
	let errorEvent: Record<string, unknown> | null = null;

	try {
		if (cell.abortController.signal.aborted) {
			throw new InterruptError();
		}
		const transpiled = transpileCell(code);
		const transformed = transformJavaScriptCell(transpiled);
		const conflict = transformed.bindingNames.find((name) => runtimeBindingNames.has(name));
		if (conflict) {
			throw new SyntaxError(`${conflict} conflicts with a runtime global and cannot be redeclared`);
		}
		const executor = new AsyncFunction("__primePersist", transformed.code);

		const abortPromise = new Promise<never>((_res, reject) => {
			if (cell.abortController.signal.aborted) {
				reject(new InterruptError());
				return;
			}
			cell.abortController.signal.addEventListener("abort", () => reject(new InterruptError()), { once: true });
		});

		const execPromise = cellContext.run(cell, () => executor(persistBinding));
		// Prevent unhandled rejection if abortPromise wins and execPromise rejects later.
		execPromise.catch(() => undefined);

		const value = await Promise.race([execPromise, abortPromise]);
		if (cell.abortController.signal.aborted) {
			throw new InterruptError();
		}
		if (value !== undefined) {
			Object.defineProperty(globalThis, "_", {
				configurable: true,
				enumerable: true,
				value,
				writable: true,
			});
			resultText = boundedInspect(value, RESULT_TEXT_CAP);
		}
	} catch (error) {
		status = "error";
		errorEvent = formatErrorEvent(cellId, error);
	} finally {
		cell.active = false;
		reconcileBindings();
		flushCellStreams(cellId);
		activeCell = null;
		activeRequestId = null;
		finishInflight(cellId);
		if (resultText !== null && status === "ok") {
			sendEvent({ event: "result", id: cellId, text: resultText });
		}
		if (errorEvent !== null) {
			sendEvent(errorEvent);
		}
		sendEvent({ event: "done", id: cellId, status });
		cell.resolveFinished();
	}
}

async function handleSnapshot(req: Record<string, unknown>): Promise<void> {
	const rid = String(req.id);
	activeRequestId = rid;
	try {
		if (consumePendingInterrupt(rid)) {
			sendEvent({ event: "done", id: rid, status: "error", reason: "interrupted" });
			return;
		}
		const prune = req.prune_oversized ?? false;
		if (typeof prune !== "boolean") {
			sendEvent({ event: "done", id: rid, status: "error", reason: "prune_oversized must be a boolean" });
			return;
		}
		for (const field of ["max_bytes", "max_variable_bytes"] as const) {
			if (field in req) {
				const v = req[field];
				if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
					sendEvent({ event: "done", id: rid, status: "error", reason: `${field} must be a non-negative integer` });
					return;
				}
			}
		}
		const payloadPath = String(req.path);
		const manifestPath = String(req.manifest_path);
		if (resolve(payloadPath) === resolve(manifestPath)) {
			sendEvent({ event: "done", id: rid, status: "error", reason: "path and manifest_path must differ" });
			return;
		}
		const maxBytes = (req.max_bytes as number | undefined) ?? DEFAULT_SNAPSHOT_MAX_BYTES;
		const maxVariableBytes = (req.max_variable_bytes as number | undefined) ?? DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES;
		const result = await performSnapshot({
			path: payloadPath,
			manifestPath,
			maxBytes,
			maxVariableBytes,
			pruneOversized: prune,
		});
		if ("error" in result) {
			sendEvent({ event: "done", id: rid, status: "error", reason: result.error });
			return;
		}
		lastSnapshotTarget = { path: payloadPath, manifestPath, maxBytes, maxVariableBytes };
		sendEvent({ event: "done", id: rid, status: "ok", ...result });
	} finally {
		activeRequestId = null;
		finishInflight(rid);
	}
}

async function handleRestore(req: Record<string, unknown>): Promise<void> {
	const rid = String(req.id);
	activeRequestId = rid;
	try {
		if (consumePendingInterrupt(rid)) {
			sendEvent({ event: "done", id: rid, status: "error", reason: "interrupted" });
			return;
		}
		const maxBytes = (req.max_bytes as number | undefined) ?? DEFAULT_SNAPSHOT_MAX_BYTES;
		const maxVariableBytes = (req.max_variable_bytes as number | undefined) ?? DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES;
		const result = await performRestore({
			path: String(req.path),
			maxBytes,
			maxVariableBytes,
		});
		if ("error" in result) {
			sendEvent({ event: "done", id: rid, status: "error", reason: result.error });
			return;
		}
		sendEvent({ event: "done", id: rid, status: "ok", ...result });
	} finally {
		activeRequestId = null;
		finishInflight(rid);
	}
}

function handleMcpStatusOutOfBand(req: Record<string, unknown>): void {
	const rid = String(req.id);
	const task = (async () => {
		try {
			const servers = req.servers;
			if (!Array.isArray(servers) || !servers.every((s) => typeof s === "string")) {
				throw new Error("mcp_status requires a list of server names");
			}
			const timeoutMs = req.timeout_ms ?? 10_000;
			if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
				throw new Error("mcp_status timeout_ms must be a positive number");
			}
			const connections = await mcpStatus(servers as string[], timeoutMs);
			sendEvent({ event: "done", id: rid, status: "ok", connections });
		} catch (error) {
			sendEvent(formatErrorEvent(rid, error));
			sendEvent({ event: "done", id: rid, status: "error" });
		}
	})();
	mcpStatusTasks.add(task);
	void task.finally(() => mcpStatusTasks.delete(task));
}

function handleBashActivityOutOfBand(req: Record<string, unknown>): void {
	const rid = String(req.id);
	try {
		const action = String(req.action);
		const activityId = typeof req.activityId === "string" ? req.activityId : undefined;
		const lines = req.lines === undefined ? 50 : (req.lines as number);
		const response = activityRequest(action, activityId, lines);
		const frame: Record<string, unknown> = { event: "done", id: rid, status: "ok", ...response };
		capBashActivityFrame(frame);
		sendEvent(frame);
	} catch (error) {
		sendEvent({
			event: "done",
			id: rid,
			status: "error",
			reason: error instanceof Error ? error.message : String(error),
		});
	}
}

async function handleShutdown(req: Record<string, unknown>): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	failPendingHostRequests();

	if (req.eof === true && lastSnapshotTarget) {
		try {
			await performSnapshot({
				...lastSnapshotTarget,
				pruneOversized: false,
			});
		} catch {
			// best-effort EOF flush
		}
	}

	if (mcpStatusTasks.size > 0) {
		await Promise.race([
			Promise.allSettled([...mcpStatusTasks]),
			new Promise((r) => setTimeout(r, 1000)),
		]);
		mcpStatusTasks.clear();
	}

	try {
		await closeMcp();
	} catch (error) {
		rawStderrWrite(`MCP shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
	}

	killLiveHandles();
	if (typeof req.id === "string") {
		sendEvent({ event: "done", id: req.id, status: "ok" });
	}
	process.exit(0);
}

// ---------------------------------------------------------------------------
// Sequential queue processor & stdin request router
// ---------------------------------------------------------------------------

async function drainQueue(): Promise<void> {
	if (servingQueue) return;
	servingQueue = true;
	try {
		while (requestQueue.length > 0) {
			const req = requestQueue.shift()!;
			const rtype = String(req.type);
			try {
				if (rtype === "shutdown") {
					await handleShutdown(req);
					return;
				}
				if (rtype === "execute") {
					await handleExecute(req);
				} else if (rtype === "snapshot") {
					await handleSnapshot(req);
				} else if (rtype === "restore") {
					await handleRestore(req);
				} else if (rtype === "list_names") {
					sendEvent({ event: "done", id: String(req.id), status: "ok", names: listUserNames() });
				}
			} catch (error) {
				const rid = typeof req.id === "string" ? req.id : null;
				if (rid) finishInflight(rid);
				sendEvent(formatErrorEvent(rid, error));
				if (rid) sendEvent({ event: "done", id: rid, status: "error" });
			}
		}
	} finally {
		servingQueue = false;
	}
}

const REQUIRED_FIELDS: Record<string, readonly string[]> = {
	execute: ["id", "code"],
	snapshot: ["id", "path", "manifest_path"],
	restore: ["id", "path"],
	list_names: ["id"],
	mcp_status: ["id"],
	bash_activity: ["id", "action"],
	factory_activity: ["id", "action"],
	shutdown: [],
};

function handleRequestLine(line: string): void {
	const trimmed = line.trim();
	if (!trimmed) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		protocolError(`JSONDecodeError: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	if (!isRecord(parsed)) {
		protocolError("ValueError: request is not a JSON object");
		return;
	}
	const rtype = parsed.type;
	if (rtype === "interrupt") {
		if ("id" in parsed && typeof parsed.id !== "string") {
			protocolError("interrupt request id must be a string");
			return;
		}
		requestInterrupt(parsed.id as string | undefined);
		return;
	}
	if (rtype === "host_reply") {
		if (typeof parsed.id === "string" && isRecord(parsed.data)) {
			resolveHostReply(parsed.id, parsed.data);
		} else {
			protocolError("host_reply request needs string id and dict data");
		}
		return;
	}
	if (typeof rtype !== "string" || !(rtype in REQUIRED_FIELDS)) {
		protocolError(`unknown request type: ${JSON.stringify(rtype)}`);
		return;
	}
	const missing = REQUIRED_FIELDS[rtype]!.filter((f) => typeof parsed[f] !== "string");
	if (missing.length > 0) {
		protocolError(`${rtype} request needs string fields: ${missing.join(", ")}`);
		return;
	}

	if (rtype === "mcp_status") {
		handleMcpStatusOutOfBand(parsed);
		return;
	}
	if (rtype === "bash_activity") {
		const action = parsed.action as string;
		if (action !== "list" && action !== "tail" && action !== "kill") {
			protocolError("unknown bash activity action");
			return;
		}
		if (action !== "list" && typeof parsed.activityId !== "string") {
			protocolError("bash activity tail/kill requires string activityId");
			return;
		}
		if ((parsed.id as string).length > 256 || (typeof parsed.activityId === "string" && parsed.activityId.length > 256)) {
			protocolError("bash activity ids must stay under 256 characters");
			return;
		}
		handleBashActivityOutOfBand(parsed);
		return;
	}
	if (rtype === "factory_activity") {
		const action = parsed.action as string;
		if (!(ACTIVITY_ACTIONS as readonly string[]).includes(action)) {
			protocolError(`unknown factory activity action: ${JSON.stringify(action)}`);
			return;
		}
		for (const field of ["runId", "specId"] as const) {
			if (parsed[field] !== undefined && parsed[field] !== null && typeof parsed[field] !== "string") {
				protocolError(`factory activity ${field} must be a string when provided`);
				return;
			}
		}
		if (parsed.timeoutMs !== undefined && parsed.timeoutMs !== null) {
			const t = parsed.timeoutMs;
			if (typeof t !== "number" || !Number.isInteger(t) || t < 0 || t > ACTIVITY_TIMEOUT_MS_CAP) {
				protocolError(`factory activity timeoutMs must be an integer between 0 and ${ACTIVITY_TIMEOUT_MS_CAP}`);
				return;
			}
		}
		if ((parsed.id as string).length > 256) {
			protocolError("factory activity ids must stay under 256 characters");
			return;
		}
		scheduleFactoryActivity(parsed);
		return;
	}

	if (rtype === "execute" || rtype === "snapshot" || rtype === "restore") {
		const rid = parsed.id as string;
		if (inflightIds.has(rid)) {
			protocolError(`duplicate in-flight request id: ${JSON.stringify(rid)}`);
			return;
		}
		inflightIds.add(rid);
	}
	if (rtype === "shutdown") {
		failPendingHostRequests();
	}

	requestQueue.push(parsed);
	void drainQueue();
}

// ---------------------------------------------------------------------------
// Owner watchdog
// ---------------------------------------------------------------------------

function startOwnerWatchdog(): void {
	const raw = (process.env.PRIME_AGENT_KERNEL_OWNER_PID ?? "").trim();
	const parsed = Number.parseInt(raw, 10);
	const initialPpid = process.ppid;
	const ownerPid = Number.isInteger(parsed) && parsed > 0 ? parsed : initialPpid;
	if (!ownerPid || ownerPid <= 1) return;

	const check = () => {
		let alive = true;
		if (ownerPid === initialPpid && process.ppid !== initialPpid) {
			alive = false;
		} else {
			try {
				process.kill(ownerPid, 0);
			} catch (error) {
				if ((error as NodeJS.ErrnoException)?.code === "ESRCH") {
					alive = false;
				}
			}
		}
		if (!alive) {
			try {
				killLiveHandles();
			} catch {
				// ignore
			}
			process.exit(1);
		}
	};

	const timer = setInterval(check, 2000);
	timer.unref?.();
}

// ---------------------------------------------------------------------------
// Bootstrap globals, intercept streams, announce ready, start serving
// ---------------------------------------------------------------------------

function defineRuntimeGlobal(name: string, value: unknown): void {
	Object.defineProperty(globalThis, name, {
		configurable: true,
		enumerable: true,
		value,
		writable: false,
	});
}

function bootstrapRuntime(): void {
	defineRuntimeGlobal("$", $);
	defineRuntimeGlobal("fs", primeFileSystem);
	defineRuntimeGlobal("os", osModule);
	defineRuntimeGlobal("path", pathModule);
	defineRuntimeGlobal("util", utilModule);
	defineRuntimeGlobal("require", requireModule);
	defineRuntimeGlobal("sh", sh);
	defineRuntimeGlobal("bash", bash);
	defineRuntimeGlobal("mcp", mcpNamespace);
	defineRuntimeGlobal("rlm", rlm);
	defineRuntimeGlobal("installPackage", installPackage);
	defineRuntimeGlobal("hostRequest", hostRequest);
	defineRuntimeGlobal("__primeHostRequest", hostRequest);
	defineRuntimeGlobal("__primeDisplay", skillDisplay);
	defineRuntimeGlobal("__primeSetCompletionNoticesWired", setCompletionNoticesWired);
	defineRuntimeGlobal("__primeLoadSkills", createSkillLoader(runtimeBindingNames, requireModule));

	process.stdout.write = createProcessStreamWrite("stdout");
	process.stderr.write = createProcessStreamWrite("stderr");
	globalThis.console = new Console({
		colorMode: false,
		stdout: createConsoleSink("stdout"),
		stderr: createConsoleSink("stderr"),
	});
	Bun.write = taggedBunWrite as typeof Bun.write;

	baselineGlobalNames = new Set(Object.getOwnPropertyNames(globalThis));

	startOwnerWatchdog();

	process.on("SIGINT", () => {
		requestInterrupt(undefined);
	});

	process.on("unhandledRejection", (reason) => {
		emitStream("stderr", `UnhandledPromiseRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`);
	});

	process.on("uncaughtException", (error) => {
		emitStream("stderr", `UncaughtException: ${error.stack ?? error.message}\n`);
	});

	// Announce Protocol v3 readiness with no banner before it.
	sendEvent({ event: "ready", protocol: PROTOCOL_VERSION, bun: Bun.version });

	// Rehydrate any persistent shells from prior kernel runs.
	queueMicrotask(() => {
		try {
			rehydratePersistentShells();
		} catch {
			// ignore
		}
	});

	const reader = createInterface({
		input: process.stdin,
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	reader.on("line", (line) => {
		try {
			handleRequestLine(line);
		} catch (error) {
			protocolError(`${error instanceof Error ? error.name : "Error"}: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
	reader.on("close", () => {
		failPendingHostRequests();
		requestQueue.push({ type: "shutdown", eof: true });
		void drainQueue();
	});
}

// Keep unused import reference clean
void fsSync;
void emit;

bootstrapRuntime();
