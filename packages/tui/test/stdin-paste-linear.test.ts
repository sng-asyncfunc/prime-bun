import assert from "node:assert/strict";
import { it } from "node:test";
import { StdinBuffer } from "../src/stdin-buffer.js";

it("scans chunked paste input in linear total characters", () => {
	const buffer = new StdinBuffer();
	const original = String.prototype.indexOf;
	let scanned = 0;
	let pasted = "";
	buffer.on("paste", (text) => {
		pasted = text;
	});
	try {
		String.prototype.indexOf = function (needle: string, position?: number) {
			if (needle === "\x1b[201~") scanned += this.length;
			return original.call(this, needle, position);
		};
		buffer.process("\x1b[200~");
		for (let i = 0; i < 1024; i++) buffer.process("x".repeat(1024));
		buffer.process("\x1b[201~");
	} finally {
		String.prototype.indexOf = original;
		buffer.destroy();
	}
	assert.equal(pasted, "x".repeat(1024 * 1024));
	assert.ok(scanned < 2 * 1024 * 1024, `scanned ${scanned} characters`);
});

it("recognizes split markers and clears an unfinished paste", () => {
	const input = "a\x1b[200~hello\x1b[201~b";
	for (let i = 1; i < input.length; i++) {
		for (let j = i + 1; j < input.length; j++) {
			const buffer = new StdinBuffer();
			const data: string[] = [];
			const pastes: string[] = [];
			buffer.on("data", (value) => data.push(value));
			buffer.on("paste", (value) => pastes.push(value));
			buffer.process("\x1b[200~abandoned\x1b[20");
			buffer.clear();
			for (const chunk of [input.slice(0, i), input.slice(i, j), input.slice(j)]) buffer.process(chunk);
			assert.deepEqual(data, ["a", "b"]);
			assert.deepEqual(pastes, ["hello"]);
			buffer.destroy();
		}
	}
});
