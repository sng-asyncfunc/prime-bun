import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.js";

describe("OutputAccumulator temp spill", () => {
	let realTmp: string | undefined;
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "prime-bun-accumulator-"));
		realTmp = process.env.TMPDIR;
	});

	afterEach(() => {
		if (realTmp === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = realTmp;
		rmSync(scratch, { recursive: true, force: true });
	});

	it("degrades a failed spill to the bounded in-memory tail", async () => {
		process.env.TMPDIR = join(scratch, "missing");
		const accumulator = new OutputAccumulator({ maxBytes: 8, maxLines: 100 });
		accumulator.append(Buffer.from("0123456789abcdef\n"));
		accumulator.append(Buffer.from("tail\n"));
		accumulator.finish();

		await expect(accumulator.closeTempFile()).resolves.toBeUndefined();
		const snapshot = accumulator.snapshot();
		expect(snapshot.fullOutputPath).toBeUndefined();
		expect(snapshot.content).toContain("tail");
	});

	it("does not let cleanup failure turn spill degradation into a process error", async () => {
		const blocker = join(scratch, "not-a-dir");
		writeFileSync(blocker, "x");
		process.env.TMPDIR = blocker;
		const accumulator = new OutputAccumulator({ maxBytes: 8, maxLines: 100 });
		accumulator.append(Buffer.from("0123456789abcdef\n"));
		accumulator.finish();

		await expect(accumulator.closeTempFile()).resolves.toBeUndefined();
		expect(accumulator.snapshot().fullOutputPath).toBeUndefined();
	});
});
