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
	diskProbe,
	exitProbe,
	type MpvDiscovery,
	type MpvDiscoveryContext,
	type MpvProbe,
	type MpvValue,
	mpvKnownLocations,
	neverStarted,
	type Player,
	type PlayerDeps,
	type PlayerReport,
	type SpawnError,
	type SpawnedProcess,
	type SpawnOptions,
	spawnErrorProbe,
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
	/** Candidates the OS never executed — `ENOENT`, a directory, no execute bit — so nothing answered (T41). */
	readonly unstartable?: readonly string[];
	/** Candidates that ran and whose answer was lost — `ENOBUFS` past `maxBuffer` — so nothing came back (T42). */
	readonly lostAnswer?: readonly string[];
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
				if ((options.unstartable ?? []).includes(command)) {
					return { ok: false, started: false, reason: `spawn ${command} ENOENT` };
				}
				if ((options.lostAnswer ?? []).includes(command)) {
					return { ok: false, started: true, answered: false, reason: `spawnSync ENOBUFS: ${command} ran` };
				}
				return { ok: false, started: true, answered: true, reason: `${command} printed no version` };
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

/** The arm of a probe that says the child ran. Asserted, not cast, so a shape regression fails here. */
function ran(probe: MpvProbe): Extract<MpvProbe, { started: true }> {
	if (probe.ok || probe.timedOut === true || probe.started === false) assert.fail("expected a run that started");
	return probe;
}

/**
 * A resolver context that hands back one probe, so the sentence the card prints for a fact is reachable here
 * without executing a binary (S9): the run is the value, not a spawn.
 */
