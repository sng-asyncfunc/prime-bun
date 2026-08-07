import { deserialize, serialize } from "bun:jsc";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { Console } from "node:console";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { type FileHandle, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { $ } from "bun";
import { type ModuleBindingRecipe, transformJavaScriptCell } from "./bun-cell-transform.js";
import {
	BUN_WORKER_PROTOCOL_VERSION,
	type BunWorkerError,
	type BunWorkerToHostMessage,
	type HostToBunWorkerMessage,
} from "./bun-protocol.js";
import { type BunRlmRuntime, createBunRlmRuntime } from "./bun-rlm-runtime.js";
import { BUN_RUNTIME_GLOBAL_NAMES } from "./bun-runtime-globals.js";
import {
	decodeSnapshotPayload,
	encodeSnapshotPayloadParts,
	SNAPSHOT_FORMAT_VERSION,
	type SnapshotPayloadEntry,
	snapshotValueSkipReason,
} from "./state-snapshot.js";

type PersistBinding = (name: string, value: unknown, recipe?: ModuleBindingRecipe) => void;
type AsyncExecutable = (...args: unknown[]) => Promise<unknown>;

export interface ShellResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface ShellPromise extends Promise<ShellResult> {
	text(): Promise<string>;
	json<T = unknown>(): Promise<T>;
}

interface PrimeWorkerGlobals {
	$: typeof $;
	sh: (command: string) => ShellPromise;
	installPackage: (...names: string[]) => Promise<ShellResult>;
	hostRequest: (requestType: string, payload?: unknown) => Promise<unknown>;
	rlm: BunRlmRuntime;
	__primeHostRequest: (requestType: string, payload: unknown) => Promise<unknown>;
	__primeDisplay: (mimeType: string, data: unknown) => void;
}

interface ActiveCell {
	cellId: string;
	source: string;
}

interface PendingHostRequest {
	resolve: (value: unknown) => void;
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
	stderr: string;
	stderrBytes: number;
	stderrScheduled: boolean;
	stdout: string;
	stdoutBytes: number;
	stdoutScheduled: boolean;
}

const protocolInput = createReadStream("", { autoClose: false, fd: 3 });
const protocolOutput = createWriteStream("", { autoClose: false, fd: 4 });
const lineReader = createInterface({ input: protocolInput, crlfDelay: Number.POSITIVE_INFINITY });
const bindings = new Set<string>();
const bindingRecipes = new Map<string, BindingRecipeState>();
const runtimeBindingNames = new Set(BUN_RUNTIME_GLOBAL_NAMES);
const pendingHostRequests = new Map<string, PendingHostRequest>();
const cellStreams = new Map<string, CellStreamState>();
const RUNTIME_STATE_ENTRY_NAME = "\0prime:runtime";
const MAX_CELL_STREAM_BYTES = 32 * 1024;
const MAX_PROTOCOL_RESULT_CHARS = 1_000_000;
const MAX_RESULT_PROJECTION_DEPTH = 8;
const MAX_RESULT_PROJECTION_ENTRIES = 256;
const MAX_RESULT_PROJECTION_KEY_CHARS = 256;
const MAX_SKILL_UNAVAILABLE_REASON_CHARS = 512;
const MAX_WRITEV_BUFFERS = 1024;
const cellContext = new AsyncLocalStorage<ActiveCell>();
const workerGlobals = globalThis as typeof globalThis & PrimeWorkerGlobals;
const requireModule = createRequire(import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
	...args: string[]
) => AsyncExecutable;
const restoreFunctionValue = new AsyncFunction("__primeSource", 'return (0, eval)("(" + __primeSource + "\\n)");');
const restoreImportedValue = new AsyncFunction("__primeSpecifier", "return import(__primeSpecifier);");

let activeCell: ActiveCell | undefined;
let lastCell: ActiveCell | undefined;
let activeExecutionId: string | undefined;
let commandPrefix = "";
let shellExecutable = "sh";
let shellArgs = ["-c"];
let bunPath = "bun";
let kernelDirectory = process.cwd();
let initialized = false;
let shuttingDown = false;
let baselineGlobalNames = new Set<string>();
let initialEnvironment: Record<string, string | undefined> = { ...process.env };

type StreamWriteCallback = (error?: Error | null) => void;

class SkillFactoryTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SkillFactoryTimeoutError";
	}
}

