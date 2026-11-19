/**
 * The mpv player (S6, S11, S19). One of the four I/O owners: it spawns mpv, speaks its JSON IPC and
 * reports what happened. Everything the outside world provides — the process spawn, the socket
 * connect, the resolver, the platform, the environment and the user id — arrives in `PlayerDeps`, so
 * a test never needs a real mpv and this module never decides to shell out on its own (S9).
 *
 * Ownership is split with the model on purpose. This module does NOT hold the queue: it reports
 * `ended` and `failed` for the track it was told to play, the shell turns those into the model's
 * `track-ended`/`track-failed`, and the model decides whether the queue advances or ends (S11). A
 * failure therefore skips exactly one track, and a failing last track ends the queue in the model
 * instead of leaving the player waiting for a file that will never finish. `lib/player` imports only
 * `lib/types.ts` and the `Platform` type — never `lib/core`.
 *
 * mpv is spawned as a plain child: no `detached`, no `unref` (L6), so it dies with Pi, and shutdown
 * sends `quit` on the socket it already has. The life cycle around that has three rules the native
 * review made explicit: the socket lives in a private directory nobody can pre-create (R1-001), a
 * shutdown during startup terminates the child instead of orphaning it (R4-004), and a lost
 * connection gets exactly one retry before it becomes a state the host can act on (R4-005).
 *
 * Finding the binary is also this module's job (S6, T12): `discoverMpv` answers which command to
 * spawn, in the order S6 gives — the setting, then PATH, then the places each platform's installers
 * really use — and only a binary that answers `--version` is ever announced as found. A Windows
 * installer leaves mpv outside PATH (L15), so a bare `"mpv"` is not an answer there. Because the
 * confirmation is a real run with a budget, its failure has two shapes and they are not the same
 * fact (R4-002, R4-003): nothing to spawn is a definitive refusal the player enforces, while a
 * candidate that exists and did not confirm is inconclusive and is still tried.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import type { Platform } from "../settings.ts";
import type { ResolveResult, Track, TrackResolver } from "../types.ts";

/** How long to wait between connection attempts (S19): mpv creates its socket a moment after spawning. */
const CONNECT_RETRY_MS = 100;
/** How long to keep trying before the missing socket becomes a state the card can show (S19). */
const CONNECT_TIMEOUT_MS = 5000;
/** A reply that never arrives must not hang the caller: mpv has died or is wedged. */
const REPLY_TIMEOUT_MS = 5000;

/** The Windows pipe prefix. Written as a constant because the backslashes are the point. */
const PIPE_PREFIX = "\\\\.\\pipe\\";

/** The extension's own directory name, under whatever private base a platform gives us. */
const DIR_NAME = "pi-streambeats";

/** A directory only its owner may enter (R1-001): the socket's name is not a secret, its path is. */
const PRIVATE_MODE = 0o700;

/** How long `<command> --version` gets before it is reported as not having answered (S6, R4-002). */
const VERSION_TIMEOUT_MS = 2000;

/* --- the IPC target and the argv: pure, platform in, string out (S6, S19) ---------------------- */

export interface IpcTargetContext {
	readonly platform: Platform;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** The current user's id: the identity a unix socket's directory already carries. */
	readonly uid: number;
	/**
	 * The user's home directory, where macOS keeps its caches. Passed in, never read from the
	 * environment here: a path function that guesses is a path function that lies (S19).
	 */
	readonly home?: string;
	/**
	 * Makes a fresh directory with a name nobody can predict or pre-create, mode 0700, and returns
	 * its absolute path. It is the last resort when the platform has no private base to build on, so
	 * the randomness is injected I/O instead of a uid-derived path (R1-001). Production passes
	 * `privateTempDir`; a test passes a stub.
	 */
	readonly privateDir?: () => string;
	/**
	 * The source of the Windows pipe's random suffix (S19). Defaults to `randomUUID`; injected so the
	 * name is a value a test can compare instead of a side effect it has to work around.
	 */
	readonly random?: () => string;
}

/**
 * Where mpv listens (S6, S19): `$XDG_RUNTIME_DIR/pi-streambeats/mpv.sock` on Linux,
 * `~/Library/Caches/pi-streambeats/mpv.sock` on macOS, and a named pipe with a random suffix on
 * Windows. Nothing lands in a shared temp directory under a name another local user can predict:
 * when a platform offers no private base, the path comes from an unpredictable `mkdtemp` directory
 * (R1-001). A fixed uid-derived fallback was the finding: it could be pre-created or symlinked by
 * anybody, and it collided between sessions.
 */
export function ipcTarget(ctx: IpcTargetContext): string {
	if (ctx.platform === "win32") return `${PIPE_PREFIX}${DIR_NAME}-${pipeSuffix(ctx.random ?? randomUUID)}`;

	// Linux: the runtime directory already belongs to this login session and is 0700 by contract.
	if (ctx.platform === "linux") {
		const runtime = absolute(ctx.env.XDG_RUNTIME_DIR);
		if (runtime) return posix.join(runtime, DIR_NAME, "mpv.sock");
	}

	// macOS: a per-user cache. `$XDG_RUNTIME_DIR` is a Linux convention, so it is not consulted here.
	if (ctx.platform === "darwin") {
		const home = absolute(ctx.home);
		if (home) return posix.join(home, "Library", "Caches", DIR_NAME, "mpv.sock");
	}

	// No private base: the injected `mkdtemp` decides, because a name we choose is a name others know.
	const fallback = absolute(ctx.privateDir?.());
	if (!fallback) throw new Error("no private directory available for the mpv socket: pass privateDir");
	return posix.join(fallback, "mpv.sock");
}

