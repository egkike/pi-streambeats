#!/usr/bin/env node
/**
 * Release tag guard (T35).
 *
 * A release tag is a pin: `pi install git:github.com/egkike/pi-streambeats@v0.1.0` promises the code
 * that `package.json` calls `0.1.0`. A tag that names a different version breaks that promise silently,
 * so the comparison here is exact — `"v" + version`, nothing looser — and runs before any release notes
 * are written.
 *
 *   node scripts/release-tag.mjs v0.1.0
 *
 * It exits non-zero on a mismatch, which is what the workflow needs; the pure function is exported so a
 * test can assert the verdicts without running the process.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const TAG_PREFIX = "refs/tags/";

/**
 * The verdict for one tag against one version.
 *
 * `refs/tags/v0.1.0` and `v0.1.0` are the same tag (GitHub hands out the bare name as `GITHUB_REF_NAME`
 * and the qualified one as `GITHUB_REF`), but nothing else is normalised: `0.1.0`, `v0.1` and `v0.1.0-rc.1`
 * are all mismatches, because the pin has to be the exact string a user types.
 */
export function compareTag(tag, version) {
	const stripped = tag.startsWith(TAG_PREFIX) ? tag.slice(TAG_PREFIX.length) : tag;
	const expected = `v${version}`;

	if (stripped === expected) return { ok: true, tag: stripped, expected };

	return {
		ok: false,
		tag: stripped,
		expected,
		message: `tag ${stripped} does not match package.json version ${version} (expected ${expected})`,
	};
}

function readVersion() {
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	if (typeof pkg.version !== "string" || pkg.version === "") {
		throw new Error("package.json has no version string");
	}
	return pkg.version;
}

// The CLI half: `process.argv[2]` is the tag the workflow passes from the pushed ref. The guard is the
// file URL of this module, not a string splice of argv[1], so it also holds on Windows.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const tag = process.argv[2];
	if (!tag) {
		console.error("release-tag: FAIL — no tag given; usage: node scripts/release-tag.mjs <tag>");
		process.exit(2);
	}

	let version;
	let verdict;
	try {
		version = readVersion();
		verdict = compareTag(tag, version);
	} catch (error) {
		console.error(`release-tag: FAIL — ${error.message}`);
		process.exit(2);
	}

	if (!verdict.ok) {
		console.error(`release-tag: FAIL — ${verdict.message}`);
		process.exit(1);
	}

	console.log(`release-tag: OK — ${verdict.tag} is package.json ${version}`);
}
