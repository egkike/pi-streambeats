/**
 * Key translation (S13). Pi delivers raw terminal bytes to a focused component; the model speaks
 * key identifiers from its only key table. The translation lives here, in the host adapter, and is
 * testable without a terminal.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { translateKey } from "../../lib/host/keys.ts";

describe("key translation (S13)", () => {
	it("translates the arrow keys in both terminal modes", () => {
		assert.equal(translateKey("\x1b[A"), "up");
		assert.equal(translateKey("\x1bOA"), "up");
		assert.equal(translateKey("\x1b[B"), "down");
		assert.equal(translateKey("\x1bOB"), "down");
		assert.equal(translateKey("\x1b[C"), "right");
		assert.equal(translateKey("\x1b[D"), "left");
	});

	it("translates the control keys the card binds", () => {
		assert.equal(translateKey("\x1b"), "escape");
		assert.equal(translateKey("\r"), "enter");
		assert.equal(translateKey("\n"), "enter");
		assert.equal(translateKey("\x7f"), "backspace");
		assert.equal(translateKey("\b"), "backspace");
		assert.equal(translateKey(" "), "space");
	});

	it("passes printable characters through so the model can type a filter term", () => {
		assert.equal(translateKey("k"), "k");
		assert.equal(translateKey("/"), "/");
		assert.equal(translateKey(">"), ">");
		assert.equal(translateKey("Z"), "Z");
	});

	it("answers undefined for a sequence the card does not bind", () => {
		assert.equal(translateKey("\x1b[Z"), undefined);
		assert.equal(translateKey("\x1bx"), undefined);
		assert.equal(translateKey(""), undefined);
	});
});