/**
 * The production fallback: a fresh directory under the OS temp root, named by `mkdtemp`, mode 0700.
 * Exported so the unpredictability is a testable fact rather than a claim in a comment (R1-001).
 */
export function privateTempDir(): string {
	return mkdtempSync(join(tmpdir(), `${DIR_NAME}-`));
}

/**
 * A Windows pipe's identity (S19): a random suffix per player, from an injected source.
 *
 * WHY random: a named pipe is machine-global and has no directory around it, so its **name** is the
 * only thing that decides who may connect. `<uid>` cannot be that name — Windows has no uid, so the
 * extension injected nothing, `ipcTarget` fell back to 0 and every session of every user shared
 * `\\.\pipe\pi-streambeats-0`: guessable, and colliding between two Pi windows or two users. It is the
 * same defect R1-001 closed for the Linux socket, where a predictable path in a shared directory let
 * another local process sit on the name first. Nothing has to discover this name — mpv is the card's
 * own child — so unpredictability costs nothing.
 */
function pipeSuffix(random: () => string): string {
	// Only what a pipe name accepts, so an injected source cannot smuggle a path separator into it.
	const suffix = random().replace(/[^A-Za-z0-9-]/g, "");
	if (suffix === "") throw new Error("the random source produced no usable pipe name");
	return suffix;
}

/** An absolute path, or nothing: a relative XDG base is ignored the way the XDG spec says (S10). */
function absolute(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed && posix.isAbsolute(trimmed) ? trimmed : undefined;
}

/** mpv's argv (S6). A list of arguments, never a command line: no path is ever interpolated into a shell. */
export function mpvArgs(target: string): readonly string[] {
	return ["--idle", "--no-video", "--no-terminal", `--input-ipc-server=${target}`];
}

/* --- finding the binary: setting, then PATH, then the installers' own places (S6, T12) ---------- */

/** What `<command> --version` answered, or whether it answered at all (S6). */
export type MpvProbe =
	| { readonly ok: true }
	/** It was still running when its budget ran out: slow or wedged, which is not the same as wrong (R4-002). */
	| { readonly ok: false; readonly timedOut: true }
	/** It answered, and the answer was an error. */
	| { readonly ok: false; readonly timedOut?: false; readonly reason: string };

export interface MpvDiscoveryContext {
	readonly platform: Platform;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** `settings.mpvPath` when the user set one. The user's own answer, never a hint (S6). */
	readonly configured?: string;
	/** Whether a candidate is a file we could run. Injected, so a test never reads the disk. */
	readonly exists: (path: string) => boolean;
	/** Runs `<command> --version`. Injected, so a test never executes a binary (S9). */
	readonly run: (command: string) => MpvProbe;
}

/**
 * What discovery decided, as data the caller can act on instead of prose it has to parse (S6, R4-002,
 * R4-003). Two failures with two different consequences, so they are two different shapes:
 *
 * - **definitive**: nothing can be spawned — no candidate exists, or the configured value is not a path
 *   this platform can resolve. There is no command to hand over, and the message is a refusal.
 * - **inconclusive**: a candidate exists and did not confirm. `command` is still the best answer there
 *   is, `cause` says which way it failed to confirm, and the message may not claim it is unavailable.
 */
export type MpvDiscovery =
	| { readonly ok: true; readonly command: string }
	| { readonly ok: false; readonly definitive: true; readonly message: string }
	| {
			readonly ok: false;
			readonly definitive: false;
			readonly command: string;
			readonly cause: "timeout" | "error";
			readonly message: string;
	  };

/** The executable's file name per platform: `mpv` everywhere except Windows, which ships `mpv.exe` (S19). */
const MPV_NAME: Readonly<Record<Platform, string>> = { linux: "mpv", darwin: "mpv", win32: "mpv.exe" };

/**
 * Where mpv lands when it is not on PATH, per platform. Deliberately short: every entry is a path this
 * project claims to know, and a list that guesses is worse than a list with two lines.
 *
 * - Windows: the shinchiro `winget` package installs here and **does not touch PATH** (verified on
 *   Windows 11, L15). That single path is the whole reason discovery exists on win32.
 * - macOS: Homebrew's two prefixes — `/opt/homebrew` on arm64, `/usr/local` on Intel. Nothing ships
 *   mpv in `/usr/bin` there, so claiming it would be the guess this list avoids.
 * - Linux: `/usr/bin` is where every package manager named in S6 lands (`apt`, `dnf`, `pacman`,
 *   `zypper`, `apk`), and `/usr/local/bin` is `make install`'s default prefix.
 */
export function mpvKnownLocations(platform: Platform): readonly string[] {
	if (platform === "win32") return ["C:\\Program Files\\MPV Player\\mpv.exe"];
	if (platform === "darwin") return ["/opt/homebrew/bin/mpv", "/usr/local/bin/mpv"];
	return ["/usr/bin/mpv", "/usr/local/bin/mpv"];
}

