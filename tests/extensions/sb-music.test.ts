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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionUIContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import sbMusic from "../../extensions/sb-music.ts";

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
		APPDATA: process.env.APPDATA,
		HOME: process.env.HOME,
	};
	process.env.XDG_CONFIG_HOME = target.configHome;
	process.env.APPDATA = target.configHome;
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
 * Let the real scanner answer. `scanFolder` really reads the temporary folder, so the listing arrives a
 * few turns later; this waits on the observable — the row appearing — instead of on a fixed delay.
 */
async function settle(component: Component | undefined, needle = "Chillhop/"): Promise<string[]> {
	assert.ok(component, "the card never opened");
	let frame = component.render(COLUMNS);
	for (let attempt = 0; attempt < 200 && !frame.join("\n").includes(needle); attempt += 1) {
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
		frame = component.render(COLUMNS);
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
			sbMusic(h.pi);

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
			sbMusic(h.pi);

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
			sbMusic(h.pi);

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
			sbMusic(h.pi);

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

	it("opens the card on the file's library root, with the scanner, the glyphs and the ceiling (S5, S14, S16)", async () => {
		const f = fixture({ asciiGlyphs: true });
		await as(f, async () => {
			const h = host();
			sbMusic(h.pi);
			try {
				await command(h, "");

				const component = h.overlays.at(-1);
				const frame = await settle(component);
				// The listing is what `scanFolder` found in the configured root: the scanner and the root are wired.
				assert.ok(
					frame.join("\n").includes("Chillhop/"),
					`the folder in ${f.library} is listed, got:\n${frame.join("\n")}`,
				);
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
});
