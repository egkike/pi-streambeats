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
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	createMpvPlayer,
	discoverMpv,
	type MpvDiscovery,
	type MpvDiscoveryContext,
	type MpvValue,
	mpvKnownLocations,
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

/** The fake mpv process: it records the signals it was sent and can pretend it was already gone. */
type FakeChild = SpawnedProcess & {
	readonly unrefCalls: number;
	/** Every signal this child received, in order: SIGTERM during a shutdown is a fact, not a flag. */
	readonly killSignals: string[];
	/** Set this to make `kill` fail the way it does for a process that is already dead. */
	killError?: Error;
	emit(event: string, value: unknown): void;
};

function fakeChild(): FakeChild {
	const listeners = new Map<string, ((...args: never[]) => void)[]>();
	const child = {
		unrefCalls: 0,
		killSignals: [] as string[],
		killError: undefined as Error | undefined,
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
		kill(signal?: string) {
			child.killSignals.push(signal ?? "SIGTERM");
			if (child.killError) throw child.killError;
			return true;
		},
		emit(event: string, value: unknown) {
			for (const listener of listeners.get(event) ?? []) listener(value as never);
		},
	};
	return child as FakeChild;
}

interface Harness {
	readonly player: Player;
	readonly mpv: FakeMpv;
	readonly reports: PlayerReport[];
	readonly spawns: SpawnedCall[];
	/** Every child the player spawned, in order: a lifecycle test has more than one. */
	readonly children: FakeChild[];
	/** The first child: most tests spawn exactly one. */
	readonly child: FakeChild;
	readonly target: string;
	readonly attempts: () => number;
}

