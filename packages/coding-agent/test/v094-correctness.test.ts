import { describe, expect, it } from "vitest";
import { findCutPoint } from "../src/core/compaction/compaction.js";
import type { SessionEntry } from "../src/core/session-manager.js";
import { truncateTail } from "../src/core/tools/truncate.js";
import { applyExifOrientation } from "../src/utils/exif-orientation.js";
import { parseFrontmatter } from "../src/utils/frontmatter.js";

describe("v0.9.4 correctness ports", () => {
	it("keeps only the final turn when compaction crosses its budget in trailing tool results", () => {
		const user = (id: string, parentId: string | null, text: string): SessionEntry => ({
			type: "message",
			id,
			parentId,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: text, timestamp: Date.now() },
		});
		const toolResult: SessionEntry = {
			type: "message",
			id: "t1",
			parentId: "u2",
			timestamp: new Date().toISOString(),
			message: {
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "javascript",
				content: [{ type: "text", text: "x".repeat(40_000) }],
				isError: false,
				timestamp: Date.now(),
			},
		};
		const entries = [
			user("u1", null, "turn one"),
			user("u2", "u1", "turn two"),
			toolResult,
			{ ...toolResult, id: "t2", parentId: "t1" },
		];
		expect(findCutPoint(entries, 0, entries.length, 1_000).firstKeptEntryIndex).toBe(1);
	});

	it("rescues an oversized final line even when trailing blank lines exist", () => {
		const result = truncateTail(`${"x".repeat(50_000)}\n`, { maxLines: 100, maxBytes: 1_000 });
		expect(result.content).toBe(`${"x".repeat(999)}\n`);
		expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(1_000);
		expect(result.lastLinePartial).toBe(true);
	});

	it("parses frontmatter behind a UTF-8 BOM", () => {
		const parsed = parseFrontmatter("\uFEFF---\nname: bom-skill\n---\nBody");
		expect(parsed.frontmatter).toEqual({ name: "bom-skill" });
		expect(parsed.body).toBe("Body");
	});

	it("terminates a WebP scan when a chunk size has its high bit set", () => {
		const bytes = new Uint8Array(20);
		bytes.set([0x52, 0x49, 0x46, 0x46], 0);
		bytes.set([0x57, 0x45, 0x42, 0x50], 8);
		bytes.set([0x4a, 0x55, 0x4e, 0x4b], 12);
		bytes.set([0xf8, 0xff, 0xff, 0xff], 16);
		const image = {} as Parameters<typeof applyExifOrientation>[1];
		expect(applyExifOrientation({} as Parameters<typeof applyExifOrientation>[0], image, bytes)).toBe(image);
	});
});
