import { readFile, stat } from "node:fs/promises";
import { PhotonImage, SamplingFilter, resize } from "@silvia-odwyer/photon-node";
import { asRecord, expandPath, requireString, type SkillContext } from "../../_shared/context.ts";

const ATTACHMENT_DISPLAY_MIME = "application/vnd.prime-agent.attachment+json";
const MAX_SOURCE_IMAGE_BYTES = 20_000_000;
const MAX_SOURCE_IMAGE_PIXELS = 36_000_000;
const MAX_ATTACHMENT_DATA_CHARS = 350_000;
const MAX_ATTACHMENT_DIMENSION = 1200;
const JPEG_QUALITIES = [82, 72, 60, 48, 36] as const;

interface ValidatedImage {
	animated: boolean;
	data: Uint8Array;
	dimensions: readonly [number, number];
	mimeType: string;
	path: string;
}

function gifFrameCount(data: Uint8Array): number {
	if (data.byteLength < 13) return 0;
	let offset = 13;
	const packed = data[10] ?? 0;
	if ((packed & 0x80) !== 0) offset += 3 * 2 ** ((packed & 0x07) + 1);
	let frames = 0;
	const skipSubBlocks = (start: number): number => {
		let cursor = start;
		while (cursor < data.byteLength) {
			const size = data[cursor] ?? 0;
			cursor += 1;
			if (size === 0) return cursor;
			cursor += size;
		}
		return cursor;
	};
	while (offset < data.byteLength) {
		const marker = data[offset];
		if (marker === 0x3b) break;
		if (marker === 0x21) {
			offset = skipSubBlocks(offset + 2);
			continue;
		}
		if (marker !== 0x2c || offset + 10 > data.byteLength) break;
		frames += 1;
		const imagePacked = data[offset + 9] ?? 0;
		offset += 10;
		if ((imagePacked & 0x80) !== 0) offset += 3 * 2 ** ((imagePacked & 0x07) + 1);
		offset = skipSubBlocks(offset + 1);
	}
	return frames;
}

function declaredDimensions(data: Uint8Array, mimeType: string): readonly [number, number] | undefined {
	if (mimeType === "image/png" && data.byteLength >= 24) {
		const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
		return [view.getUint32(16), view.getUint32(20)];
	}
	if (mimeType === "image/gif" && data.byteLength >= 10) {
		const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
		return [view.getUint16(6, true), view.getUint16(8, true)];
	}
	return undefined;
}

function assertPixelLimit(path: string, dimensions: readonly [number, number]): void {
	const pixelCount = dimensions[0] * dimensions[1];
	if (pixelCount <= MAX_SOURCE_IMAGE_PIXELS) return;
	throw new Error(
		`${path} is ${dimensions[0]}x${dimensions[1]} (${Math.floor(pixelCount / 1_000_000)}MP); ` +
			`images must be at most ${Math.floor(MAX_SOURCE_IMAGE_PIXELS / 1_000_000)}MP. Resize it first.`,
	);
}

function detectImageMime(data: Uint8Array): string | undefined {
	const starts = (...values: number[]) => values.every((value, index) => data[index] === value);
	if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
	if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
	const header = new TextDecoder().decode(data.subarray(0, 12));
	if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) return "image/gif";
	if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") return "image/webp";
	return undefined;
}

function base64Chars(data: Uint8Array): number {
	return Math.ceil(data.byteLength / 3) * 4;
}

function toBase64(data: Uint8Array): string {
	return Buffer.from(data).toString("base64");
}

function compositeTransparency(image: PhotonImage): { image: PhotonImage; hadTransparency: boolean } {
	const width = image.get_width();
	const height = image.get_height();
	const pixels = image.get_raw_pixels();
	let hadTransparency = false;
	for (let index = 0; index < pixels.length; index += 4) {
		const alpha = pixels[index + 3] ?? 255;
		if (alpha === 255) continue;
		hadTransparency = true;
		const fraction = alpha / 255;
		for (let channel = 0; channel < 3; channel += 1) {
			pixels[index + channel] = Math.round((pixels[index + channel] ?? 0) * fraction + 136 * (1 - fraction));
		}
		pixels[index + 3] = 255;
	}
	return { image: new PhotonImage(pixels, width, height), hadTransparency };
}