const rawStdoutWrite = process.stdout.write.bind(process.stdout) as (
	chunk: string,
	callback?: StreamWriteCallback,
) => boolean;
const rawStderrWrite = process.stderr.write.bind(process.stderr) as (
	chunk: string,
	callback?: StreamWriteCallback,
) => boolean;
const nativeBunWrite = Bun.write.bind(Bun);

function send(message: BunWorkerToHostMessage): void {
	if (protocolOutput.destroyed || protocolOutput.writableEnded) return;
	protocolOutput.write(`${JSON.stringify(message)}\n`);
}

function cellStreamState(cellId: string): CellStreamState {
	const existing = cellStreams.get(cellId);
	if (existing) return existing;
	const created: CellStreamState = {
		stderr: "",
		stderrBytes: 0,
		stderrScheduled: false,
		stdout: "",
		stdoutBytes: 0,
		stdoutScheduled: false,
	};
	cellStreams.set(cellId, created);
	return created;
}

function streamByteCountKey(name: "stdout" | "stderr"): "stdoutBytes" | "stderrBytes" {
	return name === "stdout" ? "stdoutBytes" : "stderrBytes";
}

function streamScheduledKey(name: "stdout" | "stderr"): "stdoutScheduled" | "stderrScheduled" {
	return name === "stdout" ? "stdoutScheduled" : "stderrScheduled";
}

function removeEmptyCellStreamState(cellId: string, state: CellStreamState): void {
	if (state.stdout || state.stderr || state.stdoutScheduled || state.stderrScheduled) return;
	if (cellStreams.get(cellId) === state) cellStreams.delete(cellId);
}

function flushCellStream(cellId: string, name: "stdout" | "stderr"): void {
	const state = cellStreams.get(cellId);
	if (!state) return;
	state[streamScheduledKey(name)] = false;
	const text = state[name];
	if (!text) {
		removeEmptyCellStreamState(cellId, state);
		return;
	}
	state[name] = "";
	state[streamByteCountKey(name)] = 0;
	send({
		cellId,
		id: randomUUID(),
		name,
		protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
		text,
		type: "stream",
	});
	removeEmptyCellStreamState(cellId, state);
}

function flushCellStreams(cellId: string): void {
	flushCellStream(cellId, "stdout");
	flushCellStream(cellId, "stderr");
	const state = cellStreams.get(cellId);
	if (state) removeEmptyCellStreamState(cellId, state);
}

function emitCellStream(name: "stdout" | "stderr", text: string): boolean {
	const sourceCell = cellContext.getStore();
	if (!sourceCell) return false;
	const state = cellStreamState(sourceCell.cellId);
	const byteCountKey = streamByteCountKey(name);
	const scheduledKey = streamScheduledKey(name);
	state[name] += text;
	state[byteCountKey] += Buffer.byteLength(text);
	if (state[byteCountKey] >= MAX_CELL_STREAM_BYTES) {
		flushCellStream(sourceCell.cellId, name);
		return true;
	}
	if (!state[scheduledKey]) {
		state[scheduledKey] = true;
		queueMicrotask(() => {
			if (cellStreams.get(sourceCell.cellId) === state) flushCellStream(sourceCell.cellId, name);
		});
	}
	return true;
}

function streamChunkText(chunk: string | Uint8Array, encoding?: BufferEncoding): string {
	return typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(encoding);
}

function createProcessStreamWrite(
	name: "stdout" | "stderr",
	rawWrite: (chunk: string, callback?: StreamWriteCallback) => boolean,
): typeof process.stdout.write {
	const write = (
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | StreamWriteCallback,
		callback?: StreamWriteCallback,
	): boolean => {
		const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
		const completed = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
		const text = streamChunkText(chunk, encoding);
		if (!emitCellStream(name, text)) return rawWrite(text, completed);
		if (completed) queueMicrotask(() => completed());
		return true;
	};
	return write as typeof process.stdout.write;
}

