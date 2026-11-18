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

interface Declaration {
	readonly specifier: string;
	/** What sits between `import`/`export` and `from`: `type { A }`, `* as ns`, `Foo`, `{ type A, B }`. */
	readonly clause: string;
	/** A bare `import "x"` or a dynamic `import("x")`, where there is no clause to inspect at all. */
	readonly runtime: boolean;
}

/** One lexical token: a `word` (keyword or identifier), a `literal` (a quoted string's value) or one `punct`. */
interface Token {
	readonly kind: "word" | "literal" | "punct";
	readonly value: string;
}

const WORD_START = /[A-Za-z_$]/;
const WORD_PART = /[A-Za-z0-9_$]/;
/** Keywords after which a `/` opens a regular expression rather than dividing. */
const REGEX_AFTER_WORD = new Set([
	"await",
	"case",
	"delete",
	"do",
	"else",
	"in",
	"instanceof",
	"new",
	"of",
	"return",
	"typeof",
	"void",
	"yield",
]);

/**
 * Whether a `/` here opens a regular expression instead of dividing. A regex has to be recognised for
 * its body to be skipped: reading it as code puts its quotes into the token stream, and from there the
 * scan can hide whole declarations — the failure this parser exists to close, reintroduced by its own
 * subject matter (the regex this file used to read declarations with carried three quotes).
 */
function opensRegex(previous: Token | undefined): boolean {
	if (previous === undefined) return true;
	if (previous.kind === "word") return REGEX_AFTER_WORD.has(previous.value);
	if (previous.kind === "literal") return false;
	return previous.value !== ")" && previous.value !== "]" && previous.value !== "}";
}

/**
 * The source as tokens, with whitespace and comments dropped. Tokens do not know what a line is, so a
 * declaration is the same declaration however Biome decides to format it — which is the defect R3-001
 * and R2-001 named: a regex tied to a physical line stops seeing a long import the moment it wraps,
 * and a guard that stops seeing a violation passes in silence.
 *
 * Deliberately lexical and small: it reads import/export headers, not TypeScript. Template literals are
 * skipped whole rather than expression by expression, and a nested `import()` inside one is not seen;
 * that is the price of a parser nobody has to trust beyond headers.
 */
function tokensOf(source: string): Token[] {
	const found: Token[] = [];
	let index = 0;
	while (index < source.length) {
		const char = source.charAt(index);
		const next = source.charAt(index + 1);
		if (/\s/.test(char)) {
			index += 1;
		} else if (char === "/" && next === "/") {
			const end = source.indexOf("\n", index + 2);
			index = end === -1 ? source.length : end + 1;
		} else if (char === "/" && next === "*") {
			const end = source.indexOf("*/", index + 2);
			index = end === -1 ? source.length : end + 2;
		} else if (char === "/" && opensRegex(found.at(-1))) {
			let end = index + 1;
			let inClass = false;
			while (end < source.length) {
				const inner = source.charAt(end);
				// A regex cannot span a line, so a newline means this was not one: resume as division.
				if (inner === "\n") break;
				if (inner === "\\") {
					end += 2;
					continue;
				}
				if (inner === "[") inClass = true;
				else if (inner === "]") inClass = false;
				else if (inner === "/" && !inClass) break;
				end += 1;
			}
			index = end + 1;
		} else if (char === '"' || char === "'" || char === "`") {
			let end = index + 1;
			while (end < source.length && source.charAt(end) !== char) end += source.charAt(end) === "\\" ? 2 : 1;
			found.push({ kind: "literal", value: source.slice(index + 1, Math.min(end, source.length)) });
			index = end + 1;
		} else if (WORD_START.test(char)) {
			let end = index + 1;
			while (end < source.length && WORD_PART.test(source.charAt(end))) end += 1;
			found.push({ kind: "word", value: source.slice(index, end) });
			index = end;
		} else {
			found.push({ kind: "punct", value: char });
			index += 1;
		}
	}
	return found;
}

/**
 * The clause of the declaration that starts at `start`, read up to its `from` clause. A clause is built
 * from words, one `{ … }` block, its commas and `*`: anything else means this is not a declaration that
 * carries a specifier (`export function`, `export const x = …`, `import x = require(…)`), so it is not
 * one the direction guard can judge. `from` inside the braces is a name, not the clause keyword — hence
 * the depth, which is what makes `import { from } from "x"` still readable.
 */