function resizeForAttachment(image: ValidatedImage): {
	data: string;
	mimeType: string;
	note?: string;
} {
	if (
		base64Chars(image.data) <= MAX_ATTACHMENT_DATA_CHARS &&
		Math.max(...image.dimensions) <= MAX_ATTACHMENT_DIMENSION
	) {
		return { data: toBase64(image.data), mimeType: image.mimeType };
	}

	const decoded = PhotonImage.new_from_byteslice(image.data);
	const composited = compositeTransparency(decoded);
	decoded.free();
	const originalWidth = composited.image.get_width();
	const originalHeight = composited.image.get_height();
	const scale = Math.min(1, MAX_ATTACHMENT_DIMENSION / Math.max(originalWidth, originalHeight));
	let width = Math.max(1, Math.round(originalWidth * scale));
	let height = Math.max(1, Math.round(originalHeight * scale));
	let smallestChars = Number.POSITIVE_INFINITY;
	let smallestDimensions = `${width}x${height}`;

	try {
		while (width >= 1 && height >= 1) {
			const resized = resize(composited.image, width, height, SamplingFilter.Lanczos3);
			try {
				for (const quality of JPEG_QUALITIES) {
					const candidate = resized.get_bytes_jpeg(quality);
					const chars = base64Chars(candidate);
					if (chars < smallestChars) {
						smallestChars = chars;
						smallestDimensions = `${width}x${height}`;
					}
					if (chars <= MAX_ATTACHMENT_DATA_CHARS) {
						const transparencyNote = composited.hadTransparency
							? "; transparent pixels composited on #888888 background"
							: "";
						const animationNote = image.animated ? "; animated image flattened to first frame" : "";
						return {
							data: toBase64(candidate),
							mimeType: "image/jpeg",
							note: `original ${originalWidth}x${originalHeight}; attached ${width}x${height} JPEG at quality ${quality}${transparencyNote}${animationNote}`,
						};
					}
				}
			} finally {
				resized.free();
			}
			const nextWidth = Math.max(1, Math.floor(width * 0.75));
			const nextHeight = Math.max(1, Math.floor(height * 0.75));
			if (nextWidth === width && nextHeight === height) break;
			width = nextWidth;
			height = nextHeight;
		}
	} finally {
		composited.image.free();
	}
	throw new Error(
		`${image.path} could not be compressed below ${Math.floor(MAX_ATTACHMENT_DATA_CHARS / 1000)}KB base64 payload ` +
			`(smallest was ${Math.floor(smallestChars / 1000)}KB at ${smallestDimensions}).`,
	);
}

async function validateImage(path: string, cwd: string): Promise<ValidatedImage> {
	requireString(path, "path");
	const filepath = expandPath(path, cwd);
	const info = await stat(filepath).catch(() => undefined);
	if (!info?.isFile()) throw new Error(`${path} is not an existing regular file`);
	if (info.size > MAX_SOURCE_IMAGE_BYTES) {
		throw new Error(
			`${path} is ${Math.floor(info.size / 1_000_000)}MB; images must be under ${Math.floor(MAX_SOURCE_IMAGE_BYTES / 1_000_000)}MB. Resize it first.`,
		);
	}
	const data = await readFile(filepath);
	const mimeType = detectImageMime(data);
	if (!mimeType) {
		throw new Error(
			`${path} is not a supported image (PNG, JPEG, GIF, WebP). Only images can be loaded into context.`,
		);
	}
	const encodedDimensions = declaredDimensions(data, mimeType);
	if (encodedDimensions) assertPixelLimit(path, encodedDimensions);
	let decoded: PhotonImage;
	try {
		decoded = PhotonImage.new_from_byteslice(data);
	} catch {
		throw new Error(`${path} is not a readable supported image (PNG, JPEG, GIF, WebP).`);
	}
	const dimensions = [decoded.get_width(), decoded.get_height()] as const;
	decoded.free();
	assertPixelLimit(path, dimensions);
	return { animated: mimeType === "image/gif" && gifFrameCount(data) > 1, data, dimensions, mimeType, path: filepath };
}

export function createSkill(context: SkillContext) {
	return async (...paths: string[]): Promise<string> => {
		if (paths.length === 0) throw new Error("attachImage requires at least one image path");
		const model = asRecord(await context.hostRequest("model.info"));
		if (!Array.isArray(model.input) || !model.input.includes("image")) {
			throw new Error(
				`${typeof model.id === "string" ? model.id : "The current model"} does not support vision. ` +
					"Tell the user to switch to a vision-capable model to load images into context.",
			);
		}
		const validated = await Promise.all(paths.map((path) => validateImage(path, context.cwd)));
		const notes: string[] = [];
		for (const image of validated) {
			const attached = resizeForAttachment(image);
			context.display(ATTACHMENT_DISPLAY_MIME, {
				mime_type: attached.mimeType,
				data: attached.data,
				path: image.path,
			});
			if (attached.note) notes.push(`${image.path}: ${attached.note}`);
		}
		let message = `Loaded ${validated.length} image(s) into context: ${paths.join(", ")}`;
		if (notes.length > 0) {
			message += `\nResized for efficient inline rendering/replay:\n- ${notes.join("\n- ")}`;
		}
		return message;
	};
}
