/**
 * The mpv player (S6, S11, S19). Every test here drives a REAL unix socket — a `net.Server` in a
 * temporary directory — and a fake child process, so nothing touches mpv, the network or the user's
 * music folder (S9). The server records the commands it receives and answers them, which is the only
 * way to check the JSON-per-line protocol without believing a mock of the protocol itself.
 *
 * Windows named pipes are the other transport (S19) and arrive with T12; these tests speak the unix
 * socket they can create on the host that runs them.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	createMpvPlayer,
	type MpvValue,
	type Player,
	type PlayerDeps,
	type PlayerReport,
	type SpawnedProcess,
	type SpawnOptions,
} from "../../lib/player/mpv.ts";
import type { Track } from "../../lib/types.ts";

/** Unix sockets are the Linux/macOS transport; Windows pipes need the worker of T12. */
const unixSockets = process.platform === "win32" ? "unix sockets are not the Windows transport (T12)" : false;

const track: Track = { id: "/music/Chillhop/01 - Dawn.mp3", title: "Dawn", origin: "local" };

let root: string;
const servers: FakeMpv[] = [];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sb-mpv-"));
});

afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
	rmSync(root, { recursive: true, force: true });
});

async function delay(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) assert.fail("the expected event never arrived");
		await delay(5);
	}
}

/* --- the fake mpv: a real socket server that records and answers ------------------------------- */

interface Received {
	readonly command: readonly MpvValue[];
	readonly request_id: number;
}

type Handler = (received: Received, socket: net.Socket, index: number) => void;

/** Write one JSON line to a client, exactly as mpv would. */
function send(socket: net.Socket, line: object): void {
	socket.write(`${JSON.stringify(line)}\n`);
}

class FakeMpv {
	readonly commands: Received[] = [];
	readonly clients: net.Socket[] = [];
	closed = 0;
	/** Per-test behaviour: by default every command succeeds and nothing is pushed back. */
	handle: Handler = (received, socket) => send(socket, { error: "success", request_id: received.request_id });
	readonly #server: net.Server;

