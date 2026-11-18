/**
 * Library scanning (S5, S14). One of the four I/O owners: it reads the current folder, one level
 * only, and it never writes anything inside the library.
 *
 * The module never throws at its caller. A folder that does not exist, one we cannot read and one
 * with nothing playable are all *data*: the card decides how to say it, this layer decides what is
 * true. Every name that leaves here has been neutralized (S5), and the path is left raw because it
 * is identity, not display.
 *
 * The scan is asynchronous (S21): it runs inside the host's input path, and a big folder or a network
 * mount used to freeze the editor while the listing was read. Failure is still data, never a
 * rejection, so a caller that cannot wait has nothing to catch either.
 */
import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { AUDIO_EXTENSIONS, isAudioFile, neutralizeName } from "../core/names.ts";
import type { Folder, LibraryEntry, Track } from "../types.ts";

/** Shared vocabulary (see lib/types.ts): the card holds these rows in its state. */
export type { LibraryEntry };

/** What the caller knows about the configured library (S2, S14), echoed in the no-audio state. */
export interface LibraryContext {
	/** The root the card starts at, from settings. */
	readonly libraryRoot: string;
	/** The settings file the root came from; the no-audio message names it. */
	readonly settingsPath: string;
}

/** Why the current folder cannot be shown at all (S5). Both carry the path the user asked for. */
export type ScanFailure =
	/** The path does not exist, or it is a file rather than a folder. */
	| { readonly kind: "missing"; readonly path: string }
	/** The path exists but the process may not read it. */
	| { readonly kind: "unreadable"; readonly path: string };

/**
 * A folder with nothing playable (S5): it says what is missing, where the user is, which root is
 * configured and which file that root came from. It accompanies the listing instead of replacing
 * it, so a folder that only holds subfolders can still be navigated.
 */
export interface NoAudio {
	readonly path: string;
	readonly libraryRoot: string;
	readonly settingsPath: string;
	readonly extensions: readonly string[];
}

export type ScanResult =
	| {
			readonly ok: true;
			/** Canonical path of the folder that was listed (S14). */
			readonly path: string;
			readonly entries: readonly LibraryEntry[];
			/** Present only when the folder has no audio at all. */
			readonly noAudio?: NoAudio;
	  }
	| { readonly ok: false; readonly path: string; readonly failure: ScanFailure };

/** Alphabetical for a human, deterministic for a test: fixed locale, no environment lookup. */
const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

function compareNames(left: string, right: string): number {
	const collated = collator.compare(left, right);
	if (collated !== 0) return collated;
	// A stable tie-break for names that differ only in case or in accents.
	return left < right ? -1 : left > right ? 1 : 0;
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
}

/** `ENOENT`/`ENOTDIR` mean "nothing to list here"; everything else means "we are not allowed". */
function failureOf(error: unknown, path: string): ScanFailure {
	const code = errorCode(error);
	return { kind: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable", path };
}

/** Canonical form of a path, best effort: a folder we cannot resolve is kept as it was found. */
async function canonical(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		return path;
	}
}

/** Whether a path names a directory, following symlinks. A broken link answers false. */
async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

/** A symlink is listed as whatever it points at, so the entry is not skipped for being a link. */
async function isFolder(dirent: Dirent, path: string): Promise<boolean> {
	return dirent.isDirectory() || (dirent.isSymbolicLink() && (await isDirectory(path)));
}

/**
 * List the current folder: direct children only, folders first, then audio files, each group
 * alphabetical (S5). Hidden entries are skipped, every name is neutralized, and no failure escapes
 * as an exception.
 */
export async function scanFolder(dir: string, ctx: LibraryContext): Promise<ScanResult> {
	let path: string;
	try {
		// Canonical first: a symlinked folder is listed under its real path, so `u` and the ceiling
		// both compare real paths and navigation cannot loop (S14).
		path = await realpath(dir);
	} catch (error) {
		return { ok: false, path: dir, failure: failureOf(error, dir) };
	}

	let dirents: Dirent[];
	try {
		dirents = await readdir(path, { withFileTypes: true });
	} catch (error) {
		return { ok: false, path, failure: failureOf(error, path) };
	}

	const folders: Folder[] = [];
	const tracks: Track[] = [];

	for (const dirent of dirents) {
		const name = dirent.name;
		// Hidden: dotfiles, .DS_Store and the macOS ._* twins (S5). The Go repo's issue #88 was a queue
		// poisoned by these; the rule is a prefix, so it needs no list of known offenders.
		if (name.startsWith(".")) continue;

		const full = join(path, name);
		const display = neutralizeName(name);

		if (await isFolder(dirent, full)) {
			folders.push({ path: await canonical(full), name: display });
			continue;
		}
		// Sockets, fifos and devices are neither enterable nor playable.
		if (!dirent.isFile() && !dirent.isSymbolicLink()) continue;
		if (!isAudioFile(name)) continue;
		// The track number prefix and the extension are removed later, by the now-playing formatter
		// (S12, T7): this layer has no business guessing what a file is called.
		tracks.push({ id: full, title: display, origin: "local" });
	}

	folders.sort((left, right) => compareNames(left.name, right.name));
	tracks.sort((left, right) => compareNames(left.title, right.title));

	const entries: LibraryEntry[] = [
		...folders.map((folder): LibraryEntry => ({ kind: "folder", folder })),
		...tracks.map((track): LibraryEntry => ({ kind: "track", track })),
	];

	if (tracks.length > 0) return { ok: true, path, entries };

	const noAudio: NoAudio = {
		path,
		libraryRoot: ctx.libraryRoot,
		settingsPath: ctx.settingsPath,
		extensions: AUDIO_EXTENSIONS,
	};
	return { ok: true, path, entries, noAudio };
}
