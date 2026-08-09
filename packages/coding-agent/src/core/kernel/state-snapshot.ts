import { join } from "node:path";

export const DEFAULT_SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024;
export const LARGE_SNAPSHOT_SWEEP_BYTES = 8 * 1024 * 1024;

export function shouldSweepSnapshotPayload(byteLength: number): boolean {
	return byteLength >= LARGE_SNAPSHOT_SWEEP_BYTES;
}

const KERNEL_STATE_BASENAME = "kernel-state";
export const SNAPSHOT_FORMAT_VERSION = 4;
const PREVIOUS_SNAPSHOT_FORMAT_VERSION = 3;
const LEGACY_SNAPSHOT_FORMAT_VERSION = 2;
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

export interface SnapshotPayloadParts {
	parts: Uint8Array[];
	byteLength: number;
}

export type SnapshotPayloadKind = "bindings" | "function" | "import" | "module" | "runtime";

interface SnapshotHeaderEntry {
	name: string;
	offset: number;
	length: number;
	kind?: SnapshotPayloadKind;
}

interface SnapshotHeader {
	version:
		| typeof LEGACY_SNAPSHOT_FORMAT_VERSION
		| typeof PREVIOUS_SNAPSHOT_FORMAT_VERSION
		| typeof SNAPSHOT_FORMAT_VERSION;
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
	if (
		!isRecord(value) ||
		(value.version !== LEGACY_SNAPSHOT_FORMAT_VERSION &&
			value.version !== PREVIOUS_SNAPSHOT_FORMAT_VERSION &&
			value.version !== SNAPSHOT_FORMAT_VERSION) ||
		!Array.isArray(value.entries)
	) {
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
			(kind !== undefined &&
				kind !== "bindings" &&
				kind !== "function" &&
				kind !== "import" &&
				kind !== "module" &&
				kind !== "runtime")
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
	return { version: value.version, entries };
}

export function encodeSnapshotPayloadParts(entries: readonly SnapshotPayloadEntry[]): SnapshotPayloadParts {
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
	return {
		byteLength: HEADER_LENGTH_BYTES + header.byteLength + offset,
		parts: [prefix, header, ...entries.map((entry) => entry.data)],
	};
}

export function encodeSnapshotPayload(entries: readonly SnapshotPayloadEntry[]): Buffer {
	const encoded = encodeSnapshotPayloadParts(entries);
	return Buffer.concat(encoded.parts, encoded.byteLength);
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
			data: new Uint8Array(buffer.buffer, buffer.byteOffset + dataStart + entry.offset, entry.length),
			...(entry.kind ? { kind: entry.kind } : {}),
		};
	});
}

const float16ArrayConstructor = (globalThis as { Float16Array?: { prototype: object } }).Float16Array;

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
	...(float16ArrayConstructor ? [float16ArrayConstructor.prototype] : []),
]);

function isSnapshotSafePrimitive(value: unknown): boolean {
	if (value === null) return true;
	const valueType = typeof value;
	return (
		valueType === "undefined" ||
		valueType === "string" ||
		valueType === "number" ||
		valueType === "boolean" ||
		valueType === "bigint"
	);
}

function isUnsignedIntegerString(value: string): boolean {
	if (value === "0") return true;
	if (value.length === 0) return false;
	const first = value.charCodeAt(0);
	if (first < 49 || first > 57) return false;
	for (let index = 1; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code < 48 || code > 57) return false;
	}
	return true;
}

const INSPECTION_VISITING = Symbol("inspection-visiting");
const INSPECTION_PROVISIONAL_SAFE = Symbol("inspection-provisional-safe");
const INSPECTION_SAFE = Symbol("inspection-safe");
type InspectionState = typeof INSPECTION_SAFE | string;
type TraversalState = typeof INSPECTION_VISITING | typeof INSPECTION_PROVISIONAL_SAFE;

interface InspectionTraversal {
	cycleMembers: WeakSet<object>;
	provisionalSafe: Set<object>;
	stack: object[];
	stackIndexes: WeakMap<object, number>;
	states: WeakMap<object, TraversalState>;
}

