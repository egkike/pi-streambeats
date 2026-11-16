/**
 * The Pi entry point (S1, S8). This is the only file besides `lib/host/` that touches the host
 * packages, and it does so as types: Pi calls the default factory with its own `ExtensionAPI` and
 * the adapter receives it. The factory registers the command, the shortcut and the session hooks;
 * it starts no process and opens no socket, which is why mpv is created on `session_start` and not
 * here (docs/extensions.md, "Long-lived resources and shutdown").
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_VOLUME } from "../lib/core/model.ts";
import { registerSbMusic } from "../lib/host/host.ts";
import { ceilingFor } from "../lib/library/paths.ts";
import { scanFolder } from "../lib/library/scan.ts";
import { createMpvPlayer, type PlayerSocket, type SpawnedProcess } from "../lib/player/mpv.ts";
import { loadSettings, type Platform, settingsPath } from "../lib/settings.ts";
import type { ResolveResult, Track, TrackResolver } from "../lib/types.ts";

/** The three platforms S19 promises; every other Node platform is treated as POSIX/Linux. */
function platformOf(): Platform {
	if (process.platform === "win32") return "win32";
	if (process.platform === "darwin") return "darwin";
	return "linux";
}

/**
 * v1's only resolver (S7): a local track is already its own playable path. Kept inline because it
 * is the identity case, and the catalog's second implementation will replace it behind the same
 * `TrackResolver` seam.
 */
const localResolver: TrackResolver = {
	prefetchable: false,
	resolve: (track: Track): Promise<ResolveResult> => Promise.resolve({ ok: true, target: { uri: track.id } }),
};

export default function sbMusic(pi: ExtensionAPI): void {
	const platform = platformOf();
	const env = process.env;
	const home = homedir();
	const context = { platform, env, home };
	const loaded = loadSettings(context);
	const settings = loaded.settings;
	const settingsFile = settingsPath(context);
	const ceiling = ceilingFor(platform, home, settings.libraryRoot);

	registerSbMusic(pi, {
		settings,
		ceiling,
		warning: loaded.warning,
		scan: (path: string) => scanFolder(path, { libraryRoot: settings.libraryRoot, settingsPath: settingsFile }),
		createPlayer: (onReport) =>
			createMpvPlayer({
				// Explicit argv and `shell: false`: no path, title or file name is ever interpolated.
				spawn: (command, args) =>
					spawn(command, [...args], { stdio: ["ignore", "ignore", "pipe"], shell: false }) as unknown as SpawnedProcess,
				connect: (target) => connect(target) as unknown as PlayerSocket,
				resolve: localResolver,
				onReport,
				platform,
				env,
				home,
				volume: DEFAULT_VOLUME,
			}),
	});
}