	constructor() {
		this.#server = net.createServer((socket) => {
			this.clients.push(socket);
			socket.setEncoding("utf8");
			socket.on("error", () => {});
			socket.on("close", () => {
				this.closed += 1;
			});

			let buffer = "";
			socket.on("data", (chunk: string) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					if (line.trim() === "") continue;
					const message = JSON.parse(line) as { command?: readonly MpvValue[]; request_id?: number };
					const received: Received = { command: message.command ?? [], request_id: message.request_id ?? -1 };
					this.commands.push(received);
					this.handle(received, socket, this.commands.length - 1);
				}
			});
		});
	}

	async listen(path: string): Promise<void> {
		mkdirSync(dirname(path), { recursive: true });
		await new Promise<void>((resolve, reject) => {
			this.#server.once("error", reject);
			this.#server.listen(path, () => resolve());
		});
	}

	/** Push an event line to every connected client, the way mpv announces `end-file`. */
	emit(line: object): void {
		for (const client of this.clients) send(client, line);
	}

	commandArgs(index: number): readonly MpvValue[] {
		return this.commands[index]?.command ?? [];
	}

	allCommands(): readonly (readonly MpvValue[])[] {
		return this.commands.map((received) => received.command);
	}

	async close(): Promise<void> {
		for (const client of this.clients) client.destroy();
		if (!this.#server.listening) return;
		await new Promise<void>((resolve) => this.#server.close(() => resolve()));
	}
}

/* --- the fake process and the harness -------------------------------------------------------- */

interface SpawnedCall {
	readonly command: string;
	readonly args: readonly string[];
	readonly options: SpawnOptions;
}

function fakeChild() {
	const listeners = new Map<string, ((...args: never[]) => void)[]>();
	const child = {
		unrefCalls: 0,
		killed: false,
		stderr: null,
		on(event: string, listener: (...args: never[]) => void) {
			const known = listeners.get(event) ?? [];
			known.push(listener);
			listeners.set(event, known);
			return child;
		},
		unref() {
			child.unrefCalls += 1;
			return child;
		},
		kill() {
			child.killed = true;
			return true;
		},
		emit(event: string, value: unknown) {
			for (const listener of listeners.get(event) ?? []) listener(value as never);
		},
	};
	return child as SpawnedProcess & {
		readonly unrefCalls: number;
		readonly killed: boolean;
		emit(event: string, value: unknown): void;
	};
}

interface Harness {
	readonly player: Player;
	readonly mpv: FakeMpv;
	readonly reports: PlayerReport[];
	readonly spawns: SpawnedCall[];
	readonly child: ReturnType<typeof fakeChild>;
	readonly target: string;
	readonly attempts: () => number;
}

function createHarness(overrides: Partial<PlayerDeps> = {}): Harness {
	const mpv = new FakeMpv();
	servers.push(mpv);

	const reports: PlayerReport[] = [];
	const spawns: SpawnedCall[] = [];
	const child = fakeChild();
	const env = { XDG_RUNTIME_DIR: root };
	const target = join(root, "pi-streambeats", "mpv.sock");
	let attempts = 0;

	const player = createMpvPlayer({
		platform: "linux",
		env,
		uid: 1000,
		tmpDir: root,
		spawn: (command, args, options) => {
			spawns.push({ command, args, options });
			return child;
		},
		connect: (path) => {
			attempts += 1;
			return net.connect(path);
		},
		resolve: { prefetchable: false, resolve: async (requested) => ({ ok: true, target: { uri: requested.id } }) },
		onReport: (report) => {
			reports.push(report);
		},
		retryMs: 10,
		connectTimeoutMs: 2000,
		replyTimeoutMs: 2000,
		...overrides,
	});

	return { player, mpv, reports, spawns, child, target, attempts: () => attempts };
}

/* --- the tests ------------------------------------------------------------------------------- */

describe("spawning mpv (S6)", { skip: unixSockets }, () => {
	it("runs one mpv as a plain child with an explicit argv, never through a shell", async () => {
		const h = createHarness({ mpvPath: "/opt/mpv/bin/mpv" });
		await h.mpv.listen(h.target);
		await h.player.start();

		assert.equal(h.spawns.length, 1);
		const spawned = h.spawns[0];
		assert.ok(spawned);
		assert.equal(spawned.command, "/opt/mpv/bin/mpv");
		assert.ok(Array.isArray(spawned.args), "argv must be an array, never an interpolated command line");
		assert.deepEqual(spawned.args, ["--idle", "--no-video", "--no-terminal", `--input-ipc-server=${h.target}`]);
		assert.equal(spawned.options.shell, false);
		assert.ok(!("detached" in spawned.options), "mpv must not be detached");
		assert.equal(h.child.unrefCalls, 0, "mpv must not be unref'd: it dies with Pi");
		assert.deepEqual(h.reports, [{ kind: "ready" }]);
	});

	it("creates the socket's own directory before mpv is asked to listen there", async () => {
		const h = createHarness({ retryMs: 5, connectTimeoutMs: 10 });
		await h.player.start();

		assert.deepEqual(readdirSync(dirname(h.target)), [], "the directory exists and is still empty");
	});

	it("applies the session volume as soon as it connects", async () => {
		const h = createHarness({ volume: 70 });
		await h.mpv.listen(h.target);
		await h.player.start();

		assert.deepEqual(h.mpv.commandArgs(0), ["set_property", "volume", 70]);
		assert.deepEqual(h.reports, [{ kind: "ready" }]);
	});
});

describe("the JSON line protocol (S6)", { skip: unixSockets }, () => {
	it("writes one JSON object per line, with a request_id on every command", async () => {
		const h = createHarness();
		await h.mpv.listen(h.target);
		await h.player.play(track);

		assert.ok(h.mpv.commands.length > 0);
		for (const received of h.mpv.commands) {
			assert.equal(typeof received.request_id, "number");
			assert.ok(Array.isArray(received.command));
		}
	});

	it("matches every reply to the request that asked, even when replies arrive out of order", async () => {
		const h = createHarness();
		await h.mpv.listen(h.target);

		const held: { socket: net.Socket; received: Received }[] = [];
		h.mpv.handle = (received, socket) => {
			held.push({ socket, received });
		};

		const first = h.player.command(["get_property", "volume"]);
		const second = h.player.command(["get_property", "pause"]);
		await waitFor(() => held.length === 2);

		const firstHeld = held[0];
		const secondHeld = held[1];
		assert.ok(firstHeld && secondHeld);
		assert.notEqual(firstHeld.received.request_id, secondHeld.received.request_id);

		send(secondHeld.socket, {
			error: "success",
			request_id: secondHeld.received.request_id,
			data: "the second answer",
		});
		send(firstHeld.socket, {
			error: "success",
			request_id: firstHeld.received.request_id,
			data: "the first answer",
		});

		assert.deepEqual(await first, {
			error: "success",
			request_id: firstHeld.received.request_id,
			data: "the first answer",
		});
		assert.deepEqual(await second, {
			error: "success",
			request_id: secondHeld.received.request_id,
			data: "the second answer",
		});
	});

	it("never mistakes a stray reply for the answer to the next request", async () => {
		const h = createHarness();
		await h.mpv.listen(h.target);

		const held: { socket: net.Socket; received: Received }[] = [];
		h.mpv.handle = (received, socket, index) => {
			// Only the first command is held: the two that follow answer normally.
			if (index === 0) {
				held.push({ socket, received });
				return;
			}
			send(socket, { error: "success", request_id: received.request_id });
		};

		const playing = h.player.play(track);
		await waitFor(() => held.length === 1);
		const first = held[0];
		assert.ok(first);

		// A reply nobody can own arrives before the real one, and it must not unblock the request.
		send(first.socket, { error: "success", request_id: first.received.request_id + 500, data: "stray" });
		send(first.socket, { error: "success", request_id: first.received.request_id });
		await playing;

		assert.deepEqual(h.mpv.commandArgs(0), ["loadfile", track.id, "replace"]);
	});
});

describe("what the card asks for (S6, S11)", { skip: unixSockets }, () => {
	it("loads the resolved target with replace, names the title and starts playing", async () => {
		const h = createHarness();
		await h.mpv.listen(h.target);
		await h.player.play(track);

		assert.deepEqual(h.mpv.allCommands(), [
			["loadfile", track.id, "replace"],
			["set_property", "force-media-title", track.title],
			["set_property", "pause", false],
		]);
	});

	it("pauses and resumes through the pause property", async () => {
		const h = createHarness();
		await h.mpv.listen(h.target);
		await h.player.pause();
		await h.player.resume();

		assert.deepEqual(h.mpv.allCommands(), [
			["set_property", "pause", true],
			["set_property", "pause", false],
		]);
	});

	it("sets the volume the card asked for", async () => {
		const h = createHarness();
		await h.mpv.listen(h.target);
		await h.player.setVolume(45);

		assert.deepEqual(h.mpv.allCommands(), [["set_property", "volume", 45]]);
	});

	it("reports a track with no playable target instead of loading garbage", async () => {
		const h = createHarness({
			resolve: { prefetchable: false, resolve: async () => ({ ok: false, failure: "missing" }) },
		});
		await h.mpv.listen(h.target);
		await h.player.play(track);

		assert.deepEqual(h.reports, [
			{ kind: "ready" },
			{ kind: "failed", trackId: track.id, message: `${track.title}: cannot open, skipping` },
		]);
		assert.deepEqual(h.mpv.allCommands(), []);
	});

	it("does not spawn mpv to stop something that never played", async () => {
		const h = createHarness();
		await h.player.stop();

		assert.equal(h.spawns.length, 0);
		assert.deepEqual(h.mpv.commands, []);
	});
});

describe("end-file (S11)", { skip: unixSockets }, () => {
	it("reports a normal end so the caller can advance the queue", async () => {
		const h = createHarness();
		await h.mpv.listen(h.target);
		await h.player.play(track);

		h.mpv.emit({ event: "end-file", reason: "eof" });
		await waitFor(() => h.reports.length === 2);

		assert.deepEqual(h.reports[1], { kind: "ended", trackId: track.id });
	});

	it("reports a failed file with its skip message and keeps playing the rest", async () => {
		const h = createHarness();
		await h.mpv.listen(h.target);
		await h.player.play(track);

		h.mpv.emit({ event: "end-file", reason: "error", error: "loading failed" });
		await waitFor(() => h.reports.length === 2);

		assert.deepEqual(h.reports[1], {
			kind: "failed",
			trackId: track.id,
			message: `${track.title}: cannot open, skipping`,
		});

		const next: Track = { ...track, id: "/music/Chillhop/02 - Dusk.mp3", title: "Dusk" };
		await h.player.play(next);
		assert.deepEqual(h.mpv.commandArgs(3), ["loadfile", next.id, "replace"]);
	});

	it("reports the skip when mpv never answers the loadfile", async () => {
		const h = createHarness({ replyTimeoutMs: 50 });
		await h.mpv.listen(h.target);
		// mpv goes quiet on exactly the command that loads the file, and nothing else will report:
		// without a failure the queue would stop silently (R4-001).
		h.mpv.handle = (received, socket) => {
			if (received.command[0] === "loadfile") return;
			send(socket, { error: "success", request_id: received.request_id });
		};

		await h.player.play(track);
		await waitFor(() => h.reports.length === 2);

		assert.deepEqual(h.reports[1], {
			kind: "failed",
			trackId: track.id,
			message: `${track.title}: cannot open, skipping`,
		});
	});

	it("treats a failing last track as the end of the queue instead of hanging", async () => {
		const h = createHarness();
		await h.mpv.listen(h.target);
		await h.player.play(track);

		h.mpv.emit({ event: "end-file", reason: "error", error: "loading failed" });
		await waitFor(() => h.reports.length === 2);

		// The queue ends in the model, not here: the player stays idle and keeps answering.
		await h.player.stop();
		await h.player.quit();

		await waitFor(() => quitCommands(h) === 1);
		assert.equal(h.reports.length, 2);
		assert.deepEqual(h.mpv.commandArgs(h.mpv.commands.length - 1), ["quit"]);
	});

	it("ignores the end-file its own stop causes", async () => {
		const h = createHarness();
		await h.mpv.listen(h.target);
		await h.player.play(track);
		await h.player.stop();

		h.mpv.emit({ event: "end-file", reason: "stop" });
		await delay(50);

		assert.equal(h.reports.length, 1);
		assert.deepEqual(h.mpv.commandArgs(3), ["stop"]);
	});

	it("ignores an end-file for a file it no longer owns", async () => {
		const h = createHarness();
		await h.mpv.listen(h.target);

		h.mpv.emit({ event: "end-file", reason: "eof" });
		await delay(50);

		assert.deepEqual(h.reports, []);
	});
});

describe("connecting to the socket (S19)", { skip: unixSockets }, () => {
	it("retries until mpv has created the socket", async () => {
		const h = createHarness({ retryMs: 20, connectTimeoutMs: 2000 });

		const started = h.player.start();
		await delay(100);
		await h.mpv.listen(h.target);
		await started;

		assert.ok(h.attempts() >= 2, `expected at least two connect attempts, saw ${h.attempts()}`);
		assert.deepEqual(h.reports, [{ kind: "ready" }]);
	});

	it("gives up after the timeout with a reportable state instead of crashing", async () => {
		const h = createHarness({ retryMs: 5, connectTimeoutMs: 40 });
		await h.player.start();

		const report = h.reports[0];
		assert.equal(report?.kind, "unavailable");
		const message = report?.kind === "unavailable" ? report.message : "";
		assert.ok(message.includes(h.target), `expected the target in "${message}"`);

		// Every later request is a state, not a rejection.
		await h.player.play(track);
		await h.player.quit();
	});

	it("gives up when an attempt never answers instead of hanging on it", async () => {
		let destroyed = 0;
		const h = createHarness({
			retryMs: 5,
			connectTimeoutMs: 40,
			// A peer that accepts the call and then says nothing: the failure mode a pipe can produce.
			connect: () => ({
				write: () => true,
				on: () => undefined,
				destroy: () => {
					destroyed += 1;
				},
			}),
		});

		await h.player.start();

		assert.equal(h.reports[0]?.kind, "unavailable");
		assert.ok(destroyed > 0, "a stuck attempt is destroyed, not leaked");
	});

	it("reports a missing mpv as a state, not as a crash", async () => {
		const h = createHarness({ retryMs: 5, connectTimeoutMs: 60 });

		const started = h.player.start();
		h.child.emit("error", new Error("spawn mpv ENOENT"));
		await started;

		const report = h.reports[0];
		assert.equal(report?.kind, "unavailable");
		assert.ok(report?.kind === "unavailable" && report.message.includes("ENOENT"));
	});

	it("reports the connection closing while it was expected to stay", async () => {
		const h = createHarness();
		await h.mpv.listen(h.target);
		await h.player.start();
		await h.mpv.close();

		await waitFor(() => h.reports.length === 2);
		assert.equal(h.reports[1]?.kind, "unavailable");
	});
});

describe("shutdown (S6)", { skip: unixSockets }, () => {
	it("sends quit and closes the connection", async () => {
		const h = createHarness();
		await h.mpv.listen(h.target);
		await h.player.play(track);
		await h.player.quit();

		await waitFor(() => quitCommands(h) === 1);
		assert.deepEqual(h.mpv.commandArgs(h.mpv.commands.length - 1), ["quit"]);
		await waitFor(() => h.mpv.closed > 0);
		assert.equal(
			h.reports.filter((report) => report.kind === "unavailable").length,
			0,
			"a clean shutdown is not a lost connection",
		);
	});

	it("is a no-op the second time", async () => {
		const h = createHarness();
		await h.mpv.listen(h.target);
		await h.player.start();
		await h.player.quit();
		await waitFor(() => quitCommands(h) === 1);
		await h.player.quit();
		await delay(30);

		assert.equal(quitCommands(h), 1);
	});

	it("does not spawn mpv to quit a player that never started", async () => {
		const h = createHarness();
		await h.player.quit();

		assert.equal(h.spawns.length, 0);
	});
});
/** How many `quit` commands the fake mpv has received: shutdown is a fact on the wire, not a local flag. */
function quitCommands(h: Harness): number {
	return h.mpv.commands.filter((received) => received.command[0] === "quit").length;
}