/**
 * The command to spawn (S6): the setting, then PATH, then the known locations. The first candidate
 * that exists is asked to answer `--version`, and its answer is final — a binary that exists and does
 * not answer is never a reason to try the next one, because falling through would announce a working
 * mpv the user never asked for (S6, L15). A `mpvPath` that is not absolute stops here as definitive
 * (R3-002): the OS would resolve it against the directory Pi was started in, which is not a value
 * this function is allowed to guess.
 */
export function discoverMpv(ctx: MpvDiscoveryContext): MpvDiscovery {
	const configured = ctx.configured?.trim();
	if (configured) {
		// R3-002: `mpvPath` names a binary, and there are three honest shapes. An absolute path is used as written;
		// a **bare command name** is what PATH is for, so it resolves through PATH and cannot depend on where Pi was
		// started; anything else — `bin/mpv`, `./mpv` — is refused, because the OS would resolve it against the launch
		// directory and the same settings file would confirm a different binary in another window.
		if (isBareName(configured)) return confirm(ctx, configured, "mpvPath in settings.json");
		if (!isAbsoluteFor(ctx.platform, configured)) {
			return {
				ok: false,
				definitive: true,
				message: `mpvPath in settings.json is "${configured}", which is a relative path: it would resolve against whatever directory Pi was started in — set the full path of the binary, a bare command name PATH can find, or clear it to search PATH`,
			};
		}
		// A typo in `mpvPath` is the user's to see. Quietly falling back to PATH would hide it forever.
		if (!ctx.exists(configured)) {
			return {
				ok: false,
				definitive: true,
				message: `mpvPath in settings.json points at ${configured}, which does not exist: fix it or install mpv`,
			};
		}
		return confirm(ctx, configured, "mpvPath in settings.json");
	}

	// PATH next: it is the user's own answer to "where do my commands live", in the order they chose.
	for (const candidate of pathCandidates(ctx)) {
		if (ctx.exists(candidate)) return confirm(ctx, candidate, "PATH");
	}

	const known = mpvKnownLocations(ctx.platform);
	for (const candidate of known) {
		if (ctx.exists(candidate)) return confirm(ctx, candidate, "a known location");
	}

	return {
		ok: false,
		definitive: true,
		message: `mpv was not found: no ${MPV_NAME[ctx.platform]} on PATH and none of ${known.join(", ")} exists — install mpv or set mpvPath in settings.json`,
	};
}

/** Absolute in the platform's own flavour (R3-002): `C:\...` is absolute on win32 and nowhere else. */
function isAbsoluteFor(platform: Platform, value: string): boolean {
	return (platform === "win32" ? win32 : posix).isAbsolute(value);
}

/** A command name with no path in it: PATH resolves it, so it cannot depend on where Pi was started (R3-002). */
function isBareName(value: string): boolean {
	return !value.includes("/") && !value.includes("\\");
}

/** Every PATH entry joined with the platform's own executable name, in the order the user put them. */
function pathCandidates(ctx: MpvDiscoveryContext): readonly string[] {
	const path = ctx.platform === "win32" ? win32 : posix;
	const entries = (ctx.env.PATH ?? "")
		.split(path.delimiter)
		// A quoted entry is how some Windows installers write a path with spaces; the quotes are not part of it.
		.map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
		.filter((entry) => entry !== "");
	return entries.map((entry) => path.join(entry, MPV_NAME[ctx.platform]));
}

/**
 * Put one candidate to the only test S6 accepts, and report the answer as the answer. A candidate that
 * exists but did not confirm is **inconclusive**, not a refusal: the 2 s ceiling is short enough that a
 * slow disk or a cold cache lands here, so the player still tries the command it names (R4-002). A
 * timeout and an error are two different causes and never share one sentence.
 */
function confirm(ctx: MpvDiscoveryContext, command: string, where: string): MpvDiscovery {
	const probe = ctx.run(command);
	if (probe.ok) return { ok: true, command };
	if (probe.timedOut === true) {
		return {
			ok: false,
			definitive: false,
			command,
			cause: "timeout",
			message: `${command} (found via ${where}) did not answer --version within ${VERSION_TIMEOUT_MS / 1000} s, so it could not be confirmed: a slow or hung binary is not necessarily a broken one, so it will still be tried`,
		};
	}
	return {
		ok: false,
		definitive: false,
		command,
		cause: "error",
		message: `${command} (found via ${where}) answered --version with an error (${probe.reason}), so it could not be confirmed: it will still be tried`,
	};
}

/**
 * The production discovery I/O: a real `stat` and a real `--version` run (S6). It lives here, in the
 * module that already owns the process, and nowhere else — the resolver above stays pure, so its tests
 * never execute a binary (S9).
 */
export const diskProbe: Pick<MpvDiscoveryContext, "exists" | "run"> = {
	exists: (path) => {
		try {
			return statSync(path).isFile();
		} catch {
			// ENOENT, or a directory we may not look into: either way, not a binary we can run.
			return false;
		}
	},
	run: (command) => {
		try {
			const result = spawnSync(command, ["--version"], {
				stdio: ["ignore", "pipe", "pipe"],
				shell: false,
				// A binary that hangs must not hang the session that asked whether it works (S6).
				timeout: VERSION_TIMEOUT_MS,
				encoding: "utf8",
			});
			if (result.error) {
				// `spawnSync` reports its own budget as ETIMEDOUT: the binary was still running, which is a slower
				// fact than an answer and must not be reported as one (R4-002).
				const code = "code" in result.error ? result.error.code : undefined;
				if (code === "ETIMEDOUT") return { ok: false, timedOut: true };
				return { ok: false, reason: result.error.message };
			}
			if (result.status !== 0) {
				const detail = (result.stderr ?? "").trim();
				const code = result.status === null ? "no exit code" : `exit ${String(result.status)}`;
				return { ok: false, reason: detail ? `${code}: ${detail}` : code };
			}
			return { ok: true };
		} catch (error) {
			return { ok: false, reason: reasonOf(error) };
		}
	},
};

