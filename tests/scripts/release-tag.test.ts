import assert from "node:assert/strict";
import { describe, it } from "node:test";

/**
 * The release guard (T35) is a `.mjs` script, so it sits outside the TypeScript program: `tsconfig.json`
 * includes `extensions`, `lib` and `tests`, and `allowJs` is off. It is loaded by URL and cast to the shape
 * this test pins, so the assertions below are what keeps the CLI and the test honest about each other.
 */
interface TagVerdict {
	readonly ok: boolean;
	readonly message?: string;
}

const { compareTag } = (await import(new URL("../../scripts/release-tag.mjs", import.meta.url).href)) as {
	compareTag: (tag: string, version: string) => TagVerdict;
};

describe("the release tag guard (T35)", () => {
	it("accepts the tag the version names", () => {
		const verdict = compareTag("v0.1.0", "0.1.0");

		assert.equal(verdict.ok, true, verdict.message);
	});

	it("rejects a tag that names another version, and names both values", () => {
		// A pin that lies is worse than no pin: the release that ships `v0.2.0` from a `0.1.0` package
		// would make `pi install git:...@v0.2.0` install something the version never claimed.
		const verdict = compareTag("v0.2.0", "0.1.0");

		assert.equal(verdict.ok, false);
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
