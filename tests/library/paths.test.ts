/**
 * Navigation ceiling (S14). The rule: navigate up to HOME inclusive, or to libraryRoot when the
 * configured root lives outside HOME. The function is pure — canonical paths in, a path out — so
 * all three platforms and the "outside home" case are testable from Linux.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ceilingFor } from "../../lib/library/paths.ts";

describe("navigation ceiling (S14)", () => {
	it("uses HOME when libraryRoot is inside it", () => {
		assert.equal(ceilingFor("linux", "/home/kike", "/home/kike/Music/StreamBeats"), "/home/kike");
	});

	it("uses HOME when libraryRoot is HOME itself", () => {
		assert.equal(ceilingFor("linux", "/home/kike", "/home/kike"), "/home/kike");
	});

	it("uses libraryRoot when it lies outside HOME", () => {
		assert.equal(ceilingFor("linux", "/home/kike", "/srv/music"), "/srv/music");
	});

	it("does not mistake a sibling of HOME for a parent", () => {
		assert.equal(ceilingFor("linux", "/home/kike", "/home/kikette/Music"), "/home/kikette/Music");
	});

	it("asks the same question on macOS", () => {
		assert.equal(ceilingFor("darwin", "/Users/kike", "/Users/kike/Music"), "/Users/kike");
		assert.equal(ceilingFor("darwin", "/Users/kike", "/Volumes/music"), "/Volumes/music");
	});

	it("compares Windows paths case-insensitively", () => {
		assert.equal(ceilingFor("win32", "C:\\Users\\Kike", "c:\\users\\kike\\Music"), "C:\\Users\\Kike");
	});

	it("uses libraryRoot when it is on another Windows drive", () => {
		assert.equal(ceilingFor("win32", "C:\\Users\\Kike", "D:\\Music"), "D:\\Music");
	});

	it("answers without touching the filesystem", () => {
		const nonexistent = "/this/path/does/not/exist";
		assert.equal(ceilingFor("linux", nonexistent, `${nonexistent}/Music`), nonexistent);
	});

	it("ignores a trailing separator so equal folders compare equal", () => {
		assert.equal(ceilingFor("linux", "/home/kike/", "/home/kike/Music"), "/home/kike");
	});

	it("treats the filesystem root as inside itself", () => {
		assert.equal(ceilingFor("linux", "/", "/home/kike/Music"), "/");
	});
});