/* --- the injected world ---------------------------------------------------------------------- */

/** How mpv is spawned. Explicit argv, never `shell: true` (AGENTS.md). */
export interface SpawnOptions {
	/** stdin stays out of mpv's way; stderr is kept for diagnostics when it dies. */
	readonly stdio: readonly ["ignore", "ignore", "pipe"];
	readonly shell: false;
}

/** The slice of `ChildProcess` this module uses, so a test can hand in a plain object. */
export interface SpawnedProcess {
	unref?(): unknown;
	/** Signal the child we spawned; never a process we did not (R4-004). */
	kill?(signal?: string): unknown;
	on(event: "error", listener: (error: Error) => void): unknown;
	on(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
	readonly stderr?: { on(event: "data", listener: (chunk: string | Buffer) => void): unknown } | null;
}

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => SpawnedProcess;

/** The slice of `net.Socket` this module drives: one line-oriented peer behind both transports. */
export interface PlayerSocket {
	write(data: string): unknown;
	end?(): unknown;
	destroy?(): unknown;
	setEncoding?(encoding: "utf8"): unknown;
	on(event: "connect" | "close", listener: () => void): unknown;
	on(event: "error", listener: (error: Error) => void): unknown;
	on(event: "data", listener: (chunk: string | Buffer) => void): unknown;
}

export type ConnectFn = (target: string) => PlayerSocket;

/** A JSON value mpv accepts inside a `command` array. */
export type MpvValue = string | number | boolean;

/** mpv's answer to one command (S6): `error` is `"success"` or a reason, `data` only for queries. */
export interface MpvReply {
	readonly error: string;
	readonly request_id?: number;
	readonly data?: unknown;
}

/**
 * What the player tells the caller (S11), each fact naming the track it is about so a late report
 * cannot advance the wrong one. `unavailable` is the S6 guided state: mpv is missing, gave up on the
 * socket or lost it — a state to show, never an exception to catch. `duration` is the total mpv only
 * knows once a file is loaded (S12, S15): it travels here so the fact carries the track it describes.
 */
export type PlayerReport =
	| { readonly kind: "ready" }
	| { readonly kind: "ended"; readonly trackId: string }
	| { readonly kind: "failed"; readonly trackId: string; readonly message: string }
	| { readonly kind: "duration"; readonly trackId: string; readonly durationMs: number }
	| { readonly kind: "unavailable"; readonly message: string };

export interface PlayerDeps {
	readonly spawn: SpawnFn;
	readonly connect: ConnectFn;
	/** The one path to a playable target (S7). v1 resolves local paths; the catalog adds a second. */
	readonly resolve: TrackResolver;
	readonly onReport: (report: PlayerReport) => void;
	readonly platform: Platform;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** Defaults to `process.getuid()`, and to 0 on Windows where there is no uid. */
	readonly uid?: number;
	/** The directory macOS puts its cache in. Defaults to `os.homedir()`; never read inside the pure path. */
	readonly home?: string;
	/**
	 * Makes a fresh unpredictable private directory (mode 0700) for the fallback socket path.
	 * Defaults to `privateTempDir`; injected so the fallback is testable without real I/O (R1-001).
	 */
	readonly privateDir?: () => string;
	/** Defaults to `randomUUID`: the source of the Windows pipe's random suffix (S19). */
	readonly random?: () => string;
	/**
	 * The command to spawn. Resolved once by the composition root through `discoverMpv` (S6, T12), so the
	 * player only has to use it; `undefined` keeps the historical bare `"mpv"` meaning.
	 */
	readonly mpvPath?: string;
	/**
	 * Why playback cannot even be attempted, when discovery found nothing to spawn (S6, R4-003). With it
	 * set the play path reports this message and never spawns, so what the session announced and what the
	 * player does are the same fact. Additive: absent, the player spawns `mpvPath` as it always did, and an
	 * unconcluded candidate is **not** a refusal (R4-002).
	 */
	readonly refusal?: string;
	/** The level the session starts at, if the caller wants one applied on connect (S11: core owns 70). */
	readonly volume?: number;
	readonly retryMs?: number;
	readonly connectTimeoutMs?: number;
	readonly replyTimeoutMs?: number;
}

/** What the shell drives (S6, S11). Every method resolves; a dead player answers, it does not reject. */
export interface Player {
	/** Spawn mpv and connect. Idempotent, and every other method awaits it. */
	start(): Promise<void>;
	/** Escape hatch for a query (mpv's version, a property) with the same correlation the rest uses. */
	command(values: readonly MpvValue[]): Promise<MpvReply>;
	play(track: Track): Promise<void>;
	pause(): Promise<void>;
	resume(): Promise<void>;
	stop(): Promise<void>;
	setVolume(level: number): Promise<void>;
	quit(): Promise<void>;
}

/**
 * The player this module hands out. It is deliberately a closure-backed class: the state is the
 * socket, the pending replies and the track mpv currently has, and none of it leaks to the caller.
 */
export function createMpvPlayer(deps: PlayerDeps): Player {
	return new MpvPlayer(deps);
}

interface PendingRequest {
	readonly resolve: (reply: MpvReply) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

class MpvPlayer implements Player {
	readonly #deps: PlayerDeps;
	readonly #target: string;
	readonly #pending = new Map<number, PendingRequest>();
	#nextRequestId = 1;
	#socket?: PlayerSocket;
	/** The child we spawned and therefore own. Replaced on the one retry, never left behind (R4-004). */
	#child?: SpawnedProcess;
	#buffer = "";
	#starting?: Promise<void>;
	/** The single reconnect in flight, if any: a `play` that lands inside it waits for it (R4-005). */
	#recovering?: Promise<void>;
	#closing = false;
	/** The level this session last asked for; re-applied after a recovery (R4-002). */
	#volume: number | undefined;
	#gaveUp = false;
	/** True once the one retry was spent: a second loss is terminal, not a loop (R4-005). */
	#retried = false;
	#reported = false;
	#lastError?: string;
	#stderr = "";
	/** The track mpv has loaded: the identity every `end-file` is attributed to. */
	#trackId?: string;
	#trackName?: string;
	/** Commands run one after another: two quick `play`s must not interleave their three commands. */
	#tail: Promise<unknown> = Promise.resolve();

