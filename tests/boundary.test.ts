/**
 * Architecture guard (S8). These tests encode the module boundary so it cannot drift silently:
 * a violation fails CI instead of being caught in review, or never.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
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

/** First path segment under lib/, without the extension: the unit the boundary is drawn around. */
function unitOf(file: string): string {
	return (relative(LIB, file).split(sep)[0] ?? "").replace(/\.ts$/, "");
}

const LIB_FILES = tsFiles(LIB);

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
});