function readClause(tokens: readonly Token[], start: number): Declaration | undefined {
	const clause: string[] = [];
	let depth = 0;
	for (let index = start + 1; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === undefined) break;
		if (token.kind === "literal") return undefined;
		if (token.kind === "punct") {
			if (token.value === "{") depth += 1;
			else if (token.value === "}") depth -= 1;
			else if (token.value === ",") {
				// A trailing comma is formatting, not a name: `{ a, }` and `{ a }` are the same clause.
				if (tokens[index + 1]?.value !== "}") clause.push(token.value);
				continue;
			} else if (token.value !== "*") return undefined;
			if (depth < 0) return undefined;
			clause.push(token.value);
			continue;
		}
		if (depth === 0 && token.value === "from") {
			const specifier = tokens[index + 1];
			if (specifier?.kind !== "literal") return undefined;
			return { clause: clause.join(" ").replace(/ ,/g, ","), specifier: specifier.value, runtime: false };
		}
		clause.push(token.value);
	}
	return undefined;
}

/**
 * Every import/export declaration with its module specifier, so the clause can be judged, not just the path.
 * Exported because the parser is the guard's own eyes: a test feeds it source instead of a file.
 */
export function parseDeclarations(source: string): Declaration[] {
	const tokens = tokensOf(source);
	const found: Declaration[] = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token?.kind !== "word") continue;
		if (token.value !== "import" && token.value !== "export") continue;
		// `x.import(…)` is a method call and `import.meta` is a property: neither is a declaration.
		if (tokens[index - 1]?.value === ".") continue;
		const next = tokens[index + 1];
		if (next?.kind === "punct" && next.value === ".") continue;
		// `import("x")` and `import "x"` carry no clause: both are runtime by definition.
		if (token.value === "import" && next?.kind === "punct" && next.value === "(") {
			const specifier = tokens[index + 2];
			if (specifier?.kind === "literal") found.push({ clause: "", specifier: specifier.value, runtime: true });
			continue;
		}
		if (token.value === "import" && next?.kind === "literal") {
			found.push({ clause: "", specifier: next.value, runtime: true });
			continue;
		}
		const declaration = readClause(tokens, index);
		if (declaration !== undefined) found.push(declaration);
	}
	return found;
}

/** The declarations of a file on disk, which is what every guard below judges. */
function declarations(file: string): Declaration[] {
	return parseDeclarations(readFileSync(file, "utf8"));
}

/** A module the boundary guards judge: the file it lives in, and the declarations parsed out of it. */
interface Module {
	readonly file: string;
	readonly declarations: readonly Declaration[];
}

/**
 * A module built from source, so a guard's reach can be tested without a file on disk. It reads through
 * `parseDeclarations`, the only parser this file has: two readers of the same source is how the hole below
 * (T33) was born, and keeping both would guarantee a third.
 */
function moduleOf(file: string, source: string): Module {
	return { declarations: parseDeclarations(source), file };
}

/** Every module under lib/, read once: the guards share one parse, and therefore one truth. */
function libModules(): Module[] {
	return LIB_FILES.map((file) => moduleOf(file, readFileSync(file, "utf8")));
}

/**
 * `file → specifier` for every declaration whose specifier `forbidden` accepts. Both boundary guards ask the
 * same question of the same declarations, so they answer it once, here, instead of each re-reading the source.
 */