	constructor(deps: PlayerDeps) {
		this.#deps = deps;
		this.#target = ipcTarget({
			platform: deps.platform,
			env: deps.env,
			uid: deps.uid ?? process.getuid?.() ?? 0,
			home: deps.home ?? homedir(),
			privateDir: deps.privateDir ?? privateTempDir,
			random: deps.random ?? randomUUID,
		});
	}

	async start(): Promise<void> {
		this.#starting ??= this.#connect();
		await this.#starting;
		// A retry after a lost connection is still starting: a play must not race past it (R4-005).
		if (this.#recovering) await this.#recovering;
	}

	/**
	 * One query, sent as soon as the player is connected. Not serialized with the command groups: two
	 * queries may be in flight at once, which is what the request ids are for. Read-only by nature, so
	 * landing between two commands of a `play` cannot reorder anything that matters.
	 */
	async command(values: readonly MpvValue[]): Promise<MpvReply> {
		await this.start();
		return this.#request(values);
	}

	play(track: Track): Promise<void> {
		return this.#serialize(() => this.#play(track));
	}

	pause(): Promise<void> {
		return this.#serialize(() => this.#setProperty("pause", true));
	}

	resume(): Promise<void> {
		return this.#serialize(() => this.#setProperty("pause", false));
	}

	stop(): Promise<void> {
		return this.#serialize(async () => {
			// Stopping nothing must not spawn mpv just to stop it.
			if (!this.#starting) return;
			await this.start();
			// Our own stop unloads the file; the `end-file` it causes is not the track ending (S11).
			this.#trackId = undefined;
			this.#trackName = undefined;
			await this.#request(["stop"]);
		});
	}

	async setVolume(level: number): Promise<void> {
		const value = Math.trunc(level);
		await this.#serialize(() => this.#setProperty("volume", value));
		// Remembered only once it landed, so a recovery restores what the session actually asked for and
		// a level set before connecting is not applied twice (R4-002).
		this.#volume = value;
	}

