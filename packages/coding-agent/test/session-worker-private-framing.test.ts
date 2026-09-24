import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
	encodePrivateFrame,
	PrivateFrameDecoder,
	PrivateFramedChannel,
	type PrivateFrameHeaderValidator,
} from "../src/modes/session-worker/private-framing.js";

interface TestHeader {
	type: string;
	requestId?: string;
}

const isTestHeader: PrivateFrameHeaderValidator<TestHeader> = (value: unknown): value is TestHeader => {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as { type?: unknown; requestId?: unknown };
	return (
		typeof candidate.type === "string" &&
		(candidate.requestId === undefined || typeof candidate.requestId === "string")
	);
};

describe("private worker framing", () => {
	it("releases consumed frame storage when a tiny next-frame prefix remains", () => {
		const frame = encodePrivateFrame({ type: "event" }, Buffer.alloc(1024 * 1024, 7));
		const decoder = new PrivateFrameDecoder(isTestHeader);
		decoder.push(Buffer.from(frame.subarray(0, 1)));
		for (let i = 0; i < 5; i++) {
			const chunk = Buffer.concat([frame.subarray(1), frame.subarray(0, 1)]);
			expect(decoder.push(chunk)).toHaveLength(1);
			expect(decoder.bufferedBytes).toBe(1);
		}
		// Account for actual backing allocations, including consumed entries and subarray parents.
		const pending = Reflect.get(decoder, "pending") as Buffer[];
		const backing = new Set(pending.map((chunk) => chunk.buffer));
		const retainedBytes = [...backing].reduce((total, buffer) => total + buffer.byteLength, 0);
		expect(retainedBytes).toBeLessThan(64 * 1024);
		expect(decoder.push(frame.subarray(1))[0]?.payload.equals(Buffer.alloc(1024 * 1024, 7))).toBe(true);
		decoder.finish();
	});
	it("copies only a linear number of bytes for fragmented large frames", () => {
		const payload = Buffer.alloc(1024 * 1024, 7);
		const frame = encodePrivateFrame({ type: "event" }, payload);
		const decoder = new PrivateFrameDecoder(isTestHeader);
		const concat = Buffer.concat;
		let copied = 0;
		const spy = vi.spyOn(Buffer, "concat").mockImplementation((parts, length) => {
			const result = concat(parts, length);
			copied += result.length;
			return result;
		});
		const decoded = [];
		try {
			for (let i = 0; i < frame.length; i += 1024) decoded.push(...decoder.push(frame.subarray(i, i + 1024)));
		} finally {
			spy.mockRestore();
		}
		expect(decoded).toEqual([{ header: { type: "event" }, payload }]);
		expect(decoder.bufferedBytes).toBe(0);
		decoder.finish();
		expect(copied).toBeLessThan(frame.length * 3);
	});
	it("decodes headers and opaque payloads across arbitrary chunk boundaries", () => {
		const first = encodePrivateFrame({ type: "event", requestId: "one" }, Buffer.from([0, 1, 2, 255]));
		const second = encodePrivateFrame({ type: "response", requestId: "two" }, Buffer.from("payload"));
		const combined = Buffer.concat([first, second]);
		const decoder = new PrivateFrameDecoder(isTestHeader);
		const frames = [];

		for (let offset = 0; offset < combined.length; offset += 3) {
			frames.push(...decoder.push(combined.subarray(offset, offset + 3)));
		}
		decoder.finish();

		expect(frames).toEqual([
			{ header: { type: "event", requestId: "one" }, payload: Buffer.from([0, 1, 2, 255]) },
			{ header: { type: "response", requestId: "two" }, payload: Buffer.from("payload") },
		]);
	});

	it("rejects invalid lengths, JSON, and routing headers", () => {
		const oversized = Buffer.alloc(8);
		oversized.writeUInt32BE(1025, 0);
		expect(() =>
			new PrivateFrameDecoder(isTestHeader, { maxHeaderBytes: 1024, maxPayloadBytes: 1024 }).push(oversized),
		).toThrow("Invalid private frame header length");

		const invalidJson = Buffer.concat([Buffer.from([0, 0, 0, 1, 0, 0, 0, 0]), Buffer.from("{")]);
		expect(() => new PrivateFrameDecoder(isTestHeader).push(invalidJson)).toThrow(
			"Invalid private frame header JSON",
		);

		const invalidHeader = encodePrivateFrame({ missing: "type" }, Buffer.alloc(0));
		expect(() => new PrivateFrameDecoder(isTestHeader).push(invalidHeader)).toThrow(
			"Invalid private frame routing header",
		);
	});

	it("reports an incomplete trailing frame", () => {
		const decoder = new PrivateFrameDecoder(isTestHeader);
		decoder.push(encodePrivateFrame({ type: "event" }, Buffer.from("body")).subarray(0, 9));
		expect(() => decoder.finish()).toThrow("incomplete bytes");
	});

	it("sends frames through a duplex channel without interpreting payload bytes", async () => {
		const stream = new PassThrough();
		const channel = new PrivateFramedChannel(stream, isTestHeader);
		const received = new Promise<{ header: TestHeader; payload: Buffer }>((resolve) => {
			channel.onFrame(resolve);
		});

		await channel.send({ type: "snapshot", requestId: "request" }, Buffer.from([9, 8, 7]));

		await expect(received).resolves.toEqual({
			header: { type: "snapshot", requestId: "request" },
			payload: Buffer.from([9, 8, 7]),
		});
		channel.close();
	});
});