function createConsoleSink(
	name: "stdout" | "stderr",
	rawWrite: (chunk: string, callback?: StreamWriteCallback) => boolean,
): Writable {
	return new Writable({
		write(chunk: Buffer, _encoding: BufferEncoding, callback: StreamWriteCallback): void {
			const text = chunk.toString();
			if (emitCellStream(name, text)) {
				callback();
				return;
			}
			rawWrite(text, callback);
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
	if (!name || !cellContext.getStore()) return nativeBunWrite(destination, data, options);
	const text = await bunWriteDataText(data);
	emitCellStream(name, text);
	return Buffer.byteLength(text);
}

function normalizeError(error: unknown): BunWorkerError {
	if (error instanceof Error) {
		return {
			message: error.message,
			name: error.name || "Error",
			...(error.stack ? { stack: error.stack } : {}),
		};
	}
	return { message: String(error), name: "Error" };
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
		const constructorName = Object.getPrototypeOf(value)?.constructor?.name ?? "ArrayBufferView";
		return `[${constructorName} ${value.byteLength} bytes]`;
	}
	if (Array.isArray(value)) {
		const projected: unknown[] = [];
		const entryCount = Math.min(value.length, Math.max(0, budget.entriesRemaining));
		for (let index = 0; index < entryCount; index += 1) {
			budget.entriesRemaining -= 1;
			const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
			if (!descriptor) {
				projected.push("[Empty]");
			} else if ("value" in descriptor) {
				projected.push(projectForInspect(descriptor.value, budget, depth + 1));
			} else {
				projected.push(descriptor.get ? "[Getter]" : "[Setter]");
			}
		}
		if (entryCount < value.length) projected.push(`[... ${value.length - entryCount} entries truncated ...]`);
		return projected;
	}
	if (value instanceof Map) {
		const projected = new Map<unknown, unknown>();
		let retained = 0;
		for (const [key, entryValue] of value) {
			if (budget.entriesRemaining <= 0) break;
			budget.entriesRemaining -= 1;
			retained += 1;
			projected.set(projectForInspect(key, budget, depth + 1), projectForInspect(entryValue, budget, depth + 1));
		}
		if (retained < value.size) projected.set(`[... ${value.size - retained} entries truncated ...]`, "");
		return projected;
	}
	if (value instanceof Set) {
		const projected = new Set<unknown>();
		let retained = 0;
		for (const entryValue of value) {
			if (budget.entriesRemaining <= 0) break;
			budget.entriesRemaining -= 1;
			retained += 1;
			projected.add(projectForInspect(entryValue, budget, depth + 1));
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
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor) continue;
			projectedValue =
				"value" in descriptor
					? projectForInspect(descriptor.value, budget, depth + 1)
					: descriptor.get
						? "[Getter]"
						: "[Setter]";
		} catch (error) {
			projectedValue = `[Property inspection failed: ${normalizeError(error).message.slice(0, 128)}]`;
		}
		defineProjectedProperty(projected, projectedKey, projectedValue);
	}
	if (truncated) defineProjectedProperty(projected, "[... properties truncated ...]", true);
	return projected;
}

function boundedInspect(value: unknown, maxChars: number): string {
	const boundedMaxChars = Math.min(
		MAX_PROTOCOL_RESULT_CHARS,
		Math.max(0, Math.floor(Number.isFinite(maxChars) ? maxChars : 0)),
	);
	const projected = projectForInspect(
		value,
		{
			charsRemaining: boundedMaxChars,
			entriesRemaining: MAX_RESULT_PROJECTION_ENTRIES,
			seen: new WeakSet<object>(),
		},
		0,
	);
	const inspected = Bun.inspect(projected, { colors: false, depth: MAX_RESULT_PROJECTION_DEPTH });
	if (inspected.length <= boundedMaxChars) return inspected;
	return `${inspected.slice(0, boundedMaxChars)}\n[... result truncated at ${boundedMaxChars} chars ...]`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new SkillFactoryTimeoutError(`${label} timed out after ${timeoutMs} ms`)),
			timeoutMs,
		);
		timer.unref?.();
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
	for (const [name, environmentValue] of Object.entries(set)) {
		if (typeof environmentValue !== "string") throw new Error(`runtime environment value ${name} is invalid`);
		normalizedSet[name] = environmentValue;
	}
	return { cwd: value.cwd, environment: { deleted: deleted as string[], set: normalizedSet } };
}

