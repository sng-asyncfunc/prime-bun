import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_SNAPSHOT_MAX_BYTES,
	decodeSnapshotPayload,
	encodeSnapshotPayload,
	encodeSnapshotPayloadParts,
	manifestPathIn,
	snapshotPathIn,
	snapshotValueSkipReason,
} from "../src/core/kernel/state-snapshot.js";

const float16ArrayConstructor = (globalThis as { Float16Array?: new (values: Iterable<number>) => object })
	.Float16Array;

describe("Bun kernel state snapshot paths", () => {
	it("places the binary payload and manifest in the session artifact directory", () => {
		const artifactDir = "/home/u/.prime/agent/session-artifacts/abc-123";
		expect(snapshotPathIn(artifactDir)).toBe(join(artifactDir, "kernel-state.bin"));
		expect(manifestPathIn(artifactDir)).toBe(join(artifactDir, "kernel-state.json"));
		expect(DEFAULT_SNAPSHOT_MAX_BYTES).toBe(256 * 1024 * 1024);
	});
});

describe("Bun snapshot binary format", () => {
	function legacyV2ImportPayload(name: string, specifier: string): Buffer {
		const data = Buffer.from(specifier, "utf8");
		const header = Buffer.from(
			JSON.stringify({
				entries: [{ kind: "import", length: data.byteLength, name, offset: 0 }],
				version: 2,
			}),
			"utf8",
		);
		const prefix = Buffer.alloc(4);
		prefix.writeUInt32BE(header.byteLength);
		return Buffer.concat([prefix, header, data]);
	}

	it("materializes the legacy payload from zero-copy entry parts", () => {
		const alpha = Uint8Array.from([1, 2, 3]);
		const entries = [
			{ name: "alpha", data: alpha },
			{ name: "unicode_变量", data: Uint8Array.from([5, 8, 13, 21]) },
		];
		const payload = encodeSnapshotPayload(entries);
		const encoded = encodeSnapshotPayloadParts(entries);

		expect(Buffer.concat(encoded.parts, encoded.byteLength)).toEqual(payload);
		expect(encoded.byteLength).toBe(payload.byteLength);
		alpha[1] = 89;
		expect(encoded.parts[2]?.[1]).toBe(89);
	});

	it("round-trips independently serialized binding blobs", () => {
		const payload = encodeSnapshotPayload([
			{ name: "alpha", data: Uint8Array.from([1, 2, 3]) },
			{
				name: "basename",
				data: Uint8Array.from(
					Buffer.from(
						JSON.stringify({ exportName: "basename", loader: "import", specifier: "node:path", type: "module" }),
					),
				),
				kind: "module",
			},
			{ name: "unicode_变量", data: Uint8Array.from([5, 8, 13, 21]) },
		]);
		const headerLength = payload.readUInt32BE(0);
		const header = JSON.parse(payload.subarray(4, 4 + headerLength).toString("utf8")) as { version: number };

		expect(header.version).toBe(3);
		expect(decodeSnapshotPayload(payload)).toEqual([
			{ name: "alpha", data: Uint8Array.from([1, 2, 3]) },
			{
				name: "basename",
				data: Uint8Array.from(
					Buffer.from(
						JSON.stringify({
							exportName: "basename",
							loader: "import",
							specifier: "node:path",
							type: "module",
						}),
					),
				),
				kind: "module",
			},
			{ name: "unicode_变量", data: Uint8Array.from([5, 8, 13, 21]) },
		]);
	});

	it("decodes hand-built v2 import entries", () => {
		expect(decodeSnapshotPayload(legacyV2ImportPayload("pathModule", "node:path"))).toEqual([
			{ data: Uint8Array.from(Buffer.from("node:path")), kind: "import", name: "pathModule" },
		]);
	});

	it("rejects corrupt headers, entry ranges, and duplicate names", () => {
		expect(() => decodeSnapshotPayload(Buffer.from([0, 0, 0, 9, 1]))).toThrow(/corrupt Bun snapshot/i);

		const duplicate = encodeSnapshotPayload([
			{ name: "same", data: Uint8Array.from([1]) },
			{ name: "same", data: Uint8Array.from([2]) },
		]);
		expect(() => decodeSnapshotPayload(duplicate)).toThrow(/duplicate snapshot binding/i);
	});
});

