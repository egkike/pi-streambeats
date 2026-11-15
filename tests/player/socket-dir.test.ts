/**
 * The socket's own directory (R1-001, S6). The socket lives in a private directory with mode 0700,
 * a directory that is not ours is never reused, and the fallback name cannot be guessed because it
 * comes from `mkdtemp` (R1-001). These tests touch the real filesystem, but only inside a temp
 * directory they create and remove; no mpv, no network and no music folder is involved (S9).
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ensurePrivateDir, privateTempDir } from "../../lib/player/mpv.ts";

/** File modes and symlinks are POSIX facts; the Windows transport is a named pipe, due in T12. */
const posixOnly = process.platform === "win32" ? "POSIX file modes are not the Windows transport (T12)" : false;

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sb-sockdir-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function modeOf(path: string): number {
	return statSync(path).mode & 0o777;
}

describe("the fallback directory (R1-001)", { skip: posixOnly }, () => {
	it("is unpredictable: two runs never land on the same path, and both are private", () => {
		const first = privateTempDir();
		const second = privateTempDir();
		try {
			assert.notEqual(first, second, "a predictable name can be pre-created or symlinked by anyone");
			assert.equal(modeOf(first), 0o700);
			assert.equal(modeOf(second), 0o700);
			assert.match(first, /pi-streambeats-/);
		} finally {
			rmSync(first, { recursive: true, force: true });
			rmSync(second, { recursive: true, force: true });
		}
	});
});

describe("a first run may not have the parents yet (R1-001)", { skip: posixOnly }, () => {
	it("creates the missing ancestors and keeps the leaf private", () => {
		const nested = join(root, "Library", "Caches", "pi-streambeats");

		ensurePrivateDir(nested);

		assert.equal(statSync(nested).mode & 0o777, 0o700, "the leaf is ours and private");
	});
});

describe("the socket directory guard (R1-001)", { skip: posixOnly }, () => {
	it("creates the directory with mode 0700", () => {
		const dir = join(root, "pi-streambeats");
		ensurePrivateDir(dir);
		assert.equal(modeOf(dir), 0o700);
	});

	it("tightens a directory we own that an older version left readable", () => {
		const dir = join(root, "pi-streambeats");
		mkdirSync(dir);
		chmodSync(dir, 0o755);

		ensurePrivateDir(dir);

		assert.equal(modeOf(dir), 0o700);
	});

	it("keeps what it already made: the guard is idempotent", () => {
		const dir = join(root, "pi-streambeats");
		ensurePrivateDir(dir);
		ensurePrivateDir(dir);
		assert.equal(modeOf(dir), 0o700);
	});

	it("never reuses a symlink, so nobody can point the socket somewhere else", () => {
		const elsewhere = join(root, "elsewhere");
		mkdirSync(elsewhere, { mode: 0o700 });
		chmodSync(elsewhere, 0o700);
		const link = join(root, "pi-streambeats");
		symlinkSync(elsewhere, link);

		assert.throws(() => ensurePrivateDir(link), /symlink/i);
	});

	it("never reuses a path that is not a directory", () => {
		const file = join(root, "pi-streambeats");
		writeFileSync(file, "");

		assert.throws(() => ensurePrivateDir(file), /not a directory/i);
	});
});
