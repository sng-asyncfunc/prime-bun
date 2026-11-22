import { randomUUID } from "node:crypto";

export const PROTOCOL_VERSION = 3;
export const PAYLOAD_CAP = 16 * 1024 * 1024;
export const RESULT_TEXT_CAP = 1_048_576;
export const RESULT_TRUNCATION_MARKER = `\n[... result truncated at ${RESULT_TEXT_CAP} characters ...]`;

export interface CellExecutionContext {
	cellId: string;
	finished: Promise<void>;
	abortSignal: AbortSignal;
	isActive(): boolean;
}

export interface ReplBridgeImpl {
	isActive(): boolean;
	send(event: Record<string, unknown>): void;
	hostRequestRaw(data: Record<string, unknown>): Promise<Record<string, unknown>>;
	currentCellId(): string | null;
	currentCellExecution(): CellExecutionContext | null;
	activeCellId(): string | null;
	writeStderr(text: string): void;
}

let bridgeImpl: ReplBridgeImpl | null = null;
let customHostRequestOverride:
	| ((requestType: string, payload?: Record<string, unknown>) => Promise<Record<string, unknown>>)
	| null = null;

export function registerReplBridge(impl: ReplBridgeImpl | null): void {
	bridgeImpl = impl;
}

/** Test hook allowing unit tests to mock hostRequest without spawning the full REPL. */
export function setHostRequestOverride(
	fn: ((requestType: string, payload?: Record<string, unknown>) => Promise<Record<string, unknown>>) | null,
): void {
	customHostRequestOverride = fn;
}

export function isActive(): boolean {
	return bridgeImpl?.isActive() ?? false;
}

export function sendProtocolEvent(event: Record<string, unknown>): void {
	bridgeImpl?.send(event);
}

export function currentCellId(): string | null {
	return bridgeImpl?.currentCellId() ?? null;
}

export function currentCellExecution(): CellExecutionContext | null {
	return bridgeImpl?.currentCellExecution() ?? null;
}

export function activeCellId(): string | null {
	return bridgeImpl?.activeCellId() ?? null;
}

export function writeCellStderr(text: string): void {
	if (bridgeImpl) {
		bridgeImpl.writeStderr(text);
	} else {
		process.stderr.write(text);
	}
}

function assertStrictJson(value: unknown, seen = new Set<object>()): void {
	if (value === null || value === undefined) return;
	const t = typeof value;
	if (t === "number") {
		if (!Number.isFinite(value)) {
			throw new TypeError("JSON payload cannot contain NaN or Infinity");
		}
		return;
	}
	if (t === "string" || t === "boolean") return;
	if (t === "bigint" || t === "symbol" || t === "function") {
		throw new TypeError(`JSON payload cannot serialize ${t}`);
	}
	if (t === "object") {
		const obj = value as object;
		if (seen.has(obj)) throw new TypeError("JSON payload contains circular reference");
		seen.add(obj);
		try {
			if (Array.isArray(obj)) {
				for (const item of obj) assertStrictJson(item, seen);
			} else {
				for (const val of Object.values(obj as Record<string, unknown>)) {
					assertStrictJson(val, seen);
				}
			}
		} finally {
			seen.delete(obj);
		}
	}
}

export function checkPayload(event: string, data: Record<string, unknown>): void {
	assertStrictJson(data);
	const encoded = JSON.stringify(data);
	if (encoded.length > PAYLOAD_CAP) {
		throw new RangeError(`${event} payload exceeds the ${PAYLOAD_CAP}-character frame cap`);
	}
}

export function emit(data: Record<string, unknown>): void {
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		throw new TypeError("emit() requires a non-empty object keyed by MIME type strings");
	}
	const keys = Object.keys(data);
	if (keys.length === 0) {
		throw new TypeError("emit() requires a non-empty object keyed by MIME type strings");
	}
	checkPayload("display", data);
	if (!bridgeImpl) return;
	bridgeImpl.send({
		event: "display",
		id: bridgeImpl.currentCellId(),
		data,
	});
}

export async function hostRequestRaw(data: Record<string, unknown>): Promise<Record<string, unknown>> {
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		throw new TypeError("hostRequest data must be an object");
	}
	if (!bridgeImpl) {
		throw new Error("repl runtime is not serving");
	}
	checkPayload("host_request", data);
	return bridgeImpl.hostRequestRaw(data);
}

export function sendHostRequestFireAndForget(data: Record<string, unknown>): void {
	if (!bridgeImpl || !bridgeImpl.isActive()) return;
	bridgeImpl.send({
		event: "host_request",
		id: randomUUID().replace(/-/g, ""),
		data,
	});
}

function parseHostReply(requestType: string, reply: Record<string, unknown>): Record<string, unknown> {
	const status = reply.status;
	if (status === "ok") {
		return (reply.result ?? {}) as Record<string, unknown>;
	}
	if (status === "error") {
		const message = typeof reply.error === "string" && reply.error ? reply.error : `host request ${requestType} failed`;
		throw new Error(message);
	}
	throw new Error(`host request ${requestType} returned unexpected status: ${String(status)}`);
}

export async function hostRequest(
	requestType: string,
	payload?: Record<string, unknown> | null,
): Promise<Record<string, unknown>> {
	if (typeof requestType !== "string" || !requestType) {
		throw new TypeError("requestType must be a non-empty string");
	}
	if (payload !== undefined && payload !== null && (typeof payload !== "object" || Array.isArray(payload))) {
		throw new TypeError(`payload must be an object or null/undefined, got ${typeof payload}`);
	}
	if (customHostRequestOverride) {
		return customHostRequestOverride(requestType, payload ?? undefined);
	}
	// requestType goes last so payload.type cannot reroute the request.
	const wirePayload: Record<string, unknown> = { ...(payload ?? {}), type: requestType };
	const reply = await hostRequestRaw(wirePayload);
	return parseHostReply(requestType, reply);
}
