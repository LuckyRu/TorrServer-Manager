# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.
Keep this file short — for anything with a `docs/...` link, that file is the source of truth; don't
restate it here. Before adding a line, ask: would removing it cause a mistake? If not, it belongs in
`docs/` or a skill, not here.

## Project overview

TorrServerManager is a Windows tray app (WinForms, .NET 10) that installs, runs, and updates
[TorrServer](https://github.com/YouROK/TorrServer) and [Jackett](https://github.com/Jackett/Jackett) for
use with the Lampa media center app. It also hosts a local HTTP service ("Lampa Plugin Hub", port 8095)
that mirrors Lampa plugin scripts on the LAN and ships a built-in Lampa plugin (`TorrentModPlugin.js`)
for aggregated torrent search, matching, and playback.

Single-project WinForms app (`TorrServerManager.csproj`), no `.sln`, no C# test project. See
[`README.md`](README.md) for the user-facing overview and [`docs/`](docs/README.md) (Diataxis: tutorials/
how-to/reference/explanation, plus ADRs and system-design write-ups) for everything not in this file.

**Build prerequisite: Node.js on PATH** — `TorrentModPlugin.js` is real ES modules bundled via esbuild;
`dotnet build`/`dotnet publish` runs this automatically (MSBuild → `npm run build:plugin`, auto-`npm
install` first run), but Node.js must be installed on the build machine.

## Commands

```bash
dotnet build TorrServerManager.csproj                              # debug build
dotnet publish TorrServerManager.csproj -c Release                 # -> bin\Release\net10.0-windows\win-x64\publish\
dotnet run --project TorrServerManager.csproj                      # run locally
dotnet run --project TorrServerManager.csproj -- --background      # run hidden to tray; the app only reads the flag, it never registers autostart
npm run test:plugin                                                 # JS plugin tests, run before any plugin release
powershell -ExecutionPolicy Bypass -File .\scripts\build-all.ps1  # clean full build: TorrServer + Jackett + Manager
```

No linter in this repo. The full clean build (TorrServer and Jackett submodules + Manager) is
`scripts/build-all.ps1`; it writes the executables to `publish\`. **Concurrency tests in
`external/TorrServer/server` have no oracle without `-race`, and `-race` is impossible on Windows
(needs cgo, no gcc) — run `scripts\test-race.ps1` (WSL, ~8 s); `build-all.ps1` calls it. A test that
spawns goroutines and cannot fail without `-race` is a `t.Skip`.** Scenario map, coverage audit and
race-test design: [`docs/system-design/scenarios-and-test-plan.md`](docs/system-design/scenarios-and-test-plan.md). TorrServer is pulled in as the
`external/TorrServer` submodule (fork `LuckyRu/TorrServer`, branch `torrserver-manager`) — downstream
fixes are commits on that branch, not patch files; see
[`docs/how-to/rebuild-patched-torrserver.md`](docs/how-to/rebuild-patched-torrserver.md). Full release checklist (version bump, deploy, plugin-cache refresh) is the
**`release-a-change` skill**; fast JS-only iteration without a full rebuild is the **`iterate-on-a-plugin-
without-rebuilding`** doc. Verifying UI/navigation/search behavior live is the **`verify-lampa-live`**
skill — Lampa has no public API docs, its own source and a live instance are the only ground truth.

`external/Jackett` is the `LuckyRu/Jackett` fork on branch `jackett-manager`; downstream tags use
`v<upstream>-JackettManager.<downstream>` (for example `v0.24.2413-JackettManager.1`). The full
build validates the upstream base and publishes `publish\Jackett\App`; see
[`docs/how-to/rebuild-patched-jackett.md`](docs/how-to/rebuild-patched-jackett.md).

## Architecture

`MainForm.cs` owns everything directly (no DI container), disposing it all in `OnFormClosing`. Full
per-file map of the C# side (entry point, process controllers, `PluginHub.cs`'s HTTP endpoints, plugin
loading) is [`docs/reference/architecture-map.md`](docs/reference/architecture-map.md) — read that
before touching a `.cs` file you haven't seen yet, not this file.

### `TorrentModPlugin.js`

Source is real ES modules under `Plugins/TorrentModPlugin/`, folders following the actual import graph:
`shared/` (incl. `core/` reliability primitives), `search/` (query building → parsing → scoring →
parallel Jackett fetch), `metadata/` (TMDB), `playback/` (deliberately outside the domain layer below —
a playback session can outlive the results screen), `domain/` (Store + State + Interactors for the
results screen), `ui/` (Lampa registration + the results screen View). `npm run build:plugin` (esbuild)
bundles it into a single IIFE, `Plugins/TorrentModPlugin.bundle.js` (gitignored, generated, never edited
directly) — `dotnet build`/`publish` run this automatically. Own card button and own
`Lampa.Component.add('torrent_mod', ...)` screen, not a native-screen wrapper: [ADR-0001](docs/adr/0001-torrent-mod-own-screen.md).

Five subsystems, one pointer each — **read the linked doc before changing that area**, don't rely on this
summary:

| Area | What | Doc |
|---|---|---|
| Search & matching | Whole season searched once in background ([ADR-0005](docs/adr/0005-search-whole-season-once.md)); parallel per-indexer Jackett fetch; matchScore-as-gate then quality+availability ranking; strict word-count title matching + TMDB English-title fetch | [`scoring-model.md`](docs/reference/torrent-mod-scoring-model.md), [`parallel-search.md`](docs/system-design/torrent-mod-parallel-search.md), [`search-architecture.md`](docs/system-design/torrent-mod-search-architecture.md) (архитектура + замеры), [`tracker-formats.md`](docs/reference/torrent-mod-tracker-formats.md) (трекеры, форматы, порядок разбора) |
| Domain | Store/State/Interactors, `shared/core/` primitives (result/generation-guard/lifecycle), View/Domain boundary rule (UI timers live in the View, not the domain) | [`domain-architecture.md`](docs/system-design/torrent-mod-domain-architecture.md) |
| UI/navigation | `Lampa.Explorer` chrome + real `Lampa.Filter` toolbar ([ADR-0004](docs/adr/0004-lampa-filter-not-handbuilt-chips.md)); 10 documented Controller/Activity/Select/Scroll bugs | [`lampa-navigation-contract.md`](docs/system-design/lampa-navigation-contract.md) |
| Playback | GST-first, no `url_reserve`, no global player patching ([ADR-0003](docs/adr/0003-no-global-player-patching.md), historical chain in [ADR-0006](docs/adr/0006-native-player-fallback-not-ffprobe-gate.md)) | [`lampa-player-api.md`](docs/reference/lampa-player-api.md), [`gstreamer-seek-accuracy.md`](docs/system-design/gstreamer-seek-accuracy.md) (перемотка: индекс ≠ точность, флаги, точки обрезки) |
| Dev workflow | `npm run dev:plugin` writes a dev-override the built-in loader checks first — **delete it before a real deploy** or the `.exe` silently serves stale JS | [`iterate-on-a-plugin-without-rebuilding.md`](docs/how-to/iterate-on-a-plugin-without-rebuilding.md) |

**Gotchas that cause real regressions if forgotten** (full detail behind each link):
- Never wrap `\b` around a Cyrillic alternative in a JS regex — silently never matches, no error.
- `Lampa.Component.create` silently swaps in an empty `nocomponent` screen on any constructor exception —
  check devtools console first, not the DOM, if a screen won't render. `Lampa.Utils.escape` doesn't exist.
- `state.pool` is always an array, never `null` — a selector assuming otherwise crashes on first paint.
- A lazy-load function that synchronously fires its own "done" callback with nothing changed will recurse
  forever if the caller retries on every callback — fix the contract (make it fire-and-forget +
  reactive), don't patch another bail branch.
- In C#, `foreach`+`await` over async tasks preserves list order, not completion order — use
  `Task.WhenAny` in a loop when "fastest first" matters.
- `-race` is not an oracle for *logical* races: two goroutines can be perfectly synchronised on memory
  and still corrupt a stream by acting in the wrong order. The cache sweep moving a reader that was
  mid-read was silent under `-race` and needed a deterministic rendezvous test
  ([§5.1](docs/system-design/one-torrent-many-streams-concurrency.md)).
- GStreamer seek flags are not additive: `ACCURATE` asks for the exact position, `KEY_UNIT|SNAP_AFTER`
  for the next keyframe after it. Set together, the latter wins and `ACCURATE` silently does nothing —
  the log even says `accurate=true` while the position is seconds off
  ([seek-accuracy](docs/system-design/gstreamer-seek-accuracy.md)).

Full list with root cause and fix: [`docs/reference/torrent-mod-gotchas.md`](docs/reference/torrent-mod-gotchas.md).

## Conventions

- User-facing strings (UI, errors, `MessageBox`) are in Russian.
- External processes (TorrServer, Jackett) are found by name/path on every check, never a cached
  `Process` handle — the manager can restart while the child keeps running.
- Anything written to shared state on disk goes to a temp path first, then `File.Move`/`Directory.Move`.
- Commit messages: Russian, Conventional Commits (`тип(область): суть`), short — no line-by-line diff recap.
- Bump `<Version>` in `TorrServerManager.csproj` (SemVer2) on every user-visible change; it must show in
  the main window and the tray tooltip, not just assembly metadata.
- The plugin carries its **own** version — `VERSION` in `Plugins/TorrentModPlugin/shared/state.js`, shown
  on the card button and in every plugin log line. Touching `Plugins/TorrentModPlugin/` means bumping it
  too; the manager version in the csproj does not cover it.

## Agent workflow and comments

- Keep this file concise: commands, invariants, traps, and links to durable docs only. Update it when a
  rule should apply to future agent sessions; put feature history and rationale in `docs/` or ADRs.
- Use `explore → plan → implement → verify → commit`. For multi-file work, write the plan before editing,
  add regression tests for discovered bugs, and run the narrowest relevant checks before the full suite.
- Comments explain a non-obvious invariant, external contract, safety constraint, or reason a simpler
  alternative is invalid. Prefer names and structure over comments that restate the code.
- Never put investigation transcripts, issue history, timestamps, user quotes, or step-by-step narration
  in source comments. Move durable rationale to an ADR/design doc and link it with one short comment when
  the code needs a pointer.
- Keep source comments to one or two concise lines. A multi-line block needs a strong reason and should
  normally be a doc/ADR instead. Do not add comments solely to describe an obvious function or branch.
