/**
 * The IPC target and mpv's argv (S6, S19). Both are pure: the platform, the environment and the
 * user id come in as arguments, so the three platforms are testable from one host and none of these
 * tests needs mpv, a socket or a music folder. No path here is ever a fixed `/home/<user>`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ipcTarget, mpvArgs } from "../../lib/player/mpv.ts";

describe("the IPC target (S6, S19)", () => {
	it("puts the socket under XDG_RUNTIME_DIR on Linux", () => {
		const target = ipcTarget({ platform: "linux", env: { XDG_RUNTIME_DIR: "/run/user/1000" }, uid: 1000 });
		assert.equal(target, "/run/user/1000/pi-streambeats/mpv.sock");
	});

	it("falls back to a tmpdir path that carries the uid when XDG_RUNTIME_DIR is missing", () => {
		const target = ipcTarget({ platform: "linux", env: {}, uid: 1000, tmpDir: "/tmp" });
		assert.equal(target, "/tmp/pi-streambeats-1000/mpv.sock");
	});

	it("ignores a relative XDG_RUNTIME_DIR, the way the XDG spec does", () => {
		const target = ipcTarget({
			platform: "linux",
			env: { XDG_RUNTIME_DIR: "run/user/1000" },
			uid: 1000,
			tmpDir: "/tmp",
		});
		assert.equal(target, "/tmp/pi-streambeats-1000/mpv.sock");
	});

	it("honours TMPDIR when no explicit tmpdir is passed in", () => {
		const target = ipcTarget({ platform: "linux", env: { TMPDIR: "/var/tmp/me" }, uid: 7 });
		assert.equal(target, "/var/tmp/me/pi-streambeats-7/mpv.sock");
	});

	it("uses a tmpdir path on macOS: XDG_RUNTIME_DIR is a Linux convention", () => {
		const target = ipcTarget({
			platform: "darwin",
			env: { XDG_RUNTIME_DIR: "/run/user/501", TMPDIR: "/var/folders/x1/T" },
			uid: 501,
		});
		assert.equal(target, "/var/folders/x1/T/pi-streambeats-501/mpv.sock");
	});

	it("names a Windows pipe after the user: a pipe has no directory", () => {
		const target = ipcTarget({ platform: "win32", env: {}, uid: 1000 });
		assert.equal(target, "\\\\.\\pipe\\pi-streambeats-1000");
	});

	it("never puts two users on the same predictable path in a shared temp directory", () => {
		const first = ipcTarget({ platform: "linux", env: {}, uid: 1000, tmpDir: "/tmp" });
		const second = ipcTarget({ platform: "linux", env: {}, uid: 1001, tmpDir: "/tmp" });
		assert.notEqual(first, second);
		assert.ok(first.includes("1000"));
		assert.ok(second.includes("1001"));
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
