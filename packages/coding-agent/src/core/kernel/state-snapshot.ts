import { join } from "node:path";

export const DEFAULT_SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024;

const KERNEL_STATE_BASENAME = "kernel-state";
export const SNAPSHOT_FORMAT_VERSION = 2;
const HEADER_LENGTH_BYTES = 4;
const MAX_HEADER_BYTES = 16 * 1024 * 1024;

export interface SnapshotResult {
	saved: string[];
	skipped: { name: string; reason: string }[];
	bytes: number;
	path: string;
}

export interface RestoreResult {
	restored: string[];
	failed: { name: string; reason: string }[];
	path: string;
}

export interface SnapshotPayloadEntry {
	name: string;
	data: Uint8Array;
	kind?: SnapshotPayloadKind;
}

export type SnapshotPayloadKind = "function" | "import" | "runtime";

interface SnapshotHeaderEntry {
	name: string;
	offset: number;
	length: number;
	kind?: SnapshotPayloadKind;
}

interface SnapshotHeader {
	version: number;
	entries: SnapshotHeaderEntry[];
}

export function snapshotPathIn(artifactDir: string): string {
	return join(artifactDir, `${KERNEL_STATE_BASENAME}.bin`);
}

export function manifestPathIn(artifactDir: string): string {
	return join(artifactDir, `${KERNEL_STATE_BASENAME}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function corruptSnapshot(reason: string): Error {
	return new Error(`Corrupt Bun snapshot: ${reason}`);
}

function parseHeader(value: unknown): SnapshotHeader {
	if (!isRecord(value) || value.version !== SNAPSHOT_FORMAT_VERSION || !Array.isArray(value.entries)) {
		throw corruptSnapshot("invalid header");
	}
	const entries = value.entries.map((entry): SnapshotHeaderEntry => {
		if (!isRecord(entry)) throw corruptSnapshot("invalid entry metadata");
		const kind = entry.kind;
		if (
			typeof entry.name !== "string" ||
			!Number.isSafeInteger(entry.offset) ||
			!Number.isSafeInteger(entry.length) ||
			(entry.offset as number) < 0 ||
			(entry.length as number) < 0 ||
			(kind !== undefined && kind !== "function" && kind !== "import" && kind !== "runtime")
		) {
			throw corruptSnapshot("invalid entry metadata");
		}
		return {
			name: entry.name,
			offset: entry.offset as number,
			length: entry.length as number,
			...(kind ? { kind } : {}),
		};
	});
	return { version: SNAPSHOT_FORMAT_VERSION, entries };
}

export function encodeSnapshotPayload(entries: readonly SnapshotPayloadEntry[]): Buffer {
	let offset = 0;
	const headerEntries = entries.map((entry): SnapshotHeaderEntry => {
		const metadata: SnapshotHeaderEntry = {
			name: entry.name,
			offset,
			length: entry.data.byteLength,
			...(entry.kind ? { kind: entry.kind } : {}),
		};
		offset += entry.data.byteLength;
		return metadata;
	});
	const header = Buffer.from(
		JSON.stringify({ version: SNAPSHOT_FORMAT_VERSION, entries: headerEntries } satisfies SnapshotHeader),
		"utf8",
	);
	if (header.byteLength > MAX_HEADER_BYTES) throw new Error("Bun snapshot header exceeds the 16 MiB limit");
	const prefix = Buffer.allocUnsafe(HEADER_LENGTH_BYTES);
	prefix.writeUInt32BE(header.byteLength, 0);
	return Buffer.concat([prefix, header, ...entries.map((entry) => Buffer.from(entry.data))]);
}

export function decodeSnapshotPayload(payload: Uint8Array): SnapshotPayloadEntry[] {
	const buffer = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
	if (buffer.byteLength < HEADER_LENGTH_BYTES) throw corruptSnapshot("missing header length");
	const headerLength = buffer.readUInt32BE(0);
	if (headerLength > MAX_HEADER_BYTES || HEADER_LENGTH_BYTES + headerLength > buffer.byteLength) {
		throw corruptSnapshot("header length is out of range");
	}

	let rawHeader: unknown;
	try {
		rawHeader = JSON.parse(buffer.subarray(HEADER_LENGTH_BYTES, HEADER_LENGTH_BYTES + headerLength).toString("utf8"));
	} catch (error) {
		throw corruptSnapshot(`header JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
	}
	const header = parseHeader(rawHeader);
	const dataStart = HEADER_LENGTH_BYTES + headerLength;
	const dataLength = buffer.byteLength - dataStart;
	const names = new Set<string>();
	const ranges: Array<{ start: number; end: number }> = [];

	return header.entries.map((entry) => {
		if (names.has(entry.name)) throw new Error(`Duplicate snapshot binding: ${entry.name}`);
		names.add(entry.name);
		const end = entry.offset + entry.length;
		if (!Number.isSafeInteger(end) || end > dataLength) throw corruptSnapshot(`entry ${entry.name} is out of range`);
		const overlaps = ranges.some((range) => entry.offset < range.end && end > range.start);
		if (overlaps) throw corruptSnapshot(`entry ${entry.name} overlaps another entry`);
		ranges.push({ start: entry.offset, end });
		return {
			name: entry.name,
			data: Uint8Array.from(buffer.subarray(dataStart + entry.offset, dataStart + end)),
			...(entry.kind ? { kind: entry.kind } : {}),
		};
	});
}