function probeContext(probe: MpvProbe): MpvDiscoveryContext {
	return {
		platform: "linux",
		env: {},
		configured: "/opt/mpv/bin/mpv",
		exists: () => true,
		run: () => probe,
	};
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
		for (const configured of ["bin/mpv", "./mpv"]) {
			const { ctx, runs } = world({
				configured,
				path: "/usr/local/bin",
				exists: [configured, "/usr/local/bin/mpv"],
				answers: [configured, "/usr/local/bin/mpv"],
			});

			const found = discoverMpv(ctx);

			assert.equal(found.ok, false, `${configured} is not a bare name`);
			assert.equal(found.ok ? undefined : found.definitive, true, "nothing can be spawned, so it is definitive");
			assert.match(found.ok ? "" : found.message, /mpvPath/, "the message names the setting");
			assert.ok((found.ok ? "" : found.message).includes(configured), "and the value it holds");
			assert.deepEqual(runs, [], "a relative setting is not a reason to ask PATH behind the user's back");
		}
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

	it("refuses a drive-relative configured value on both flavours, because it is not a bare name (R3-002, T41)", () => {
		// `C:mpv.exe` carries no separator, so a bare-name test let it through and confirmed it through PATH:
		// Windows resolves it against the current directory **of drive C:**, which is the cwd dependence R3-002
		// forbids. It is not absolute in either flavour, so neither platform may hand it to a child.
		const onWindows = world({
			platform: "win32",
			configured: "C:mpv.exe",
			path: "C:\\Tools",
			exists: ["C:mpv.exe", "C:\\Tools\\mpv.exe"],
			answers: ["C:mpv.exe", "C:\\Tools\\mpv.exe"],
		});
		const onLinux = world({
			platform: "linux",
			configured: "C:mpv.exe",
			path: "/usr/local/bin",
			exists: ["C:mpv.exe", "/usr/local/bin/mpv"],
			answers: ["C:mpv.exe", "/usr/local/bin/mpv"],
		});

		const cases = [
			{ flavour: "win32", found: discoverMpv(onWindows.ctx), runs: onWindows.runs },
			{ flavour: "linux", found: discoverMpv(onLinux.ctx), runs: onLinux.runs },
		];
		for (const { flavour, found, runs } of cases) {
			assert.equal(found.ok, false, `${flavour} must refuse a drive-relative value`);
			assert.equal(found.ok ? undefined : found.definitive, true, "nothing can be spawned, so it is definitive");
			assert.match(found.ok ? "" : found.message, /mpvPath/, "the message names the setting");
			assert.ok((found.ok ? "" : found.message).includes("C:mpv.exe"), "and the value it holds");
			assert.deepEqual(runs, [], "a drive-relative setting is not a command name PATH may answer for");
		}
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

	it("never says a binary answered when the OS never executed it (R4-002, T41)", () => {
		// `ENOENT` for a bare name installed nowhere and a file without the execute bit are one fact for the OS:
		// it never started the process. Something that never started answered nothing, so the sentence may not
		// report an answer — even though the consequence is the same one an error has.
		const unstarted = world({
			configured: "/opt/mpv/bin/mpv",
			exists: ["/opt/mpv/bin/mpv"],
			unstartable: ["/opt/mpv/bin/mpv"],
		});
		const answered = world({ configured: "/opt/mpv/bin/mpv", exists: ["/opt/mpv/bin/mpv"] });

		const neverRan = unconfirmed(discoverMpv(unstarted.ctx));
		const answeredBadly = unconfirmed(discoverMpv(answered.ctx));

		assert.notEqual(neverRan.message, answeredBadly.message, "two different facts never share one sentence");
		assert.doesNotMatch(neverRan.message, /answered --version with an error/, "nothing answered anything");
		assert.match(neverRan.message, /could not be started/, "and the sentence says what did happen");
		assert.match(neverRan.message, /never answered/, "the only answer it may report is that there was none");
		assert.match(answeredBadly.message, /answered --version with an error/);
		assert.match(answeredBadly.message, /printed no version/, "the answer's own words travel with the failure");
		// The consequence is the unconfirmed one for both, so the cause stays what it was: this is prose, not a
		// third state nobody can act on differently.
		assert.equal(neverRan.cause, "error");
		assert.equal(neverRan.command, "/opt/mpv/bin/mpv", "and the player still gets the candidate to try");
	});

	it("does not report a start failure for an error only a running child can produce (R4-002, T42)", () => {
		// `ENOBUFS` is what `spawnSync` reports when the child's output passed `maxBuffer`, and passing it requires
		// the child to exist: the binary ran and its answer was lost. That is neither "never started" nor
		// "answered with an error", and collapsing it into either puts words in the mouth of a process we could
		// not hear — the same false claim R4-002 closed for the timeout, in the opposite direction.
		const lost = unconfirmed(
			discoverMpv(
				world({
					configured: "/opt/mpv/bin/mpv",
					exists: ["/opt/mpv/bin/mpv"],
					lostAnswer: ["/opt/mpv/bin/mpv"],
				}).ctx,
			),
		);

		assert.doesNotMatch(lost.message, /could not be started/, "it did start, so the OS did not refuse it");
		assert.doesNotMatch(lost.message, /never answered/, "saying it never answered is the same false claim");
		assert.doesNotMatch(lost.message, /answered --version with an error/, "no answer reached us, so none is reported");
		assert.match(lost.message, /ran --version/, "the sentence names the run that did happen");
		assert.match(lost.message, /ENOBUFS/, "the reason travels with it, so the loss is not invented");
		assert.match(lost.message, /could not be confirmed/, "the consequence is still only that it did not confirm");

		// Triangulation: a lost answer is not the budget running out and not the OS refusing to execute, so the
		// fix cannot be satisfied by collapsing every error into one branch or by reusing the timeout's words.
		const silent = unconfirmed(
			discoverMpv(
				world({ configured: "/opt/mpv/bin/mpv", exists: ["/opt/mpv/bin/mpv"], silent: ["/opt/mpv/bin/mpv"] }).ctx,
			),
		);
		const unstarted = unconfirmed(
			discoverMpv(
				world({ configured: "/opt/mpv/bin/mpv", exists: ["/opt/mpv/bin/mpv"], unstartable: ["/opt/mpv/bin/mpv"] }).ctx,
			),
		);
		assert.equal(silent.cause, "timeout", "ETIMEDOUT is still its own fact");
		assert.match(silent.message, /within 2 s/, "and keeps its own sentence");
		assert.equal(new Set([lost.message, silent.message, unstarted.message]).size, 3, "three facts, three sentences");
	});

	it("treats only the codes that prove the OS never executed the command as a start failure (R4-002, T42)", () => {
		// Every one of these is refused before a child exists: no such file, no execute bit, a directory, a path
		// through a non-directory, a symlink loop, and a file the kernel will not load. The OS executed nothing,
		// so nothing answered, and the sentence may say exactly that.
		for (const code of ["ENOENT", "EACCES", "EISDIR", "ENOTDIR", "ELOOP", "ENOEXEC"]) {
			assert.equal(neverStarted(code), true, `${code} means the OS never executed the command`);
		}
		// The honest side: an error a running child can produce, one this project has never classified, and a
		// missing code are all not proof that nothing started, so none of them may become a start failure.
		for (const code of ["ENOBUFS", "ETIMEDOUT", "ERR_INVALID_ARG_VALUE", "", undefined]) {
			assert.equal(neverStarted(code), false, `${String(code)} is not proof the command never ran`);
		}
	});

	it("reads every `spawnSync` error through that mapping, so the list and the fact cannot drift (R4-002, T42)", () => {
		// The defect was the wiring, not the list: every error but `ETIMEDOUT` was turned into `started: false`.
		// These assertions run the production interpretation, so no binary and no disk are involved (S9).
		assert.deepEqual(spawnErrorProbe({ code: "ENOENT", message: "no such file" }), {
			ok: false,
			started: false,
			reason: "no such file",
		});
		assert.deepEqual(spawnErrorProbe({ code: "ENOBUFS", message: "output was too large" }), {
			ok: false,
			started: true,
			answered: false,
			reason: "output was too large",
		});
		// `ETIMEDOUT` keeps exactly the shape it had: the budget is not a refusal and not a lost answer.
		assert.deepEqual(spawnErrorProbe({ code: "ETIMEDOUT", message: "timed out" }), { ok: false, timedOut: true });
		// An error nobody classified, and one with no code at all, land on the same honest side: it may have run.
		const unknowns: readonly SpawnError[] = [
			{ message: "unknown" },
			{ code: "", message: "empty code" },
			{ code: "EWHATEVER", message: "unknown" },
		];
		for (const error of unknowns) {
			assert.deepEqual(
				spawnErrorProbe(error),
				{ ok: false, started: true, answered: false, reason: error.message },
				`${JSON.stringify(error)} is not a start failure`,
			);
		}
	});

	it("maps a `--version` run's exit through one pure function, so the sentence cannot drift from the fact (S6, T43)", () => {
		// Extraction, same facts as before: status, signal and the child's own words in; the probe out. Pure, so
		// every case below is reachable from a platform that executes nothing (S9), and `diskProbe` has no second
		// reading of the same result to drift away from this one.
		assert.deepEqual(exitProbe(0, null), { ok: true }, "exit 0 is the answer that confirms the binary");
		assert.deepEqual(
			exitProbe(2, null),
			{ ok: false, started: true, answered: true, reason: "exit 2" },
			"a clean non-zero exit did answer: it answered with an error",
		);
		// Pinned on purpose. Marking every exit unanswered would satisfy the defect below and be false here.
		assert.deepEqual(
			exitProbe(2, null, "  bad option: --frobnicate\n"),
			{ ok: false, started: true, answered: true, reason: "exit 2: bad option: --frobnicate" },
			"the child's own words still travel with a non-zero exit, exactly as they did",
		);

		const answeredBadly = unconfirmed(discoverMpv(probeContext(exitProbe(2, null))));
		assert.match(
			answeredBadly.message,
			/answered --version with an error \(exit 2\)/,
			"and the sentence printed for a non-zero exit is the one it printed before the fix",
		);
	});

	it("never reports an answer for a `--version` run a signal killed (S6, R4-002, T43)", () => {
		// A child killed by a signal exits with `status === null` AND no `result.error`, so the error mapping is
		// never consulted. The run fell into the answered branch and printed "answered --version with an error (no
		// exit code)" about a process that was killed mid-sentence — the same false claim ENOBUFS made, and the
		// reason it has to be a fact and not a guess: nothing answered, so nothing may be reported as answered.
		const found = unconfirmed(discoverMpv(probeContext(exitProbe(null, "SIGKILL"))));

		assert.doesNotMatch(found.message, /answered --version with an error/, "nothing answered: it was killed");
		assert.match(found.message, /ran --version/, "the child did run, so the sentence may say so");
		assert.match(found.message, /killed by SIGKILL/, "the reason names the signal that ended it");
		assert.equal(found.cause, "error", "the consequence is the same inconclusive one: it will still be tried");
		assert.equal(found.command, "/opt/mpv/bin/mpv", "and the player still gets the candidate to try");

		const probe = ran(exitProbe(null, "SIGKILL"));
		assert.equal(probe.answered, false, "a run with no exit status produced no answer fact");
	});

	it("says plainly when a run ended with neither an exit code nor a signal name (S6, T43)", () => {
		// The honest version of the same branch: `status: null` with no signal name proves only that no exit
		// status arrived. A sentence that invented a cause here would be the same defect with better manners.
		const found = unconfirmed(discoverMpv(probeContext(exitProbe(null, null))));

		assert.doesNotMatch(found.message, /answered --version with an error/, "no answer reached us, so none is reported");
		assert.match(found.message, /no exit code and no signal/, "the reason says what is known and stops there");
		assert.doesNotMatch(found.message, /SIG[A-Z]+/, "no signal is named, because none was reported");

		const probe = ran(exitProbe(null, null));
		assert.equal(probe.answered, false, "no signal name does not turn a missing answer into one");
	});

	it("keeps the four facts as four sentences, with the timeout and the never-started arms untouched (S6, T43)", () => {
		// Triangulation for the fix above: a killed run is neither the budget running out nor the OS refusing to
		// execute it, so the fix cannot be satisfied by collapsing every failure into one arm, and it may not add
		// a fifth sentence for a fact the resolver already knew how to print.
		const answered = unconfirmed(discoverMpv(probeContext(exitProbe(2, null))));
		const killed = unconfirmed(discoverMpv(probeContext(exitProbe(null, "SIGTERM"))));
		const silent = unconfirmed(discoverMpv(probeContext({ ok: false, timedOut: true })));
		const unstarted = unconfirmed(discoverMpv(probeContext({ ok: false, started: false, reason: "spawn mpv ENOENT" })));

		assert.equal(
			new Set([answered.message, killed.message, silent.message, unstarted.message]).size,
			4,
			"four facts, four sentences",
		);
		assert.equal(silent.cause, "timeout", "ETIMEDOUT is still its own fact");
		assert.match(silent.message, /within 2 s/, "and keeps its own sentence");
		assert.match(unstarted.message, /could not be started/, "and the OS refusing to execute keeps its own");
		assert.doesNotMatch(killed.message, /within 2 s/, "a kill is not the budget running out");
		assert.doesNotMatch(killed.message, /could not be started/, "and the child did run");
		assert.notEqual(
			ran(exitProbe(null, "SIGTERM")).reason,
			ran(exitProbe(null, null)).reason,
			"signal or no signal is a fact, so it is not one reason",
		);
	});

	it("covers the arm where `spawnSync` itself throws: no child was created, so nothing started (R3-002)", () => {
		// `spawnSync` throws before it forks — an argument it refuses, an options object it cannot read — so that
		// arm is a start failure by construction: there is no child that could have answered. It is reached here
		// with a command Node refuses to spawn, which covers the real production arm with no binary and no disk
		// (S9) instead of believing a description of it.
		const probe = diskProbe.run(`mpv${"\u0000"}--version`);
		if (probe.ok || probe.timedOut === true) assert.fail("a refused argument is a failure, not a timeout");
		assert.equal(probe.started, false, "nothing was executed, so nothing started");
		assert.match(probe.reason, /null bytes/i, "the refusal is the OS-level reason nothing ran");

		// And the sentence that fact produces never claims an answer: the same probe the composition root
		// would have received goes through the resolver.
		const found = unconfirmed(
			discoverMpv({
				platform: "linux",
				env: {},
				configured: "/opt/mpv/bin/mpv",
				exists: () => true,
				run: () => probe,
			}),
		);
		assert.match(found.message, /could not be started/);
		assert.doesNotMatch(found.message, /answered --version with an error/, "nothing answered anything");
	});

	it("says where a bare configured name came from without claiming it was found (T41)", () => {
		// A bare name reaches the run without any `exists()` check — PATH is what resolves it, so nothing was
		// searched for a file. Only the setting supplied this value, and a message claiming a found candidate
		// would announce one that was never looked for.
		const { ctx } = world({ configured: "mpv-beta", path: "/usr/local/bin" });

		const found = unconfirmed(discoverMpv(ctx));

		assert.equal(found.command, "mpv-beta", "the name comes from the setting, so it is what the player tries");
		assert.match(found.message, /mpvPath in settings\.json/, "the sentence names the setting it came from");
		assert.match(found.message, /bare command name/, "and how that value is meant to be resolved");
		assert.doesNotMatch(found.message, /found/, "nothing was found: no candidate was ever looked for");
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
