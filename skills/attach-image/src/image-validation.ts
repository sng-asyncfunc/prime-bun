import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

const MAX_SOURCE_IMAGE_PIXELS = 36_000_000;

export interface DecodedImageDimensions {
	free(): void;
	get_height(): number;
	get_width(): number;
}

export interface ImagePreflight {
	animated: boolean;
	digest: string;
	dimensions: readonly [number, number];
	mimeType: string;
	path: string;
}

export interface ImageWithSource extends ImagePreflight {
	data: Uint8Array;
}

interface WebpFrame {
	height: number;
	width: number;
	x: number;
	y: number;
}

interface WebpMetadata {
	canvas?: readonly [number, number];
	dimensions: Array<readonly [number, number]>;
	frames: WebpFrame[];
	malformedAnmf: boolean;
}

function jpegDimensions(data: Uint8Array): readonly [number, number] | undefined {
	if (data.byteLength < 4 || data[0] !== 0xff || data[1] !== 0xd8) return undefined;
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
	let offset = 2;
	while (offset + 1 < data.byteLength) {
		while (offset < data.byteLength && data[offset] !== 0xff) offset += 1;
		while (offset < data.byteLength && data[offset] === 0xff) offset += 1;
		if (offset >= data.byteLength) return undefined;
		const marker = data[offset] ?? 0;
		offset += 1;
		if (marker === 0xd9 || marker === 0xda) return undefined;
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
		if (offset + 2 > data.byteLength) return undefined;
		const segmentLength = view.getUint16(offset);
		if (segmentLength < 2 || offset + segmentLength > data.byteLength) return undefined;
		if (startOfFrameMarkers.has(marker)) {
			if (segmentLength < 7) return undefined;
			return [view.getUint16(offset + 5), view.getUint16(offset + 3)];
		}
		offset += segmentLength;
	}
	return undefined;
}

function uint24LittleEndian(data: Uint8Array, offset: number): number {
	return (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8) | ((data[offset + 2] ?? 0) << 16);
}

function webpMetadata(data: Uint8Array): WebpMetadata {
	const metadata: WebpMetadata = { dimensions: [], frames: [], malformedAnmf: false };
	if (data.byteLength < 20) return metadata;
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	let offset = 12;
	while (offset + 8 <= data.byteLength) {
		const chunk = String.fromCharCode(
			data[offset] ?? 0,
			data[offset + 1] ?? 0,
			data[offset + 2] ?? 0,
			data[offset + 3] ?? 0,
		);
		const chunkLength = view.getUint32(offset + 4, true);
		const payload = offset + 8;
		if (payload + chunkLength > data.byteLength) {
			if (chunk === "ANMF") metadata.malformedAnmf = true;
			return metadata;
		}
		if (chunk === "VP8X" && chunkLength >= 10) {
			const dimensions = [
				uint24LittleEndian(data, payload + 4) + 1,
				uint24LittleEndian(data, payload + 7) + 1,
			] as const;
			metadata.canvas ??= dimensions;
			metadata.dimensions.push(dimensions);
		}
		if (
			chunk === "VP8 " &&
			chunkLength >= 10 &&
			data[payload + 3] === 0x9d &&
			data[payload + 4] === 0x01 &&
			data[payload + 5] === 0x2a
		) {
			metadata.dimensions.push([
				view.getUint16(payload + 6, true) & 0x3fff,
				view.getUint16(payload + 8, true) & 0x3fff,
			]);
		}
		if (chunk === "VP8L" && chunkLength >= 5 && data[payload] === 0x2f) {
			const byte1 = data[payload + 1] ?? 0;
			const byte2 = data[payload + 2] ?? 0;
			const byte3 = data[payload + 3] ?? 0;
			const byte4 = data[payload + 4] ?? 0;
			metadata.dimensions.push([
				1 + byte1 + ((byte2 & 0x3f) << 8),
				1 + (byte2 >> 6) + (byte3 << 2) + ((byte4 & 0x0f) << 10),
			]);
		}
		if (chunk === "ANMF") {
			if (chunkLength < 16) {
				metadata.malformedAnmf = true;
			} else {
				metadata.frames.push({
					x: uint24LittleEndian(data, payload) * 2,
					y: uint24LittleEndian(data, payload + 3) * 2,
					width: uint24LittleEndian(data, payload + 6) + 1,
					height: uint24LittleEndian(data, payload + 9) + 1,
				});
			}
		}
		offset = payload + chunkLength + (chunkLength % 2);
	}
	return metadata;
}

function declaredDimensions(data: Uint8Array, mimeType: string): Array<readonly [number, number]> {
	if (mimeType === "image/png" && data.byteLength >= 24) {
		const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
		return [[view.getUint32(16), view.getUint32(20)]];
	}
	if (mimeType === "image/gif" && data.byteLength >= 10) {
		const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
		return [[view.getUint16(6, true), view.getUint16(8, true)]];
	}
	if (mimeType === "image/jpeg") {
		const dimensions = jpegDimensions(data);
		return dimensions ? [dimensions] : [];
	}
	if (mimeType === "image/webp") return webpMetadata(data).dimensions;
	return [];
}