	async quit(): Promise<void> {
		if (this.#closing) return;
		this.#closing = true;

		const socket = this.#socket;
		this.#socket = undefined;
		// Nothing is left to wait for: whatever was in flight would wait forever on a dying socket.
		this.#settleAll({ error: "quit" });
		if (!socket) {
			// No channel means the child is still connecting or already unreachable. Kill it HERE, not
			// when the connect loop happens to notice: the caller may never come back to us, and an mpv
			// that outlives the process holding its socket is the leak R4-004 was meant to close (R4-003).
			this.#terminateChild();
			return;
		}

		try {
			socket.write(`${JSON.stringify({ command: ["quit"], request_id: this.#nextRequestId++ })}\n`);
			socket.end?.();
		} catch {
			socket.destroy?.();
		}
	}

	/* --- connecting -------------------------------------------------------------------------- */

	async #connect(): Promise<void> {
		if (this.#refuse()) return;
		if (!this.#prepareSocketDir()) return;

		const socket = await this.#reachNewChild();
		if (!socket) return;

		this.#attach(socket);
		await this.#applyInitialVolume();
		this.#emit({ kind: "ready" });
	}

	/**
	 * One retry for a lost connection (R4-005). One mpv crash must not disable playback for the rest
	 * of the session, and it must not become a respawn loop either: the second loss is terminal and
	 * leaves the `unavailable` report the host acts on by recreating the player (S6's `r` key).
	 */
	#recover(): void {
		if (this.#retried) {
			const detail = this.#lastError;
			this.#unavailable(detail ? `the mpv connection closed again: ${detail}` : "the mpv connection closed again");
			return;
		}
		this.#retried = true;

		const recovering = this.#reconnect();
		this.#recovering = recovering;
		const settled = () => {
			if (this.#recovering === recovering) this.#recovering = undefined;
		};
		void recovering.then(settled, settled);
	}

	async #reconnect(): Promise<void> {
		// The replacement child has nothing loaded: no future `end-file` can be about the lost track.
		this.#trackId = undefined;
		this.#trackName = undefined;
		// The old child lost its only control channel: it may be alive and unreachable, so it goes.
		this.#terminateChild();
		if (!this.#prepareSocketDir()) return;

		const socket = await this.#reachNewChild();
		if (!socket) return;

		this.#attach(socket);
		// A fresh mpv comes up at its own default level. Telling the host `ready` without restoring the
		// session volume would reset it silently after a recovery (R4-002).
		await this.#applyInitialVolume();
		this.#emit({ kind: "ready" });
	}

	/**
	 * The refusal discovery handed over (S6, R4-003): reported, and enforced by never spawning a command
	 * nobody confirmed. Saying it once and then trying the bare name again is the finding, not the fix.
	 */
	#refuse(): boolean {
		const refusal = this.#deps.refusal;
		if (refusal === undefined) return false;
		this.#unavailable(refusal);
		return true;
	}

	/** The socket's directory, or a report and `false`: an untrusted path is not worth an mpv process. */
	#prepareSocketDir(): boolean {
		try {
			prepareSocketDir(this.#deps.platform, this.#target);
			return true;
		} catch (error) {
			this.#unavailable(`cannot prepare the socket directory: ${reasonOf(error)}`);
			return false;
		}
	}

	/**
	 * Spawn the child and wait for the socket it is supposed to create. A shutdown that lands in this
	 * window sends SIGTERM to the child we spawned instead of leaking an mpv that holds the socket
	 * (R4-004): a child already gone is tolerated, it is not waited for, and it is not a report — the
	 * only thing shutdown says is that it shut down.
	 */
	async #reachNewChild(): Promise<PlayerSocket | undefined> {
		if (this.#closing) return undefined;
		const child = this.#spawn();
		if (!child) return undefined;

		const socket = await this.#connectWithRetry();
		if (this.#closing) {
			// The last attempt may have landed after the shutdown: nothing owns this socket or child.
			socket?.destroy?.();
			this.#terminateChild();
			return undefined;
		}
		return socket;
	}

	#spawn(): SpawnedProcess | undefined {
		const command = this.#deps.mpvPath ?? "mpv";
		let child: SpawnedProcess;
		try {
			child = this.#deps.spawn(command, mpvArgs(this.#target), { stdio: ["ignore", "ignore", "pipe"], shell: false });
		} catch (error) {
			this.#unavailable(`cannot run ${command}: ${reasonOf(error)}`);
			return undefined;
		}

		this.#child = child;
		this.#stderr = "";
		// Draining stderr keeps the pipe from filling up and gives a dead mpv a reason to quote.
		child.stderr?.on("data", (chunk) => {
			this.#stderr = `${this.#stderr}${String(chunk)}`.slice(-2000);
		});
		child.on("error", (error) => {
			// A child we replaced is not our process anymore: its late error is not a report about us.
			if (this.#child !== child) return;
			this.#unavailable(`cannot run ${command}: ${error.message}`);
		});
		child.on("exit", (code) => this.#onChildExit(child, command, code));
		return child;
	}

	#onChildExit(child: SpawnedProcess, command: string, code: number | null): void {
		// Replacing a child is our decision, and its death is not news about the current one.
		if (this.#child !== child) return;
		this.#child = undefined;
		if (this.#closing) return;
		// With a socket attached, the close that follows is the trigger for the one retry (R4-005):
		// reporting here would race that retry with a terminal state.
		if (this.#socket) return;
		const detail = this.#stderr.trim();
		this.#unavailable(`${command} exited${code === null ? "" : ` with code ${code}`}${detail ? `: ${detail}` : ""}`);
	}

	/**
	 * SIGTERM the child we spawned. A child that is already gone is tolerated: the signal is a
	 * request, and shutdown never waits for the answer (R4-004).
	 */
	#terminateChild(): void {
		const child = this.#child;
		this.#child = undefined;
		try {
			child?.kill?.("SIGTERM");
		} catch {
			// ESRCH: it died on its own between the decision and the signal.
		}
	}

	async #connectWithRetry(): Promise<PlayerSocket | undefined> {
		const retryMs = this.#deps.retryMs ?? CONNECT_RETRY_MS;
		const timeoutMs = this.#deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
		const deadline = Date.now() + timeoutMs;
		let attempts = 0;

		while (!this.#closing && !this.#gaveUp) {
			attempts += 1;
			const socket = await attempt(this.#deps.connect, this.#target, timeoutMs);
			if (socket) return socket;
			if (Date.now() >= deadline) break;
			await delay(retryMs);
		}

		if (this.#closing) {
			// A shutdown that landed while an attempt was in flight takes the child with it here, before
			// the caller resumes: returning first would leave it alive for the rest of the budget (R4-003).
			this.#terminateChild();
			return undefined;
		}
		this.#unavailable(`mpv is not listening on ${this.#target} (${attempts} attempts)`);
		return undefined;
	}

	#attach(socket: PlayerSocket): void {
		this.#socket = socket;
		// A new peer starts mid-line: a fragment left over from the dead one is not its message.
		this.#buffer = "";
		this.#lastError = undefined;
		socket.setEncoding?.("utf8");
		socket.on("data", (chunk) => this.#onData(String(chunk)));
		socket.on("error", (error) => {
			// The close that follows decides what happens next; the reason is kept for the retry's report.
			this.#lastError = error.message;
		});
		socket.on("close", () => this.#onClose());
	}

	async #applyInitialVolume(): Promise<void> {
		// The last level this session asked for wins over the session-start default, so a recovery puts
		// the card back where the user left it instead of at mpv's own default (R4-002).
		const level = this.#volume ?? this.#deps.volume;
		if (level === undefined) return;
		this.#volume = Math.trunc(level);
		await this.#request(["set_property", "volume", this.#volume]);
	}

	#onClose(): void {
		this.#socket = undefined;
		this.#settleAll({ error: "closed" });
		if (this.#closing) return;
		if (this.#gaveUp) return;
		this.#recover();
	}

	/* --- the protocol ------------------------------------------------------------------------ */

	#onData(chunk: string): void {
		const lines = `${this.#buffer}${chunk}`.split("\n");
		this.#buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (line.trim() !== "") this.#handleLine(line);
		}
	}

	#handleLine(raw: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			// A truncated line is not a message. mpv speaks JSON: anything else is not ours to guess.
			return;
		}
		if (!isRecord(parsed)) return;

		const requestId = parsed.request_id;
		if (typeof requestId === "number") {
			this.#resolveReply(requestId, replyOf(parsed, requestId));
			return;
		}

		const event = parsed.event;
		if (typeof event === "string") this.#handleEvent(event, parsed);
	}