function inspectSnapshotObject(
	object: object,
	inspected: WeakMap<object, InspectionState>,
	traversal: InspectionTraversal,
	path: string,
): string | undefined {
	if (Object.getOwnPropertySymbols(object).length > 0) {
		return `${path}: symbol-keyed state is not snapshot-safe`;
	}

	const prototype = Object.getPrototypeOf(object);
	if (prototype === Promise.prototype) return `${path}: promises are not snapshot-safe`;
	if (prototype === WeakMap.prototype || prototype === WeakSet.prototype) {
		return `${path}: weak collections are not snapshot-safe`;
	}
	if (typeof WeakRef !== "undefined" && prototype === WeakRef.prototype) {
		return `${path}: weak references are not snapshot-safe`;
	}
	if (prototype === Date.prototype) {
		return Object.keys(object).length === 0 ? undefined : `${path}: custom Date properties are not snapshot-safe`;
	}
	if (prototype === RegExp.prototype) {
		return Object.keys(object).length === 0 ? undefined : `${path}: custom RegExp properties are not snapshot-safe`;
	}
	if (prototype === ArrayBuffer.prototype) {
		return Object.keys(object).length === 0
			? undefined
			: `${path}: custom ArrayBuffer properties are not snapshot-safe`;
	}
	if (ArrayBuffer.isView(object)) {
		if (prototype === DataView.prototype || !TYPED_ARRAY_PROTOTYPES.has(prototype)) {
			return `${path}: custom prototype or unsupported view is not snapshot-safe`;
		}
		return undefined;
	}
	if (prototype === Map.prototype) {
		if (Object.keys(object).length > 0) return `${path}: custom Map properties are not snapshot-safe`;
		let index = 0;
		for (const [key, entryValue] of object as Map<unknown, unknown>) {
			if (!isSnapshotSafePrimitive(key)) {
				const keyReason = inspectSnapshotValue(key, inspected, traversal, `${path}.mapKey${index}`);
				if (keyReason) return keyReason;
			}
			if (!isSnapshotSafePrimitive(entryValue)) {
				const valueReason = inspectSnapshotValue(entryValue, inspected, traversal, `${path}.mapValue${index}`);
				if (valueReason) return valueReason;
			}
			index += 1;
		}
		return undefined;
	}
	if (prototype === Set.prototype) {
		if (Object.keys(object).length > 0) return `${path}: custom Set properties are not snapshot-safe`;
		let index = 0;
		for (const entryValue of object as Set<unknown>) {
			if (!isSnapshotSafePrimitive(entryValue)) {
				const reason = inspectSnapshotValue(entryValue, inspected, traversal, `${path}.setValue${index}`);
				if (reason) return reason;
			}
			index += 1;
		}
		return undefined;
	}
	if (Array.isArray(object)) {
		if (prototype !== Array.prototype) return `${path}: custom prototype is not snapshot-safe`;
		const array = object as unknown[];
		for (const key in array) {
			if (!Object.hasOwn(array, key)) continue;
			if (!isUnsignedIntegerString(key)) return `${path}: custom array properties are not snapshot-safe`;
			const entryValue = (array as unknown as Record<string, unknown>)[key];
			if (isSnapshotSafePrimitive(entryValue)) continue;
			const reason = inspectSnapshotValue(entryValue, inspected, traversal, `${path}[${key}]`);
			if (reason) return reason;
		}
		return undefined;
	}
	if (prototype !== Object.prototype && prototype !== null) {
		return `${path}: custom prototype is not snapshot-safe`;
	}
	for (const [key, entryValue] of Object.entries(object)) {
		if (isSnapshotSafePrimitive(entryValue)) continue;
		const reason = inspectSnapshotValue(entryValue, inspected, traversal, `${path}.${key}`);
		if (reason) return reason;
	}
	return undefined;
}

function inspectSnapshotValue(
	value: unknown,
	inspected: WeakMap<object, InspectionState>,
	traversal: InspectionTraversal,
	path: string,
): string | undefined {
	if (isSnapshotSafePrimitive(value)) return undefined;
	const valueType = typeof value;
	if (valueType === "symbol") return `${path}: symbol values are not snapshot-safe`;
	if (valueType === "function") return `${path}: function values are not snapshot-safe`;
	if (valueType !== "object") return `${path}: unsupported value type ${valueType}`;

	const object = value as object;
	const previousState = inspected.get(object);
	if (previousState === INSPECTION_SAFE) return undefined;
	if (typeof previousState === "string") return previousState;
	const traversalState = traversal.states.get(object);
	if (traversalState === INSPECTION_VISITING) {
		const cycleStart = traversal.stackIndexes.get(object);
		if (cycleStart !== undefined) {
			for (let index = cycleStart; index < traversal.stack.length; index += 1) {
				const cycleMember = traversal.stack[index];
				if (cycleMember) traversal.cycleMembers.add(cycleMember);
			}
		}
		return undefined;
	}
	if (traversalState === INSPECTION_PROVISIONAL_SAFE) return undefined;
	traversal.states.set(object, INSPECTION_VISITING);
	traversal.stackIndexes.set(object, traversal.stack.length);
	traversal.stack.push(object);

	let reason: string | undefined;
	try {
		reason = inspectSnapshotObject(object, inspected, traversal, path);
	} catch (error) {
		reason = `${path}: inspection failed: ${error instanceof Error ? error.message : String(error)}`;
	} finally {
		traversal.stack.pop();
		traversal.stackIndexes.delete(object);
	}
	if (reason) {
		inspected.set(object, reason);
		traversal.states.delete(object);
	} else if (traversal.cycleMembers.has(object)) {
		traversal.provisionalSafe.add(object);
		traversal.states.set(object, INSPECTION_PROVISIONAL_SAFE);
	} else {
		inspected.set(object, INSPECTION_SAFE);
		traversal.states.delete(object);
	}
	return reason;
}

export function createSnapshotValueInspector(): (value: unknown) => string | undefined {
	const inspected = new WeakMap<object, InspectionState>();
	let activeTraversal: InspectionTraversal | undefined;
	return (value) => {
		if (activeTraversal) return inspectSnapshotValue(value, inspected, activeTraversal, "$binding");
		const traversal: InspectionTraversal = {
			cycleMembers: new WeakSet<object>(),
			provisionalSafe: new Set<object>(),
			stack: [],
			stackIndexes: new WeakMap<object, number>(),
			states: new WeakMap<object, TraversalState>(),
		};
		activeTraversal = traversal;
		try {
			const reason = inspectSnapshotValue(value, inspected, traversal, "$binding");
			if (!reason) {
				for (const object of traversal.provisionalSafe) inspected.set(object, INSPECTION_SAFE);
			}
			return reason;
		} finally {
			activeTraversal = undefined;
		}
	};
}

export function snapshotValueSkipReason(value: unknown): string | undefined {
	return createSnapshotValueInspector()(value);
}
