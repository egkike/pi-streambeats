/**
 * Shared vocabulary (S7). One type per concept, defined once: parsers and scanners
 * produce these types directly, with no DTO layer in between.
 *
 * This module is pure: it declares shapes and nothing else.
 */

/** Where a track comes from. v1 ships `local` only; `catalog` arrives in a later slice. */
export type TrackOrigin = "local" | "catalog";

/**
 * Stable identity for a track: the absolute path for local files.
 * Identity never changes for the session, even when the playable target does.
 */
export interface Track {
	readonly id: string;
	/** Clean title for the UI (S12): track number prefix and audio extension removed when they match. */
	readonly title: string;
	readonly origin: TrackOrigin;
	/** Duration in milliseconds when it is known before playing; undefined until then. */
	readonly durationMs?: number;
}

/** A directory the card can descend into. Children are listed one level at a time (S5). */
export interface Folder {
	/** Absolute, canonical path. */
	readonly path: string;
	/** Display name: the last path segment. */
	readonly name: string;
}

/**
 * What mpv actually loads. Ephemeral by design: a catalog target carries a token that expires,
 * so it is resolved immediately before playing and never persisted.
 */
export interface Target {
	/** Absolute file path, or a signed URL. */
	readonly uri: string;
	/** Epoch milliseconds after which `uri` must not be reused. Absent means it never expires. */
	readonly expiresAt?: number;
}

/** Why a track could not be turned into a playable target. Each value gets its own message (S7). */
export type ResolveFailure = "missing" | "network" | "not-found" | "scrape" | "expired";

export type ResolveResult =
	| { readonly ok: true; readonly target: Target }
	| { readonly ok: false; readonly failure: ResolveFailure };

/** The resolver seam (S7). v1 has one implementation; the catalog adds a second without touching the player. */
export interface TrackResolver {
	/** Whether warming the next track is worth its cost. Local files are instant; remote ones are not. */
	readonly prefetchable: boolean;
	resolve(track: Track, signal?: AbortSignal): Promise<ResolveResult>;
}

/**
 * Semantic colour roles, mapped from the host theme (S3, D8).
 * No palette lives in this project: a role is a job, not a colour.
 */
export type Role = "text" | "dim" | "muted" | "accent" | "success" | "warning" | "error" | "border" | "surface";

/** What the renderer is allowed to know about the host theme. */
export interface ViewTheme {
	fg(role: Role): string;
	bold(text: string): string;
	dim(text: string): string;
}