	/** One reply, one owner. A reply nobody asked for is dropped, never handed to the next request. */
	#resolveReply(requestId: number, reply: MpvReply): void {
		const pending = this.#pending.get(requestId);
		if (!pending) return;
		this.#pending.delete(requestId);
		clearTimeout(pending.timer);
		pending.resolve(reply);
	}

	#handleEvent(event: string, payload: Readonly<Record<string, unknown>>): void {
		// The only two events that are facts about our track. `file-loaded` says the file is decodable
		// (so `duration` finally answers); `end-file` says how it left.
		if (event === "file-loaded") {
			this.#onFileLoaded();
			return;
		}
		if (event !== "end-file") return;

		const trackId = this.#trackId;
		// Nothing of ours is loaded: our own stop forgot the track on purpose, so this is not the track ending.
		if (trackId === undefined) return;

		const reason = typeof payload.reason === "string" ? payload.reason : "";
		if (reason !== "eof" && reason !== "error") return;

		const name = this.#trackName ?? trackId;
		this.#trackId = undefined;
		this.#trackName = undefined;

		if (reason === "eof") {
			this.#emit({ kind: "ended", trackId });
			return;
		}
		this.#emit({ kind: "failed", trackId, message: cannotOpen(name) });
	}

	/**
	 * The total duration, asked for when mpv says the file is loaded (S12, S15). The `loadfile` reply is
	 * NOT a load fact: on a real mpv it lands at ~2 ms and `get_property duration` then answers
	 * `property unavailable`; `file-loaded` is the event that means it is decodable, and only after it
	 * does the query answer. A player with no track of ours loaded has nothing to attribute the total
	 * to, and an answer that arrives after the track was replaced or stopped is dropped.
	 */
	#onFileLoaded(): void {
		const trackId = this.#trackId;
		if (trackId === undefined) return;

		void this.#request(["get_property", "duration"]).then((reply) => {
			if (reply.error !== "success") return;
			const seconds = reply.data;
			if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return;
			// The total belongs to the track that is still loaded, not to the one that asked.
			if (this.#trackId !== trackId) return;
			this.#emit({ kind: "duration", trackId, durationMs: Math.round(seconds * 1000) });
		});
	}

	#request(values: readonly MpvValue[]): Promise<MpvReply> {
		const socket = this.#socket;
		if (!socket) return Promise.resolve({ error: "unavailable" });

		const requestId = this.#nextRequestId++;
		const timeoutMs = this.#deps.replyTimeoutMs ?? REPLY_TIMEOUT_MS;

		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.#pending.delete(requestId);
				resolve({ error: "timeout", request_id: requestId });
			}, timeoutMs);

			this.#pending.set(requestId, { resolve, timer });
			socket.write(`${JSON.stringify({ command: values, request_id: requestId })}\n`);
		});
	}

	#settleAll(reply: MpvReply): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.resolve(reply);
		}
		this.#pending.clear();
	}

	/* --- commands ---------------------------------------------------------------------------- */

	async #play(track: Track): Promise<void> {
		await this.start();
		// The reason mpv is unusable already went out; loading into nothing would be theatre.
		if (!this.#socket) return;

		let result: ResolveResult;
		try {
			result = await this.#deps.resolve.resolve(track);
		} catch {
			this.#emit({ kind: "failed", trackId: track.id, message: cannotOpen(track.title) });
			return;
		}

		if (!result.ok) {
			this.#emit({ kind: "failed", trackId: track.id, message: cannotOpen(track.title) });
			return;
		}

		this.#trackId = track.id;
		this.#trackName = track.title;
		// The three commands of one play are written back to back, so a queued play can never land
		// between them; only then do we wait for the answers.
		const [load] = await Promise.all([
			this.#request(["loadfile", result.target.uri, "replace"]),
			this.#request(["set_property", "force-media-title", track.title]),
			// A new track plays: the card has already told the user it is not paused (S11).
			this.#request(["set_property", "pause", false]),
		]);

		// mpv answers `loadfile` before the file is decodable, so a real load failure arrives later as
		// `end-file`. A reply that never came is the other case, and it is the dangerous one: with no
		// report the track produces neither `ended` nor `failed`, the queue stops silently and the card
		// simply freezes (S11, R4-001). A dead socket already reported `unavailable`, so only an answer
		// that is about this track is turned into a failure.
		if (load.error !== "success" && load.error !== "unavailable" && this.#trackId === track.id) {
			this.#trackId = undefined;
			this.#trackName = undefined;
			this.#emit({ kind: "failed", trackId: track.id, message: cannotOpen(track.title) });
		}
	}

	async #setProperty(name: string, value: MpvValue): Promise<void> {
		await this.start();
		await this.#request(["set_property", name, value]);
	}

	/* --- speaking to the caller -------------------------------------------------------------- */

	#unavailable(message: string): void {
		this.#gaveUp = true;
		// Giving up must not leave a child holding the socket we could not reach it on (R4-004).
		this.#terminateChild();
		this.#settleAll({ error: "unavailable" });
		if (this.#reported) return;
		this.#reported = true;
		this.#emit({ kind: "unavailable", message });
	}

	#emit(report: PlayerReport): void {
		try {
			this.#deps.onReport(report);
		} catch {
			// A reporter that throws is the caller's bug; it must not take the transport down with it.
		}
	}

	/** Run the tasks in order: three commands of a play must not interleave with the next play. */
	#serialize<T>(task: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(task, task);
		this.#tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}

