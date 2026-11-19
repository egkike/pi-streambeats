/**
 * The Pi entry point (S1, S8). This is the only file besides `lib/host/` that touches the host
 * packages, and it does so as types: Pi calls the default factory with its own `ExtensionAPI` and
 * the adapter receives it. The factory registers the command, the shortcut and the session hooks;
 * it starts no process and opens no socket, which is why mpv is created on `session_start` and not
 * here (docs/extensions.md, "Long-lived resources and shutdown").
 *
 * It is also the composition root of the catalog (S20, L82): the network, the cache file and the
 * resolver that pays for a signed URL are all built here, and none of them reaches `lib/core/`.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { catalogCachePath, isCatalogFresh, readCatalogCache, writeCatalogCache } from "../lib/catalog/cache.ts";
import { type CatalogFetch, type CatalogHttp, createCatalogHttp } from "../lib/catalog/http.ts";
import { DEFAULT_VOLUME, parseCatalogTrackId } from "../lib/core/model.ts";
import { registerSbMusic } from "../lib/host/host.ts";
import { ceilingFor } from "../lib/library/paths.ts";
import { scanFolder } from "../lib/library/scan.ts";
import {
	createMpvPlayer,
	discoverMpv,
	diskProbe,
	type MpvDiscoveryContext,
	type PlayerSocket,
	type SpawnedProcess,
} from "../lib/player/mpv.ts";
import { loadSettings, type Platform, saveSettings, settingsPath } from "../lib/settings.ts";
import type { ResolveResult, Track, TrackResolver } from "../lib/types.ts";

/** How long a resolved catalog URL is trusted (S20). It is asked for again before the next play anyway. */
const CATALOG_TARGET_TTL_MS = 5 * 60_000;

/** The three platforms S19 promises; every other Node platform is treated as POSIX/Linux. */
function platformOf(): Platform {
	if (process.platform === "win32") return "win32";
	if (process.platform === "darwin") return "darwin";
	return "linux";
}

/**
 * The ambient `fetch`, shaped the way `lib/catalog` asks for it (S20). It lives here and nowhere else:
 * the reader receives it as a parameter, so it owns no socket, its tests drive it with a fake, and this
 * file stays the one place allowed to know the network exists.
 */
const ambientFetch: CatalogFetch = async (url, init) => {
	const response = await fetch(url, { signal: init.signal });
	return { status: response.status, text: await response.text() };
};

/**
 * The two things a test has to replace at the root, and production never does. `fetch` is injected for
 * the same reason S20 gives for the whole catalog: a test that opens the card must not open a socket.
 * `probe` is the same rule for finding mpv (S6): discovery confirms the binary by RUNNING it, so a test
 * hands in the answers instead of executing whatever mpv the machine happens to have.
 */
export interface SbMusicOverrides {
	readonly fetch?: CatalogFetch;
	readonly probe?: Pick<MpvDiscoveryContext, "exists" | "run">;
}

/**
 * The resolver seam (S7) with both implementations behind it (S20). A local track is already its own
 * playable path; a catalog track is `catalog:<albumSlug>/<trackSlug>` and the URL behind it carries a
 * token, so it is asked for **immediately before the play** and never stored — a cached URL is a URL
 * that has already expired.
 */
export function createResolver(
	catalog: Pick<CatalogHttp, "readTrackUrl">,
	now: () => number = Date.now,
): TrackResolver {
	return {
		// Nothing is warmed ahead: a signed URL resolved now may be an expired URL by the next track.
		prefetchable: false,
		async resolve(track: Track): Promise<ResolveResult> {
			if (track.origin === "local") return { ok: true, target: { uri: track.id } };

			// The one reader of the id format, so no second split of the string can drift from it.
			const parsed = parseCatalogTrackId(track.id);
			if (!parsed) return { ok: false, failure: "not-found" };
			const url = await catalog.readTrackUrl(parsed.albumSlug, parsed.trackSlug);
			// The catalog's three failures are the resolver's own names, so the mapping is the identity.
			if (!url.ok) return { ok: false, failure: url.failure };
			return { ok: true, target: { uri: url.value, expiresAt: now() + CATALOG_TARGET_TTL_MS } };
		},
	};
}

export default function sbMusic(pi: ExtensionAPI, overrides: SbMusicOverrides = {}): void {
	const platform = platformOf();
	const env = process.env;
	const home = homedir();
	const context = { platform, env, home };
	const loaded = loadSettings(context);
	const settings = loaded.settings;
	const settingsFile = settingsPath(context);
	const ceiling = ceilingFor(platform, home, settings.libraryRoot);
	const catalog = createCatalogHttp({ fetch: overrides.fetch ?? ambientFetch });

	registerSbMusic(pi, {
		settings,
		ceiling,
		// The resolved path is printed by `--keys`, and that report is the only place the user sees it (S22).
		settingsFile,
		warning: loaded.warning,
		// The adapter asks; this file is the only one that writes (S8, S22).
		saveSettings: (next) => saveSettings(context, next),
		scan: (path: string) => scanFolder(path, { libraryRoot: settings.libraryRoot, settingsPath: settingsFile }),
		// The catalog's reader, its cache file and its clock (S20). The cache is injected rather than
		// imported by the adapter: the direction guard lets `catalog` reach down and never up (S8).
		catalog,
		catalogCache: { read: readCatalogCache, write: writeCatalogCache, isFresh: isCatalogFresh },
		catalogCachePath: catalogCachePath(context),
		createPlayer: (onReport) => {
			// Asked once per session: the resolver is pure and receives the platform, the environment, the
			// setting and the two pieces of I/O (S6, T12).
			const mpv = discoverMpv({
				platform,
				env,
				configured: settings.mpvPath,
				...(overrides.probe ?? diskProbe),
			});
			// S6: a binary that exists and does not answer is a state for the user. It is said here, at the one
			// moment the answer is known, instead of waiting for a play that would fail with a vaguer reason.
			if (!mpv.ok) onReport({ kind: "unavailable", message: mpv.message });

			return createMpvPlayer({
				// Explicit argv and `shell: false`: no path, title or file name is ever interpolated.
				spawn: (command, args) =>
					spawn(command, [...args], { stdio: ["ignore", "ignore", "pipe"], shell: false }) as unknown as SpawnedProcess,
				connect: (target) => connect(target) as unknown as PlayerSocket,
				// Both sources, one seam: the player still asks for a target and loads it (S7, S20).
				resolve: createResolver(catalog),
				onReport,
				platform,
				env,
				home,
				// The confirmed binary is one more injected value: the player stays testable without a process. The two
				// failures are wired differently on purpose (S6, R4-002, R4-003). **Definitive** — a relative
				// `mpvPath`, one pointing nowhere, nothing on PATH and nothing in the known locations — has no command
				// to spawn, so it travels as a refusal and the play path reports instead of spawning: handing PATH the
				// bare name would confirm the very binary the notice just said it could not. **Inconclusive** still
				// hands the candidate over, because a slow or wedged mpv is not a broken one.
				...(mpv.ok ? { mpvPath: mpv.command } : mpv.definitive ? { refusal: mpv.message } : { mpvPath: mpv.command }),
				volume: DEFAULT_VOLUME,
			});
		},
	});
}
