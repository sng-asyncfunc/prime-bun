import { deserialize, serialize } from "bun:jsc";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { $ } from "bun";
import { transformJavaScriptCell } from "./bun-cell-transform.js";
import {
	BUN_WORKER_PROTOCOL_VERSION,
	type BunWorkerError,
	type BunWorkerToHostMessage,
	type HostToBunWorkerMessage,
} from "./bun-protocol.js";
import {
	decodeSnapshotPayload,
	encodeSnapshotPayload,
	type SnapshotPayloadEntry,
	snapshotValueSkipReason,
} from "./state-snapshot.js";

type PersistBinding = (name: string, value: unknown) => void;
type CellExecutor = (persist: PersistBinding) => Promise<unknown>;

interface ShellResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

interface PrimeWorkerGlobals {
	$: typeof $;
	sh: (command: string) => Promise<ShellResult>;
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

const protocolInput = createReadStream("", { autoClose: false, fd: 3 });
const protocolOutput = createWriteStream("", { autoClose: false, fd: 4 });
const lineReader = createInterface({ input: protocolInput, crlfDelay: Number.POSITIVE_INFINITY });
const bindings = new Set<string>();
const runtimeBindingNames = new Set([
	"$",
	"Bun",
	"console",
	"fetch",
	"process",
	"sh",
	"__primeDisplay",
	"__primeHostRequest",
]);
const pendingHostRequests = new Map<string, PendingHostRequest>();
const workerGlobals = globalThis as typeof globalThis & PrimeWorkerGlobals;
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
	...args: string[]
) => CellExecutor;

let activeCell: ActiveCell | undefined;
let lastCell: ActiveCell | undefined;
let activeExecutionId: string | undefined;
let commandPrefix = "";
let shellPath = "/bin/sh";
let initialized = false;
let shuttingDown = false;

function send(message: BunWorkerToHostMessage): void {
	if (protocolOutput.destroyed || protocolOutput.writableEnded) return;
	protocolOutput.write(`${JSON.stringify(message)}\n`);
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

function sendProtocolError(replyTo: string | undefined, error: unknown): void {
	send({
		error: normalizeError(error),
		id: randomUUID(),
		protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
		...(replyTo ? { replyTo } : {}),
		type: "protocol_error",
	});
}

function persistBinding(name: string, value: unknown): void {
	bindings.add(name);
	Object.defineProperty(globalThis, name, {
		configurable: true,
		enumerable: true,
		value,
		writable: true,
	});
}

function runShell(command: string): Promise<ShellResult> {
	const source = commandPrefix ? `${commandPrefix}\n${command}` : command;
	return new Promise((resolve) => {
		execFile(
			shellPath,
			["-lc", source],
			{ cwd: process.cwd(), encoding: "utf8", env: process.env, maxBuffer: 16 * 1024 * 1024 },
			(error, stdout, stderr) => {
				const exitCode = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
				resolve({ exitCode, stderr, stdout });
			},
		);
	});
}

function hostRequest(requestType: string, payload: unknown): Promise<unknown> {
	const sourceCell = activeCell ?? lastCell;
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
	const sourceCell = activeCell ?? lastCell;
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

async function snapshotState(message: Extract<HostToBunWorkerMessage, { type: "snapshot" }>): Promise<void> {
	const savedEntries: SnapshotPayloadEntry[] = [];
	const skipped: { name: string; reason: string }[] = [];
	let serializedBytes = 0;
	try {
		if (activeExecutionId) throw new Error("Cannot snapshot while a Bun cell is executing");
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
			const skipReason = snapshotValueSkipReason(value);
			if (skipReason) {
				skipped.push({ name, reason: skipReason });
				continue;
			}
			try {
				const data = Uint8Array.from(new Uint8Array(serialize(value)));
				if (data.byteLength > message.maxBytes || serializedBytes + data.byteLength > message.maxBytes) {
					skipped.push({ name, reason: "exceeds snapshot size cap" });
					continue;
				}
				savedEntries.push({ name, data });
				serializedBytes += data.byteLength;
			} catch (error) {
				skipped.push({ name, reason: `serialization failed: ${normalizeError(error).message}` });
			}
		}

		const payload = encodeSnapshotPayload(savedEntries);
		await writeAtomic(message.path, payload);
		await writeAtomic(
			message.manifestPath,
			`${JSON.stringify(
				{
					bunVersion: Bun.version,
					bytes: payload.byteLength,
					savedNames: savedEntries.map((entry) => entry.name),
					skipped,
					timestamp: new Date().toISOString(),
					version: 1,
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
			saved: savedEntries.map((entry) => entry.name),
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
	try {
		if (activeExecutionId) throw new Error("Cannot restore while a Bun cell is executing");
		let payload: Buffer;
		try {
			payload = await readFile(message.path);
		} catch (error) {
			if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
				send({
					failed,
					id: randomUUID(),
					path: message.path,
					protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
					replyTo: message.id,
					restored,
					type: "restore_result",
				});
				return;
			}
			throw error;
		}

		for (const entry of decodeSnapshotPayload(payload)) {
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
		send({
			failed,
			id: randomUUID(),
			path: message.path,
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			replyTo: message.id,
			restored,
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
			type: "restore_result",
		});
	}
}

workerGlobals.$ = $;
workerGlobals.sh = runShell;
workerGlobals.__primeHostRequest = hostRequest;
workerGlobals.__primeDisplay = display;

async function executeCell(message: Extract<HostToBunWorkerMessage, { type: "execute" }>): Promise<void> {
	if (!initialized) {
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
		const transformed = transformJavaScriptCell(message.code);
		const executor = new AsyncFunction("__primePersist", transformed.code);
		const result = await executor(persistBinding);
		send({
			bindingNames: transformed.bindingNames,
			cellId: message.cellId,
			durationMs: performance.now() - startedAt,
			id: randomUUID(),
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			replyTo: message.id,
			status: "ok",
			type: "result",
			...(result === undefined ? {} : { value: Bun.inspect(result, { colors: false, depth: 8 }) }),
		});
	} catch (error) {
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
		activeCell = undefined;
		activeExecutionId = undefined;
	}
}

function initialize(message: Extract<HostToBunWorkerMessage, { type: "initialize" }>): void {
	process.chdir(message.cwd);
	commandPrefix = message.commandPrefix;
	shellPath = message.shellPath;
	initialized = true;
	send({
		bunVersion: Bun.version,
		id: randomUUID(),
		protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
		replyTo: message.id,
		type: "ready",
	});
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
			initialize(message);
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

function reportFatal(error: unknown): void {
	send({
		...(activeCell ? { cellId: activeCell.cellId } : {}),
		error: normalizeError(error),
		id: randomUUID(),
		protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
		type: "diagnostic",
	});
	setTimeout(() => process.exit(1), 0);
}

process.on("unhandledRejection", reportFatal);
process.on("uncaughtException", reportFatal);

lineReader.on("line", (line) => {
	try {
		handleMessage(JSON.parse(line) as HostToBunWorkerMessage);
	} catch (error) {
		sendProtocolError(undefined, error);
	}
});