/* --- the pieces that do not need state -------------------------------------------------------- */

/**
 * Connect once, with no retry: the retry decides *when*, this decides *whether*. A socket that
 * fails is destroyed, because `connect` failures are ordinary here — mpv has not created it yet.
 *
 * An attempt that neither connects nor errors is abandoned at `timeoutMs`: a peer that accepts the
 * call and then says nothing must not hang the card (S19 gives up with a report, never a freeze).
 */
function attempt(connect: ConnectFn, target: string, timeoutMs: number): Promise<PlayerSocket | undefined> {
	return new Promise((resolve) => {
		let socket: PlayerSocket | undefined;
		let settled = false;

		const timer = setTimeout(() => {
			socket?.destroy?.();
			finish(undefined);
		}, timeoutMs);

		function finish(value: PlayerSocket | undefined): void {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		}

		function onConnect(): void {
			finish(socket);
		}

		function onError(): void {
			if (settled) return;
			socket?.destroy?.();
			finish(undefined);
		}

		try {
			socket = connect(target);
		} catch {
			finish(undefined);
			return;
		}

		socket.on("connect", onConnect);
		socket.on("error", onError);
	});
}

/**
 * Linux and macOS sockets are files: their directory must exist before mpv may create the socket.
 *
 * The directory must also be ours and private (R1-001): a pre-created directory, a symlink planted
 * by another local user or a path owned by somebody else would let them impersonate mpv. A
 * directory we own that an older version left readable is tightened instead of trusted.
 */
function prepareSocketDir(platform: Platform, target: string): void {
	// A Windows named pipe lives in the kernel: there is no directory, and no file to clean up.
	if (platform === "win32") return;
	ensurePrivateDir(posix.dirname(target));
}

/**
 * Create `dir` with mode 0700, or reuse it only when it is a real directory owned by this user. The
 * ownership and mode checks are the point of the guard, so both are verified and not assumed: the
 * path is predictable, and what makes it safe is that nobody else can have made it first.
 */
export function ensurePrivateDir(dir: string): void {
	const existing = lstatSync(dir, { throwIfNoEntry: false });
	if (!existing) {
		// A first run on macOS may not have ~/Library/Caches yet. Create the ancestors without a
		// recursive call on the leaf, which would hand this mode to every parent it invented (R1-001).
		mkdirSync(posix.dirname(dir), { recursive: true });
		mkdirSync(dir, { mode: PRIVATE_MODE });
		const created = lstatSync(dir);
		if (!created.isDirectory() || (created.mode & 0o777) !== PRIVATE_MODE) {
			throw new Error(`${dir} could not be made private`);
		}
		return;
	}

	if (existing.isSymbolicLink()) throw new Error(`${dir} is a symlink, refusing to use it`);
	if (!existing.isDirectory()) throw new Error(`${dir} is not a directory`);
	const uid = process.getuid?.();
	if (uid !== undefined && existing.uid !== uid) throw new Error(`${dir} belongs to another user`);
	if ((existing.mode & 0o777) !== PRIVATE_MODE) chmodSync(dir, PRIVATE_MODE);
}

function replyOf(parsed: Readonly<Record<string, unknown>>, requestId: number): MpvReply {
	const error = typeof parsed.error === "string" ? parsed.error : "unknown";
	return "data" in parsed ? { error, request_id: requestId, data: parsed.data } : { error, request_id: requestId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The footer's wording for a skipped file (S11). The model prints its own copy from the track title. */
function cannotOpen(name: string): string {
	return `${name}: cannot open, skipping`;
}

function reasonOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
