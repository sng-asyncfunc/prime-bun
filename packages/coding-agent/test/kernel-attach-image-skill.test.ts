import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas } from "canvas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ATTACHMENT_DISPLAY_MIME } from "../src/core/kernel/index.js";
import { BunKernelProvisioner, imageBlocksFromAttachments } from "../src/core/tools/javascript.js";
import { bundledJavaScriptSkill } from "./bun-skill-test-utils.js";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const ATTACH_IMAGE_SKILL = bundledJavaScriptSkill("attach-image", "attachImage");

function writeCanvas(path: string, width: number, height: number, fill: string): void {
	const canvas = createCanvas(width, height);
	const context = canvas.getContext("2d");
	context.fillStyle = fill;
	context.fillRect(0, 0, width, height);
	writeFileSync(path, canvas.toBuffer("image/png"));
}

function writeAnimatedGif(path: string): void {
	const singleFrame = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
	const header = Buffer.from(singleFrame.subarray(0, 0x13));
	header.writeUInt16LE(1300, 6);
	const frame = singleFrame.subarray(0x13, singleFrame.length - 1);
	writeFileSync(path, Buffer.concat([header, frame, frame, Buffer.from([0x3b])]));
}

function writeOversizedPngHeader(path: string): void {
	const bytes = Buffer.alloc(33);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
	bytes.writeUInt32BE(13, 8);
	bytes.write("IHDR", 12, "ascii");
	bytes.writeUInt32BE(6001, 16);
	bytes.writeUInt32BE(6001, 20);
	bytes[24] = 8;
	bytes[25] = 2;
	writeFileSync(path, bytes);
}

