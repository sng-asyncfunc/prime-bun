import assert from "node:assert";
import { describe, it } from "node:test";
import { matchesKey } from "../src/keys.js";

describe("combined modified arrows", () => {
	it("matches xterm and Kitty Ctrl+Alt arrows", () => {
		assert.equal(matchesKey("\x1b[1;7A", "ctrl+alt+up"), true);
		assert.equal(matchesKey("\x1b[1;7B", "ctrl+alt+down"), true);
		assert.equal(matchesKey("\x1b[57419;7u", "ctrl+alt+up"), true);
		assert.equal(matchesKey("\x1b[57420;7u", "ctrl+alt+down"), true);
	});

	it("does not alias Shift+Ctrl+Alt arrows onto Ctrl+Alt", () => {
		assert.equal(matchesKey("\x1b[1;8A", "shift+ctrl+alt+up"), true);
		assert.equal(matchesKey("\x1b[1;8A", "ctrl+alt+up"), false);
		assert.equal(matchesKey("\x1b[1;8B", "ctrl+alt+down"), false);
	});

	it("matches legacy Option-as-Meta wrapped Ctrl arrows", () => {
		assert.equal(matchesKey("\x1b\x1b[1;5A", "ctrl+alt+up"), true);
		assert.equal(matchesKey("\x1b\x1b[1;5B", "ctrl+alt+down"), true);
		assert.equal(matchesKey("\x1b\x1bOa", "ctrl+alt+up"), true);
		assert.equal(matchesKey("\x1b\x1bOb", "ctrl+alt+down"), true);
	});
});
