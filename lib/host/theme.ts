/**
 * The role-to-token translation (S3, S8). The core renders with semantic roles and never sees a
 * colour; this is the only place that knows which token of the host theme a role means.
 *
 * The renderer composes prefixes (`fg(role)` paints the cells that follow), so the adapter uses the
 * host's opening-sequence accessors. `Theme.fg(token, "")` is not that: it also appends the closing
 * sequence (`\x1b[39m`), which would undo the prefix before the text it was meant to paint.
 */
import type { Role, ViewTheme } from "../types.ts";

/** The slice of the host theme the adapter reads (pi-coding-agent theme.d.ts:61-77). */
export interface HostTheme {
	fg(token: string, text: string): string;
	bg(token: string, text: string): string;
	getFgAnsi(token: string): string;
	getBgAnsi(token: string): string;
	bold(text: string): string;
}

/**
 * Foreground tokens (theme-tokens.d.ts:9-47). `surface` has no foreground meaning of its own: it is
 * a background job, and falling back to `text` keeps a foreground request from inventing a colour.
 */
const FOREGROUND: Readonly<Record<Role, string>> = {
	text: "text",
	dim: "dim",
	muted: "muted",
	accent: "accent",
	success: "success",
	warning: "warning",
	error: "error",
	border: "border",
	surface: "text",
};

/**
 * Background tokens (theme-tokens.d.ts:63-107). The card only uses `surface`, the elevated row
 * under the cursor; the other roles are mapped to the host's nearest surface so a future caller
 * still gets a real background instead of an invalid token.
 */
const BACKGROUND: Readonly<Record<Role, string>> = {
	text: "selectedBg",
	dim: "selectedBg",
	muted: "selectedBg",
	accent: "selectedBg",
	success: "toolSuccessBg",
	warning: "toolPendingBg",
	error: "toolErrorBg",
	border: "selectedBg",
	surface: "selectedBg",
};

/** Translate the host theme into the renderer's vocabulary. */
export function toViewTheme(theme: HostTheme): ViewTheme {
	return {
		fg: (role) => theme.getFgAnsi(FOREGROUND[role]),
		bg: (role) => theme.getBgAnsi(BACKGROUND[role]),
		// `getBgAnsi` only opens: the host exposes no default-background token, so the close is the
		// standard reset. Without it the cursor row paints everything after it (R4-004).
		bgEnd: () => "\u001b[49m",
		bold: (text) => theme.bold(text),
		dim: (text) => theme.fg("dim", text),
	};
}
