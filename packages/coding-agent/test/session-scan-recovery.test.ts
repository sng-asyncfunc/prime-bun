import {
	appendFileSync,
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSessionInfo, SessionManager } from "../src/core/session-manager.js";

describe("session scan recovery", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `prime-bun-session-scan-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

	const header = { type: "session", version: 3, id: "scan1", timestamp: "2026-01-01T00:00:00Z", cwd: "/tmp" };
	const message = (id: string, parentId: string | null, role: string, text: string) => ({
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:01Z",
		message: { role, content: text, timestamp: 1 },
	});
	const line = (entry: unknown) => `${JSON.stringify(entry)}\n`;

	it("serializes readers and gives a post-append reader a fresh snapshot", async () => {
		const file = join(tempDir, "serialized.jsonl");
		let content = line(header);
		for (let i = 0; i < 20_000; i++) {
			content += line(message(`m${i}`, i === 0 ? null : `m${i - 1}`, "user", `filler ${i} ${"x".repeat(120)}`));
		}
		writeFileSync(file, content);

		const [first, second] = await Promise.all([readSessionInfo(file), readSessionInfo(file)]);
		expect(first?.messageCount).toBe(20_000);
		expect(second).toBe(first);

		const early = readSessionInfo(file);
		await new Promise((resolveTick) => setImmediate(resolveTick));
		appendFileSync(file, line(message("late", "m19999", "assistant", "post-append")));
		expect((await readSessionInfo(file))?.messageCount).toBe(20_001);
		expect((await early)?.messageCount).toBeLessThanOrEqual(20_001);
	});

	it("resumes from the consumed offset and folds a completed torn tail once", async () => {
		const file = join(tempDir, "incremental.jsonl");
		const torn = line(message("m2", "m1", "assistant", "answer"));
		writeFileSync(file, line(header) + line(message("m1", null, "user", "original question")) + torn.slice(0, 20));
		expect((await readSessionInfo(file))?.messageCount).toBe(1);

		const position = readFileSync(file, "utf8").indexOf("original question");
		const descriptor = openSync(file, "r+");
		try {
			writeSync(descriptor, Buffer.from("modified question"), 0, 17, position);
		} finally {
			closeSync(descriptor);
		}
		appendFileSync(file, torn.slice(20));

		const info = await readSessionInfo(file);
		expect(info?.messageCount).toBe(2);
		expect(info?.firstMessage).toBe("original question");
	});

	it.each(["rename", "truncate"])("rescans after a grown %s rewrite", async (mode) => {
		const file = join(tempDir, `${mode}.jsonl`);
		writeFileSync(file, line(header) + line(message("m1", null, "user", "first draft AAAAAA")));
		expect((await readSessionInfo(file))?.firstMessage).toBe("first draft AAAAAA");
		const rewritten =
			line(header) +
			line(message("m1", null, "user", "rewritten opening line")) +
			line(message("m2", "m1", "assistant", "appended"));
		if (mode === "rename") {
			const temporary = join(tempDir, "rewrite.tmp");
			writeFileSync(temporary, rewritten);
			renameSync(temporary, file);
		} else {
			writeFileSync(file, rewritten);
		}
		expect((await readSessionInfo(file))?.firstMessage).toBe("rewritten opening line");
	});

	it("repairs zero-filled and torn crash damage before a later append", async () => {
		const file = join(tempDir, "crashed.jsonl");
		writeFileSync(
			file,
			line(header) +
				line(message("m1", null, "user", "kept")) +
				`\0\0${line(message("m2", "m1", "user", "recovered"))}` +
				'{"type":"message","id":"torn',
		);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const manager = SessionManager.open(file, tempDir);
			expect(manager.getEntries().map((entry) => entry.id)).toEqual(["m1", "m2"]);
			manager.appendMessage({ role: "user", content: "after crash", timestamp: 3 });
			manager.flushNow();
			const parsed = readFileSync(file, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((entry) => JSON.parse(entry));
			expect(parsed.at(-1)?.message?.content).toBe("after crash");
			expect(errorSpy).toHaveBeenCalledOnce();
		} finally {
			errorSpy.mockRestore();
		}
	});
});
