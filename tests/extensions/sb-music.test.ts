/**
 * The composition root (S8, S1, S2): `extensions/sb-music.ts` is the file Pi loads, and it is the only
 * place where the user's `settings.json` becomes the real deps — the library root, the ceiling over it,
 * the folder scanner, the settings writer and the path `--keys` prints. `tests/host/host.test.ts` drives
 * the adapter with all of that already computed and handed in; nothing drove the entry point itself, so
 * the wiring from file to adapter had no test at all.
 *
 * Pi is faked at the same `ExtensionAPI` seam the adapter tests use. No process is started: the player
 * is built on `session_start`, and an unstarted player only connects when a command reaches it — no test
 * here plays a track. The only disk touched is a temporary tree built per fixture, never the user's
 * music folder and never the user's config directory.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionUIContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import sbMusic, { createResolver } from "../../extensions/sb-music.ts";
import { catalogCachePath } from "../../lib/catalog/cache.ts";
import type { CatalogFetch, CatalogHttp } from "../../lib/catalog/http.ts";
import type { MpvDiscoveryContext } from "../../lib/player/mpv.ts";
import type { Platform } from "../../lib/settings.ts";
import type { CatalogAlbumListing, Track } from "../../lib/types.ts";

/**
 * The discovery I/O every test that starts a session injects (S6, S9). The root now confirms mpv by running
 * `<command> --version`, and a test must not execute a binary on the machine that happens to run it: it
 * answers for the probe instead. Discovery itself is tested where it lives, in `tests/player/mpv.test.ts`.
 */
const FOUND_MPV: Pick<MpvDiscoveryContext, "exists" | "run"> = {
	exists: () => true,
	run: () => ({ ok: true }),
};

/**
 * The catalog's two pages, from the same fixtures the reader's own tests use: the entry point really runs
 * `createCatalogHttp` here, and there is no socket anywhere (S20).
 */
const MUSIC_PAGE = readFileSync(new URL("../fixtures/catalog/music-grid.html", import.meta.url), "utf8");
const ALBUM_PAGE = readFileSync(new URL("../fixtures/catalog/album-tralbum.html", import.meta.url), "utf8");

const catalogFetch: CatalogFetch = async (url) =>
	url.endsWith("/music") ? { status: 200, text: MUSIC_PAGE } : { status: 200, text: ALBUM_PAGE };

/** The width the frames below are rendered at: the artboard's comfortable reference (S3). */
const COLUMNS = 90;

const EDITOR: Component = { render: () => [], invalidate: () => {} };

const THEME = {
	fg: (_token: string, text: string) => text,
	bg: (_token: string, text: string) => text,
	getFgAnsi: () => "",
	getBgAnsi: () => "",
	bold: (text: string) => text,
} as unknown as Theme;

/** The temporary trees built here; removed in one place so a failure does not leave one behind. */
const roots: string[] = [];

after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
	/** The temporary root, already canonical: the ceiling compares canonical paths (S14). */
	readonly root: string;
	/** HOME for this fixture, so the ceiling over the library is a path this test owns. */
	readonly home: string;
	/** The library, INSIDE `home`: the ceiling over it is HOME itself, not the root (S14). */
	readonly library: string;
	readonly configHome: string;
	readonly configDir: string;
	readonly settingsFile: string;
}

interface FixtureOptions {
	/** Overrides merged into the written `settings.json`; everything left out keeps its default (S2). */
	readonly shortcuts?: Readonly<Record<string, string>>;
	readonly asciiGlyphs?: boolean;
	/** Write this text instead of a settings object: the broken-file path (S2, R3-001). */
	readonly raw?: string;
}

/**
 * A temporary world with one folder and one track in the library. The names are short enough to survive
 * the row's budget at 90 columns, so a passing assertion is about the wiring and not about truncation.
 */
