# Catalog fixtures (S20)

The two Bandcamp regexes in `lib/catalog/parse.ts` are coupling to markup we do not own. These
files are the contract: they are real bytes captured from the live pages, so a parser change that
would break against the real site breaks a test first.

Captured 2026-11-18 (UTC) with `curl`, no transformation of the captured bytes:

| File | Source | What was kept |
|---|---|---|
| `music-grid.html` | `https://streambeats.bandcamp.com/music` | The first three `<li data-item-id="album-…">` blocks, **verbatim and in page order**, inside a minimal `<ul id="music-grid">` wrapper |
| `album-tralbum.html` | `https://streambeats.bandcamp.com/album/better-when-im-high-remix` | The whole `data-tralbum="…"` attribute, **verbatim**, inside a minimal `<div …>` wrapper |
| `album-404.html` | A page that does **not** exist (`/album/streambeats-lofi`) | The `Sorry, that something isn't here.` block, **verbatim**: the "no tralbum here" case |

**What is real and what is not:** every byte the parser reads is real — attribute values, grid
markup, entity escapes. What is reconstructed is only the *wrapper* (`<ul id="music-grid">`,
`<div …>`), because the whole pages are 187 KB and 311 KB and a fixture that size is not a test, it
is an archive. The wrapper adds no information: the parser finds the grid items and the attribute,
never the document around them.

**They are not a specification.** A passing suite here does not prove Bandcamp still serves this
markup; it proves the parser still reads the markup it was written against. When the site changes,
the correct move is to capture the new pages and let the tests disagree, not to loosen the regex
until the green comes back.
