import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const PROBE = join(ROOT, "scripts/ipc-probe.mjs");
const FAKE_MPV = join(HERE, "fake-mpv-events.mjs");

/** The probe speaks unix sockets on this side of the fence; a named pipe is T12's job. */
const unix = process.platform !== "win32";

interface ProbeRun {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

function runProbe(): Promise<ProbeRun> {
	return new Promise((done) => {
		const child = spawn(process.execPath, [PROBE, FAKE_MPV], {
			cwd: ROOT,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		// A probe or a fake mpv that hangs must fail this test, not hang the suite (R4-003).
		const stuck = setTimeout(() => {
			child.kill("SIGKILL");
			done({ code: null, stdout, stderr: `${stderr}\ntest: the probe did not finish within 15s` });
		}, 15_000);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("close", (code) => {
			clearTimeout(stuck);
			done({ code, stdout, stderr });
		});
	});
}

describe("the transport probe (S6)", { skip: unix ? false : "unix sockets only" }, () => {
	it("ignores an event that arrives before the reply, and still completes the round-trip", async () => {
		// mpv sends events down the same stream as replies. Treating `{"event":"idle"}` as an answer turned
		// a healthy transport into a red `gate` on macOS (#40): the probe must match the reply by
		// request_id, exactly as the player's own line handler does.
		const run = await runProbe();

		assert.equal(run.code, 0, `probe exited ${run.code}: ${run.stderr}`);
		assert.match(run.stdout, /ipc-probe: OK — mpv fake via /);
		assert.equal(run.stderr, "", "an event is not an error");
	});
});