const TYPED_ARRAY_PROTOTYPES = new Set<object>([
	Int8Array.prototype,
	Uint8Array.prototype,
	Uint8ClampedArray.prototype,
	Int16Array.prototype,
	Uint16Array.prototype,
	Int32Array.prototype,
	Uint32Array.prototype,
	Float32Array.prototype,
	Float64Array.prototype,
	BigInt64Array.prototype,
	BigUint64Array.prototype,
]);

function inspectSnapshotValue(value: unknown, seen: WeakSet<object>, path: string): string | undefined {
	if (value === null) return undefined;
	const valueType = typeof value;
	if (valueType === "undefined" || valueType === "string" || valueType === "number" || valueType === "boolean") {
		return undefined;
	}
	if (valueType === "bigint") return undefined;
	if (valueType === "symbol") return `${path}: symbol values are not snapshot-safe`;
	if (valueType === "function") return `${path}: function values are not snapshot-safe`;
	if (valueType !== "object") return `${path}: unsupported value type ${valueType}`;

	const object = value as object;
	if (seen.has(object)) return undefined;
	seen.add(object);

	try {
		if (Object.getOwnPropertySymbols(object).length > 0) {
			return `${path}: symbol-keyed state is not snapshot-safe`;
		}
		if (object instanceof Promise) return `${path}: promises are not snapshot-safe`;
		if (object instanceof WeakMap || object instanceof WeakSet) {
			return `${path}: weak collections are not snapshot-safe`;
		}
		if (typeof WeakRef !== "undefined" && object instanceof WeakRef) {
			return `${path}: weak references are not snapshot-safe`;
		}

		const prototype = Object.getPrototypeOf(object);
		if (object instanceof Date) {
			if (prototype !== Date.prototype) return `${path}: custom prototype is not snapshot-safe`;
			return Object.keys(object).length === 0 ? undefined : `${path}: custom Date properties are not snapshot-safe`;
		}
		if (object instanceof RegExp) {
			if (prototype !== RegExp.prototype) return `${path}: custom prototype is not snapshot-safe`;
			return Object.keys(object).length === 0
				? undefined
				: `${path}: custom RegExp properties are not snapshot-safe`;
		}
		if (object instanceof ArrayBuffer) {
			if (prototype !== ArrayBuffer.prototype) return `${path}: custom prototype is not snapshot-safe`;
			return Object.keys(object).length === 0
				? undefined
				: `${path}: custom ArrayBuffer properties are not snapshot-safe`;
		}
		if (ArrayBuffer.isView(object)) {
			if (object instanceof DataView || !TYPED_ARRAY_PROTOTYPES.has(prototype)) {
				return `${path}: custom prototype or unsupported view is not snapshot-safe`;
			}
			if (Object.keys(object).some((key) => !/^(0|[1-9]\d*)$/.test(key))) {
				return `${path}: custom typed-array properties are not snapshot-safe`;
			}
			return undefined;
		}
		if (object instanceof Map) {
			if (prototype !== Map.prototype) return `${path}: custom prototype is not snapshot-safe`;
			if (Object.keys(object).length > 0) return `${path}: custom Map properties are not snapshot-safe`;
			let index = 0;
			for (const [key, entryValue] of object) {
				const keyReason = inspectSnapshotValue(key, seen, `${path}.mapKey${index}`);
				if (keyReason) return keyReason;
				const valueReason = inspectSnapshotValue(entryValue, seen, `${path}.mapValue${index}`);
				if (valueReason) return valueReason;
				index += 1;
			}
			return undefined;
		}
		if (object instanceof Set) {
			if (prototype !== Set.prototype) return `${path}: custom prototype is not snapshot-safe`;
			if (Object.keys(object).length > 0) return `${path}: custom Set properties are not snapshot-safe`;
			let index = 0;
			for (const entryValue of object) {
				const reason = inspectSnapshotValue(entryValue, seen, `${path}.setValue${index}`);
				if (reason) return reason;
				index += 1;
			}
			return undefined;
		}
		if (Array.isArray(object)) {
			if (prototype !== Array.prototype) return `${path}: custom prototype is not snapshot-safe`;
			for (const key of Object.keys(object)) {
				if (!/^(0|[1-9]\d*)$/.test(key)) return `${path}: custom array properties are not snapshot-safe`;
				const reason = inspectSnapshotValue(
					(object as unknown as Record<string, unknown>)[key],
					seen,
					`${path}[${key}]`,
				);
				if (reason) return reason;
			}
			return undefined;
		}
		if (prototype !== Object.prototype && prototype !== null) {
			return `${path}: custom prototype is not snapshot-safe`;
		}
		for (const [key, entryValue] of Object.entries(object)) {
			const reason = inspectSnapshotValue(entryValue, seen, `${path}.${key}`);
			if (reason) return reason;
		}
		return undefined;
	} catch (error) {
		return `${path}: inspection failed: ${error instanceof Error ? error.message : String(error)}`;
	}
}

export function snapshotValueSkipReason(value: unknown): string | undefined {
	return inspectSnapshotValue(value, new WeakSet(), "$binding");
}