describe("attach-image skill over the Bun host bridge", () => {
	let tempDir: string;
	let provisioner: BunKernelProvisioner | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-attach-image-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await provisioner?.dispose();
		provisioner = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createProvisioner(vision = true): BunKernelProvisioner {
		return new BunKernelProvisioner(tempDir, {
			javascriptSkills: [ATTACH_IMAGE_SKILL],
			hostHandlers: {
				"model.info": async () => ({
					id: vision ? "anthropic/claude-haiku-4.5" : "openai/gpt-oss-120b",
					input: vision ? ["text", "image"] : ["text"],
				}),
			},
		});
	}

	it("loads an on-disk image into the tool result as an ImageContent block", async () => {
		const imagePath = join(tempDir, "sample.png");
		writeFileSync(imagePath, Buffer.from(PNG_BASE64, "base64"));
		provisioner = createProvisioner();

		const manager = await provisioner.ensure();
		const result = await manager.execute(`console.log(await attachImage(${JSON.stringify(imagePath)}));`);

		expect(result.status).toBe("ok");
		expect(result.stdout.trim()).toContain("Loaded 1 image(s) into context");
		expect(result.attachments).toHaveLength(1);
		expect(result.attachments?.[0]?.mimeType).toBe("image/png");
		expect(result.attachments?.[0]?.data).toBe(PNG_BASE64);
		expect(imageBlocksFromAttachments(result.attachments)).toEqual([
			{ type: "image", data: PNG_BASE64, mimeType: "image/png" },
		]);
	});

	it("compresses large attached images before storing them", async () => {
		const imagePath = join(tempDir, "large.png");
		writeCanvas(imagePath, 2400, 1800, "rgb(32, 64, 96)");
		provisioner = createProvisioner();

		const manager = await provisioner.ensure();
		const result = await manager.execute(`console.log(await attachImage(${JSON.stringify(imagePath)}));`);

		expect(result.status).toBe("ok");
		expect(result.stdout).toContain("Resized for efficient inline rendering/replay");
		expect(result.attachments).toHaveLength(1);
		expect(result.attachments?.[0]?.mimeType).toBe("image/jpeg");
		expect(result.attachments?.[0]?.data.length).toBeLessThanOrEqual(350_000);
	});

	it("reports when compressed animated GIFs are flattened to their first frame", async () => {
		const imagePath = join(tempDir, "animated.gif");
		writeAnimatedGif(imagePath);
		provisioner = createProvisioner();

		const manager = await provisioner.ensure();
		const result = await manager.execute(`console.log(await attachImage(${JSON.stringify(imagePath)}));`);

		expect(result.status).toBe("ok");
		expect(result.stdout).toContain("animated image flattened to first frame");
		expect(result.attachments?.[0]?.mimeType).toBe("image/jpeg");
	});

	it("uses a neutral background when compressing transparent images", async () => {
		const imagePath = join(tempDir, "transparent.png");
		writeCanvas(imagePath, 1300, 10, "rgba(255, 255, 255, 0.5)");
		provisioner = createProvisioner();

		const manager = await provisioner.ensure();
		const result = await manager.execute(`console.log(await attachImage(${JSON.stringify(imagePath)}));`);

		expect(result.status).toBe("ok");
		expect(result.stdout).toContain("transparent pixels composited on #888888 background");
		expect(result.attachments?.[0]?.mimeType).toBe("image/jpeg");
	});

	it("rejects oversized pixel counts before decoding image data", async () => {
		const imagePath = join(tempDir, "huge.png");
		writeOversizedPngHeader(imagePath);
		provisioner = createProvisioner();

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
try {
  await attachImage(${JSON.stringify(imagePath)});
} catch (error) {
  console.log(error instanceof Error ? error.message : String(error));
}
`);

		expect(result.status).toBe("ok");
		expect(result.stdout).toContain("images must be at most 36MP");
		expect(result.attachments).toBeUndefined();
	});

	it("rejects an invalid batch before emitting any attachment", async () => {
		const validImagePath = join(tempDir, "valid.png");
		const corruptImagePath = join(tempDir, "corrupt.png");
		writeFileSync(validImagePath, Buffer.from(PNG_BASE64, "base64"));
		writeFileSync(corruptImagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
		provisioner = createProvisioner();

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
try {
  await attachImage(${JSON.stringify(validImagePath)}, ${JSON.stringify(corruptImagePath)});
} catch (error) {
  console.log(error instanceof Error ? error.message : String(error));
}
`);

		expect(result.status).toBe("ok");
		expect(result.stdout).toContain("is not a readable supported image");
		expect(result.attachments).toBeUndefined();
	});

	it("errors without emitting an attachment when the model is not vision-capable", async () => {
		const imagePath = join(tempDir, "sample.png");
		writeFileSync(imagePath, Buffer.from(PNG_BASE64, "base64"));
		provisioner = createProvisioner(false);

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
try {
  await attachImage(${JSON.stringify(imagePath)});
} catch (error) {
  console.log(error instanceof Error ? error.message : String(error));
}
`);

		expect(result.status).toBe("ok");
		expect(result.stdout.trim()).toBe(
			"openai/gpt-oss-120b does not support vision. " +
				"Tell the user to switch to a vision-capable model to load images into context.",
		);
		expect(result.attachments).toBeUndefined();
	});

	it("rejects a non-image file", async () => {
		const notImage = join(tempDir, "notes.txt");
		writeFileSync(notImage, "just text");
		provisioner = createProvisioner();

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
try {
  await attachImage(${JSON.stringify(notImage)});
} catch (error) {
  console.log(error instanceof Error ? error.message : String(error));
}
`);

		expect(result.status).toBe("ok");
		expect(result.stdout.trim()).toContain("is not a supported image");
		expect(result.attachments).toBeUndefined();
	});

	it("fails the cell when an emitted attachment exceeds the size cap", async () => {
		provisioner = new BunKernelProvisioner(tempDir);
		const manager = await provisioner.ensure();
		const result = await manager.execute(`
__primeDisplay(${JSON.stringify(ATTACHMENT_DISPLAY_MIME)}, {
  mime_type: "image/png",
  data: "A".repeat(10_000_001),
});
console.log("done");
`);

		expect(result.status).toBe("error");
		expect(result.stderr).toContain("attachment dropped");
		expect(result.attachments).toBeUndefined();
	});
});