function assertPixelLimit(path: string, dimensions: readonly [number, number]): void {
	const pixelCount = dimensions[0] * dimensions[1];
	if (pixelCount <= MAX_SOURCE_IMAGE_PIXELS) return;
	throw new Error(
		`${path} is ${dimensions[0]}x${dimensions[1]} (${Math.floor(pixelCount / 1_000_000)}MP); ` +
			`images must be at most ${Math.floor(MAX_SOURCE_IMAGE_PIXELS / 1_000_000)}MP. Resize it first.`,
	);
}

export function inspectImageDimensions(
	data: Uint8Array,
	mimeType: string,
	path: string,
	decode: (input: Uint8Array) => DecodedImageDimensions,
): readonly [number, number] {
	const webp = mimeType === "image/webp" ? webpMetadata(data) : undefined;
	const encodedDimensions = webp?.dimensions ?? declaredDimensions(data, mimeType);
	for (const dimensions of encodedDimensions) assertPixelLimit(path, dimensions);
	if (
		mimeType === "image/webp" &&
		encodedDimensions.length > 1 &&
		encodedDimensions.some(
			(dimensions) =>
				dimensions[0] !== encodedDimensions[0]![0] || dimensions[1] !== encodedDimensions[0]![1],
		)
	) {
		throw new Error(`${path} contains inconsistent WebP dimensions.`);
	}
	if (webp?.malformedAnmf) {
		throw new Error(`${path} contains a malformed ANMF frame.`);
	}
	for (const frame of webp?.frames ?? []) {
		assertPixelLimit(path, [frame.width, frame.height]);
		if (!webp?.canvas) {
			throw new Error(`${path} contains an ANMF frame without a VP8X canvas.`);
		}
		if (frame.x + frame.width > webp.canvas[0] || frame.y + frame.height > webp.canvas[1]) {
			throw new Error(`${path} contains an ANMF frame outside its VP8X canvas.`);
		}
	}
	let decoded: DecodedImageDimensions;
	try {
		decoded = decode(data);
	} catch {
		throw new Error(`${path} is not a readable supported image (PNG, JPEG, GIF, WebP).`);
	}
	let dimensions: readonly [number, number];
	try {
		dimensions = [decoded.get_width(), decoded.get_height()];
	} finally {
		decoded.free();
	}
	assertPixelLimit(path, dimensions);
	return dimensions;
}

export function sourceDigest(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

export async function readBoundedFile(path: string, maxBytes: number): Promise<Uint8Array> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
		throw new TypeError("maxBytes must be a positive safe integer");
	}
	const handle = await open(path, "r");
	try {
		const before = await handle.stat();
		if (!before.isFile()) throw new Error(`${path} is not a regular file`);
		if (before.size > maxBytes) throw new Error(`${path} exceeds the ${maxBytes} byte limit`);
		const capacity = Math.min(maxBytes + 1, before.size + 1);
		const buffer = Buffer.allocUnsafe(capacity);
		let total = 0;
		while (total < capacity) {
			const { bytesRead } = await handle.read(buffer, total, capacity - total, total);
			if (bytesRead === 0) break;
			total += bytesRead;
		}
		const after = await handle.stat();
		if (total > maxBytes || after.size > maxBytes) {
			throw new Error(`${path} exceeds the ${maxBytes} byte limit`);
		}
		if (before.size !== after.size || total !== before.size) {
			throw new Error(`${path} changed while being read`);
		}
		return buffer.subarray(0, total);
	} finally {
		await handle.close();
	}
}

export async function loadPreflightSource(preflight: ImagePreflight, maxBytes: number): Promise<ImageWithSource> {
	const data = await readBoundedFile(preflight.path, maxBytes);
	if (sourceDigest(data) !== preflight.digest) {
		throw new Error(`${preflight.path} changed after batch validation. Retry attachImage.`);
	}
	return { ...preflight, data };
}

export async function preflightImagesSequentially<T>(
	values: readonly T[],
	validate: (value: T) => Promise<ImageWithSource>,
): Promise<ImagePreflight[]> {
	const preflights: ImagePreflight[] = [];
	for (const value of values) {
		const image = await validate(value);
		preflights.push({
			animated: image.animated,
			digest: image.digest,
			dimensions: image.dimensions,
			mimeType: image.mimeType,
			path: image.path,
		});
	}
	return preflights;
}

export async function processImageBatchAtomically<T, Prepared>(
	values: readonly T[],
	validate: (value: T) => Promise<ImageWithSource>,
	prepare: (preflight: ImagePreflight) => Promise<Prepared>,
	emit: (prepared: Prepared) => void,
): Promise<Prepared[]> {
	const preflights = await preflightImagesSequentially(values, validate);
	const prepared: Prepared[] = [];
	for (const preflight of preflights) prepared.push(await prepare(preflight));
	for (const attachment of prepared) emit(attachment);
	return prepared;
}
