import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { $ } from "bun";
import { transformJavaScriptCell } from "./bun-cell-transform.js";
import {
	BUN_WORKER_PROTOCOL_VERSION,
	type BunWorkerError,
	type BunWorkerToHostMessage,
	type HostToBunWorkerMessage,
} from "./bun-protocol.js";

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
const pendingHostRequests = new Map<string, PendingHostRequest>();
const workerGlobals = globalThis as typeof globalThis & PrimeWorkerGlobals;
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
	...args: string[]
) => CellExecutor;

let activeCell: ActiveCell | undefined;
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
	if (!activeCell) throw new Error("Host requests are only available while a Bun cell is running");
	const requestId = randomUUID();
	send({
		cellId: activeCell.cellId,
		cellSource: activeCell.source,
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
	if (!activeCell) throw new Error("Displays are only available while a Bun cell is running");
	send({
		cellId: activeCell.cellId,
		data,
		id: randomUUID(),
		mimeType,
		protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
		type: "display",
	});
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
				names: [...bindings].sort(),
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				replyTo: message.id,
				type: "list_names_result",
			});
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
