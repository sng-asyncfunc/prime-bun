import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	inspectImageDimensions,
	loadPreflightSource,
	preflightImagesSequentially,
	processImageBatchAtomically,
	readBoundedFile,
	sourceDigest,
} from "../skills/attach-image/src/image-validation.js";

function oversizedJpegHeader(): Uint8Array {
	const bytes = Buffer.alloc(21);
	bytes.set([0xff, 0xd8, 0xff, 0xc0]);
	bytes.writeUInt16BE(17, 4);
	bytes[6] = 8;
	bytes.writeUInt16BE(6001, 7);
	bytes.writeUInt16BE(6001, 9);
	return bytes;
}

function oversizedWebpHeader(): Uint8Array {
	const bytes = Buffer.alloc(30);
	bytes.write("RIFF", 0, "ascii");
	bytes.writeUInt32LE(bytes.length - 8, 4);
	bytes.write("WEBP", 8, "ascii");
	bytes.write("VP8X", 12, "ascii");
	bytes.writeUInt32LE(10, 16);
	bytes.writeUIntLE(6000, 24, 3);
	bytes.writeUIntLE(6000, 27, 3);
	return bytes;
}

function webpWithConflictingChunks(
	canvasWidth: number,
	canvasHeight: number,
	imageWidth: number,
	imageHeight: number,
): Uint8Array {
	const bytes = Buffer.alloc(44);
	bytes.write("RIFF", 0, "ascii");
	bytes.writeUInt32LE(bytes.length - 8, 4);
	bytes.write("WEBP", 8, "ascii");
	bytes.write("VP8X", 12, "ascii");
	bytes.writeUInt32LE(10, 16);
	bytes.writeUIntLE(canvasWidth - 1, 24, 3);
	bytes.writeUIntLE(canvasHeight - 1, 27, 3);
	bytes.write("VP8L", 30, "ascii");
	bytes.writeUInt32LE(5, 34);
	bytes[38] = 0x2f;
	const width = imageWidth - 1;
	const height = imageHeight - 1;
	bytes[39] = width & 0xff;
	bytes[40] = ((width >> 8) & 0x3f) | ((height & 0x03) << 6);
	bytes[41] = (height >> 2) & 0xff;
	bytes[42] = (height >> 10) & 0x0f;
	return bytes;
}

function webpWithAnmf(
	canvasWidth: number,
	canvasHeight: number,
	frameX: number,
	frameY: number,
	frameWidth: number,
	frameHeight: number,
	chunkLength = 16,
): Uint8Array {
	const paddedChunkLength = chunkLength + (chunkLength % 2);
	const bytes = Buffer.alloc(38 + paddedChunkLength);
	bytes.write("RIFF", 0, "ascii");
	bytes.writeUInt32LE(bytes.length - 8, 4);
	bytes.write("WEBP", 8, "ascii");
	bytes.write("VP8X", 12, "ascii");
	bytes.writeUInt32LE(10, 16);
	bytes.writeUIntLE(canvasWidth - 1, 24, 3);
	bytes.writeUIntLE(canvasHeight - 1, 27, 3);
	bytes.write("ANMF", 30, "ascii");
	bytes.writeUInt32LE(chunkLength, 34);
	if (chunkLength >= 3) bytes.writeUIntLE(Math.floor(frameX / 2), 38, 3);
	if (chunkLength >= 6) bytes.writeUIntLE(Math.floor(frameY / 2), 41, 3);
	if (chunkLength >= 9) bytes.writeUIntLE(frameWidth - 1, 44, 3);
	if (chunkLength >= 12) bytes.writeUIntLE(frameHeight - 1, 47, 3);
	return bytes;
}

