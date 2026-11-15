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
 * sends `quit` on the socket it already has.
 */
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { posix } from "node:path";
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

/* --- the IPC target and the argv: pure, platform in, string out (S6, S19) ---------------------- */

export interface IpcTargetContext {
	readonly platform: Platform;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** The current user's id: the identity half of every fallback path (S19). */
	readonly uid: number;
	/**
	 * The OS temp directory. Injected so this stays a pure function; production passes `os.tmpdir()`,
	 * which is the real answer on macOS (`/var/folders/…`) and not a guess. Without it, `$TMPDIR` is
	 * honoured when absolute and `/tmp` is the fallback.
	 */
	readonly tmpDir?: string;
}

/**
 * Where mpv listens (S6, S19): `$XDG_RUNTIME_DIR/pi-streambeats/mpv.sock` on Linux, a tmpdir path
 * that carries the uid on macOS and as the Linux fallback, and a named pipe with the uid on
 * Windows. Nothing lands in a shared temp directory without an identity in its path.
 */
export function ipcTarget(ctx: IpcTargetContext): string {
	const uid = Math.trunc(ctx.uid);
	if (ctx.platform === "win32") return `${PIPE_PREFIX}pi-streambeats-${uid}`;

	const runtime = ctx.platform === "linux" ? absolute(ctx.env.XDG_RUNTIME_DIR) : undefined;
	if (runtime) return posix.join(runtime, "pi-streambeats", "mpv.sock");
	return posix.join(tmpBase(ctx), `pi-streambeats-${uid}`, "mpv.sock");
}

/** An absolute path, or nothing: a relative XDG base is ignored the way the XDG spec says (S10). */
function absolute(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed && posix.isAbsolute(trimmed) ? trimmed : undefined;
}

function tmpBase(ctx: IpcTargetContext): string {
	return absolute(ctx.tmpDir) ?? absolute(ctx.env.TMPDIR) ?? "/tmp";
}

/** mpv's argv (S6). A list of arguments, never a command line: no path is ever interpolated into a shell. */
export function mpvArgs(target: string): readonly string[] {
	return ["--idle", "--no-video", "--no-terminal", `--input-ipc-server=${target}`];
}

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
 * socket or lost it — a state to show, never an exception to catch.
 */
export type PlayerReport =
	| { readonly kind: "ready" }
	| { readonly kind: "ended"; readonly trackId: string }
	| { readonly kind: "failed"; readonly trackId: string; readonly message: string }
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
	/** Defaults to `os.tmpdir()`. Injected so the target is a function of its arguments (S19). */
	readonly tmpDir?: string;
	/** Defaults to `"mpv"`: on Windows the installer often leaves it off `PATH` (T12 looks it up). */
	readonly mpvPath?: string;
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
	#buffer = "";
	#starting?: Promise<void>;
	#closing = false;
	#gaveUp = false;
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
			// `os.tmpdir()` is the real answer on macOS (`/var/folders/…`), which `$TMPDIR` alone is not.
			tmpDir: deps.tmpDir ?? tmpdir(),
		});
	}

	start(): Promise<void> {
		this.#starting ??= this.#connect();
		return this.#starting;
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

	setVolume(level: number): Promise<void> {
		return this.#serialize(() => this.#setProperty("volume", Math.trunc(level)));
	}

	async quit(): Promise<void> {
		if (this.#closing) return;
		this.#closing = true;

		const socket = this.#socket;
		this.#socket = undefined;
		// Nothing is left to wait for: whatever was in flight would wait forever on a dying socket.
		this.#settleAll({ error: "quit" });
		if (!socket) return;

		try {
			socket.write(`${JSON.stringify({ command: ["quit"], request_id: this.#nextRequestId++ })}\n`);
			socket.end?.();
		} catch {
			socket.destroy?.();
		}
	}

	/* --- connecting -------------------------------------------------------------------------- */

	async #connect(): Promise<void> {
		try {
			prepareSocketDir(this.#deps.platform, this.#target);
		} catch (error) {
			this.#unavailable(`cannot prepare the socket directory: ${reasonOf(error)}`);
			return;
		}

		const child = this.#spawn();
		if (!child) return;

		const socket = await this.#connectWithRetry();
		if (!socket) return;

		this.#attach(socket);
		await this.#applyInitialVolume();
		this.#emit({ kind: "ready" });
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

		// Draining stderr keeps the pipe from filling up and gives a dead mpv a reason to quote.
		child.stderr?.on("data", (chunk) => {
			this.#stderr = `${this.#stderr}${String(chunk)}`.slice(-2000);
		});
		child.on("error", (error) => this.#unavailable(`cannot run ${command}: ${error.message}`));
		child.on("exit", (code) => {
			if (this.#closing) return;
			const detail = this.#stderr.trim();
			this.#unavailable(`${command} exited${code === null ? "" : ` with code ${code}`}${detail ? `: ${detail}` : ""}`);
		});
		return child;
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

		if (!this.#closing) {
			this.#unavailable(`mpv is not listening on ${this.#target} (${attempts} attempts)`);
		}
		return undefined;
	}

	#attach(socket: PlayerSocket): void {
		this.#socket = socket;
		socket.setEncoding?.("utf8");
		socket.on("data", (chunk) => this.#onData(String(chunk)));
		socket.on("error", (error) => {
			// The close that follows carries the report, so the reason is only kept here.
			this.#lastError = error.message;
		});
		socket.on("close", () => this.#onClose());
	}

	async #applyInitialVolume(): Promise<void> {
		const level = this.#deps.volume;
		if (level === undefined) return;
		await this.#request(["set_property", "volume", Math.trunc(level)]);
	}

	#onClose(): void {
		this.#socket = undefined;
		this.#settleAll({ error: "closed" });
		if (this.#closing) return;
		this.#unavailable(this.#lastError ? `the mpv connection closed: ${this.#lastError}` : "the mpv connection closed");
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
		await Promise.all([
			this.#request(["loadfile", result.target.uri, "replace"]),
			this.#request(["set_property", "force-media-title", track.title]),
			// A new track plays: the card has already told the user it is not paused (S11).
			this.#request(["set_property", "pause", false]),
		]);
	}

	async #setProperty(name: string, value: MpvValue): Promise<void> {
		await this.start();
		await this.#request(["set_property", name, value]);
	}

	/* --- speaking to the caller -------------------------------------------------------------- */

	#unavailable(message: string): void {
		this.#gaveUp = true;
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

/** Linux and macOS sockets are files: their directory must exist before mpv may create the socket. */
function prepareSocketDir(platform: Platform, target: string): void {
	// A Windows named pipe lives in the kernel: there is no directory, and no file to clean up.
	if (platform === "win32") return;
	mkdirSync(posix.dirname(target), { recursive: true, mode: 0o700 });
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
