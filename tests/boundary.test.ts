/**
 * Architecture guard (S8). These tests encode the module boundary so it cannot drift silently:
 * a violation fails CI instead of being caught in review, or never.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LIB = join(ROOT, "lib");

/** The only modules allowed to touch the world. Everything else must stay pure. */
const IO_OWNERS = ["catalog", "host", "library", "player", "settings"];

const NODE_IO = /^(node:)?(fs|net|http|https|child_process|dgram|worker_threads|os)(\/|$)/;
const HOST_PACKAGE = "@earendil-works/";
const ASYNC = /\b(async|await)\b/;

function tsFiles(dir: string): string[] {
	try {
		return readdirSync(dir, { recursive: true, encoding: "utf8" })
			.filter((name) => name.endsWith(".ts"))
			.map((name) => join(dir, name));
	} catch {
		return [];
	}
}

function importSpecifiers(file: string): string[] {
	const source = readFileSync(file, "utf8");
	return [...source.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map((match) => match[1] ?? "");
}

interface Declaration {
	readonly specifier: string;
	/** What sits between `import`/`export` and `from`: `type { A }`, `* as ns`, `Foo`, `{ type A, B }`. */
	readonly clause: string;
	/** A bare `import "x"` or a dynamic `import("x")`, where there is no clause to inspect at all. */
	readonly runtime: boolean;
}

/** Every import/export declaration with its module specifier, so the clause can be judged, not just the path. */
function declarations(file: string): Declaration[] {
	const source = readFileSync(file, "utf8");
	const found: Declaration[] = [];
	for (const match of source.matchAll(/\b(?:import|export)\s+([^"';]*?)\s*\bfrom\s*"([^"]+)"/g)) {
		found.push({ clause: match[1] ?? "", specifier: match[2] ?? "", runtime: false });
	}
	for (const match of source.matchAll(/\bimport\s*\(\s*"([^"]+)"\s*\)/g)) {
		found.push({ clause: "", specifier: match[1] ?? "", runtime: true });
	}
	for (const match of source.matchAll(/\bimport\s*"([^"]+)"/g)) {
		found.push({ clause: "", specifier: match[1] ?? "", runtime: true });
	}
	return found;
}

/**
 * Whether a declaration disappears when types are erased: `import type …` or `{ type A, type B }`.
 * Anything the check cannot prove is type-only counts as a runtime dependency, because a guard that
 * guesses wrong in that direction is a guard that cannot fail.
 */
function typeOnly(declaration: Declaration): boolean {
	if (declaration.runtime) return false;
	const clause = declaration.clause.trim();
	if (/^type\s/.test(clause)) return true;
	if (!clause.startsWith("{") || !clause.endsWith("}")) return false;
	const named = clause
		.slice(1, -1)
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part !== "");
	return named.length > 0 && named.every((part) => /^type\s/.test(part));
}

/** First path segment under lib/, without the extension: the unit the boundary is drawn around. */
function unitOf(file: string): string {
	return (relative(LIB, file).split(sep)[0] ?? "").replace(/\.ts$/, "");
}

const LIB_FILES = tsFiles(LIB);

/**
 * Who may import whom (S8, AGENTS.md): `extensions → host → {library, player} → core → types`, in one
 * direction. `lib/types.ts` is the shared vocabulary and imports nothing; the outer layers may reach
 * anything under them.
 */
const MAY_IMPORT: Record<string, readonly string[]> = {
	core: ["core", "types"],
	host: ["core", "host", "library", "player", "settings", "types"],
	library: ["core", "library", "settings", "types"],
	player: ["core", "player", "settings", "types"],
	settings: ["types"],
	types: [],
};

/** The unit a relative import resolves into, without the extension (see `unitOf`). */
function targetUnit(file: string, specifier: string): string {
	return unitOf(resolve(dirname(file), specifier));
}

describe("module boundaries", () => {
	it("finds the library sources it is meant to guard", () => {
		assert.ok(LIB_FILES.length > 0, "expected at least one file under lib/ to guard");
	});

	it("keeps I/O out of every module that is not an I/O owner", () => {
		const offenders: string[] = [];
		for (const file of LIB_FILES) {
			if (IO_OWNERS.includes(unitOf(file))) continue;
			for (const specifier of importSpecifiers(file)) {
				if (NODE_IO.test(specifier)) offenders.push(`${relative(ROOT, file)} → ${specifier}`);
			}
		}
		assert.deepEqual(offenders, [], "these modules must not import Node I/O");
	});

	it("imports the Pi host only from lib/host", () => {
		const offenders: string[] = [];
		for (const file of LIB_FILES) {
			if (unitOf(file) === "host") continue;
			for (const specifier of importSpecifiers(file)) {
				if (specifier.startsWith(HOST_PACKAGE)) offenders.push(`${relative(ROOT, file)} → ${specifier}`);
			}
		}
		assert.deepEqual(offenders, [], "only the host adapter may depend on @earendil-works/*");
	});

	it("keeps the core synchronous: effects are data, not promises", () => {
		const offenders: string[] = [];
		for (const file of tsFiles(join(LIB, "core"))) {
			if (ASYNC.test(readFileSync(file, "utf8"))) offenders.push(relative(ROOT, file));
		}
		assert.deepEqual(offenders, [], "lib/core must not use async/await (S2)");
	});

	it("keeps the dependency direction one-way: no layer imports an outer one (S8)", () => {
		const offenders: string[] = [];
		for (const file of LIB_FILES) {
			const allowed = MAY_IMPORT[unitOf(file)];
			// A module this map does not know (the catalog of S20) is a decision nobody took yet: the guard
			// refuses to invent its row instead of silently demanding one, and says nothing about it.
			if (allowed === undefined) continue;
			for (const declaration of declarations(file)) {
				const specifier = declaration.specifier;
				if (!specifier.startsWith(".")) continue;
				const target = targetUnit(file, specifier);
				if (!allowed.includes(target)) offenders.push(`${relative(ROOT, file)} → ${specifier}`);
			}
		}
		assert.deepEqual(offenders, [], "an inner layer may not import an outer one");
	});

	it("lets the entry point import the host only as types (S8)", () => {
		// S8 draws the host package at lib/host, with one exception: the types an entry point declares its
		// factory with. A value import there would make Pi's package a runtime dependency of the extension.
		const entryPoints = tsFiles(join(ROOT, "extensions"));
		assert.ok(entryPoints.length > 0, "expected at least one entry point under extensions/ to guard");
		const offenders: string[] = [];
		let hostImports = 0;
		for (const file of entryPoints) {
			for (const declaration of declarations(file)) {
				if (!declaration.specifier.startsWith(HOST_PACKAGE)) continue;
				hostImports += 1;
				if (!typeOnly(declaration)) offenders.push(`${relative(ROOT, file)} → ${declaration.specifier}`);
			}
		}
		assert.deepEqual(offenders, [], "an entry point may import the host as types only");
		assert.ok(hostImports > 0, "no host import was found at all: this guard would pass on any file");
	});
});