function createHarness(overrides: Partial<PlayerDeps> = {}): Harness {
	const mpv = new FakeMpv();
	servers.push(mpv);

	const reports: PlayerReport[] = [];
	const spawns: SpawnedCall[] = [];
	const children: FakeChild[] = [];
	const env = { XDG_RUNTIME_DIR: root };
	const target = join(root, "pi-streambeats", "mpv.sock");
	let attempts = 0;

	const player = createMpvPlayer({
		platform: "linux",
		env,
		uid: 1000,
		spawn: (command, args, options) => {
			spawns.push({ command, args, options });
			const child = fakeChild();
			children.push(child);
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

	return {
		player,
		mpv,
		reports,
		spawns,
		children,
		get child() {
			return children[0] as FakeChild;
		},
		target,
		attempts: () => attempts,
	};
}

/* --- finding mpv (S6) ----------------------------------------------------------------------- */

interface World {
	readonly ctx: MpvDiscoveryContext;
	/** Every command the resolver really ran, in order: a candidate nobody ran was never tried. */
	readonly runs: string[];
}

/**
 * A world for the pure resolver: the paths that exist, the commands that answer `--version`, and the
 * environment. Nothing here touches the disk and nothing executes a binary — both halves are injected (S9).
 */
function world(options: {
	readonly exists?: readonly string[];
	readonly answers?: readonly string[];
	/** Candidates that exist and never answer: still running when their budget ran out (R4-002). */
	readonly silent?: readonly string[];
	readonly configured?: string;
	readonly platform?: "linux" | "darwin" | "win32";
	readonly path?: string;
}): World {
	const runs: string[] = [];
	return {
		runs,
		ctx: {
			platform: options.platform ?? "linux",
			env: options.path === undefined ? {} : { PATH: options.path },
			configured: options.configured,
			exists: (path) => (options.exists ?? []).includes(path),
			run: (command) => {
				runs.push(command);
				const answers = options.answers ?? [];
				if (answers.includes(command)) return { ok: true };
				if ((options.silent ?? []).includes(command)) return { ok: false, timedOut: true };
				return { ok: false, reason: `${command} printed no version` };
			},
		},
	};
}

/**
 * The inconclusive half of a discovery answer. The shape is asserted instead of cast: a test that assumed it
 * would keep passing if discovery started calling every failure definitive, which is the rule under test here.
 */
function unconfirmed(found: MpvDiscovery): Extract<MpvDiscovery, { ok: false; definitive: false }> {
	if (found.ok || found.definitive) assert.fail("expected a candidate that exists and did not confirm");
	return found;
}

describe("finding mpv (S6)", () => {
	it("lets the path in settings win over PATH and over every known location", () => {
		// The user's own answer is not a hint: it is the answer, so nothing else is even probed.
		const { ctx, runs } = world({
			configured: "/opt/mpv/bin/mpv",
			path: "/usr/local/bin:/usr/bin",
			exists: ["/opt/mpv/bin/mpv", "/usr/local/bin/mpv", "/usr/bin/mpv"],
			answers: ["/opt/mpv/bin/mpv", "/usr/local/bin/mpv", "/usr/bin/mpv"],
		});

		assert.deepEqual(discoverMpv(ctx), { ok: true, command: "/opt/mpv/bin/mpv" });
		assert.deepEqual(runs, ["/opt/mpv/bin/mpv"]);
	});

	it("prefers PATH over a known location", () => {
		const { ctx } = world({
			path: "/usr/local/sbin:/opt/bin",
			exists: ["/opt/bin/mpv", "/usr/bin/mpv"],
			answers: ["/opt/bin/mpv", "/usr/bin/mpv"],
		});

		assert.deepEqual(discoverMpv(ctx), { ok: true, command: "/opt/bin/mpv" });
	});

	it("finds a known location when PATH has nothing", () => {
		const { ctx } = world({
			path: "/usr/local/bin:/opt/bin:nothing-here",
			exists: ["/usr/bin/mpv"],
			answers: ["/usr/bin/mpv"],
		});

		assert.deepEqual(discoverMpv(ctx), { ok: true, command: "/usr/bin/mpv" });
	});

	it("returns the command it confirmed by running it, not merely the one that exists", () => {
		const { ctx, runs } = world({ path: "/opt/bin", exists: ["/opt/bin/mpv"], answers: ["/opt/bin/mpv"] });

		const found = discoverMpv(ctx);

		assert.equal(found.ok, true);
		assert.deepEqual(runs, found.ok ? [found.command] : [], "the answer is the binary that answered --version");
	});

	it("turns a candidate that exists but does not answer into the failure state, never into the next candidate", () => {
		// S6: detection may not announce success until the binary answers a real run. A silent fallback would
		// announce a working mpv when the one the user pointed at is broken.
		const { ctx, runs } = world({
			configured: "/opt/mpv/bin/mpv",
			exists: ["/opt/mpv/bin/mpv", "/usr/bin/mpv"],
			answers: ["/usr/bin/mpv"],
		});

		const found = discoverMpv(ctx);

		assert.equal(found.ok, false);
		assert.match(found.ok ? "" : found.message, /\/opt\/mpv\/bin\/mpv/, "the failure names the binary that failed");
		assert.deepEqual(runs, ["/opt/mpv/bin/mpv"], "the working candidate is never tried behind the user's back");
	});

	it("does not walk past a broken candidate on PATH either", () => {
		const { ctx, runs } = world({
			path: "/opt/bin:/usr/bin",
			exists: ["/opt/bin/mpv", "/usr/bin/mpv"],
			answers: ["/usr/bin/mpv"],
		});

		const found = discoverMpv(ctx);

		assert.equal(found.ok, false);
		assert.match(found.ok ? "" : found.message, /\/opt\/bin\/mpv/);
		assert.deepEqual(runs, ["/opt/bin/mpv"]);
	});

	it("names the configured path that is not there instead of quietly ignoring the setting", () => {
		const { ctx, runs } = world({
			configured: "/nowhere/mpv",
			exists: ["/usr/bin/mpv"],
			answers: ["/usr/bin/mpv"],
		});

		const found = discoverMpv(ctx);

		assert.equal(found.ok, false);
		assert.match(found.ok ? "" : found.message, /\/nowhere\/mpv/);
		assert.deepEqual(runs, [], "nothing was run, so nothing may announce success");
	});

	it("reports an mpv that is nowhere as a reachable failure that names where it looked", () => {
		const { ctx } = world({ path: "/opt/bin" });

		const found = discoverMpv(ctx);

		assert.equal(found.ok, false);
		const message = found.ok ? "" : found.message;
		assert.match(message, /mpv/);
		assert.match(message, /PATH/, "the message says what was searched, so the user can act on it");
	});

	it("keeps Windows' own names: mpv.exe, a semicolon PATH and the path the installer really uses", () => {
		// Verified on Windows 11 (L15): `winget install shinchiro.mpv` leaves the binary in Program Files and
		// out of PATH, so the known location is the one that makes discovery work there.
		const installed = "C:\\Program Files\\MPV Player\\mpv.exe";
		const fromPath = world({
			platform: "win32",
			path: "C:\\Tools;C:\\Other",
			exists: ["C:\\Other\\mpv.exe"],
			answers: ["C:\\Other\\mpv.exe"],
		});
		assert.deepEqual(discoverMpv(fromPath.ctx), { ok: true, command: "C:\\Other\\mpv.exe" });

		const bare = world({ platform: "win32", exists: [installed], answers: [installed] });
		assert.deepEqual(discoverMpv(bare.ctx), { ok: true, command: installed });
	});

	it("finds Homebrew's mpv on macOS, where nothing installs into /usr/bin", () => {
		const homebrew = "/opt/homebrew/bin/mpv";
		const { ctx } = world({ platform: "darwin", exists: [homebrew], answers: [homebrew] });

		assert.deepEqual(discoverMpv(ctx), { ok: true, command: homebrew });
	});

	it("refuses a configured value that is not absolute instead of resolving it against the launch directory (R3-002)", () => {
		// The same settings file confirmed a different binary depending on where Pi was started, so a
		// relative value is not something to complete for the user: it is a setting they have to fix.
		const { ctx, runs } = world({
			configured: "bin/mpv",
			path: "/usr/local/bin",
			exists: ["bin/mpv", "/usr/local/bin/mpv"],
			answers: ["bin/mpv", "/usr/local/bin/mpv"],
		});

		const found = discoverMpv(ctx);

		assert.equal(found.ok, false);
		assert.equal(found.ok ? undefined : found.definitive, true, "nothing can be spawned, so it is definitive");
		assert.match(found.ok ? "" : found.message, /mpvPath/, "the message names the setting");
		assert.match(found.ok ? "" : found.message, /bin\/mpv/, "and the value it holds");
		assert.deepEqual(runs, [], "a relative setting is not a reason to ask PATH behind the user's back");
	});

	it("resolves a configured bare command name through PATH instead of refusing it (R4-001)", () => {
		// A bare name is not a relative path: PATH is exactly the answer to "where do my commands live", and it
		// cannot resolve against Pi's launch directory. Refusing it would stop playback for a setting that says
		// what it means.
		const { ctx, runs } = world({
			configured: "mpv-beta",
			path: "/usr/local/bin",
			exists: ["/usr/local/bin/mpv-beta"],
			answers: ["mpv-beta"],
		});

		assert.deepEqual(discoverMpv(ctx), { ok: true, command: "mpv-beta" });
		assert.deepEqual(runs, ["mpv-beta"], "confirmed by name, so PATH is what resolved it");
	});

	it("validates absoluteness in the platform's own path flavour (R3-002)", () => {
		// `C:\...` is absolute to Windows and relative to POSIX, so one shared flavour would be wrong in one
		// of the two places, and this project has to run on both.
		const windowsPath = "C:\\Tools\\mpv.exe";
		const onWindows = world({
			platform: "win32",
			configured: windowsPath,
			exists: [windowsPath],
			answers: [windowsPath],
		});
		assert.deepEqual(discoverMpv(onWindows.ctx), { ok: true, command: windowsPath });

		const onLinux = world({
			platform: "linux",
			configured: windowsPath,
			exists: [windowsPath],
			answers: [windowsPath],
		});
		const found = discoverMpv(onLinux.ctx);
		assert.equal(found.ok, false);
		assert.equal(found.ok ? undefined : found.definitive, true);
		assert.deepEqual(onLinux.runs, [], "a Windows path is not a path this platform can run");
	});

	it("tells a candidate that never answered apart from one that answered with an error (R4-002)", () => {
		// A binary still running at the ceiling may be a slow disk or a cold cache, not a broken install:
		// one sentence for both causes would report a working mpv as a failure.
		const silent = world({
			configured: "/opt/mpv/bin/mpv",
			exists: ["/opt/mpv/bin/mpv"],
			silent: ["/opt/mpv/bin/mpv"],
		});
		const broken = world({ configured: "/opt/mpv/bin/mpv", exists: ["/opt/mpv/bin/mpv"] });

		const timedOut = unconfirmed(discoverMpv(silent.ctx));
		const answeredBadly = unconfirmed(discoverMpv(broken.ctx));

		assert.notEqual(timedOut.message, "", "a candidate that never answers is still a state to show");
		assert.notEqual(timedOut.message, answeredBadly.message, "two different causes never share one sentence");
		assert.equal(timedOut.cause, "timeout", "the difference is data, not only prose");
		assert.equal(answeredBadly.cause, "error");
		assert.match(timedOut.message, /within 2 s/, "a timeout is named as a timeout");
		assert.doesNotMatch(answeredBadly.message, /within 2 s/, "an answer that came back is not a timeout");
		for (const message of [timedOut.message, answeredBadly.message]) {
			assert.match(message, /could not be confirmed/, "both say only what is true: it did not confirm");
			assert.doesNotMatch(message, /unavailable|not found/i, "neither claims the binary is unavailable");
		}
		// Inconclusive, not definitive: the candidate exists, so the player still tries it (R4-002).
		assert.equal(timedOut.command, "/opt/mpv/bin/mpv", "the command to try is part of the answer");
		assert.equal(answeredBadly.command, "/opt/mpv/bin/mpv");
	});

	it("claims only the locations this project can defend, and no package manager's guess", () => {
		// Locking the lists down is the point: a candidate is a claim about where a binary lives, and an
		// invented scoop/chocolatey path would send the user to a directory that never had mpv in it.
		assert.deepEqual(mpvKnownLocations("linux"), ["/usr/bin/mpv", "/usr/local/bin/mpv"]);
		assert.deepEqual(mpvKnownLocations("darwin"), ["/opt/homebrew/bin/mpv", "/usr/local/bin/mpv"]);
		assert.deepEqual(mpvKnownLocations("win32"), ["C:\\Program Files\\MPV Player\\mpv.exe"]);

		const all = [...mpvKnownLocations("linux"), ...mpvKnownLocations("darwin"), ...mpvKnownLocations("win32")];
		assert.equal(
			all.some((location) => /scoop|chocolatey|choco/i.test(location)),
			false,
			"nobody documented those layouts, so no candidate may name them",
		);
	});
});

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

		const dir = dirname(h.target);
		assert.deepEqual(readdirSync(dir), [], "the directory exists and is still empty");
		assert.equal(statSync(dir).mode & 0o777, 0o700, "the socket lives in a private directory (R1-001)");
	});

	it("applies the session volume as soon as it connects", async () => {
		const h = createHarness({ volume: 70 });
		await h.mpv.listen(h.target);
		await h.player.start();

		assert.deepEqual(h.mpv.commandArgs(0), ["set_property", "volume", 70]);
		assert.deepEqual(h.reports, [{ kind: "ready" }]);
	});
});