function fixture(options: FixtureOptions = {}): Fixture {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "sb-entry-")));
	roots.push(root);
	const home = join(root, "home");
	const library = join(home, "Music");
	const configHome = join(root, "config");
	const configDir = join(configHome, "pi-streambeats");
	const settingsFile = join(configDir, "settings.json");

	mkdirSync(join(library, "Chillhop"), { recursive: true });
	writeFileSync(join(library, "03 - Arcade Dreams.mp3"), "");
	mkdirSync(home, { recursive: true });
	mkdirSync(configDir, { recursive: true });

	const settings = {
		libraryRoot: library,
		...(options.shortcuts === undefined ? {} : { shortcuts: options.shortcuts }),
		...(options.asciiGlyphs === undefined ? {} : { asciiGlyphs: options.asciiGlyphs }),
	};
	writeFileSync(settingsFile, options.raw ?? `${JSON.stringify(settings, null, "\t")}\n`);

	return { root, home, library, configHome, configDir, settingsFile };
}

/**
 * Run with the fixture's directories as the ones the entry point resolves (S10, S19). The entry point
 * reads `process.env` and the home directory when the factory runs, and closes over the values it read,
 * so the swap only has to be in place around that call. Both config variables are set so the fixture
 * holds on every platform the suite runs on.
 */