function restoreRuntimeState(data: Uint8Array): void {
	const state = parseRuntimeState(data);
	process.chdir(state.cwd);
	for (const name of state.environment.deleted) delete process.env[name];
	for (const [name, value] of Object.entries(state.environment.set)) process.env[name] = value;
}

function sendProtocolError(replyTo: string | undefined, error: unknown): void {
	send({
		error: normalizeError(error),
		id: randomUUID(),
		protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
		...(replyTo ? { replyTo } : {}),
		type: "protocol_error",
	});
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

function runShell(command: string): ShellPromise {
	const source = commandPrefix ? `${commandPrefix}\n${command}` : command;
	const promise = new Promise<ShellResult>((resolve) => {
		execFile(
			shellExecutable,
			[...shellArgs, source],
			{ cwd: process.cwd(), encoding: "utf8", env: process.env, maxBuffer: 16 * 1024 * 1024 },
			(error, stdout, stderr) => {
				const exitCode = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
				resolve({ exitCode, stderr, stdout });
			},
		);
	});
	const shellPromise = promise as ShellPromise;
	shellPromise.text = async () => (await promise).stdout;
	shellPromise.json = async <T = unknown>() => JSON.parse((await promise).stdout) as T;
	return shellPromise;
}

function installPackage(...names: string[]): Promise<ShellResult> {
	if (names.length === 0 || names.some((name) => !name.trim())) {
		throw new Error("installPackage requires at least one non-empty package name");
	}
	if (names.some((name) => name.trimStart().startsWith("-"))) {
		throw new Error("installPackage package names cannot start with '-'");
	}
	return new Promise((resolve, reject) => {
		execFile(
			bunPath,
			["add", ...names],
			{ cwd: kernelDirectory, encoding: "utf8", env: process.env, maxBuffer: 16 * 1024 * 1024 },
			(error, stdout, stderr) => {
				const exitCode = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
				const result = { exitCode, stderr, stdout };
				if (error) {
					reject(
						new Error(`bun add ${names.join(" ")} failed with exit code ${exitCode}: ${stderr.trim()}`, {
							cause: error,
						}),
					);
					return;
				}
				resolve(result);
			},
		);
	});
}

function hostRequest(requestType: string, payload: unknown): Promise<unknown> {
	const sourceCell = cellContext.getStore() ?? activeCell ?? lastCell;
	if (!sourceCell) throw new Error("Host requests require a previously started Bun cell");
	const requestId = randomUUID();
	send({
		cellId: sourceCell.cellId,
		cellSource: sourceCell.source,
		id: randomUUID(),
		payload,
		protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
		requestId,
		requestType,
		type: "host_request",
	});
	return new Promise((resolve, reject) => {
		pendingHostRequests.set(requestId, { reject, resolve });
	});
}

function display(mimeType: string, data: unknown): void {
	const sourceCell = cellContext.getStore() ?? activeCell ?? lastCell;
	if (!sourceCell) throw new Error("Displays require a previously started Bun cell");
	send({
		cellId: sourceCell.cellId,
		data,
		id: randomUUID(),
		mimeType,
		protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
		type: "display",
	});
}

function defineUnavailableSkill(name: string, globalName: string, error: unknown): void {
	const failure = normalizeError(error);
	const unavailable = async (): Promise<never> => {
		throw new Error(`JavaScript skill ${name} is unavailable: ${failure.message}`);
	};
	Object.defineProperty(globalThis, globalName, {
		configurable: true,
		enumerable: true,
		value: unavailable,
		writable: false,
	});
	send({
		error: failure,
		id: randomUUID(),
		protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
		type: "diagnostic",
	});
}

async function writeAtomic(path: string, data: Uint8Array | string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporaryPath, data);
		await rename(temporaryPath, path);
	} catch (error) {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
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
		for (let index = partIndex; index < parts.length && buffers.length < MAX_WRITEV_BUFFERS; index += 1) {
			const part = parts[index]!;
			const offset = index === partIndex ? partOffset : 0;
			if (offset === part.byteLength) continue;
			const buffer = offset === 0 ? part : part.subarray(offset);
			buffers.push(buffer);
			batchBytes += buffer.byteLength;
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

async function writeBinaryAtomic(path: string, parts: readonly Uint8Array[]): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	let handle: FileHandle | undefined;
	try {
		handle = await open(temporaryPath, "w");
		await writeSnapshotParts(handle, parts);
		await handle.close();
		handle = undefined;
		await rename(temporaryPath, path);
	} catch (error) {
		await handle?.close().catch(() => undefined);
		await rm(temporaryPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

async function snapshotState(message: Extract<HostToBunWorkerMessage, { type: "snapshot" }>): Promise<void> {
	const savedEntries: SnapshotPayloadEntry[] = [];
	const skipped: { name: string; reason: string }[] = [];
	let serializedBytes = 0;
	const saveEntry = (entry: SnapshotPayloadEntry): boolean => {
		if (entry.data.byteLength > message.maxBytes || serializedBytes + entry.data.byteLength > message.maxBytes) {
			skipped.push({ name: entry.name, reason: "exceeds snapshot size cap" });
			return false;
		}
		savedEntries.push(entry);
		serializedBytes += entry.data.byteLength;
		return true;
	};
	try {
		if (activeExecutionId) throw new Error("Cannot snapshot while a Bun cell is executing");
		if (message.includeRuntimeState) {
			const runtimeEntry: SnapshotPayloadEntry = {
				data: Buffer.from(JSON.stringify(captureRuntimeState()), "utf8"),
				kind: "runtime",
				name: RUNTIME_STATE_ENTRY_NAME,
			};
			if (!saveEntry(runtimeEntry)) {
				throw new Error(`Runtime cwd and environment exceed the ${message.maxBytes}-byte snapshot cap`);
			}
		}
		for (const name of [...bindings].sort()) {
			if (name.startsWith("_") || runtimeBindingNames.has(name)) {
				skipped.push({ name, reason: "runtime bindings are recreated instead of snapshotted" });
				continue;
			}
			let value: unknown;
			try {
				value = Reflect.get(globalThis, name);
			} catch (error) {
				skipped.push({ name, reason: `binding read failed: ${normalizeError(error).message}` });
				continue;
			}
			const importRecipe = bindingRecipes.get(name)?.recipe;
			if (importRecipe) {
				saveEntry({ data: Buffer.from(importRecipe.specifier, "utf8"), kind: "import", name });
				continue;
			}
			if (typeof value === "function") {
				try {
					const source = Function.prototype.toString.call(value);
					if (source.includes("[native code]")) {
						skipped.push({ name, reason: "native function source is not restorable" });
						continue;
					}
					saveEntry({ data: Buffer.from(source, "utf8"), kind: "function", name });
				} catch (error) {
					skipped.push({ name, reason: `function source read failed: ${normalizeError(error).message}` });
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
				saveEntry({ name, data });
			} catch (error) {
				skipped.push({ name, reason: `serialization failed: ${normalizeError(error).message}` });
			}
		}
		const payload = encodeSnapshotPayloadParts(savedEntries);
		const savedNames = savedEntries.filter((entry) => entry.kind !== "runtime").map((entry) => entry.name);
		await writeBinaryAtomic(message.path, payload.parts);
		await writeAtomic(
			message.manifestPath,
			`${JSON.stringify(
				{
					bunVersion: Bun.version,
					bytes: payload.byteLength,
					savedNames,
					skipped,
					timestamp: new Date().toISOString(),
					version: SNAPSHOT_FORMAT_VERSION,
				},
				null,
				2,
			)}\n`,
		);
		send({
			bytes: payload.byteLength,
			id: randomUUID(),
			path: message.path,
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			replyTo: message.id,
			saved: savedNames,
			skipped,
			type: "snapshot_result",
		});
	} catch (error) {
		send({
			bytes: 0,
			error: normalizeError(error).message,
			id: randomUUID(),
			path: message.path,
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			replyTo: message.id,
			saved: [],
			skipped,
			type: "snapshot_result",
		});
	}
}

async function restoreState(message: Extract<HostToBunWorkerMessage, { type: "restore" }>): Promise<void> {
	const restored: string[] = [];
	const failed: { name: string; reason: string }[] = [];
	let runtimeRestored = false;
	try {
		if (activeExecutionId) throw new Error("Cannot restore while a Bun cell is executing");
		let payload: Buffer;
		try {
			payload = await readFile(message.path);
		} catch (error) {
			if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
				if (message.required) throw new Error(`Required Bun recovery snapshot does not exist: ${message.path}`);
				send({
					failed,
					id: randomUUID(),
					path: message.path,
					protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
					replyTo: message.id,
					restored,
					runtimeRestored,
					type: "restore_result",
				});
				return;
			}
			throw error;
		}

		const entries = decodeSnapshotPayload(payload);
		for (const entry of entries.filter((candidate) => candidate.kind === "runtime")) {
			try {
				restoreRuntimeState(entry.data);
				runtimeRestored = true;
			} catch (error) {
				failed.push({ name: RUNTIME_STATE_ENTRY_NAME, reason: normalizeError(error).message });
			}
		}
		for (const entry of entries.filter((candidate) => candidate.kind === undefined)) {
			if (runtimeBindingNames.has(entry.name)) {
				failed.push({ name: entry.name, reason: "runtime binding was not restored" });
				continue;
			}
			try {
				persistBinding(entry.name, deserialize(entry.data));
				restored.push(entry.name);
			} catch (error) {
				failed.push({ name: entry.name, reason: normalizeError(error).message });
			}
		}
		for (const entry of entries.filter((candidate) => candidate.kind === "function" || candidate.kind === "import")) {
			if (runtimeBindingNames.has(entry.name)) {
				failed.push({ name: entry.name, reason: "runtime binding was not restored" });
				continue;
			}
			try {
				const source = Buffer.from(entry.data).toString("utf8");
				switch (entry.kind) {
					case "function": {
						const value = await restoreFunctionValue(source);
						if (typeof value !== "function") throw new Error("function recipe did not restore a function");
						persistBinding(entry.name, value);
						break;
					}
					case "import": {
						if (!source) throw new Error("import recipe has an empty specifier");
						const value = await restoreImportedValue(source);
						persistBinding(entry.name, value, { loader: "import", specifier: source, type: "module" });
						break;
					}
				}
				restored.push(entry.name);
			} catch (error) {
				failed.push({ name: entry.name, reason: normalizeError(error).message });
			}
		}
		send({
			failed,
			id: randomUUID(),
			path: message.path,
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			replyTo: message.id,
			restored,
			runtimeRestored,
			type: "restore_result",
		});
	} catch (error) {
		send({
			error: normalizeError(error).message,
			failed,
			id: randomUUID(),
			path: message.path,
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			replyTo: message.id,
			restored,
			runtimeRestored,
			type: "restore_result",
		});
	}
}

workerGlobals.$ = $;
workerGlobals.sh = runShell;
workerGlobals.installPackage = installPackage;
workerGlobals.hostRequest = hostRequest;
workerGlobals.rlm = createBunRlmRuntime(hostRequest);
workerGlobals.__primeHostRequest = hostRequest;
workerGlobals.__primeDisplay = display;
process.stdout.write = createProcessStreamWrite("stdout", rawStdoutWrite);
process.stderr.write = createProcessStreamWrite("stderr", rawStderrWrite);
globalThis.console = new Console({
	colorMode: false,
	stderr: createConsoleSink("stderr", rawStderrWrite),
	stdout: createConsoleSink("stdout", rawStdoutWrite),
});
Bun.write = taggedBunWrite;

const cellTranspiler = new Bun.Transpiler({ deadCodeElimination: false, loader: "ts", target: "bun" });

async function executeCell(message: Extract<HostToBunWorkerMessage, { type: "execute" }>): Promise<void> {
	if (!initialized) {
		flushCellStreams(message.cellId);
		send({
			cellId: message.cellId,
			durationMs: 0,
			error: { message: "Bun worker is not initialized", name: "InitializationError" },
			id: randomUUID(),
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			replyTo: message.id,
			status: "error",
			type: "result",
		});
		return;
	}
	if (activeExecutionId) {
		flushCellStreams(message.cellId);
		send({
			cellId: message.cellId,
			durationMs: 0,
			error: { message: "Bun worker is already executing a cell", name: "BusyError" },
			id: randomUUID(),
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			replyTo: message.id,
			status: "error",
			type: "result",
		});
		return;
	}

	activeExecutionId = message.id;
	activeCell = { cellId: message.cellId, source: message.code };
	lastCell = activeCell;
	const startedAt = performance.now();
	try {
		const transformed = transformJavaScriptCell(cellTranspiler.transformSync(message.code));
		const executor = new AsyncFunction("__primePersist", transformed.code);
		const result = await cellContext.run(activeCell, () => executor(persistBinding));
		flushCellStreams(message.cellId);
		send({
			bindingNames: transformed.bindingNames,
			cellId: message.cellId,
			durationMs: performance.now() - startedAt,
			id: randomUUID(),
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			replyTo: message.id,
			status: "ok",
			type: "result",
			...(result === undefined ? {} : { value: boundedInspect(result, message.maxResultChars ?? 65_536) }),
		});
	} catch (error) {
		flushCellStreams(message.cellId);
		send({
			cellId: message.cellId,
			durationMs: performance.now() - startedAt,
			error: normalizeError(error),
			id: randomUUID(),
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			replyTo: message.id,
			status: "error",
			type: "result",
		});
	} finally {
		reconcileBindings();
		activeCell = undefined;
		activeExecutionId = undefined;
	}
}

async function initialize(message: Extract<HostToBunWorkerMessage, { type: "initialize" }>): Promise<void> {
	try {
		initialized = false;
		process.chdir(message.cwd);
		bunPath = message.bunPath;
		commandPrefix = message.commandPrefix;
		kernelDirectory = message.kernelDirectory;
		shellExecutable = message.shell.executable;
		shellArgs = [...message.shell.args];
		initialEnvironment = { ...process.env };
		for (const skill of message.skills) {
			if (runtimeBindingNames.has(skill.globalName)) {
				send({
					error: normalizeError(
						new Error(`JavaScript skill ${skill.name} conflicts with runtime global ${skill.globalName}`),
					),
					id: randomUUID(),
					protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
					type: "diagnostic",
				});
				continue;
			}
			if (skill.unavailableReason !== undefined) {
				defineUnavailableSkill(
					skill.name,
					skill.globalName,
					new Error(skill.unavailableReason.slice(0, MAX_SKILL_UNAVAILABLE_REASON_CHARS)),
				);
				runtimeBindingNames.add(skill.globalName);
				continue;
			}
			let loaded: unknown;
			try {
				loaded = requireModule(skill.entryPath);
			} catch (error) {
				defineUnavailableSkill(skill.name, skill.globalName, error);
				runtimeBindingNames.add(skill.globalName);
				continue;
			}
			const exports = typeof loaded === "object" && loaded !== null ? (loaded as Record<string, unknown>) : {};
			const factory = exports.createSkill;
			const context = {
				get cwd(): string {
					return process.cwd();
				},
				display,
				hostRequest,
			};
			let value: unknown;
			if (typeof factory === "function") {
				try {
					value = await withTimeout(
						Promise.resolve(factory(context)),
						message.skillFactoryTimeoutMs,
						`JavaScript skill ${skill.name} factory`,
					);
				} catch (error) {
					if (error instanceof SkillFactoryTimeoutError) {
						throw new Error(error.message, { cause: error });
					}
					defineUnavailableSkill(skill.name, skill.globalName, error);
					runtimeBindingNames.add(skill.globalName);
					continue;
				}
			} else {
				value = exports.default ?? loaded;
			}
			if (value === undefined) {
				defineUnavailableSkill(
					skill.name,
					skill.globalName,
					new Error("module exports neither createSkill nor default"),
				);
				runtimeBindingNames.add(skill.globalName);
				continue;
			}
			Object.defineProperty(globalThis, skill.globalName, {
				configurable: true,
				enumerable: true,
				value,
				writable: false,
			});
			runtimeBindingNames.add(skill.globalName);
		}
		baselineGlobalNames = new Set(Object.getOwnPropertyNames(globalThis));
		initialized = true;
		send({
			bunVersion: Bun.version,
			id: randomUUID(),
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			replyTo: message.id,
			type: "ready",
		});
	} catch (error) {
		initialized = false;
		sendProtocolError(message.id, error);
	}
}

function acceptHostResponse(message: Extract<HostToBunWorkerMessage, { type: "host_response" }>): void {
	const pending = pendingHostRequests.get(message.requestId);
	if (!pending) {
		sendProtocolError(message.id, new Error(`Unknown host request: ${message.requestId}`));
		return;
	}
	pendingHostRequests.delete(message.requestId);
	if (message.error) {
		const error = new Error(message.error.message);
		error.name = message.error.name;
		pending.reject(error);
		return;
	}
	pending.resolve(message.value);
}

function shutdown(): void {
	if (shuttingDown) return;
	shuttingDown = true;
	lineReader.close();
	for (const pending of pendingHostRequests.values()) {
		pending.reject(new Error("Bun worker shut down before the host request completed"));
	}
	pendingHostRequests.clear();
	protocolOutput.end(() => process.exit(0));
}

function handleMessage(message: HostToBunWorkerMessage): void {
	if (message.protocolVersion !== BUN_WORKER_PROTOCOL_VERSION) {
		sendProtocolError(
			message.id,
			new Error(
				`Unsupported Bun worker protocol ${message.protocolVersion}; expected ${BUN_WORKER_PROTOCOL_VERSION}`,
			),
		);
		return;
	}
	switch (message.type) {
		case "initialize":
			void initialize(message);
			return;
		case "execute":
			void executeCell(message);
			return;
		case "list_names":
			send({
				id: randomUUID(),
				names: [...bindings].filter((name) => !name.startsWith("_") && !runtimeBindingNames.has(name)).sort(),
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				replyTo: message.id,
				type: "list_names_result",
			});
			return;
		case "snapshot":
			void snapshotState(message);
			return;
		case "restore":
			void restoreState(message);
			return;
		case "host_response":
			acceptHostResponse(message);
			return;
		case "shutdown":
			shutdown();
			return;
	}
}

function reportDiagnostic(error: unknown): void {
	send({
		...(activeCell ? { cellId: activeCell.cellId } : {}),
		error: normalizeError(error),
		id: randomUUID(),
		protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
		type: "diagnostic",
	});
}

function reportFatal(error: unknown): void {
	reportDiagnostic(error);
	setTimeout(() => process.exit(1), 0);
}

process.on("unhandledRejection", reportDiagnostic);
process.on("uncaughtException", reportFatal);

lineReader.on("line", (line) => {
	try {
		handleMessage(JSON.parse(line) as HostToBunWorkerMessage);
	} catch (error) {
		sendProtocolError(undefined, error);
	}
});