function offendingSpecifiers(modules: readonly Module[], forbidden: (specifier: string) => boolean): string[] {
	const found: string[] = [];
	for (const module of modules) {
		for (const declaration of module.declarations) {
			if (forbidden(declaration.specifier)) found.push(`${relative(ROOT, module.file)} → ${declaration.specifier}`);
		}
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
	catalog: ["catalog", "core", "settings", "types"],
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

describe("the declaration parser", () => {
	/** `[specifier, runtime, typeOnly]` for each declaration a source carries, in the order they appear. */
	const judged = (source: string) =>
		parseDeclarations(source).map((declaration) => [declaration.specifier, declaration.runtime, typeOnly(declaration)]);

	/**
	 * R3-001 (WARNING) and R2-001: the parser read imports with regexes tied to one physical line, so a
	 * statement formatted across several lines — which is how Biome writes a long import, `lib/host/host.ts`
	 * among them — produced no `Declaration` at all. The direction guard and the entry-point guard then both
	 * passed in silence on a file that breaks the boundary, an invariant the repo believed it had.
	 */
	it("sees a boundary violation however the import is formatted", () => {
		const violation = [
			"// a lib/core file reaching into the library layer, which core may not import (S8)",
			"import {",
			"\t// the scanner's entry point: core must never depend on it",
			"\tscanFolder,",
			'} from "../library/scan.ts";',
		].join("\n");
		const found = parseDeclarations(violation);
		assert.deepEqual(found, [{ clause: "{ scanFolder }", specifier: "../library/scan.ts", runtime: false }]);
		const [declaration] = found;
		assert.ok(declaration !== undefined, "the multi-line import was not seen at all: no guard can judge it");
		assert.equal(typeOnly(declaration), false, "a value import is never provably type-only");
	});

	/**
	 * Every form the two guards judge, including the ones a line-based regex missed. The clause still decides
	 * `typeOnly`, so `import type` and a fully-`type` named block stay erasing while everything else counts as
	 * runtime — the conservative direction, because a guard that guesses "type only" is a guard that cannot fail.
	 */
	it("reads every import and export form the guards judge", () => {
		assert.deepEqual(judged('import { a } from "./a.ts";'), [["./a.ts", false, false]]);
		assert.deepEqual(judged('import {\n\ta,\n\tb,\n} from "./a.ts";'), [["./a.ts", false, false]]);
		// Single quotes and a `from` on its own line: the same declaration, differently formatted.
		assert.deepEqual(judged("import {\n\ta,\n}\nfrom './a.ts';"), [["./a.ts", false, false]]);
		assert.deepEqual(judged('import type {\n\tA,\n} from "./a.ts";'), [["./a.ts", false, true]]);
		assert.deepEqual(judged("import type { A } from './a.ts';"), [["./a.ts", false, true]]);
		assert.deepEqual(judged('import { type A, type B } from "./a.ts";'), [["./a.ts", false, true]]);
		// One value among the types is enough to be a runtime dependency.
		assert.deepEqual(judged('import { type A, b } from "./a.ts";'), [["./a.ts", false, false]]);
		assert.deepEqual(judged('import * as ns from "./a.ts";'), [["./a.ts", false, false]]);
		assert.deepEqual(judged('import type * as ns from "./a.ts";'), [["./a.ts", false, true]]);
		assert.deepEqual(judged('export {\n\ta,\n} from "./a.ts";'), [["./a.ts", false, false]]);
		assert.deepEqual(judged("export type { A } from './a.ts';"), [["./a.ts", false, true]]);
		assert.deepEqual(judged('export * from "./a.ts";'), [["./a.ts", false, false]]);
		assert.deepEqual(judged('import "side-effect.ts";'), [["side-effect.ts", true, false]]);
		assert.deepEqual(judged('const lazy = () => import(\n\t"./a.ts"\n);'), [["./a.ts", true, false]]);
	});

	/**
	 * The other half of reading source: what is *not* a declaration. A `from` inside a comment used to be
	 * read as a dependency, so a doc example could fail the guard for a specifier nothing imports; and a
	 * declaration that carries no specifier is not one the direction guard can judge.
	 */
	it("ignores specifiers that are not import or export declarations", () => {
		assert.deepEqual(judged('// import { a } from "./a.ts"\nconst a = 1;'), []);
		assert.deepEqual(judged('/* export * from "./a.ts" */\nconst b = 2;'), []);
		assert.deepEqual(judged("const text = 'import { a } from \"./a.ts\"';"), []);
		assert.deepEqual(judged("const url = import.meta.url;"), []);
		assert.deepEqual(judged("export function run(from: string): string {\n\treturn from;\n}"), []);
		assert.deepEqual(judged('export const seen = { from: "./a.ts" };'), []);
		assert.deepEqual(judged("export interface Shape {\n\tfrom: string;\n}"), []);
		// A regex literal carrying quotes must not open a string: the scan would then hide what follows,
		// and the regexes this file used to read declarations with carried three quotes. Division must not either.
		assert.deepEqual(judged('const re = /"([^"]+)"/g;\nimport { a } from "./a.ts";'), [["./a.ts", false, false]]);
		assert.deepEqual(judged('const half = total / 2;\nimport { a } from "./a.ts";'), [["./a.ts", false, false]]);
	});
});

describe("module boundaries", () => {
	it("finds the library sources it is meant to guard", () => {
		assert.ok(LIB_FILES.length > 0, "expected at least one file under lib/ to guard");
	});

	/**
	 * Both guards below ask one question of one reader: which specifiers does this module carry? Each used to
	 * answer it with its own regex over the file, so the guards had two truths about what a declaration is.
	 */
	it("keeps I/O out of every module that is not an I/O owner", () => {
		const modules = libModules().filter((module) => !IO_OWNERS.includes(unitOf(module.file)));
		const found = offendingSpecifiers(modules, (specifier) => NODE_IO.test(specifier));
		assert.deepEqual(found, [], "these modules must not import Node I/O");
	});

	it("imports the Pi host only from lib/host", () => {
		const modules = libModules().filter((module) => unitOf(module.file) !== "host");
		const found = offendingSpecifiers(modules, (specifier) => specifier.startsWith(HOST_PACKAGE));
		assert.deepEqual(found, [], "only the host adapter may depend on @earendil-works/*");
	});

	/**
	 * T33: the two guards above used to read source through `importSpecifiers()`, a second and regex-based
	 * parser that only matched double quotes, so a bare `import 'node:fs'` in a module that is not an I/O
	 * owner passed both of them in silence. Biome's `quoteStyle: double` would fail such a file at lint
	 * first, but a guard must not depend on the linter arriving earlier: it exists for the file the linter
	 * never saw. Both guards now read through `parseDeclarations`, so there is no second reader to go blind.
	 */
	it("catches a single-quoted I/O import in a module that is not an I/O owner", () => {
		const probe = moduleOf(join(LIB, "core", "probe.ts"), "import 'node:fs';\n");
		assert.equal(IO_OWNERS.includes(unitOf(probe.file)), false, "the probe must not live in an I/O owner");
		assert.deepEqual(
			offendingSpecifiers([probe], (specifier) => NODE_IO.test(specifier)),
			[`${join("lib", "core", "probe.ts")} → node:fs`],
		);
	});

	it("catches a single-quoted host import outside lib/host", () => {
		const probe = moduleOf(join(LIB, "core", "probe.ts"), "import '@earendil-works/pi-tui';\n");
		assert.deepEqual(
			offendingSpecifiers([probe], (specifier) => specifier.startsWith(HOST_PACKAGE)),
			[`${join("lib", "core", "probe.ts")} → @earendil-works/pi-tui`],
		);
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
			// A module this map does not know is a decision nobody took yet: the guard refuses to invent its row
			// instead of silently demanding one, and says nothing about it.
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

	it("keeps the catalog's network injected: no I/O import in its parser or its HTTP port", () => {
		// S20's contract over the reference implementation's: `fetch` arrives as a parameter. A `node:http(s)`
		// import here would make the module own a socket, and the tests that drive it with a fake would lie.
		const offenders: string[] = [];
		for (const name of ["parse.ts", "http.ts"]) {
			const file = join(LIB, "catalog", name);
			for (const declaration of declarations(file)) {
				if (NODE_IO.test(declaration.specifier)) offenders.push(`${relative(ROOT, file)} → ${declaration.specifier}`);
			}
		}
		assert.deepEqual(offenders, [], "lib/catalog must not import node I/O outside its cache");
	});

	it("never reaches the ambient fetch outside the composition root", () => {
		// The network is a dependency the root injects (S20): a bare `fetch(` anywhere else is a module that went
		// looking for the world by itself, and `extensions/` is the only place allowed to know it exists.
		const offenders: string[] = [];
		for (const file of LIB_FILES) {
			if (/(?<![\w.$])fetch\s*\(/.test(readFileSync(file, "utf8"))) offenders.push(relative(ROOT, file));
		}
		assert.deepEqual(offenders, [], "only the composition root may call fetch");
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