async function as(target: Fixture, run: () => void | Promise<void>): Promise<void> {
	const saved = {
		XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
		XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
		APPDATA: process.env.APPDATA,
		LOCALAPPDATA: process.env.LOCALAPPDATA,
		HOME: process.env.HOME,
	};
	process.env.XDG_CONFIG_HOME = target.configHome;
	// The catalog's cache is one of the extension's own files (S20): it belongs in the fixture, never in
	// the real user's cache directory.
	process.env.XDG_CACHE_HOME = join(target.root, "cache");
	process.env.APPDATA = target.configHome;
	process.env.LOCALAPPDATA = target.configHome;
	process.env.HOME = target.home;
	try {
		await run();
	} finally {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

interface CommandEntry {
	readonly description?: string;
	readonly handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

interface ShortcutEntry {
	readonly description?: string;
	readonly handler: (ctx: ExtensionContext) => Promise<void> | void;
}

interface Host {
	readonly pi: ExtensionAPI;
	readonly ctx: ExtensionCommandContext;
	readonly commands: Map<string, CommandEntry>;
	/** Read after the factory ran: the keys arrive during registration, not before it. */
	readonly shortcutKeys: () => string[];
	readonly shortcutDescriptions: Map<string, string | undefined>;
	readonly handlers: Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>;
	/** Every `setWidget` payload, in order: the multi-line surface `--keys` prints into (S22). */
	readonly widgets: string[][];
	readonly notices: string[];
	/** Every overlay the adapter built, in order (S15). */
	readonly overlays: Component[];
}

/** The handle `ctx.ui.custom` hands back; the adapter only asks it for focus and for its finish. */
function fakeHandle(): OverlayHandle {
	let hidden = false;
	return {
		hide: () => {},
		setHidden: (value: boolean) => {
			hidden = value;
		},
		isHidden: () => hidden,
		focus: () => {},
		unfocus: () => {},
		isFocused: () => false,
		getBounds: () => undefined,
	};
}

/** A Pi with no terminal, no process and no disk of its own. */
function host(): Host {
	const commands = new Map<string, CommandEntry>();
	const shortcutDescriptions = new Map<string, string | undefined>();
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
	const widgets: string[][] = [];
	const notices: string[] = [];
	const overlays: Component[] = [];

	const tui = {
		getFocusedComponent: () => EDITOR,
		requestRender: () => {},
		terminal: { rows: 24, columns: COLUMNS },
	} as unknown as TUI;

	const ui = {
		theme: THEME,
		setStatus: () => {},
		notify: (message: string) => {
			notices.push(message);
		},
		setWidget: (_key: string, content: string[] | undefined) => {
			if (content) widgets.push([...content]);
		},
		custom: (
			factory: (tui: TUI, theme: Theme, keybindings: unknown, done: (result: unknown) => void) => Component,
			options?: {
				overlay?: boolean;
				overlayOptions?: { nonCapturing?: boolean } | (() => { nonCapturing?: boolean });
				onHandle?: (handle: OverlayHandle) => void;
			},
		) => {
			let finish!: (value: unknown) => void;
			const settled = new Promise<unknown>((resolve) => {
				finish = resolve;
			});
			const component = factory(tui, THEME, {}, (value: unknown) => finish(value));
			overlays.push(component);
			options?.onHandle?.(fakeHandle());
			return settled;
		},
	} as unknown as ExtensionUIContext;

	const ctx = { ui, mode: "tui", hasUI: true, cwd: "/tmp", shutdown: () => {} } as ExtensionCommandContext;

	const pi = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) => {
			handlers.set(event, handler);
			return () => {};
		},
		registerCommand: (name: string, options: CommandEntry) => {
			commands.set(name, options);
		},
		registerShortcut: (key: string, options: ShortcutEntry) => {
			shortcutDescriptions.set(key, options.description);
		},
	} as unknown as ExtensionAPI;

	return {
		pi,
		ctx,
		commands,
		shortcutKeys: () => [...shortcutDescriptions.keys()],
		shortcutDescriptions,
		handlers,
		widgets,
		notices,
		overlays,
	};
}

/** `/sb-music <args>` through the handler Pi registered. */
async function command(h: Host, args: string): Promise<void> {
	const entry = h.commands.get("sb-music");
	assert.ok(entry, "/sb-music was never registered");
	await entry.handler(args, h.ctx);
}

/** The last block of lines `--keys` or `--help` printed (S22). */
function report(h: Host): string[] {
	const last = h.widgets.at(-1);
	assert.ok(last, "nothing was printed");
	return last;
}

/**
 * How long `settle()` is willing to wait, in wall-clock milliseconds. The scanner really reads the
 * temporary tree below — that is the whole point of this test — so the ceiling has to survive a loaded
 * CI runner and a cold filesystem, not just the few milliseconds a warm local run takes. Five seconds is
 * hundreds of times the observed cost — a three-entry temporary tree answers in single digits of
 * milliseconds — and a wait that succeeds returns as soon as the row appears, so the margin is only ever
 * paid by a genuine failure. It is a fixed budget, not a race that sometimes passes: when it runs out, the
 * wait stops and says it was a timeout.
 */
const SETTLE_BUDGET_MS = 5_000;

/** Short enough to notice the row promptly, long enough not to spin a core for the whole budget. */
const SETTLE_POLL_MS = 10;

/**
 * Let the real scanner answer. `scanFolder` really reads the temporary folder, so the listing arrives a
 * few turns later; this waits on the observable — the row appearing — instead of on a fixed delay.
 *
 * The budget is measured on the clock and not counted in turns, because the slow part on a loaded runner
 * is the disk, not this loop. When it runs out the failure is reported as what it is — a timeout naming
 * the budget and the row it was waiting for — and not left to the caller's assertion, which would blame
 * the listing and send whoever reads a red CI log to the scanner instead of to the wait.
 */
async function settle(component: Component | undefined, needle = "Chillhop/"): Promise<string[]> {
	assert.ok(component, "the card never opened");
	const card = component;
	const deadline = Date.now() + SETTLE_BUDGET_MS;
	let frame = card.render(COLUMNS);
	while (!frame.join("\n").includes(needle)) {
		if (Date.now() >= deadline) {
			assert.fail(
				`settle timed out after ${SETTLE_BUDGET_MS} ms: the card never showed ${JSON.stringify(needle)}\n` +
					"this waits for the real scanFolder to answer over the temporary tree, not for a stub, so the\n" +
					"budget running out means the answer did not arrive in time — it does not by itself mean the\n" +
					"listing is wrong. The frame below is what the card had when the wait gave up:\n" +
					frame.join("\n"),
			);
		}
		await new Promise<void>((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
		frame = card.render(COLUMNS);
	}
	return frame;
}

/** End the session the card opened, so its one-second tick does not outlive the test (T16). */
async function shutdown(h: Host): Promise<void> {
	await h.handlers.get("session_shutdown")?.(undefined, h.ctx);
}

describe("the entry point Pi loads (S1, S2, S8)", () => {
	it("takes the command and the four keys from the settings file, not from the defaults (S1, S2)", async () => {
		// Two keys are edited in the file on purpose: a binding read from the defaults would be invisible.
		const f = fixture({ shortcuts: { overlay: "ctrl+alt+m", next: "ctrl+alt+j" } });
		await as(f, () => {
			const h = host();
			sbMusic(h.pi, { fetch: catalogFetch });

			assert.deepEqual(
				h.shortcutKeys().sort(),
				["ctrl+alt+j", "ctrl+alt+m", "ctrl+alt+p", "ctrl+alt+space"],
				"the four keys are the ones the file names",
			);
			// The command announces the overlay key that is configured, not a literal (S22 requirement 8).
			assert.match(h.commands.get("sb-music")?.description ?? "", /ctrl\+alt\+m/);
			// Nothing but the registrations happens at load time (S1, S6): the player is a session's job.
			assert.deepEqual([...h.handlers.keys()].sort(), ["session_shutdown", "session_start"]);
			assert.deepEqual(h.overlays, [], "loading the extension opens nothing");
		});
	});

	it("prints the settings file it resolved, and the keys this session bound (S2, S22)", async () => {
		const f = fixture({ shortcuts: { overlay: "ctrl+alt+m" } });
		await as(f, async () => {
			const h = host();
			sbMusic(h.pi, { fetch: catalogFetch });

			await command(h, "--keys");

			const lines = report(h);
			// The file is the one the XDG convention resolves, not a guess made by the test (S10).
			assert.equal(lines[0], `sb-music keys · ${f.settingsFile}`);
			assert.ok(
				lines.some((line) => line.includes("ctrl+alt+m")),
				"the report names the key the file carries",
			);
			assert.deepEqual(h.overlays, [], "--keys is text: it must not build the card");
		});
	});

	it("carries a settings file it could not use into the report, and leaves it alone (S2, R3-001)", async () => {
		// The loader keeps a broken file untouched so the user can fix it (L19). The report is exactly where
		// they look when a change will not save, so the warning travels with it.
		const f = fixture({ raw: "{\n" });
		await as(f, async () => {
			const h = host();
			sbMusic(h.pi, { fetch: catalogFetch });

			await command(h, "--keys");

			const lines = report(h);
			assert.ok(
				lines.some((line) => line.includes(`${f.settingsFile} is not valid JSON`)),
				`the report carries the loader's warning, got:\n${lines.join("\n")}`,
			);
			assert.ok(lines.includes("these are the defaults in memory: the file above could not be used"));
			assert.equal(readFileSync(f.settingsFile, "utf8"), "{\n", "a file it could not use is not rewritten");
		});
	});

	it("saves through the atomic writer it owns, into the file it resolved (S2, S22)", async () => {
		const f = fixture({});
		await as(f, async () => {
			const h = host();
			sbMusic(h.pi, { fetch: catalogFetch });

			await command(h, "--keys overlay=ctrl+alt+k");

			assert.match(report(h)[0] ?? "", /^sb-music keys saved · /);
			const written = JSON.parse(readFileSync(f.settingsFile, "utf8")) as {
				libraryRoot: string;
				shortcuts: Record<string, string>;
			};
			assert.equal(written.shortcuts.overlay, "ctrl+alt+k");
			// The rest of the file survives the edit: this is the loader's shape written back, not a new one.
			assert.equal(written.libraryRoot, f.library);
			// The writer is the atomic one (tmp + rename in the same directory): no straggler is left behind.
			assert.deepEqual(readdirSync(f.configDir), ["settings.json"]);
		});
	});

	it("opens on the catalog, and reads the file's library root when it is asked for (S5, S14, S16, S20)", async () => {
		const f = fixture({ asciiGlyphs: true });
		await as(f, async () => {
			const h = host();
			sbMusic(h.pi, { fetch: catalogFetch, probe: FOUND_MPV });
			try {
				await command(h, "");

				const component = h.overlays.at(-1);
				// The card opens in the catalog (S20, L74) and the catalog's loader is the next slice: the
				// library is the source this one `l` asks for, and that key is what proves the wiring.
				component?.handleInput?.("l");
				// `settle` only returns once `Chillhop/` is on the frame, and that default needle is the proof the
				// scanner and the configured root are wired. The assertion that used to stand here re-checked the
				// same row and could never fail once the wait succeeded (T32), so it says its intent and leaves
				// the proof to `settle`.
				const frame = await settle(component);
				assert.ok(frame.join("\n").includes("Arcade Dreams"), "the track in the root is listed");
				// `asciiGlyphs: true` from the file reaches the frame's own outline (S16).
				assert.match(frame[0] ?? "", /^\+-+\+$/, "the frame uses the ASCII family the file asked for");

				// The ceiling is HOME, not the library root: one `u` leaves the root and lists what is above it (S14).
				component?.handleInput?.("u");
				const up = await settle(component, "Music/");
				assert.ok(up.join("\n").includes("Music/"), `u goes up to HOME, got:\n${up.join("\n")}`);
				assert.ok(!up.join("\n").includes("at home"), "HOME is the ceiling, so the first `u` still moves");

				// And there it stops: the card walks up to HOME inclusive and no further (S14).
				component?.handleInput?.("u");
				const stayed = component?.render(COLUMNS) ?? [];
				assert.ok(stayed.join("\n").includes("at home"), `the footer says why it did not move:\n${stayed.join("\n")}`);
				assert.ok(stayed.join("\n").includes("Music/"), "and the listing did not move either");
			} finally {
				await shutdown(h);
			}
		});
	});

	it("reports an mpv it could not confirm instead of announcing playback is ready (S6)", async () => {
		// The installer case of L15: a binary that exists and does not answer must not be announced as found.
		const f = fixture({});
		await as(f, async () => {
			const h = host();
			sbMusic(h.pi, {
				fetch: catalogFetch,
				probe: { exists: () => true, run: () => ({ ok: false, reason: "mpv printed no version" }) },
			});
			try {
				await command(h, "");

				assert.ok(
					h.notices.some((notice) => notice.includes("mpv")),
					`a binary that does not answer is a state to show, got: ${JSON.stringify(h.notices)}`,
				);
			} finally {
				await shutdown(h);
			}
		});
	});

	it("says nothing about mpv when discovery confirmed one (S6)", async () => {
		const f = fixture({});
		await as(f, async () => {
			const h = host();
			sbMusic(h.pi, { fetch: catalogFetch, probe: FOUND_MPV });
			try {
				await command(h, "");

				assert.deepEqual(h.notices, [], "a working mpv is not a warning");
			} finally {
				await shutdown(h);
			}
		});
	});
});

/** The platform the entry point resolves, mirrored here so the test knows where the cache lands (S19, S10). */
function platformOf(): Platform {
	if (process.platform === "win32") return "win32";
	if (process.platform === "darwin") return "darwin";
	return "linux";
}

/** The cache file the XDG convention resolves for the current fixture (S20). */
function cacheFile(): string {
	return catalogCachePath({ platform: platformOf(), env: process.env, home: homedir() });
}

/** One album as the cache stores it: metadata only, never a URL (S20). */
const CHILLHOP: CatalogAlbumListing = {
	slug: "chillhop",
	title: "Chillhop",
	tracks: [{ slug: "arcade-dreams", title: "Arcade Dreams", durationMs: 200_000 }],
};

/** The catalog track the resolver is asked about: `origin + id`, never a URL (S3, S20). */
const CATALOG_TRACK: Track = { id: "catalog:chillhop/arcade-dreams", title: "Arcade Dreams", origin: "catalog" };

/** A catalog that answers one URL per call, so a second play paying for its own token is observable (S20). */
function countingCatalog(): { port: Pick<CatalogHttp, "readTrackUrl">; asked: string[] } {
	const asked: string[] = [];
	return {
		asked,
		port: {
			readTrackUrl: (albumSlug, trackSlug) => {
				asked.push(`${albumSlug}/${trackSlug}`);
				return Promise.resolve({ ok: true, value: `https://streambeats.test/${asked.length}?token=abc` });
			},
		},
	};
}

describe("the resolver the root builds owns both sources (S7, S20)", () => {
	it("gives a local track its own path and asks nobody", async () => {
		const catalog = countingCatalog();

		const result = await createResolver(catalog.port).resolve({ id: "/music/a.mp3", title: "a.mp3", origin: "local" });

		assert.deepEqual(result, { ok: true, target: { uri: "/music/a.mp3" } });
		assert.deepEqual(catalog.asked, [], "a local file is already its own target");
	});

	it("resolves the catalog id into a URL with a bounded life", async () => {
		const catalog = countingCatalog();

		const result = await createResolver(catalog.port, () => 1_000).resolve(CATALOG_TRACK);

		assert.deepEqual(catalog.asked, ["chillhop/arcade-dreams"], "the model's own reader took the id apart");
		assert.deepEqual(result, {
			ok: true,
			target: { uri: "https://streambeats.test/1?token=abc", expiresAt: 1_000 + 5 * 60_000 },
		});
	});

	it("pays for a fresh token on every play instead of reusing the last one", async () => {
		// The invariant S20 states and AGENTS.md repeats: a cached URL is an expired URL, so nothing here
		// remembers what the previous play resolved.
		const catalog = countingCatalog();
		const resolver = createResolver(catalog.port);

		const first = await resolver.resolve(CATALOG_TRACK);
		const second = await resolver.resolve(CATALOG_TRACK);

		const uriOf = (result: typeof first): string | undefined => (result.ok ? result.target.uri : undefined);
		assert.equal(catalog.asked.length, 2, "each play asked for its own");
		assert.notEqual(uriOf(first), uriOf(second), "and the two URLs are not the same token");
	});

	it("maps the catalog's failures onto the names the resolver already has", async () => {
		for (const failure of ["network", "not-found", "scrape"] as const) {
			const resolver = createResolver({ readTrackUrl: () => Promise.resolve({ ok: false, failure }) });

			assert.deepEqual(await resolver.resolve(CATALOG_TRACK), { ok: false, failure }, failure);
		}
	});

	it("refuses an id that names no album and track without asking for a URL", async () => {
		const catalog = countingCatalog();
		const resolver = createResolver(catalog.port);

		const result = await resolver.resolve({ id: "catalog:broken", title: "x", origin: "catalog" });

		assert.deepEqual(result, { ok: false, failure: "not-found" });
		assert.deepEqual(catalog.asked, [], "there is nothing to ask about");
	});
});

describe("the catalog at the composition root (S20)", () => {
	it("opens from the cache file the XDG convention resolves and never touches the network", async () => {
		const f = fixture({});
		await as(f, async () => {
			const file = cacheFile();
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, `${JSON.stringify({ version: 1, fetchedAt: Date.now(), albums: [CHILLHOP] })}\n`);
			let calls = 0;
			const h = host();
			sbMusic(h.pi, {
				fetch: async () => {
					calls += 1;
					return { status: 200, text: MUSIC_PAGE };
				},
				probe: FOUND_MPV,
			});
			try {
				await command(h, "");

				assert.equal(calls, 0, "a warm cache is the whole opening: no socket at all");
				assert.match(h.overlays.at(-1)?.render(COLUMNS).join("\n") ?? "", /Chillhop/);
			} finally {
				await shutdown(h);
			}
		});
	});

	it("reads the catalog on open, paints the albums and writes the cache once", async () => {
		const f = fixture({});
		await as(f, async () => {
			const h = host();
			sbMusic(h.pi, { fetch: catalogFetch, probe: FOUND_MPV });
			try {
				await command(h, "");
				// The read is asynchronous by contract; what it must not do is leave a blank card behind.
				const frame = await settle(h.overlays.at(-1), "Groovy");
				assert.ok(frame.join("\n").includes("Better When"), "the list grew with the albums the index announced");

				const file = cacheFile();
				const written = JSON.parse(readFileSync(file, "utf8")) as { albums: { slug: string }[] };
				assert.deepEqual(
					written.albums.map((album) => album.slug),
					["better-when-im-high-remix", "electric", "groovy"],
					"the metadata the pass read is what got cached",
				);
				// L80 made this structural — the cache has no field for a token — and the file proves it.
				assert.equal(readFileSync(file, "utf8").includes("http"), false, "no audio URL is ever persisted");
			} finally {
				await shutdown(h);
			}
		});
	});
});