describe("what discovery hands the player (S6, R4-002, R4-003)", { skip: unixSockets }, () => {
	const refusal =
		"mpv was not found: no mpv on PATH and none of /usr/bin/mpv, /usr/local/bin/mpv exists — install mpv or set mpvPath in settings.json";

	it("enforces a refusal: the play path reports it and never spawns", async () => {
		// R4-003: announced and enforced have to be the same fact. A refusal that only printed a notice would
		// hand the bare name back to PATH, which is the binary nobody confirmed.
		const h = createHarness({ mpvPath: "bin/mpv", refusal });
		await h.player.play(track);

		assert.deepEqual(h.spawns, [], "a definitive failure spawns nothing at all");
		assert.deepEqual(h.reports, [{ kind: "unavailable", message: refusal }], "and the play path says why");
	});

	it("still tries an inconclusive candidate instead of refusing it", async () => {
		// The other half of the triangulation: without it, the fix above could be satisfied by never spawning.
		// R4-002: the candidate exists and did not confirm, so it is worth the one attempt it asks for.
		const h = createHarness({ mpvPath: "/opt/mpv/bin/mpv" });
		await h.mpv.listen(h.target);

		await h.player.play(track);

		assert.equal(h.spawns.length, 1, "an unconfirmed candidate is not a refusal");
		assert.equal(h.spawns[0]?.command, "/opt/mpv/bin/mpv", "and it is the candidate the user pointed at");
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

describe("file-loaded (S12)", { skip: unixSockets }, () => {
	it("asks mpv for the duration once the file is loaded and reports it with its track", async () => {
		const h = createHarness();
		await h.mpv.listen(h.target);
		h.mpv.handle = (received, socket) => {
			const data = received.command[1] === "duration" ? 245.4 : undefined;
			send(
				socket,
				data === undefined
					? { error: "success", request_id: received.request_id }
					: { error: "success", request_id: received.request_id, data },
			);
		};

		await h.player.play(track);
		// The `loadfile` reply is not a load fact: it lands before the file is decodable and
		// `duration` is still unavailable then, which is how the real card ended up saying `--:--`.
		assert.deepEqual(
			h.mpv.allCommands().filter((command) => command[0] === "get_property"),
			[],
			"nothing is asked before mpv says the file is loaded",
		);

		h.mpv.emit({ event: "file-loaded" });
		await waitFor(() => h.reports.length === 2);

		assert.ok(
			h.mpv.allCommands().some((command) => command[0] === "get_property" && command[1] === "duration"),
			"the loaded file is where the total comes from",
		);
		assert.deepEqual(h.reports[1], { kind: "duration", trackId: track.id, durationMs: 245_400 });
	});

	it("reports nothing when the loaded file belongs to no track of ours", async () => {
		const h = createHarness();
		await h.mpv.listen(h.target);
		await h.player.play(track);
		await h.player.stop();

		// Our own stop forgets the track on purpose, so the load that follows is not about anything.
		h.mpv.emit({ event: "file-loaded" });
		await delay(50);

		assert.deepEqual(h.reports, [{ kind: "ready" }]);
		assert.deepEqual(
			h.mpv.allCommands().filter((command) => command[0] === "get_property"),
			[],
			"a stopped player does not ask for a total it would have nowhere to put",
		);
	});

	it("drops a duration answered for a track that was replaced meanwhile", async () => {
		const h = createHarness();
		await h.mpv.listen(h.target);
		const held: { socket: net.Socket; requestId: number }[] = [];
		h.mpv.handle = (received, socket) => {
			if (received.command[0] === "get_property") {
				held.push({ socket, requestId: received.request_id });
				return;
			}
			send(socket, { error: "success", request_id: received.request_id });
		};

		await h.player.play(track);
		h.mpv.emit({ event: "file-loaded" });
		await waitFor(() => held.length === 1);

		// Another track takes over before mpv answers: that total describes the one already gone.
		const next: Track = { ...track, id: "/music/Chillhop/02 - Dusk.mp3", title: "Dusk" };
		await h.player.play(next);
		const first = held[0];
		assert.ok(first);
		send(first.socket, { error: "success", request_id: first.requestId, data: 2 });
		await delay(50);

		assert.deepEqual(h.reports, [{ kind: "ready" }]);
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
		assert.deepEqual(h.children[0]?.killSignals, ["SIGTERM"], "giving up terminates the mpv it could never reach");

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
		// The single retry (R4-005) spends the connect budget before the loss becomes terminal.
		const h = createHarness({ retryMs: 5, connectTimeoutMs: 40 });
		await h.mpv.listen(h.target);
		await h.player.start();
		await h.mpv.close();

		await waitFor(() => h.reports.length === 2);
		assert.equal(h.reports[1]?.kind, "unavailable");
	});
});

describe("the socket directory (R1-001)", { skip: unixSockets }, () => {
	it("never reuses a socket directory that points somewhere else", async () => {
		const h = createHarness({ retryMs: 5, connectTimeoutMs: 20 });
		const elsewhere = join(root, "elsewhere");
		mkdirSync(elsewhere, { mode: 0o700 });
		symlinkSync(elsewhere, dirname(h.target));

		await h.player.start();

		assert.equal(h.reports[0]?.kind, "unavailable");
		assert.equal(h.spawns.length, 0, "a socket we cannot trust is not worth an mpv process");
	});
});

describe("shutdown during startup (R4-004)", { skip: unixSockets }, () => {
	it("sends SIGTERM to the child it spawned when quit lands before the socket connects", async () => {
		// No server: the connect keeps retrying, which is the window where a quit used to leak mpv.
		const h = createHarness({ retryMs: 10, connectTimeoutMs: 2000 });

		const started = h.player.start();
		await delay(30);
		await h.player.quit();
		await started;

		assert.equal(h.spawns.length, 1);
		assert.deepEqual(h.children[0]?.killSignals, ["SIGTERM"]);
		await delay(50);
		assert.deepEqual(h.reports, [], "a shutdown is not a lost connection");
	});

	it("tolerates a child that is already gone, without waiting for it", async () => {
		const h = createHarness({ retryMs: 10, connectTimeoutMs: 2000 });

		const started = h.player.start();
		await delay(10);
		const child = h.children[0];
		assert.ok(child);
		child.killError = new Error("ESRCH: no such process");

		await h.player.quit();
		await started;

		assert.deepEqual(child.killSignals, ["SIGTERM"]);
		assert.deepEqual(h.reports, []);
	});
});

describe("the lifecycle the review found half-closed (T9a)", { skip: unixSockets }, () => {
	it("kills the child when the shutdown arrives, not when the connect budget ends (R4-003)", async () => {
		// Nobody listens: the connect loop would keep trying for two seconds on its own.
		const h = createHarness({ retryMs: 10, connectTimeoutMs: 2000 });
		const started = h.player.start();
		await delay(20);
		const child = h.children[0];
		assert.ok(child);

		const began = Date.now();
		await h.player.quit();

		assert.deepEqual(child.killSignals, ["SIGTERM"], "the child dies with the shutdown, not with the budget");
		assert.ok(Date.now() - began < 1000, "and it does not wait for the remaining budget");
		await started;
		assert.deepEqual(h.reports, [], "a shutdown is not a lost connection");
	});

	it("restores the session volume on the replacement mpv (R4-002)", async () => {
		const h = createHarness({ retryMs: 10, connectTimeoutMs: 2000 });
		await h.mpv.listen(h.target);
		await h.player.start();
		await h.player.setVolume(33);

		await h.mpv.close();
		await h.mpv.listen(h.target);
		await waitFor(() => h.reports.length === 2);

		const volumes = h.mpv.allCommands().filter((command) => command[0] === "set_property" && command[1] === "volume");
		assert.deepEqual(volumes.at(-1), ["set_property", "volume", 33], "the replacement knows the level");
	});
});

describe("a lost connection (R4-005)", { skip: unixSockets }, () => {
	it("gets one retry: the player is usable again without a new player", async () => {
		const h = createHarness({ retryMs: 10, connectTimeoutMs: 2000 });
		await h.mpv.listen(h.target);
		await h.player.start();
		await h.player.play(track);
		assert.deepEqual(h.reports, [{ kind: "ready" }]);

		// mpv dies; a replacement mpv creates the same socket again, which is what the retry connects to.
		await h.mpv.close();
		await h.mpv.listen(h.target);

		await waitFor(() => h.reports.length === 2);
		assert.deepEqual(h.reports[1], { kind: "ready" }, "the recovered player says so");
		assert.equal(h.spawns.length, 2, "the retry spawns a replacement mpv");
		assert.deepEqual(h.children[0]?.killSignals, ["SIGTERM"], "the unreachable child is terminated, not orphaned");

		// The lost track is not invented as `failed` here: resyncing the model is the host's call (T9b).
		assert.equal(h.reports.length, 2, "no fabricated end or failure for the track the crash took");

		const next: Track = { ...track, id: "/music/Chillhop/02 - Dusk.mp3", title: "Dusk" };
		await h.player.play(next);
		assert.deepEqual(h.mpv.commandArgs(3), ["loadfile", next.id, "replace"], "the recovered player still plays");
	});

	it("is terminal the second time: one reportable unavailable, no retry loop", async () => {
		const h = createHarness({ retryMs: 5, connectTimeoutMs: 40 });
		await h.mpv.listen(h.target);
		await h.player.start();

		await h.mpv.close();
		await h.mpv.listen(h.target);
		await waitFor(() => h.reports.length === 2);
		assert.equal(h.reports[1]?.kind, "ready");

		await h.mpv.close();
		await waitFor(() => h.reports.length === 3);
		assert.equal(h.reports[2]?.kind, "unavailable");

		await delay(120);
		assert.equal(h.spawns.length, 2, "exactly one retry per session: the second loss spawns nothing");
		assert.deepEqual(h.children[1]?.killSignals, ["SIGTERM"], "giving up does not leave the unreachable child running");

		// The host acts on that report by recreating the player (S6's `r` key): every later call answers.
		await h.player.play(track);
		await h.player.quit();
		assert.equal(h.reports.length, 3);
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
