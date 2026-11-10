#!/usr/bin/env node
/**
 * Round-trip probe for mpv's JSON IPC.
 *
 * It verifies the transport the host actually uses — a unix socket on Linux and
 * macOS, a named pipe on Windows — instead of the transport a test simulates.
 * Run it locally or from CI; it exits non-zero when the round-trip does not
 * complete, so a green job means the pipe really answered.
 *
 *   node scripts/ipc-probe.mjs [mpv-command-or-path]
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MPV = process.argv[2] ?? "mpv";
const NAME = `pi-streambeats-probe-${randomUUID().slice(0, 8)}`;
const TARGET = process.platform === "win32" ? `\\\\.\\pipe\\${NAME}` : join(tmpdir(), `${NAME}.sock`);

const CONNECT_TIMEOUT_MS = 5000;
const RESPONSE_TIMEOUT_MS = 5000;
const RETRY_MS = 100;

function cleanup() {
	if (process.platform !== "win32") rmSync(TARGET, { force: true });
}

function fail(reason, code) {
	console.error(`ipc-probe: FAIL — ${reason}`);
	console.error(`ipc-probe: platform=${process.platform} target=${TARGET} mpv=${MPV}`);
	cleanup();
	process.exit(code);
}

function succeed(version) {
	console.log(`ipc-probe: OK — ${version} via ${TARGET} (${process.platform})`);
	cleanup();
	process.exit(0);
}

const child = spawn(MPV, ["--idle=yes", "--no-video", "--no-terminal", `--input-ipc-server=${TARGET}`], {
	stdio: ["ignore", "ignore", "pipe"],
});

let mpvStderr = "";
child.stderr?.on("data", (chunk) => {
	mpvStderr += String(chunk);
});
child.on("error", (error) => fail(`spawn failed: ${error.message}`, 3));
child.on("exit", (code) => fail(`mpv exited early with code ${code}${mpvStderr ? `: ${mpvStderr.trim()}` : ""}`, 3));

const deadline = Date.now() + CONNECT_TIMEOUT_MS;

function attempt() {
	const socket = net.connect(TARGET);
	socket.setEncoding("utf8");

	let buffer = "";
	const giveUp = setTimeout(() => fail("no response to get_property within 5s", 2), RESPONSE_TIMEOUT_MS);

	socket.on("connect", () => {
		socket.write(`${JSON.stringify({ command: ["get_property", "mpv-version"], request_id: 1 })}\n`);
	});

	socket.on("data", (chunk) => {
		buffer += chunk;
		const line = buffer.split("\n")[0];
		if (!line) return;

		let reply;
		try {
			reply = JSON.parse(line);
		} catch {
			return; // partial line: wait for the rest
		}

		clearTimeout(giveUp);
		if (reply.error !== "success" || typeof reply.data !== "string") fail(`unexpected reply: ${line}`, 2);

		socket.write(`${JSON.stringify({ command: ["quit"], request_id: 2 })}\n`);
		socket.end();
		child.removeAllListeners("exit");
		child.kill();
		succeed(reply.data);
	});

	socket.on("error", () => {
		clearTimeout(giveUp);
		socket.destroy();
		// mpv creates the socket/pipe a moment after spawning: retry until the deadline.
		if (Date.now() > deadline) fail("no connection within 5s", 1);
		setTimeout(attempt, RETRY_MS);
	});
}

attempt();
