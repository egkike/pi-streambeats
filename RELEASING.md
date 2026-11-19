# Releasing

A release here is a **git tag plus a GitHub Release**. There is no npm publish: a Pi extension installed
with `pi install git:…` resolves a ref, so the tag is the version, and the GitHub Release is the notes a
user reads before pinning it.

`package.json#version` is the single source of the version. `scripts/release-tag.mjs` compares it with a
pushed `v*` tag and the `Release tag` workflow fails when they disagree — a pin that lies is worse than no
pin at all.

## What the version covers

The public surface is what a user can see or write down:

- the `/sb-music` slash command and its flags (`--keys`, `--help`);
- the four keys, their defaults, and the names `overlay`, `playPause`, `next`, `prev` they are set by;
- the settings keys in `settings.json`: `libraryRoot`, `mpvPath`, `shortcuts`, `asciiGlyphs`;
- the now-playing line in the host's status bar;
- the published paths — `files` in `package.json` (`extensions/`, `lib/`) and `pi.extensions`
  (`./extensions`) — because they are what an install loads;
- the declared floor in `engines.node`.

Everything else is internal and may move in a patch.

## Semver

| Bump | Justified by |
| --- | --- |
| **major** `1.0.0` | Removing or renaming something on that list: a deleted flag, a removed or renamed settings key (an existing `settings.json` stops being read the way it was), a published path that moves so an installed card no longer loads, or an `engines` floor raised above a Node version that used to work. `1.0.0` itself is the promise that the surface is settled |
| **minor** `0.2.0` | A change a user notices without being broken: a new key, a new settings key, a new default, a new row or source in the card, different now-playing text. While the version is `0.x`, this is also where a break goes — the pin is the only promise, so the number still has to move visibly |
| **patch** `0.1.1` | A fix where the surface stays exactly as documented: a wrong track order, a crash, a message that lied |

A documentation-only or CI-only change needs no release at all: `main` is the tip, and a tag that ships no
code change adds noise to the pin list.

## Cutting a release

`main` only changes through a pull request (see [`AGENTS.md`](AGENTS.md)); the tag is pushed afterwards,
on the merge commit. Nothing here needs a local tag before the merge.

```sh
# 1. Start from a fresh main, on a branch — never commit a bump straight onto main.
git switch main
git pull --ff-only
git switch -c chore/release-vX.Y.Z

# 2. Set "version" in package.json to X.Y.Z. It is the only place the version lives.
#    (The `Release tag` workflow reads it; nothing else has to be edited.)

# 3. Commit and open the pull request.
git add package.json
git commit -m "chore(release): vX.Y.Z"
git push -u origin chore/release-vX.Y.Z
gh pr create --title "chore(release): vX.Y.Z" --body "Bumps package.json to X.Y.Z." --label type:chore

# 4. Wait for `gate` to be green and for the owner to merge.

# 5. Tag the merge commit, on main, and push the tag. This is the step that starts the guard.
git switch main
git pull --ff-only
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z

# 6. Publish the release and its notes.
gh release create vX.Y.Z --title vX.Y.Z --generate-notes
```

Check the guard's result before announcing anything: `Release tag` runs on the tag push, and a red run
means `package.json` on `main` does not say `X.Y.Z`. Fix the version through another pull request, then
delete the tag as described below and tag the new merge commit — never re-point the existing tag.

`--generate-notes` lists the merged pull requests. Read them before publishing: the notes are the only
changelog a pinned user sees.

## Rollback

Withdrawing a release is deleting the release and the tag; the code on `main` stays, and the next release
carries the fix.

```sh
# 1. Withdraw the release page. Without --cleanup-tag the tag survives, which is what step 2 and 3 are for.
gh release delete vX.Y.Z --yes

# 2. Delete the tag locally.
git tag -d vX.Y.Z

# 3. Delete the tag on the remote.
git push origin :refs/tags/vX.Y.Z
```

**The number is burned.** A withdrawn `X.Y.Z` is never reused: the next version is `X.Y.(Z+1)` for a fix,
or the next minor if the withdrawal came with a change a user notices, and it goes through the sequence
above from its own bump commit. Re-creating the same tag over different bytes would change what
`pi install git:…@X.Y.Z` installs for everyone who already pinned it, silently.

A release whose notes are wrong needs no rollback: `gh release edit vX.Y.Z --notes-file notes.md` rewrites
the page and the tag is untouched.

If the tag itself is wrong — it is not on the merge commit, or `Release tag` is red — it is withdrawn the
same way, and the next attempt is tagged from `main` once the version and the code agree.
