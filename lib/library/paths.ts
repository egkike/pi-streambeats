/**
 * Navigation boundary (S14): where `u` stops. The card walks up from `libraryRoot` and stops at
 * HOME inclusive; when `libraryRoot` lives outside HOME, the root itself is the ceiling, because
 * going above it would leave the library the user configured.
 *
 * The function is pure and synchronous on purpose: both paths are already canonical (the scanner
 * resolves symlinks), so the answer is a string comparison and the filesystem is never consulted.
 * That is what makes all three platforms testable from one of them.
 */
import { type PlatformPath, posix, win32 } from "node:path";
import type { Platform } from "../settings.ts";

/** The path flavour of a platform, so a Windows path can be answered on Linux (S19). */
function flavour(platform: Platform): PlatformPath {
	return platform === "win32" ? win32 : posix;
}

/** Drop a trailing separator (except on the root itself) so two spellings of one folder compare equal. */
function trimSeparator(path: PlatformPath, value: string): string {
	if (value.length <= path.sep.length) return value;
	return value.endsWith(path.sep) ? value.replace(/[\\/]+$/, "") || path.sep : value;
}

/**
 * Whether `candidate` is `ancestor` or lives under it, with no string prefix shortcuts:
 * `/home/kikette` is not inside `/home/kike`. `path.relative` also answers the Windows questions,
 * where the comparison is case-insensitive and a different drive produces an absolute result.
 */
function contains(path: PlatformPath, ancestor: string, candidate: string): boolean {
	const relative = path.relative(ancestor, candidate);
	if (relative === "") return true;
	return !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * The highest folder navigation may reach (S14). Inputs are canonical; the result is one of them.
 */
export function ceilingFor(platform: Platform, home: string, libraryRoot: string): string {
	const path = flavour(platform);
	const canonicalHome = trimSeparator(path, home);
	const canonicalRoot = trimSeparator(path, libraryRoot);
	return contains(path, canonicalHome, canonicalRoot) ? canonicalHome : canonicalRoot;
}