describe("attach-image safety", () => {
	it.each([
		["JPEG", "image/jpeg", oversizedJpegHeader],
		["WebP", "image/webp", oversizedWebpHeader],
	] as const)("rejects oversized %s dimensions before invoking the decoder", (_format, mimeType, createHeader) => {
		const decode = vi.fn(() => ({ free: vi.fn(), get_height: () => 1, get_width: () => 1 }));

		expect(() => inspectImageDimensions(createHeader(), mimeType, "oversized", decode)).toThrow(
			"images must be at most 36MP",
		);
		expect(decode).not.toHaveBeenCalled();
	});

	it.each([
		["oversized later chunk", 1, 1, 6001, 6001, "images must be at most 36MP"],
		["inconsistent later chunk", 10, 10, 20, 20, "inconsistent WebP dimensions"],
	] as const)(
		"rejects a %s before invoking the decoder",
		(_case, canvasWidth, canvasHeight, imageWidth, imageHeight, error) => {
			const decode = vi.fn(() => ({ free: vi.fn(), get_height: () => 1, get_width: () => 1 }));
			const data = webpWithConflictingChunks(canvasWidth, canvasHeight, imageWidth, imageHeight);

			expect(() => inspectImageDimensions(data, "image/webp", "conflicting.webp", decode)).toThrow(error);
			expect(decode).not.toHaveBeenCalled();
		},
	);

	it.each([
		["oversized", webpWithAnmf(10, 10, 0, 0, 6001, 6001), "images must be at most 36MP"],
		["malformed", webpWithAnmf(10, 10, 0, 0, 1, 1, 15), "malformed ANMF"],
		["out-of-bounds", webpWithAnmf(10, 10, 10, 0, 2, 1), "outside its VP8X canvas"],
	] as const)("rejects %s animated WebP frame metadata before invoking the decoder", (_case, data, error) => {
		const decode = vi.fn(() => ({ free: vi.fn(), get_height: () => 1, get_width: () => 1 }));

		expect(() => inspectImageDimensions(data, "image/webp", "animated.webp", decode)).toThrow(error);
		expect(decode).not.toHaveBeenCalled();
	});

	it("retains no source byte arrays after batch preflight", async () => {
		const sourceBytesPerImage = 20_000_000;
		const preflights = await preflightImagesSequentially(["first", "second", "third"], async (path) => ({
			animated: false,
			data: new Uint8Array(sourceBytesPerImage),
			digest: `${path}-digest`,
			dimensions: [1, 1] as const,
			mimeType: "image/png",
			path,
		}));

		const retainedSourceBytes = preflights.reduce(
			(total, preflight) =>
				total +
				Object.values(preflight).reduce(
					(entryTotal, value) => entryTotal + (ArrayBuffer.isView(value) ? value.byteLength : 0),
					0,
				),
			0,
		);
		expect(retainedSourceBytes).toBe(0);
		expect(preflights).toHaveLength(3);
		expect(preflights.every((preflight) => !("data" in preflight))).toBe(true);
	});

	it("bounds a grown second-pass file and emits no earlier attachment", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-agent-attach-image-growth-"));
		const firstPath = join(directory, "first.png");
		const secondPath = join(directory, "second.png");
		writeFileSync(firstPath, Buffer.alloc(32, 1));
		writeFileSync(secondPath, Buffer.alloc(32, 2));
		const emit = vi.fn();

		try {
			await expect(
				processImageBatchAtomically(
					[firstPath, secondPath],
					async (path) => {
						const data = await readBoundedFile(path, 64);
						return {
							animated: false,
							data,
							digest: sourceDigest(data),
							dimensions: [1, 1] as const,
							mimeType: "image/png",
							path,
						};
					},
					async (preflight) => {
						if (preflight.path === secondPath) appendFileSync(secondPath, Buffer.alloc(128, 3));
						const image = await loadPreflightSource(preflight, 64);
						return { bytes: image.data.byteLength, path: image.path };
					},
					emit,
				),
			).rejects.toThrow("64 byte limit");
			expect(emit).not.toHaveBeenCalled();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
