import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The release guard (T35) is a `.mjs` script, so it sits outside the TypeScript program: `tsconfig.json`
 * includes `extensions`, `lib` and `tests`, and `allowJs` is off. It is loaded by URL and cast to the shape
 * this test pins, so the assertions below are what keeps the CLI and the test honest about each other.
 */
interface TagVerdict {
	readonly ok: boolean;
	/** The tag with any `refs/tags/` prefix removed: the name the verdict is about. */
	readonly tag: string;
	/** The tag that would have matched, `v` + the version it was compared with. */
	readonly expected: string;
	readonly message?: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const GUARD = join(ROOT, "scripts/release-tag.mjs");

/**
 * The version the CLI will read, taken from the real `package.json` instead of written down here: a hardcoded
 * tag would turn this test red at the first bump, and the guard's own release is exactly when a red suite is
 * least welcome. The pure tests below still state versions explicitly, because that is the function's input.
 */
const VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;

const { compareTag } = (await import(new URL("../../scripts/release-tag.mjs", import.meta.url).href)) as {
	compareTag: (tag: string, version: string) => TagVerdict;
};

describe("the release tag guard (T35)", () => {
	it("accepts the tag the version names", () => {
		const verdict = compareTag("v0.1.0", "0.1.0");

		assert.equal(verdict.ok, true, verdict.message);
		assert.equal(verdict.tag, "v0.1.0");
		assert.equal(verdict.expected, "v0.1.0");
		assert.equal(verdict.message, undefined, "a match has nothing to explain");
	});

	it("rejects a tag that names another version, and names both values", () => {
		// A pin that lies is worse than no pin: the release that ships `v0.2.0` from a `0.1.0` package
		// would make `pi install git:...@v0.2.0` install something the version never claimed.
		const verdict = compareTag("v0.2.0", "0.1.0");

		assert.equal(verdict.ok, false);
		assert.equal(verdict.tag, "v0.2.0", "the verdict names the tag it judged");
		assert.equal(verdict.expected, "v0.1.0", "and the one that would have matched");
		assert.match(String(verdict.message), /v0\.2\.0/);
		assert.match(String(verdict.message), /0\.1\.0/);
	});

	it("accepts the refs/tags/ form of the same tag", () => {
		// GITHUB_REF_NAME is bare (`v0.1.0`); GITHUB_REF is `refs/tags/v0.1.0`. Both reach the guard.
		const verdict = compareTag("refs/tags/v0.1.0", "0.1.0");

		assert.equal(verdict.ok, true, verdict.message);
	});

	it("compares exactly, so a version that is only a prefix of the tag does not match", () => {
		assert.equal(compareTag("v0.1.0", "0.1").ok, false);
		assert.equal(compareTag("v0.1.0.1", "0.1.0").ok, false);
		assert.equal(compareTag("v0.1.0-rc.1", "0.1.0").ok, false);
	});
});

/* --- the half the workflow actually runs (R3-001) ---------------------------------------------- */

interface GuardRun {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

/** Run the guard exactly as `.github/workflows/release-tag.yml` does: the tag is the only argument. */
function runGuard(...args: readonly string[]): Promise<GuardRun> {
	return new Promise((done) => {
		const child = spawn(process.execPath, [GUARD, ...args], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		// A guard that hangs must fail this test instead of hanging the suite.
		const stuck = setTimeout(() => {
			child.kill("SIGKILL");
			done({ code: null, stdout, stderr: `${stderr}\ntest: the guard did not finish within 15s` });
		}, 15_000);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("close", (code) => {
			clearTimeout(stuck);
			done({ code, stdout, stderr });
		});
	});
}

/**
 * The exit codes are a contract, not an implementation detail: `release-tag.yml` decides from them, and a
 * refactor that swapped 1 for 2 would turn a version mismatch into "the guard could not run" without any
 * pure test noticing (R3-001). The messages are pinned because `RELEASING.md` tells a releaser to read the
 * `release-tag: FAIL —` line as the whole diagnosis.
 */
describe("the guard's CLI, which is what the workflow consumes", () => {
	it("exits zero and says so when the tag matches package.json", async () => {
		const run = await runGuard(`v${VERSION}`);

		assert.equal(run.code, 0, run.stderr);
		assert.match(run.stdout, /release-tag: OK/);
		assert.equal(run.stderr, "");
	});

	it("accepts the qualified ref GitHub also hands out", async () => {
		const run = await runGuard(`refs/tags/v${VERSION}`);

		assert.equal(run.code, 0, run.stderr);
	});

	it("exits one and names both values when the tag disagrees", async () => {
		const run = await runGuard("v999.0.0");

		assert.equal(run.code, 1, run.stdout);
		assert.match(run.stderr, /release-tag: FAIL — tag v999\.0\.0 does not match package\.json version/);
		assert.ok(run.stderr.includes(VERSION), `the message must name the version, got: ${run.stderr}`);
	});

	it("exits two, with a usage line, when no tag reaches it", async () => {
		const run = await runGuard();

		assert.equal(run.code, 2, run.stdout);
		assert.match(run.stderr, /no tag given/);
		assert.match(run.stderr, /usage:/);
	});
});