describe("snapshotValueSkipReason", () => {
	it("accepts the characterized structured-clone allowlist, including cycles", () => {
		const cycle: { self?: unknown; values: Map<string, Set<number>> } = {
			values: new Map([["numbers", new Set([1, 2, 3])]]),
		};
		cycle.self = cycle;
		const value = {
			array: [cycle, new Date("2024-01-01T00:00:00.000Z")],
			buffer: Uint8Array.from([3, 5, 8]).buffer,
			nullPrototype: Object.assign(Object.create(null) as Record<string, unknown>, { ok: true }),
			regexp: /prime/giu,
			typed: Uint16Array.from([13, 21]),
		};

		expect(snapshotValueSkipReason(value)).toBeUndefined();
	});

	it("accepts built-in typed arrays without enumerating their elements", () => {
		const objectKeys = Object.keys;
		const objectKeysSpy = vi.spyOn(Object, "keys").mockImplementation((value) => {
			if (ArrayBuffer.isView(value)) throw new Error("typed-array enumeration is not allowed");
			return objectKeys(value);
		});

		try {
			expect(snapshotValueSkipReason(new Uint8Array(1_000_000))).toBeUndefined();
		} finally {
			objectKeysSpy.mockRestore();
		}
	});

	it("accepts dense primitive arrays when user code modifies RegExp.prototype.test", () => {
		const regexpTestSpy = vi.spyOn(RegExp.prototype, "test").mockImplementation(() => {
			throw new Error("user-modified RegExp.prototype.test");
		});
		let reason: string | undefined;

		try {
			reason = snapshotValueSkipReason([1, "two", true, null, undefined, 3n]);
		} finally {
			regexpTestSpy.mockRestore();
		}
		expect(reason).toBeUndefined();
	});

	it("preserves sparse arrays while rejecting custom properties on them", () => {
		const sparse: unknown[] = [];
		sparse.length = 3;
		sparse[0] = 1;
		sparse[2] = 3;
		const sparseWithState = Object.assign(sparse.slice(), { extra: true });

		expect(snapshotValueSkipReason(sparse)).toBeUndefined();
		expect(snapshotValueSkipReason(sparseWithState)).toMatch(/custom array properties/i);
	});

	it("ignores enumerable properties inherited by arrays", () => {
		Object.defineProperty(Array.prototype, "primeInheritedSnapshotTest", {
			configurable: true,
			enumerable: true,
			value: () => undefined,
		});
		let reason: string | undefined;
		try {
			reason = snapshotValueSkipReason([1, 2, 3]);
		} finally {
			Reflect.deleteProperty(Array.prototype, "primeInheritedSnapshotTest");
		}

		expect(reason).toBeUndefined();
	});

	it.skipIf(float16ArrayConstructor === undefined)("accepts Float16Array when the host supports it", () => {
		expect(snapshotValueSkipReason(new float16ArrayConstructor!([1.5, -2.25]))).toBeUndefined();
	});

	it("rejects unsupported values at any nesting depth", () => {
		class CustomValue {
			value = 1;
		}

		expect(snapshotValueSkipReason(() => undefined)).toMatch(/function/i);
		expect(snapshotValueSkipReason(Promise.resolve())).toMatch(/promise/i);
		expect(snapshotValueSkipReason(new WeakMap())).toMatch(/weak collection/i);
		expect(snapshotValueSkipReason(Symbol("state"))).toMatch(/symbol/i);
		expect(snapshotValueSkipReason({ nested: [{ custom: new CustomValue() }] })).toMatch(/custom prototype/i);
		expect(snapshotValueSkipReason({ [Symbol("hidden")]: true })).toMatch(/symbol-keyed/i);
		const dateWithState = Object.assign(new Date(), { extra: new CustomValue() });
		expect(snapshotValueSkipReason(dateWithState)).toMatch(/custom Date properties/i);
		const arrayWithState = Object.assign([1, 2], { extra: () => undefined });
		expect(snapshotValueSkipReason(arrayWithState)).toMatch(/custom array properties/i);
	});

	it("rejects proxies that throw during inspection", () => {
		const value = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw new Error("blocked");
				},
			},
		);

		expect(snapshotValueSkipReason(value)).toMatch(/inspection failed.*blocked/i);
	});
});
