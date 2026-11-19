/**
 * The IPC target and mpv's argv (S6, S19). `ipcTarget` stays pure for every path that can be pure:
 * the platform, the environment, the uid, the home directory, the random source the Windows pipe is
 * named from, and — only when no private base exists — an injected function that makes a fresh
 * unpredictable directory (R1-001). None of these tests needs mpv, a socket or a music folder, and no
 * path here is a fixed `/home/<user>`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ipcTarget, mpvArgs } from "../../lib/player/mpv.ts";

/** The stub for the fallback: production answers with `mkdtemp`, whose name nobody can predict. */
function privateDir(path: string): () => string {
	return () => path;
}

describe("the IPC target (S6, S19)", () => {
	it("puts the socket under XDG_RUNTIME_DIR on Linux", () => {
		const target = ipcTarget({ platform: "linux", env: { XDG_RUNTIME_DIR: "/run/user/1000" }, uid: 1000 });
		assert.equal(target, "/run/user/1000/pi-streambeats/mpv.sock");
	});

	it("gives macOS a private directory inside the user's own cache, not a temp path", () => {
		const target = ipcTarget({
			platform: "darwin",
			env: { XDG_RUNTIME_DIR: "/run/user/501", TMPDIR: "/var/folders/x1/T" },
			uid: 501,
			home: "/Users/ana",
		});
		assert.equal(target, "/Users/ana/Library/Caches/pi-streambeats/mpv.sock");
	});

	it("falls back to an unpredictable private directory, never a uid-derived name", () => {
		const target = ipcTarget({
			platform: "linux",
			env: {},
			uid: 1000,
			privateDir: privateDir("/var/folders/9c/pi-streambeats-q3w8e1"),
		});
		assert.equal(target, "/var/folders/9c/pi-streambeats-q3w8e1/mpv.sock");
		assert.ok(!target.includes("1000"), "a uid is not an identity: it is the most predictable name there is");
	});

	it("ignores a relative XDG_RUNTIME_DIR, the way the XDG spec does", () => {
		const target = ipcTarget({
			platform: "linux",
			env: { XDG_RUNTIME_DIR: "run/user/1000" },
			uid: 1000,
			privateDir: privateDir("/var/folders/9c/pi-streambeats-a1b2c3"),
		});
		assert.equal(target, "/var/folders/9c/pi-streambeats-a1b2c3/mpv.sock");
	});

	it("ignores TMPDIR: a fallback that obeys the environment is a fallback anyone can aim", () => {
		const target = ipcTarget({
			platform: "linux",
			env: { TMPDIR: "/var/tmp/me" },
			uid: 7,
			privateDir: privateDir("/var/folders/9c/pi-streambeats-zz9"),
		});
		assert.equal(target, "/var/folders/9c/pi-streambeats-zz9/mpv.sock");
	});

	it("falls back on macOS when there is no home directory to put a cache in", () => {
		const target = ipcTarget({
			platform: "darwin",
			env: {},
			uid: 501,
			privateDir: privateDir("/var/folders/9c/pi-streambeats-b7"),
		});
		assert.equal(target, "/var/folders/9c/pi-streambeats-b7/mpv.sock");
	});

	it("refuses to build a predictable path when no private directory can be made", () => {
		assert.throws(() => ipcTarget({ platform: "linux", env: {}, uid: 1000 }), /private directory/);
	});

	it("names a Windows pipe with a per-player random suffix, because Windows has no uid to name it after", () => {
		const target = ipcTarget({
			platform: "win32",
			env: {},
			uid: 0,
			random: () => "8f14e45f-ceea-467f-a9c1-8b5d0f2a3c11",
		});

		assert.equal(target, "\\\\.\\pipe\\pi-streambeats-8f14e45f-ceea-467f-a9c1-8b5d0f2a3c11");
	});

	it("is not the machine-global name every Windows process can sit on", () => {
		// The triangulation for the finding this slice closes: the default suffix is the injected random
		// source, so a fixed source still must not produce `pi-streambeats-0` — the name two sessions and two
		// users shared before, when the uid fallback was all Windows had.
		const target = ipcTarget({ platform: "win32", env: {}, uid: 0, random: () => "q3w8e1" });

		assert.equal(target, "\\\\.\\pipe\\pi-streambeats-q3w8e1");
		assert.notEqual(target, "\\\\.\\pipe\\pi-streambeats-0");
	});

	it("gives two players different pipe names when their random sources differ", () => {
		const first = ipcTarget({ platform: "win32", env: {}, uid: 0, random: () => "aaaa1111" });
		const second = ipcTarget({ platform: "win32", env: {}, uid: 0, random: () => "bbbb2222" });

		assert.notEqual(first, second, "two mpv children must not fight over one pipe");
	});

	it("gives two players the same pipe name from the same source, so the name is a value and not a side effect", () => {
		const one = ipcTarget({ platform: "win32", env: {}, uid: 0, random: () => "same-source" });
		const two = ipcTarget({ platform: "win32", env: {}, uid: 0, random: () => "same-source" });

		assert.equal(one, two);
	});

	it("differs on every call when the default source decides, so nothing can predict the next pipe", () => {
		const first = ipcTarget({ platform: "win32", env: {}, uid: 0 });
		const second = ipcTarget({ platform: "win32", env: {}, uid: 0 });

		assert.notEqual(first, second);
		for (const target of [first, second]) {
			assert.match(target, /^\\\\\.\\pipe\\pi-streambeats-[0-9a-f-]{36}$/, "the default is a uuid, not a counter");
		}
	});

	it("keeps the uid inside the private directory on unix: the pipe is the only target without a path", () => {
		// The uid rule did not move: it is the Windows pipe, which has no directory, that needed an identity.
		const linux = ipcTarget({
			platform: "linux",
			env: { XDG_RUNTIME_DIR: "/run/user/1000" },
			uid: 1000,
			random: () => "ignored-on-unix",
		});

		assert.equal(linux, "/run/user/1000/pi-streambeats/mpv.sock");
	});

	it("refuses a Windows pipe named from nothing, which would be the shared name again", () => {
		assert.throws(
			() => ipcTarget({ platform: "win32", env: {}, uid: 0, random: () => "" }),
			/random source/,
			"an empty suffix is `pi-streambeats-`, a name every player would collide on",
		);
	});
});

describe("mpv's argv (S6)", () => {
	it("is a list of arguments, with the target as one argument and never a shell string", () => {
		const args = mpvArgs("/run/user/1000/pi-streambeats/mpv.sock");
		assert.ok(Array.isArray(args), "argv must be an array, never an interpolated command line");
		assert.deepEqual(args, [
			"--idle",
			"--no-video",
			"--no-terminal",
			"--input-ipc-server=/run/user/1000/pi-streambeats/mpv.sock",
		]);
		for (const argument of args) assert.equal(typeof argument, "string");
	});
});
