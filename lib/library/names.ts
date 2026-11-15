/**
 * Name rules (S5). File names come from disk and are untrusted: a name can carry ANSI or OSC
 * escape sequences that repaint the terminal or write the clipboard. Nothing that leaves this
 * layer is a raw name, and nothing here touches the filesystem or the terminal — truncation is the
 * view's job, so a name is cleaned here and shortened there.
 *
 * This module is pure and synchronous: text in, text out. It imports nothing, which lets the core
 * and the host adapter reuse it without pulling in I/O.
 */

/** The nine audio extensions of the Go repo (S5), leading dot included: this is what a folder is missing. */
export const AUDIO_EXTENSIONS = [".mp3", ".flac", ".ogg", ".oga", ".opus", ".m4a", ".aac", ".wav", ".wma"] as const;

const AUDIO_EXTENSION_SET: ReadonlySet<string> = new Set(AUDIO_EXTENSIONS);

/**
 * Whether a file name carries one of the nine audio extensions (S5). The match is case-insensitive
 * because files copied from a case-insensitive filesystem often arrive upper-cased.
 */
export function isAudioFile(name: string): boolean {
	const dot = name.lastIndexOf(".");
	// `dot <= 0` also rejects a dotfile such as ".mp3": it has no name, only a hidden prefix.
	if (dot <= 0) return false;
	return AUDIO_EXTENSION_SET.has(name.slice(dot).toLowerCase());
}

/**
 * Unicode categories that must never reach a renderer: Cc (C0, DEL, C1 — the ANSI/OSC bytes),
 * Cf (bidi overrides, zero-width characters, BOM) and Cs (lone surrogates, which a lossy decode of
 * an undecodable name leaves behind).
 */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}]/gu;

/**
 * Strip every character that can act on the terminal instead of occupying a cell (S5, AGENTS.md).
 * The escape itself is removed and the remaining printable tail is left alone: a name keeps its
 * identity for the eye and loses its ability to move the cursor. Truncation is not done here.
 */
export function neutralizeName(name: string): string {
	return name.replace(UNSAFE, "");
}
