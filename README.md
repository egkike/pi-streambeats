# pi-streambeats

<div align="center">

<a href="https://github.com/egkike/pi-streambeats">
  <img width="1280" src="docs/assets/pi-streambeats-banner.svg" alt="pi-streambeats — your music, inside the editor; local library and the StreamBeats catalog" />
</a>

<a href="https://github.com/Gentleman-Programming/gentle-ai">
  <img width="180" src="https://raw.githubusercontent.com/Gentleman-Programming/gentle-ai/main/docs/assets/brand/built-with-gentle-ai.png" alt="Built with Gentle-AI" />
</a>

</div>

Your music, inside the editor: a card for [Pi](https://pi.dev) and Gentle Shell that browses a local
music library and plays it with [mpv](https://mpv.io), without taking the keyboard away from you.

> **Status: early development.** Nothing is published yet — `pi install` would fail, and this
> repository holds the toolchain, the CI and the specification, not the product. The specification is
> [`odd/tasks/sb-music-card.md`](odd/tasks/sb-music-card.md): 19 numbered specs quoted from the owner's
> own words, plus the log of every decision behind them.

## What it is

`/sb-music` opens a card. It is a slash command, **never an agent tool**: your library and your listening
history never reach the model's context.

- **A card, not a window.** It lives in the corner of the terminal and shows what is playing without
  covering your work. One key — `ctrl+alt+z` by default — cycles it hidden → corner → expanded → hidden,
  `esc` hides it, and the status bar keeps the now-playing line either way. See [Keys](#keys).
- **The keyboard stays yours.** The card is not modal: it takes the keyboard only while it is expanded
  and focused, and `esc` hands it straight back to the editor, so nothing is trapped behind a window.
- **Two sources.** Your own folders (v1) and the free [StreamBeats](https://streambeats.bandcamp.com/music)
  catalog (later slice). Local files are read, never touched.
- **mpv plays.** The card drives a real `mpv` process over its JSON IPC socket, so playback survives the
  card being hidden and the audio is not tied to the terminal's redraw loop.

## Keys

Every key below exists; there is no separate expand key, because the cycle key owns both sizes. To see
the table with the values your machine is actually using, run `/sb-music --keys`.

**From the editor.** Registered when the session starts, and they work with the card open, hidden, or
never opened at all:

| Key | What it does |
| --- | --- |
| `ctrl+alt+z` | Cycle the card: hidden → corner → expanded → hidden |
| `ctrl+alt+space` | Pause or resume |
| `ctrl+alt+n` | Next track |
| `ctrl+alt+p` | Previous track |

On macOS the terminal's `alt` is <kbd>⌥</kbd>, so `ctrl+alt+z` is <kbd>ctrl</kbd>+<kbd>⌥</kbd>+<kbd>z</kbd>.
Some terminals need “Option as Meta” enabled before <kbd>⌥</kbd> reaches the app as `alt`.

**Inside the card**, which owns the keyboard while it is expanded and focused:

| Key | What it does |
| --- | --- |
| `↑` `↓`, `k` `j` | Move the cursor |
| `enter` | Open the folder or play the track |
| `space` | Pause or resume |
| `n` `>`, `p` `<` | Next, previous |
| `u`, `⌫` | Up one folder |
| `/` | Filter the current folder |
| `s` | Stop and empty the queue |
| `+` `-` | Volume |
| `z` | Shuffle the rest of the queue |
| `esc` | Hide the card (clears the filter first) |

## Changing the keys

```sh
/sb-music --keys                                    # what is in effect, and where the file is
/sb-music --keys overlay=ctrl+alt+m                 # change one key
/sb-music --keys overlay=ctrl+alt+m next=alt+ctrl+k # several at once, all or nothing
/sb-music --keys overlay=default                    # back to the documented default
/sb-music --help                                    # the syntax, plus the table
```

A value needs a modifier (`ctrl`, `alt` or `shift`) — a bare `j` would take that key away from the editor
— and the value has to be a key Pi itself can produce. No two of the four keys may be the same, and the
name has to be one of `overlay`, `playPause`, `next`, `prev`. Anything else is refused with a message, and
nothing is written.

They are saved in `~/.config/pi-streambeats/settings.json`
(`$XDG_CONFIG_HOME/pi-streambeats/settings.json`; `%APPDATA%\pi-streambeats\settings.json` on Windows),
under `shortcuts`. **A change applies at the next session**: Pi binds shortcuts when the session starts,
so the session you edited from keeps the key it was bound with — and `--keys` shows the new value from the
file next to it.

## What it will not do

- **It will never write inside your music folder.** No sync, no renames, no downloads: the only files it
  creates are its own `settings.json` and a socket.
- **No accounts, no cookies, no telemetry.** There is nothing to log into.
- **No system theme.** Colours come from the host's theme, so the card belongs to your terminal instead
  of fighting it.

## Requirements

| Requirement | Why |
| --- | --- |
| Pi or Gentle Shell | The card is an extension of the host's TUI; it has no UI of its own |
| [mpv](https://mpv.io) 0.41+ | Playback. Without it the card still browses and says so |
| Node 22.19+ | The host's floor, declared in `engines` and exercised in CI |

## Development

```sh
pnpm install
pnpm check          # lint + typecheck + tests
node scripts/ipc-probe.mjs mpv   # the real transport, against a real mpv
```

`pnpm check` never spawns mpv and never reads your library: the tests fake both. The transport is proven
separately by the probe, which is what CI runs on macOS against a Homebrew mpv.

CI runs the suite on Ubuntu 26.04 with Node 22.19, 24 and 26 — the declared floor is a promise only if
something executes it. **macOS does not run the suite**: the macOS runner pool serves roughly one job per
run, so asking for two starved whichever lost the race and turned `gate` red on infrastructure instead of
on code. macOS runs the real IPC probe, against Homebrew mpv, when a change touches the transport; the
darwin code path itself stays covered on Ubuntu because the platform-dependent functions are pure and take
`platform` as a parameter. A darwin-only path owes a test that runs from Linux, or its own job. Windows is
validated on a Windows 11 VM (toolchain, gate and named-pipe transport) and joins CI with task T12.

## Design

The card and this banner were designed before being implemented, as artboards:

- [`design/sb-music-card/`](design/sb-music-card/) — the corner card (default state) and the expanded
  list, with the ASCII fallback for terminals that render geometric glyphs double-width.
- [`design/pi-streambeats-banner/`](design/pi-streambeats-banner/) — this banner, chosen from three
  directions.

## Contributing

The project is single-owner: changes travel through an issue-linked pull request and the owner merges.
Bug reports and feature requests are the useful contribution — open an issue. Security problems go
through the private advisory form, never a public issue.

## License

MIT — see [LICENSE](LICENSE).
