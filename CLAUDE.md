# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

TorrServerManager is a Windows tray application (WinForms, .NET 10) that installs, runs, and updates
[TorrServer](https://github.com/YouROK/TorrServer) and [Jackett](https://github.com/Jackett/Jackett) for
use with the Lampa media center app. It also hosts a small local HTTP service ("Lampa Plugin Hub") that
mirrors Lampa plugin scripts on the LAN, and ships a built-in Lampa plugin (`TorrentModPlugin.js`) for
aggregated torrent search, playback, and duration-aware buffering.

There is no `.sln` file and no test project — this is a single-project WinForms app built directly from
`TorrServerManager.csproj`. See [`README.md`](README.md) for a user-facing overview and
[`docs/`](docs/README.md) for Diataxis-structured documentation (tutorials/how-to/reference/explanation,
plus ADRs and system-design write-ups) — this file stays a dense, agent-oriented instruction set; `docs/`
is where the same knowledge lives reorganized for a human reading one topic at a time.

**Build prerequisite: Node.js on PATH.** `TorrentModPlugin.js`'s source is real ES modules (see its own
section below); `dotnet build`/`dotnet publish` bundles it via esbuild automatically (MSBuild shells out
to `npm run build:plugin`, auto-running `npm install` first if `node_modules/` is missing) — no separate
manual step, but Node.js has to actually be installed on whatever machine runs `dotnet build`.

## Commands

Build (debug):
```bash
dotnet build TorrServerManager.csproj
```

Publish a self-contained single-file win-x64 executable:
```bash
dotnet publish TorrServerManager.csproj -c Release
```
Output: `bin\Release\net10.0-windows\win-x64\publish\TorrServerManager.exe`.

Run locally (starts the tray app):
```bash
dotnet run --project TorrServerManager.csproj
```

Run hidden/minimized to tray (same flag the app uses for autostart):
```bash
dotnet run --project TorrServerManager.csproj -- --background
```

### Release workflow

For a user-visible change, the full loop is commit → publish → deploy → restart:

1. Bump `<Version>` in `TorrServerManager.csproj` per SemVer2 (see Conventions).
2. `git commit` — Russian, Conventional Commits, short description.
3. `dotnet publish TorrServerManager.csproj -c Release`.
4. Deploy to the live install: stop the running `TorrServerManager.exe`, back up the old one in place as
   `TorrServerManager.v<old-version>.bak.exe` (matches the existing `.bak.exe` files next to it), copy the
   freshly published exe over `%LocalAppData%\Programs\TorrServer\TorrServerManager.exe`, then start it
   again with `--background` (same flag the autostart shortcut uses).
   `TorrServer.exe`/`JackettConsole.exe` are independent processes and don't need restarting for a manager
   deploy.

There is no linter configured in this repo. There IS now a small hand-rolled test suite for
`TorrentModPlugin.js` (`npm run test:plugin` — `Plugins/TorrentModPlugin/test/{parsing,domain,smoke}.test.mjs`,
plain Node `assert`, no test framework dependency; `npm run test:e2e` separately runs a Playwright
browser test). It covers the pure parsing/scoring/domain functions and a few full domain-flow smoke
scenarios (movie vs. series entry, season switching, lazy per-season loading, the picker) — grew out
of the same review-driven-hardening habit documented throughout this file: a real bug found by review
gets a regression test alongside its fix when the bug was in one of these pure/domain functions. It
does not cover the C# side (`TorrServerManager.csproj` itself still has no test project) or DOM/Lampa
API integration (`ui/`, `playback/`) — those stay verified live, as documented throughout this file.

## Architecture

The app is a single WinForms `Form` (`MainForm.cs`) wired up to a handful of controller/service classes.
There is no DI container — `MainForm` constructs and owns everything, and disposes it all in
`OnFormClosing`.

Source is organized into folders that match their C# namespace (`TorrServerManager.<FolderName>`):
`Infrastructure/` (`AppPaths`, `AppLog` — no dependencies on anything else in the project),
`Controllers/` (`ServerController`, `JackettController` — external child-process management),
`Services/` (`UpdateService`, `PluginHub`, `FirewallService` — depend on `Controllers`/`Infrastructure`),
`Plugins/` (`BuiltInPlugins.cs` + the embedded `TorrentModPlugin.js`), `UI/` (`MainForm`, `IconFactory`).
`Program.cs`, `TorrServerManager.csproj`, and `app.manifest` stay at the repository root as the
entry-point/build-config layer above all of them.

- **`Program.cs`** — entry point. Enforces single-instance via a named `Mutex` and signals an already
  running instance through a named `EventWaitHandle` (`Local\TorrServerManager.Show`) so a second launch
  just brings the existing tray window forward instead of starting a second process.
- **`MainForm.cs`** — the tray/status window. Polls status every 2.5s via a `System.Windows.Forms.Timer`,
  drives all user actions (start/stop/restart TorrServer and Jackett, open web UIs, check/install
  updates), and manages the tray icon/menu. Closing the window hides it to the tray instead of exiting;
  only the tray menu's "Выход" actually exits.
- **`ServerController.cs`** — manages the external `TorrServer.exe` child process: start/stop/restart,
  HTTP health checks against `http://127.0.0.1:8090`, installed-version detection (parses `MatriX.x.x.x`
  version strings out of `--version` output), and LAN IP address discovery for handing out an address
  reachable from other devices (e.g. a TV running Lampa).
- **`JackettController.cs`** — manages Jackett's `JackettConsole.exe` as a plain child process, the
  same shape as `ServerController` (find-by-path process lookup, `Process.Start`/`Kill`, no Windows
  service, no UAC). Started with `-z --DataFolder <JackettDirectory> -p 9117 --NoUpdates` (loopback-only;
  `--NoUpdates` because updates are the manager's job, not Jackett's own built-in updater). Updates mirror
  `UpdateService`: download `Jackett.Binaries.Windows.zip` from GitHub Releases, verify its SHA-256
  `digest`, swap the `App/` folder (`Directory.Move`, with an `App.previous` backup restored on a failed
  start). There used to be a `SaveRutrackerCredentialsAsync` that pushed RuTracker.org login/password
  into Jackett's indexer config via API — removed because RuTracker's login intermittently requires a
  CAPTCHA a script can't solve; RuTracker is now configured by hand through Jackett's own web UI.
- **`UpdateService.cs`** — checks GitHub Releases for the latest TorrServer build, downloads it,
  verifies SHA-256 and the reported version before replacing the running binary, and rolls back to a
  backup copy if the new binary fails to start.
- **`PluginHub.cs`** — the largest and most involved file. Runs its own `HttpListener` on port 8095
  (`http://+:8095/`) as a mini local web app:
  - Serves an HTML control panel at `/` for adding/editing/enabling Lampa plugins (by URL) and choosing
    a torrent search mode (Rutor / Torznab / both).
  - Downloads and SHA-256-caches plugin `.js` files locally (`lampa-cache/`), so devices on the LAN load
    plugins from this machine rather than directly from the internet — see `/plugins/{cacheKey}.js`.
    Keeps a previous-version backup and never removes a working cached copy on a failed refresh.
  - **`/plugins/*.js` and `/lampa.js` both send `Cache-Control: no-cache` + an `ETag`, and the plugin
    route now actually honors `If-None-Match` with a real 304** — found missing while chasing a report of
    a device seemingly running old plugin JS after an update. Without `Cache-Control`, nothing stops a
    device's own HTTP cache from reusing a stale response indefinitely and never even asking the server
    again — our own SHA-256 diffing on the *server* side (deciding when to re-download from the plugin's
    real source) is a completely separate mechanism from whether a LAN device's *client-side* cache
    thinks it needs to ask us again at all, and updating one doesn't fix the other. `no-cache` (not
    `no-store`) keeps the cheap-revalidation win — the client still gets to skip the response body on an
    unchanged 304, it just can't skip asking anymore.
  - Serves `/lampa.js`, a bootstrap loader script that Lampa fetches once; it reads `/api/config` and
    sequentially injects the enabled, locally cached plugin scripts.
  - `/api/config` (GET/POST) and `/api/plugins/refresh` (POST) drive the panel; mutating endpoints are
    restricted to loopback requests (`EnsureLoopback`).
  - `/api/smart-search` proxies a RuTracker query through the locally running Jackett instance using its
    stored API key. Used by `SmartTsPlugin.js`.
  - `/api/torrent-search` is the same idea but calls Jackett's aggregate `indexers/all/results` endpoint
    (all configured indexers fanned out server-side by Jackett itself, not by us) instead of the hardcoded
    `rutracker-ru` one, and returns `{results, indexers}` — `indexers` is Jackett's own per-source
    `{ID,Name,Status,Results,Error,ElapsedTime}` array, verified live against this project's own Jackett
    instance before wiring it up, so the client can tell "no results" apart from "half the trackers timed
    out." Uses a request-scoped `CancelAfter(45s)` linked `CancellationTokenSource` rather than the shared
    `httpClient.Timeout` (25s) — Jackett's own aggregate ceiling is ~40s, so the shared timeout would cut
    the request off before Jackett gives up on its slowest indexer. Used by `TorrentModPlugin.js`.
  - `/jackett/*` reverse-proxies to loopback Jackett (`GET` only, path + query string passed through
    verbatim) so LAN devices can reach it despite Jackett staying bound to `127.0.0.1`. This exists
    because Lampa 3.2.8+ has its own native "Тип парсера: Jackett" setting (a direct URL + API key field,
    separate from `SmartTsPlugin`'s RuTracker-only proxy) that needs a LAN-reachable Jackett endpoint.
    Tried making Jackett itself bind `0.0.0.0` directly first (`AllowExternal`/`LocalBindAddress` in its
    `ServerConfig.json`) — Jackett refuses with "Unable to switch to public listening without admin
    rights" unless `JackettConsole.exe` itself runs elevated (its own internal check, confirmed by
    running it manually with `-z` and watching the console output; a `netsh http add urlacl` reservation
    for the port did *not* help, so it isn't an HTTP.SYS/URL-ACL issue). Running Jackett as a Windows
    service (LocalSystem) would also satisfy that check, but reintroduces the UAC-per-click and
    service-install complexity the migration away from a service (see below) deliberately removed, plus
    runs Jackett with far broader privileges than the interactive user — rejected for both reasons. The
    proxy keeps Jackett unprivileged and loopback-only exactly as before; `MainForm`'s Jackett card shows
    `PluginHub.JackettProxyUrl` (`http://<lan-ip>:8095/jackett`) as the "Ссылка" to paste into Lampa's
    parser settings, alongside `JackettController.GetApiKey()` (read straight from `ServerConfig.json`).
  - Plugin configuration persists to `lampa-plugins.json`; download cache metadata persists to
    `lampa-cache/cache-state.json`. Both are written atomically (write to `.tmp`, then `File.Move`).
  - Runs a periodic background refresh (`RefreshInterval` = 6h) of all enabled plugins in addition to
    on-demand refresh from the panel.
  - Also hosts the Lampa web app itself (not just plugins for an existing install) at `/app/`, source
    [yumata/lampa](https://github.com/yumata/lampa) (the built static distribution — not
    `yumata/lampa-source`, which needs an npm build). Update checks read
    `raw.githubusercontent.com/yumata/lampa/main/assembly.json` for `app_version`/`hash` (cheap; no
    GitHub API calls, no rate limit concern); on a hash change it downloads the `main` branch zip via
    `codeload.github.com`, validates `index.html` is present, then swaps `lampa-app/` with an
    `App.previous`-style backup — same download/verify/swap/rollback shape as `UpdateService` and the
    Jackett updater. Runs on the same 6h loop as plugin refresh, plus a manual "Обновить" button in
    the UI. State persists to `lampa-app-state.json`.
  - Static files under `/app/` are served relative to `AppPaths.LampaAppDirectory` with a path-traversal
    guard and an extension → MIME map (`HttpListener` has none built in). `msx/start.json` gets its
    `{domain}` placeholder rewritten on the fly to this machine's LAN address + `/app`, since Lampa's own
    MSX install docs otherwise expect that substitution done at build/deploy time.
  - Note: `HttpListenerRequest.Url.AbsolutePath` is trimmed of trailing slashes before routing (see
    `path.TrimEnd('/')` in `HandleAsync`), so route matching must treat `/app` and `/app/` as the same
    path — a route that 302-redirects `/app` to `/app/` will redirect-loop forever once the trailing
    slash gets stripped back off. Handle both spellings in one branch instead.
- **`BuiltInPlugins.cs`** — holds a static list of `BuiltInPluginDefinition` (id/url/name/category/embedded
  resource name) and loops over it in `Ensure`/`Read`/`IsBuiltIn`, rather than one hardcoded plugin — this
  is what lets `TorrentModPlugin.js` (`builtin://torrent-mod`) ship embedded in the assembly instead of
  fetched from a URL, while still flowing through the same PluginHub caching/serving path as
  externally-added plugins. Add a new entry here (plus the matching `<EmbeddedResource>` in the `.csproj`)
  for any future built-in plugin. (A second built-in, `SmartTsPlugin.js`, shipped earlier in this
  project's history — a single-RuTracker-indexer, `Lampa.Select.show`-overlay-only predecessor. Retired
  once `TorrentModPlugin.js` matured into a full replacement — same job, all Jackett indexers instead of
  one, its own results screen instead of an overlay. If a plugin's config entry survives from before this
  removal, `BuiltInPlugins.Read` throws `InvalidDataException("Неизвестный встроенный плагин.")` for it —
  clear it via `POST /api/config` rather than hand-editing `lampa-plugins.json`.)
- **`TorrentModPlugin.js`** — source lives as real ES modules (`import`/`export`) under
  `Plugins/TorrentModPlugin/`, grouped into folders by concern rather than left flat — the split
  follows the actual import graph between files (checked, not guessed), not a copy of the C# side's
  Infrastructure/Controllers/Services/UI layering: `shared/` (`state.js`, `utils.js` — no internal
  deps, imported by nearly everything), `search/` (`query-building.js`, `release-parsing.js`,
  `scoring.js`, `search-backend.js` — the Jackett query→parse→score pipeline), `metadata/`
  (`tmdb.js`, `season-picker.js` — TMDB season/episode data; zero import edges to/from `search/`,
  confirming these are genuinely separate concerns and not one pipeline), `playback/`
  (`smart-preload.js` alone — a deliberately single-file folder, since it's a named headline feature
  orthogonal to both search and screen rendering, not because every folder needs >1 file), `domain/`
  (State + Interactors for the results screen — see below), `ui/` (the three Lampa-registration
  files `card-button.js`/`settings.js`/`styles.js`, plus the results screen's own View — see below),
  and `index.js` at the folder root as the entry point (mirrors `Program.cs` staying at the C#
  project root). `npm run build:plugin` (esbuild,
  `package.json`) bundles it into
  `Plugins/TorrentModPlugin.bundle.js` — a single classic script, `--format=iife` — which is what
  actually gets embedded as `TorrServerManager.TorrentModPlugin.js`; the bundle is generated and
  gitignored, never edited directly. `TorrServerManager.csproj`'s `BuildTorrentModPluginBundle`
  target runs this automatically before `CoreCompile` (with `Inputs`/`Outputs` so it skips when
  nothing under `Plugins/TorrentModPlugin/` changed), auto-installing npm packages first via a
  `node_modules`-existence check — `dotnet build`/`dotnet publish` alone is still enough, but
  **building this project now requires Node.js on PATH**. Deliberately *not* `<script
  type="module">` in Lampa itself — Lampa injects one plain `<script src="...">` tag per plugin,
  and the target device is an LG WebOS TV browser, not worth the module-loading/CORS risk there;
  esbuild's IIFE bundle is what actually ships. Own card button, own
  `Lampa.Component.add('torrent_mod', ...)` results screen (not a native-screen wrapper) — a deliberate
  product choice; see the plan this was built from (`playful-leaping-wilkinson` in `~/.claude/plans/` at
  authoring time) for the tradeoffs. Searches via `/api/torrent-search` (all Jackett indexers at once).
  Primary content is EPISODE metadata from TMDB (a scrollable list, not raw torrent results) — picking an
  episode triggers an automatic, mostly-invisible torrent match: auto-play on a confident match, a small
  `Lampa.Select.show` picker otherwise. `parseRelease()` (quality/HDR/audio/subtitle/season/episode
  tagging from raw Torznab titles) was tuned against real titles pulled live from this project's own
  Jackett instance, not guessed — re-tune here if tag accuracy drifts.
  - **Candidate scoring is matchScore-as-gate, then qualityScore+availabilityScore for ranking — not one
    blended number.** `passesMatchGate(item, target)` is a hard filter: title similarity below 0.34, or a
    release that explicitly states the wrong season, or explicitly states an episode range that excludes
    the target episode, and the candidate is dropped from the list entirely — it does not get ranked low,
    it does not appear in the fallback picker either. A torrent titled with the right `SxxExx` tag for a
    completely different show must never be an option just because nothing else matched. Releases that
    don't state season/episode explicitly at all (common on some trackers) pass through ungated for
    quality/availability to rank. Among gate-passed candidates, `qualityScore` is a **triangular peak**
    around `referenceBitrateMbps(release)` (a resolution → Mbps table, halved for `H.265`/HEVC since it's
    roughly twice as efficient as H.264 at the same perceived quality) — full marks on-target, falling off
    in *both* directions, so a bloated 80 Mbps 1080p remux does not automatically outrank a sane 6 Mbps
    encode the way a monotonic "bigger bitrate wins" score would. `availabilityScore` folds seeders and
    peers into one `log(seeders + peers*1.5 + 1)` figure (peers weighted above seeders — they're the live
    swarm that actually drives download *speed*; a seeder can be idle) instead of two separately-capped
    terms. Auto-play requires `availabilityScore` above a floor (`MIN_AVAILABILITY_FOR_AUTOPLAY`) on top of
    being the clear top-ranked candidate — a perfect title/season/episode match with an empty swarm must
    never auto-play, that's a hang, not "feels like an online service". Sanity-checked against synthetic
    candidates in a standalone Node harness (gate correctly excludes a same-`SxxExx`-tagged wrong show and
    a wrong-season release of the right show; season packs score the same per-episode bitrate as an
    equivalent single-episode release, via `estimateBitrateMbps`'s coverage-aware division; a bloated
    remux loses to a sane encode on `qualityScore`; HEVC at half the H.264 reference bitrate still scores
    near-peak) since live Jackett search is occasionally slow/unavailable and the scoring functions are
    pure enough to test without a browser.
  - **Per-candidate data pulled from Jackett's own response, not just regexed off the title**: publish
    date (`raw.PublishDate` → `item.publishedAt`, shown in the picker as "N дн. назад" — a stale season
    pack sometimes has a data problem a newer one already fixed), plus the already-parsed
    `audioChannels`/`subtitles` (parsed since early on but previously computed and discarded — now shown
    in the picker subtitle alongside tracker/seeders/peers/size/voice type).
  - **Searches the whole season once, in the background, the moment the episode list loads — not once
    per episode click.** The insight: everything needed to search is already known the instant Torrent
    Mod opens for a series (title, season, TMDB's own runtime/episode-count data for a correct
    per-episode bitrate estimate) — every per-episode search would build the same season-pack-shaped
    query anyway (`buildQueries` with no `episode` on the target only ever produces season-level query
    variants). `ensureSeasonPool()` fires this search from `loadEpisodes()`, and the pool it returns
    does three things: (1) **episode row badges** — `candidatesForEpisode(pool, number)` runs the exact
    same gate+filter+sort pipeline `selectEpisode`'s fresh search uses, just against the already-fetched
    pool, and `annotateEpisodeRows()` writes a quality/seed summary (or "раздачи не найдены") onto each
    row *before* the user commits to anything; (2) **Перевод/Фильтры options are pulled from what's
    actually in the pool** (`poolValues()`) instead of a fixed list — no point offering a 4K filter for
    a season nothing 4K was ever found in, falls back to the old static list only while the pool is
    still loading; (3) **`selectEpisode` reuses the pool instead of a fresh network round trip** when it
    already has a gate-passing match for the clicked episode — a season pack candidate has no
    `explicitEpisode`, so it legitimately matches *every* episode in the season, not just the one it was
    first found under. Falls through to a real, episode-targeted search only when there's a custom query
    override (explicit intent always gets its own search), the pool hasn't resolved yet, or the pool
    genuinely has nothing for that specific episode — a targeted `SxxExx` query can surface
    single-episode torrents a season-level query's terms missed, so the fallback is a recall safety net,
    not just a loading-state placeholder. Verified with a Node harness extending the `scoreCandidate` one
    above (a season pack candidate correctly matches multiple distinct episodes; the gate still excludes
    the wrong show/season per-episode even when read from a shared pool; voice-filtering the pool
    correctly narrows to just the episode-specific release when the pack's own translation doesn't
    match, and correctly returns nothing — not a silent fallback to the whole pool — when a requested
    translation exists somewhere in the pool but not for that specific episode).
  - **The toolbar's search chip is a real `new Lampa.Filter(object)`, not a hand-built lookalike** — this
    was the actual gap behind "где системный интерфейс поиска по названию": the first version used
    `Lampa.Input.edit`, a bare text box with none of what Lampa's own search-clarification flow gives for
    free. Confirmed by reading `Lampa.Filter`'s constructor in `app.min.js`: pressing `.filter--search`
    opens a native "Уточнить" picker with — a "Указать название" entry that opens `SearchInput` (a real
    typed-search widget, not a plain prompt) and *saves what you type* to `Storage['user_clarifys'][movie.id]`
    so it resurfaces as a history entry next time; a "Глобальный поиск" entry; the movie's own
    `names`/`alternative_titles.titles` (TMDB alt-name data, when present); and title+year combinations
    built from `search_one`/`search_two` (Torrent Mod passes `baseTitles(movie)`'s two entries here — the
    localized and original titles). None of this is reachable by constructing the markup by hand; it only
    exists inside `Lampa.Filter` itself.
  - **Season/Перевод/Качество live in `Lampa.Filter`'s own `'sort'`/`'filter'` chip slots, not extra
    hand-built chips appended alongside it** — confirmed by reading Online Mod's own source: it does the
    same thing, `filter.set('sort', its own balancer list)` and `filter.set('filter', its own quality
    list)`, not extra `.simple-button--filter` divs of its own. The two built-in chip labels
    ("Сортировать"/"Фильтр") aren't tied to their literal meaning — Online Mod repurposes 'sort' for an
    unrelated balancer/source picker the same way Torrent Mod repurposes it for season — so there was no
    real tension in reusing them for three custom concepts across two slots: `filter.set('sort',
    buildSeasonItems(...))` for season (flat list), `filter.set('filter', [{title:'Перевод', items:...},
    {title:'Качество', items:...}])` for voice+quality (`Filter.prototype.show()`'s own nested-submenu
    support — an item with its own `.items` reopens as a child `Select.show`, confirmed live: picking
    "Перевод" opens a second-level list, picking a leaf there calls `onSelect(type, parentItem,
    leafItem)` and Filter reopens the parent list itself, no extra code needed for that part).
    `filter.set('filter', ...)` gets re-called whenever the season pool resolves, so the options track
    what's actually available exactly like the old hand-built chips did.
  - **Found the real, serious bug behind all of this while wiring it up: `Lampa.Select.show()` has two
    independent close paths, and only one of them restores focus.** Back/cancel goes through `close$a()`
    (`hide$3(); Activity.mixState(); if (active.onBack) active.onBack();`) — the only path that calls
    `onBack`. A **successful pick** goes through a completely different function, `hide$3()` alone (found
    in `bind$3()`'s `goclose()`: `if (!active.nohide) hide$3();`) — it only flips the `selectbox--open`
    body class, never touches `Controller`, never calls `onBack`. A first pass at fixing this (setting
    `filter.onBack` to restore focus) looked complete because *nested* picks — Перевод→Дубляж, the
    season submenu inside the Фильтр panel — happen to self-heal: `Lampa.Filter`'s own code reopens a
    fresh `Select.show` right after a nested leaf pick, which re-toggles `'select'` and defers the actual
    breakage to the next real Back press, which does go through `close$a()`. A **flat, non-nested** pick —
    the reset entry, a season chosen directly off the fast season chip, a search suggestion picked
    directly (no sub-menu involved) — never gets that reopen, so `onBack` never fires and `'select'`
    stays permanently active. Confirmed live on both a vanilla `Lampa.Select.show(...)` call on the
    untouched native main screen (general API trap, not specific to this plugin) and on each affected
    branch here. **Fix: restore focus (`Controller.toggle('content')`) explicitly inside every branch of
    `onSelect`/`onSearch` itself, not just in `onBack`** — safe to do unconditionally even on branches
    that already self-heal via reopening (a redundant `toggle('content')` immediately followed by the
    reopen's own `toggle('select')` is harmless synchronous churn). Full writeup with the exact source
    read: [`docs/system-design/lampa-navigation-contract.md`](docs/system-design/lampa-navigation-contract.md).
  - **The Фильтр panel's shape was rebuilt to match Online Mod's own, read directly from its source rather
    than guessed from the screenshot alone**: a `{title:'Сбросить фильтр', reset:true}` leaf first (no
    `.items`, so `Filter.show()` calls `onSelect(type, a)` directly on pick, no submenu), then one row per
    dimension built the same way Online Mod's own `add(type, title)` helper does —
    `{title, subtitle: currentValueLabel, items: subitems, kind}` — so the collapsed panel shows the
    current value of every dimension at a glance instead of requiring a drill-down to see it. Season is
    intentionally in both places (its own fast `'sort'` chip *and* a row inside the Фильтр panel) —
    Online Mod does the same redundancy with its balancer, own chip plus a row in the comprehensive panel.
  - **Torrent candidates now render as the screen's own primary content (reusing the episode row markup,
    including the badge slot) instead of a `Lampa.Select.show` overlay** — for a movie this *is* the
    primary content from the start (`start()` calls `selectEpisode(0)` directly instead of waiting on a
    "Найти раздачи" button click); for a series it replaces the episode list when auto-play isn't
    confident enough, with a "← К списку серий" row (using the already-fetched `state.episodesCache`, no
    refetch) to go back. Two side benefits: richer info than a Select item's single subtitle line ever
    fit (quality/source/HDR/codec/translator/tracks on one line, tracker/seeds/peers/size/date on
    another), and one whole class of Select-focus-restoration bug (see above) no longer applies to this
    particular interaction at all, because it isn't a `Select.show` anymore.
  - **`parseRelease()` now extracts translator studio names, source type (WEB-DL/BDRip/Remux/HDTV/...),
    and audio track count**, not just resolution/HDR/codec/generic voice category. `translator` is a
    curated, deliberately incomplete list of common Russian-scene studios (`TRANSLATOR_STUDIOS` —
    LostFilm, NewStudio, Jaskier, Кубик в Кубе, Кураж-Бамбей, etc.) matched via `containsWord()`, a
    Cyrillic-safe manual word-boundary check (plain `\b` doesn't work — see the Дубляж regex bug below)
    that also tolerates spaces being written as dots/underscores/hyphens in real release titles
    (`Кубик.в.Кубе` matches `Кубик в Кубе`). Extend the list as new studios show up in
    `torrent_mod_debug` logging rather than trying to enumerate every one up front. `translator` is shown
    wherever a candidate's info line is built (row badges, picker text, debug table) in preference to the
    generic `voiceType` bucket when present, but deliberately isn't wired into the Перевод *filter*
    dimension itself — mixing specific studio names and generic MVO/AVO/Дубляж categories as sibling
    filter options would conflate two different things the user might want to filter by.
  - **The results list wasn't using `Lampa.Scroll` correctly — keyboard scrolling silently did nothing,
    the last rows were permanently unreachable, and there was no bottom mask/gradient**, all from the
    same root cause: `scroll.minus()` was called with **no argument**. Reading `Lampa.Scroll.prototype.minus`
    directly: `minus(el) { html.classList.add('layer--wheight'); html.mheight = el; }` — it only *marks*
    the element and stores which other element's height to subtract; the actual math
    (`window.innerHeight − head − navbar − el.height`) runs in `Lampa.Layer`'s own internal sweep over
    every `.layer--wheight` element, triggered automatically once when the marked element mounts (no
    explicit `Layer.update()` call was needed for *that* first render). Without an
    argument, the scroll container never gets a height constraint at all — it just grows to fit all
    content, unconstrained, which is exactly why there was nothing to internally scroll and no mask
    (mask-image fade only makes visual sense against an actually-clipped container). Fixed:
    `scroll.minus(explorer.render(true).querySelector('.explorer__files-head'))` — the actual *mounted*
    head container (a bare pre-mount `toolbar` element gave the wrong height — confirmed live, 56px off),
    matching Online Mod's own `scroll.minus(files.render().find('.explorer__files-head'))`. `status` also
    had to move from `explorer.appendFiles(status)` to `explorer.appendHead(status)` so its height was
    covered by that same subtraction (33px off otherwise). Separately (but related): **`Navigator.move()`/
    arrow-key focus changes never scroll anything into view by themselves** — that's `hover:focus`, a real
    per-item jQuery event Lampa's own native lists all bind individually (`item.on('hover:focus', e =>
    scroll.update($(e.target), true))`, confirmed both in core Select's own item binding and in Online
    Mod's own `this.append`) to make the *scroll* follow whichever element focus lands on. `row()` now
    does the same for every row. Also matched Online Mod's real horizontal spacing, found the same way
    (`getComputedStyle`, not a screenshot): its scroll body carries a `torrent-list` class with ~1.4em
    horizontal padding, and each row counters it with ~-.75em negative margin.
  - **Even after all of the above, a stubborn ~15.2px gap remained** between the left card's scroll
    bottom and the right content's scroll bottom — the two independent `mask-image` fades (each computed
    as a percentage of its own container's height) landed at visibly different heights instead of forming
    Online Mod's one continuous full-width fade band. Root cause: plain CSS margin collapse, nothing to do
    with `Lampa.Scroll` at all. `.torrent-mod__status` (the last child inside `.explorer__files-head`) had
    `margin: 0 0 1em 1.5em`; a block element's bottom margin collapses straight through its parent's own
    bottom edge when the parent has no border/padding there (`.explorer__files-head` doesn't) — so that
    `1em` (15.2073px on this build's base font-size, matched the observed gap to within 0.01px) silently
    pushed `.explorer__files-body` down without ever showing up in `.explorer__files-head`'s own
    `getBoundingClientRect().height`, which is exactly what `.minus()` measures. Fixed by changing that
    rule to `padding: 0 0 1em 1.5em` — padding doesn't collapse, so the same visual spacing now counts
    toward the measured height. Verified live via `getBoundingClientRect`, not a screenshot:
    `leftTop + headH === rightTop` and `leftBottom === rightBottom === 703.0625` — pixel-identical to the
    same measurement taken on live Online Mod. Lesson: a geometry mismatch between a plugin's layout and a
    native reference doesn't have to be a JS/API misuse bug — it can just as easily be ordinary CSS margin
    collapse on an element the code never directly touches.
  - **A third, independent cause of the same symptom, found while re-verifying the above two fixes on
    the candidate-list render (not just the episode list)**: `Lampa.Layer`'s `.layer--wheight` sweep only
    fires on its own triggers (element mount, apparently), not on every mutation *inside* an
    already-marked element. `status`'s text changes repeatedly during a screen's lifetime (`'Загрузка
    списка серий…'` → `''` → `'Ищем S07E01…'` → `''`), which changes `.explorer__files-head`'s real
    height each time — but the height baked into the scroll's `style.height` by `scroll.minus()` stays
    pinned to whatever `.explorer__files-head` measured at the *first* sweep, silently drifting stale as
    soon as status's height changes again. Confirmed live: after a search resolved, the candidate list's
    scroll bottom sat 18.25px above the left card's — calling `Lampa.Layer.update()` (a public, no-arg
    function, confirmed to exist) closed the gap back to 0 immediately. Fixed by calling it inside
    `refreshGrid()` (the shared function both `renderEpisodes` and `renderCandidateList` already call
    after rebuilding `grid`), so a fresh recompute happens every time content — and therefore potentially
    the head's own height — changes, not just on first mount.
  - **Found a real, pre-existing accuracy bug while building the above**: `matchOne`'s voiceType pattern
    for Дубляж was `/\bдубляж\b|\bdub\b/i` — the `\b` word-boundary wrapped around the *Cyrillic* word
    never matches, because JS regex `\b` is defined against `\w` (`[A-Za-z0-9_]` only) and neither side
    of a Cyrillic word is `\w`, so no boundary transition ever forms there (confirmed:
    `/\bдубляж\b/i.test('x264 Дубляж')` → `false`; the boundary-free `/дубляж/i` → `true`). Every other
    voiceType alternative (Многоголосый/Одноголосый/Оригинал) already omitted `\b` around its own
    Cyrillic form for exactly this reason — Дубляж was the one inconsistent case, so real Дубляж
    releases have been silently mis-tagged as unlabeled since this regex was written. Fixed by dropping
    the `\b` pair around the Cyrillic alternative, matching the other three. **General lesson: never wrap
    `\b` around a Cyrillic (or any non-ASCII-word-character) alternative in a JS regex** — it silently
    never matches rather than erroring, so nothing flags it short of a side-by-side data check like the
    one that caught this.
  - **The whole left info panel + toolbar + scrollable list chrome is `Lampa.Explorer`**, not hand-built
    markup — confirmed live by opening this app's own `/app/` in a browser and inspecting the real,
    running Lampa/Online Mod DOM (`new Lampa.Explorer(object)` auto-populates the left card from
    `object.movie`; `explorer.appendHead(el)` fills the toolbar row, unhiding it;
    `explorer.appendFiles(el)` fills the scrollable body; `explorer.render(js)`/`explorer.destroy()` map
    straight onto the Component contract). An earlier hand-rolled version (custom flex CSS for the info
    panel, custom `.torrent-mod__control` toolbar chips) visually didn't read as "native" at all — this
    is why. Toolbar controls use Lampa's own real `.simple-button.simple-button--filter` markup
    (`<div class="simple-button simple-button--filter selector"><span>Label</span><div>Value</div></div>`,
    also confirmed live) instead of custom-styled divs, for free native styling.
  - **Lampa's real Controller/Activity navigation contract, confirmed live by reading `app.min.js`
    directly (not guessed) after a real reported bug — the Torrent Mod screen broke Lampa's own back
    button app-wide.** Root cause: `new Lampa.Explorer(object)` only ever registers **one** named
    controller, `'explorer'`, for the left info card (`explorer.toggle()` → `Controller.add('explorer',
    {..., right: () => Controller.toggle('content'), back: () => Activity.backward()})`). It does **not**
    register `'content'` for the scrollable body/grid — that's left entirely to the caller. Without doing
    that ourselves, `Controller.collectionSet(...)` calls from the results-rendering functions silently
    mutate whatever controller happens to be active *at that moment* (usually still `'explorer'`, since
    they often run before the user ever presses right), stomping Explorer's own left-card focus
    collection with our grid rows while leaving Explorer's `left`/`back`/`toggle` handlers in place —
    back then does the wrong thing depending on timing. The fix: register our own `'content'` controller
    (`left` → `Controller.toggle('explorer')`, `back` → `Controller.toggle('explorer')` — i.e. leaving the
    grid returns focus to the card, it does **not** pop the activity; only `'explorer'`'s own `back` does
    that), symmetric with what Explorer already does for the card. **Must be (re-)registered inside the
    component's own `start()`**, not once in the constructor — `ActivitySlide.start()` (Lampa's own
    per-activity wrapper) unconditionally re-registers its placeholder `'content'` on every start/restart
    of an activity (e.g. whenever the user returns from a pushed sub-screen) *before* calling the
    component's `start()`, so a constructor-time-only registration silently reverts after any round trip.
    Verified live via `Lampa.Controller.move('right')` / `Lampa.Controller.back()` / `Lampa.Activity.all()`
    scripted against the running page: focus now goes `explorer → content → explorer → (pop, back to the
    calling screen)`, one activity popped per back press, matching native Explorer-based screens. General
    lesson for any future Explorer-based plugin screen: **the framework only wires navigation for the
    parts of the layout it owns (the left card); anything a plugin adds to the body is the plugin's own
    responsibility to wire into `Controller`, not just visually append.**
  - **`Controller.collectionSet(html, append)` concatenates `.selector` matches from *both* arguments
    into one flat, spatially-navigable collection** (confirmed by reading its body in `app.min.js`) —
    this is exactly how Online Mod's own results screen keeps its filter/balancer chip row and its result
    rows reachable by the same up/down presses: `collectionSet(scroll.render(), files.render())`.
    Torrent Mod's first pass got this backwards: it passed `grid` (a DOM descendant of `scroll`, already
    covered by `html`, so a no-op) instead of `toolbar` (the search/season/voice/filters chip row, which
    lives in Explorer's separate `.explorer__files-head` and was never in *any* collection) — confirmed
    live by pushing the component and driving `Lampa.Controller.move('up'/'right'/...)` from script: the
    toolbar was a dead zone, reachable only by mouse/touch, never by keyboard or a TV remote, which for an
    app whose whole purpose is a Lampa/WebOS TV setup is as serious as the back-button bug. Fixed by
    passing `toolbar` as the second argument. Caught a second, related gap the same way: the `'content'`
    controller had no `right` handler at all — per `Controller`'s internal `run(name)` (confirmed live:
    `if (active[name]) active[name](params)`, no fallback when the key is simply absent), an *undefined*
    direction handler isn't a no-op with default behavior, it's a completely dead key. Any named controller
    a plugin registers needs an explicit handler for every direction it wants to support; there is no
    built-in default movement to fall back on.
  - `Lampa.Component.add`'s real contract, confirmed live: a bare `create`/`render`/`destroy` is
    enough (this is literally what Lampa's own `nocomponent` fallback implements) — `start`/`pause`/
    `stop`/`back` are optional extras the Activity wrapper calls if present. `Lampa.Component.create`
    wraps `new component[name](object)` in try/catch and **silently swaps in `nocomponent`** (a generic
    "Здесь пусто" empty-state) on ANY constructor exception — a real bug (e.g. a typo'd API call) shows
    no visible error at all, just the wrong empty screen. Check `console.log('Component', 'create error',
    ...)` in devtools first if a results screen won't render.
  - `Lampa.Utils.escape` **does not exist** in this Lampa build (confirmed live — was the actual cause of
    the "silently falls back to nocomponent" bug above the first time). Use the plugin's own local
    `escapeHtml()` for any HTML interpolation instead of assuming Lampa provides one.
  - Deliberately does **not** globally patch `Lampa.Player.play`/`Lampa.Torserver.stream` — that would
    affect every torrent screen in Lampa, not just this one, a reliable source of hard-to-debug ordering
    bugs. **`Lampa.Torrent.start(...)` is NOT called anymore** (it used to force Lampa's native
    torrent-file screen open — «сиди и выбирай» — which is exactly what we got rid of; see the direct
    playback pipeline below). Instead: `Lampa.Torserver.hash({link: magnet||.torrent-link})` registers
    the torrent directly, `Torserver.files(hash)` is polled until metadata resolves, `pickBestFile()`
    scores season/episode signals in the file paths (from `file_stats`, not native events), and once
    our **duration-based** buffer target is met we call `Lampa.Player.play({url, timeline, playlist})`
    where `url = Torserver.stream(path, hash, id)` (the official Lampa stream URL, never invented),
    `timeline = Timeline.view(Torserver.parse({movie, files, filename, path}).hash)` (the same hash
    `Timeline.watchedEpisode` reads — NOT the torrent infohash), and `playlist` built from all
    playable files of the pack (Player.play wires Playlist from data.playlist, player.js:1243 — that's
    what keeps next-episode inside a season pack working). Three native side effects of the old
    `Lampa.Torrent.start` path are compensated explicitly: `Favorite.add('history', movie, 100)`
    (continue-watch card), the timeline above (per-episode watch history), and the playlist.
    **No pre-start buffer overlay anymore** — the user rejected it as "лишний моргающий интерфейс":
    a click goes STRAIGHT to `Player.play`, the player buffers on its own via the TorrServer stream.
    What stays silent: a fire-and-forget `&preload` nudge (starts the download before the player
    asks), the ffprobe gate (probeSelectedFile: a CONFIRMED-bad video codec — MPEG-2/MPEG-4 ASP/
    VC-1/WMV/... — blocks playback with an honest toast instead of a black screen; 'unavailable' is
    not proof of bad, play anyway), and next-episode preloading near the end of the current file
    (`torrent_mod_preload_next`). (History: the old path listened to Lampa's `torrent_file`
    events and replayed the file's own `hover:enter` — replaced because the native screen itself was
    the problem.)
  - **Confirms the title-guessed quality/audio/subtitle badges against the real file once one is picked**,
    via TorrServer's own `/ffp/{hash}/{fileId}` — TorrServer bundles `ffprobe` for its transcoding support
    and exposes it at that path. Found by reading a third-party plugin, **MediaInfo** (`iptvgeek_mediainfo`,
    formerly in this project's own plugin list), whose entire job is exactly this: it calls `/ffp/`, with a
    fallback to a public "Tracks Inspector" service when a TorrServer build lacks `ffprobe` (that endpoint
    then 400s). `fileId` isn't DOM/array position — it's TorrServer's own file `.id`, obtained the same way
    MediaInfo gets it: `POST /torrents {action:'get', hash}` → match `file_stats[].path` against the
    already-picked file, read `.id` off that entry. `probeRealTracks()` does this once per download, right
    after `pickBestFile()` — on success, replaces the preload overlay's generic buffering copy with the
    ffprobe-confirmed resolution/codec/audio-track-count/subtitle-track-count; on failure (no `ffprobe` on
    this TorrServer build, or the request just fails) it stays quiet, same as the title-only badges already
    shown elsewhere. Deliberately skips MediaInfo's own public-service fallback — a third-party dependency
    outside this project's infrastructure, inconsistent with keeping everything (Jackett, TorrServer)
    local/loopback-only.
  - **Two real, repeatedly-reported bugs in the smart-preload overlay, both found live while
    re-verifying an unrelated View/ViewModel/Core split of `results-screen.js` (see below) — neither
    was caused by that split, `smart-preload.js` itself was untouched by it (confirmed via `git diff`
    before investigating).** (1) Some Torznab indexers (confirmed live: NoNaMe Club) don't return a
    magnet URI at all, only an HTTP link to download the raw `.torrent` file — `item.magnet` is `''`,
    so `extractInfoHash()` has nothing to parse and `hash` comes back empty. The old code treated this
    as "can't poll `/cache` without a hash — let native flow run unassisted" and bailed out of the
    whole smart-preload flow entirely, leaving `Lampa.Torrent.start()`'s own native torrent-file
    screen (an unavoidable side effect of that call) fully exposed with nothing covering it — this is
    the actual bug behind repeated user reports of "Lampa's ugly native torrent interface" appearing.
    Fixed without implementing bencode parsing ourselves: `Lampa.Torrent.start()` still downloads and
    parses the `.torrent` on TorrServer's own side, and the resolved hash shows up shortly after in
    `POST /torrents {action:'list'}` under a title match — confirmed live, `Lampa.Torrent.start` itself
    prefixes whatever title we pass with `"[LAMPA] "` before TorrServer sees it, so a substring match
    against the plain title survives that prefix without needing to know its exact format.
    `resolveHashByTitle()` polls that same `list` action (already used elsewhere by `probeRealTracks`,
    just a different action) every 700ms up to 8 times, filtering by title+hash-present and picking the
    most recent match by `timestamp` (in case of duplicate historical entries), and mutates
    `pending.hash` in place once found — no need to restart the already-running `/cache` poll loop
    inside `showSmartPreload`, since it reads `pending.hash` fresh on every tick already. (2) Even once
    the overlay does show, its background was `rgba(8,12,20,.92)` (92% opaque, not fully) — confirmed
    live this was enough for the native torrent-file screen's own bright rows to visibly bleed through
    at the edges, reported directly as "тоже самое говно" (same crap) still showing behind our own
    overlay despite it technically being on top and z-indexed correctly. Changed to a fully opaque
    `#080c14` — no CSS-transparency category of bug can recur here regardless of what's rendered
    underneath, a stronger guarantee than tuning the alpha value closer to 1 would have been.
  - **Season/translation/quality filter choices persist across visits, per-movie, matching Online
    Mod's own pattern exactly** — pointed at directly (`Lampa.Storage.get('online_balanser',
    'videocdn')` + `Lampa.Storage.cache('online_last_balanser', 200, {})`, confirmed live in
    `vendor/lampa-source/plugins/online/component.js`) as the standard to match, after the screen
    was resetting to defaults on every open. Two-tier, same shape: a global default
    (`torrent_mod_voice`/`torrent_mod_quality`, `Lampa.Storage.get`) plus a per-movie override cache
    (`torrent_mod_last_season`/`torrent_mod_last_voice`/`torrent_mod_last_quality`,
    `Lampa.Storage.cache(name, 200, {})`, keyed by `movie.id`) that wins over the global default when
    present — same unconditional-override read as Online Mod's own `if (last_bls[movie.id]) balanser
    = last_bls[movie.id]`. **`Storage.cache()` only reads (and prunes down to the max entry count if
    over) — confirmed against the real source, `core/storage/storage.js` — it does not auto-persist
    further mutations**, so every write still needs its own explicit `Storage.set()` call, exactly
    matching Online Mod's own read-mutate-`set()` sequence rather than assuming the returned object is
    a live-persisting reference. Season has no sensible *global* tier (season numbers don't transfer
    between shows) so it only gets the per-movie cache, layered on top of the pre-existing
    `initialSeason()` continue-watching guess (`metadata/season-picker.js`, driven by Lampa's own
    Timeline/watch-progress data) as a fallback, not a replacement for it — per-movie *browsing*
    memory (which season you were looking at) and continue-watching (which episode you've actually
    watched up to) are different signals worth keeping both of. "Сбросить фильтр" persists `'any'`
    too, not just the in-memory state — otherwise reset wouldn't *stick*, the per-movie memory would
    silently restore the old choice on the very next visit. Verified live: picked Season 5 + Дубляж
    for a movie, closed the screen, reopened fresh for the same `movie.id` — both restored
    automatically with no re-selection, confirmed via `Lampa.Storage.cache(...)`/`.get(...)` reads
    showing the correct persisted values immediately after each pick, not just after reopening.
  - **Independent architecture + code review pass** (two separate agents — one evaluating module
    boundaries/state-management/cascading-update risk, one doing a skeptical "what breaks and when"
    code-level pass, both reading the actual source rather than a summary) turned up several real,
    fixed issues plus a calibrated set of things explicitly *not* worth doing for a codebase this
    size (~1,600 lines, no test suite, no linter, no TypeScript — see the project's own stated
    conventions). Fixed:
    - **`loadEpisodes()` and `selectEpisode()`'s fresh-search branch had no staleness guard**, unlike
      `ensureSeasonPool()` two functions away in the same file, which already checked
      `state.seasonPoolSeason !== state.season` before trusting its own async response. Switching
      season twice quickly (trivial via the toolbar chip) could resolve two TMDB/Jackett requests
      out of order over real HTTP (no FIFO guarantee) and silently mislabel one season's episodes
      as another, or paint a stale search result over a newer one — wrong content, not a crash,
      worse than a visible error. Both functions now capture the season/episode they were called
      for and re-check it against current state before acting on their own response, mirroring
      `ensureSeasonPool`'s existing pattern exactly rather than inventing a new one.
    - **No "has this screen been destroyed" check anywhere** — backing out of Torrent Mod while a
      search was still in flight let the stale `.then()` fire `notify('Jackett недоступен или не
      ответил')` after the fact — a false, confusing message, since the request wasn't rejected by
      Jackett, it was cancelled by `cancelSearch()` on `destroy()`. Added a `destroyed` flag to
      `results-viewmodel.js` (this file was later replaced by `domain/results-domain.js` +
      interactors, see the "domain: Store/State/Interactors" bullet below — the `destroyed` flag
      itself carried straight over as `isDestroyed()`), set by a new `destroy()` on its returned API, checked first thing in
      every async continuation (`loadEpisodes`, `ensureSeasonPool`, `selectEpisode`'s fresh-search
      branch) — `TorrentModComponent.destroy()` now calls `viewModel.destroy()` before `view.destroy()`.
      Verified live: clicked an episode, backed out immediately, watched the console — no spurious
      toast, no error, once the in-flight search actually resolved seconds later.
    - **`maybeProceed()` (playback/smart-preload.js) checked `!pending.bestFile` *before* checking
      `ready`/`timedOut`**, so if TorrServer never rendered any file for the torrent at all (a
      dead/stalled magnet, or genuinely zero usable peers) — exactly the population most likely for
      a manually-picked, lower-availability candidate, since auto-play already filters those out —
      **both** intended escape hatches (the 60s timeout and the "Смотреть сейчас" button) silently
      did nothing. "Отмена" was the only button that actually worked; the user was otherwise stuck
      on a permanent "0%" with two dead buttons. Reordered so `ready`/`timedOut` always triggers
      cleanup regardless of whether a file was found, notifying explicitly ("Не удалось определить
      файл автоматически — выберите вручную") instead of hanging when it wasn't.
    - **Nothing prevented a second `startDownload()` call while an earlier one was still pending**
      — an impatient double-click on an episode row during the several-second Jackett search window
      is enough. The second call overwrote the module-level `pendingPlayback` singleton outright,
      orphaning the first pending's `pollTimer`/`clockTimer` (`setInterval`, 1s cadence each)
      running forever: `onTorrentFile()` only ever looks at the *current* `pendingPlayback`, so the
      first pending's `fileItems` never populate and its own `maybeProceed()` gate never opens — a
      real, permanent-for-the-session leak (two `setInterval`s plus a hidden, still-`$('body')`-attached
      overlay div stacked behind the second one at the same z-index). `startDownload()` now tears
      down any still-pending (`!clicked`) `pendingPlayback` first, same effect as pressing "Отмена"
      on it, before starting the new one.
    - **`mapTorrent()` (search/search-backend.js) had no null-entry guard** — a single malformed
      `raw` entry (`null`/`undefined`) in a merged Jackett response threw inside `allResults.map()`,
      and since nothing wraps that specific call, the exception propagated to `searchTorrentMod`'s
      *outer* `.catch()` — discarding **every** query's results, not just the one bad entry, and
      reporting the same generic "Jackett недоступен" even when most or all of the data was fine.
      Fixed with a one-line `if (!raw) return null;`, matching the existing null-return convention
      the function already uses for entries with no usable magnet/link.
    - **`scoreCandidate()` mutates its `item` argument** (`item.bitrateMbps = bitrateMbps`) — `item`
      is a long-lived, shared `state.seasonPool` entry, called once per episode per candidate
      (`results-viewmodel.js`'s `getEpisodeBadges`/`candidatesFor` at the time this was found — the
      equivalent call sites today are `domain/results-selectors.js`'s `selectEpisodeBadges`/
      `selectCandidatesForEpisode`), so `item.bitrateMbps` only ever
      reflects whichever episode this function was *last* called with for that item. Confirmed
      dormant — nothing reads it back off the pool today, only the freshly-returned score object's
      own `.bitrateMbps` is used — documented in place rather than refactored away, since fixing it
      properly means changing scoring to return a score object instead of mutating the candidate,
      a larger change than the actual current risk (zero, today) justifies.
    - **Explicitly not done, and why**: a full type system (TypeScript or `// @ts-check` + `tsc`),
      a committed/CI-gated test suite, a runtime schema-validation library (zod/ajv-style) at module
      boundaries, and blanket `Object.freeze()` on data crossing a module boundary. All would need
      either a new build-tooling dependency this project hasn't needed before (Node + esbuild exist
      *only* because ES modules need bundling for an IIFE target, not as a general precedent) or
      conflict with the working mutate-in-place scoring pattern above without a larger refactor
      first. `search/scoring.js`/`search/release-parsing.js`'s pure functions are already
      hand-verified with a throwaway Node harness exactly when the gating math is touched (see this
      file's own earlier note on that) — the right level of investment for ~1,600 lines with one
      deliberate author and no stated ambition to grow this into a general-purpose framework.
  - **The results screen's View/ViewModel/Core split above was itself superseded by an explicit
    request for a real Domain layer** — State + Interactors, with the View subscribing to state
    changes instead of being pushed to via named callback methods. `Plugins/TorrentModPlugin/domain/`
    now holds: `store.js` (~25-line generic pub-sub — `get()`/`subscribe(listener)`/`patch(partial)`;
    `patch` shallow-merges into a *new* top-level object so untouched fields keep their old
    reference, making `state.x !== previous.x` a valid, cheap dirty-check with no deep-diffing
    needed; has zero domain knowledge on purpose — no "season" or "staleness" concept lives here),
    `results-core.js` (unchanged content, just relocated from `ui/` — the request was explicit that
    "domain logic must live in the domain", and this file was already exactly that, only mis-filed),
    `results-state.js` (`createInitialResultsState` — plain data only; deliberately drops the old
    `seasonPoolPromise` field a live Promise has no business being observable state to begin with —
    replaced by a status enum + generation counter, both plain, comparable, renderable values),
    `results-selectors.js` (derived data — `selectBusy`, `selectFilterChipData`, `selectEpisodeBadges`
    etc. — computed fresh on every call, never stored, for the same "can't drift" reason a separately
    -maintained flag could: a pure function over already-stored fields cannot go out of sync with
    them by construction), and three interactor modules grouped by actual call/data-dependency edges
    in the old code, not surface topic similarity — `episodes-interactor.js` (`loadEpisodes`/
    `ensureSeasonPool`/`setSeason`/`showEpisodeList`: `ensureSeasonPool` was already *called from
    inside* `loadEpisodes`, a direct call edge, and both share the same season-scoped resource set),
    `selection-interactor.js` (`selectEpisode`/`searchWithQuery`/`playCandidate`: `searchWithQuery`
    already delegated to `selectEpisode`, both terminate in the same `finishSelection`), and
    `filters-interactor.js` (`setVoiceFilter`/`setResolutionFilter`/`resetFilters` — deliberately
    separate from the async pair above: synchronous, no network call, no staleness/generation concern
    at all, a genuinely different *shape* of process that grouping with the async ones would have
    diluted). `results-domain.js` is the composition root (`createResultsDomain`) — one shared
    `destroyed` flag both async interactors read, not one per interactor.
    - **Local vs. global waiting states**: three independent status fields
      (`episodesStatus`/`seasonPoolStatus`/`searchStatus`, each `'idle'|'loading'|'ready'|'error'`)
      because each drives a genuinely independent piece of UI (grid content vs. badge column vs.
      head status text) — a single combined enum would have conflated three different things. Global
      "is anything busy" (`selectBusy`) is a pure derivation over the three, not a fourth
      separately-maintained field, for the drift reason above.
    - **Dependency/staleness resolution**: replaced three independent, slightly-inconsistent ad hoc
      value-comparison guards (`state.season !== requestedSeason`, `state.seasonPoolSeason !==
      state.season`, `state.season !== target.season || state.lastEpisode !== episode` — added
      piecemeal during the prior hardening pass) with a monotonic `seasonGeneration`/`searchGeneration`
      counter, bumped by whichever interactor call starts a fresh async op, captured by that call, and
      compared against the *store's current* value when the response resolves. This closes a real gap
      value comparison structurally can't: switch season 2 → 3 → 2 again quickly, and the *first*
      season-2 request's late response would pass a naive `season !== requestedSeason` check (season
      really is 2 again) even though a second, newer season-2 fetch is also in flight and should win —
      a narrow edge case (needs two same-value switches within one network round trip) but a real bug
      class value comparison alone doesn't rule out. Deliberately **not** pushed down into `store.js`
      itself (e.g. a generic `patchIfCurrent(key, expected, partial)` on the Store) — staleness policy
      is domain-specific (which counter guards which field), and baking it into the generic pub-sub
      would conflate a reusable primitive with policy that has exactly two call sites; the dedup
      lives in the domain layer that actually understands it instead.
    - **The View's render loop**: exactly one `store.subscribe(render)` in `results-screen.js`,
      diffing the new state against the previous by reference-equality per field group and calling
      whichever existing DOM-update function that group implies (`renderEpisodes`, `showMessage`,
      `updateEpisodeBadges`, `syncFilterChips`/`refreshFilterOptions`, `setSearchText`, `setStatus`,
      `renderCandidateList` — all unchanged bodies from the prior ViewModel-callback version, only
      *what triggers them* changed). No per-topic/per-slice subscriptions — this is a remote-control
      TV UI where every state transition is already a discrete, deliberate action (a D-pad press, a
      network response resolving) at most a few times a minute, not continuous high-frequency input;
      building a second layer of topic-registration machinery to solve a performance problem that
      doesn't exist here would be pure ceremony. The very first paint (before the subscription has
      seen any *change* to diff against) is still done with one explicit direct call at View
      construction time, same as the old callback-port version did — a subscription only reacts to
      transitions, it has nothing to compare against for the state that was already there before
      anyone subscribed.
    - **`playback/smart-preload.js` deliberately stays outside the Store/Domain pattern**, called
      into as a plain cross-module function (`startDownload(item, target)`) from
      `selection-interactor.js`, same shape as before. Its overlay is appended directly to
      `$('body')` and its own `Lampa.Controller.add('torrent_mod_preload', ...)` entry — entirely
      outside the `Lampa.Explorer`/`Scroll`/`Filter`/`content`-controller tree the results View owns,
      and its lifetime is deliberately *decoupled* from the results screen's own (`startDownload`
      pushes into `Lampa.Torrent.start` and keeps its own timers polling after the results Activity
      is gone, by design). Folding it into this domain would mean the Store carrying state nothing in
      the results View's own render loop ever reads, or special-casing `domain.destroy()` to *not*
      cancel it — worse on both counts than a plain function call across the boundary.
    - Verified live end to end after the rewrite: initial paint (persisted season/voice/quality
      correctly restored on first render, before any subscription had fired), a season switch via
      the toolbar chip (chip label + episode list + badges all updated through the same
      `setSeason → loadEpisodes → ensureSeasonPool` chain, now entirely via `store.patch`/subscribe
      instead of explicit `view.*` calls), the Фильтр panel's Сбросить/Перевод/Качество entries, an
      episode pick resolving to the candidate list, and "К списку серий" back navigation — no new
      console errors beyond the same pre-existing, unrelated noise (`modification.js`, third-party
      cub.rip 500s) seen throughout every prior verification pass this session.
  - **A GST-transcoding audio-track picker was attempted, shipped, and reverted within the same
    day (v1.17.23 → v1.17.24)** — worth recording so it isn't re-attempted blindly. The idea:
    `Services/PluginHub.cs` would proxy TorrServer's own `/gst/{hash}/master.m3u8`, rewrite it into
    HLS with `#EXT-X-MEDIA` alternate-audio renditions (built from an `/ffp` ffprobe call), and hand
    that to the player instead of the direct TorrServer URL. It hung, then crashed, the actual
    TorrServer.exe process. Root cause, confirmed live: TorrServer's own `/gst/.../master.m3u8` takes
    **~20 seconds** to respond (it warms the real GStreamer pipeline synchronously before answering)
    — but `PluginHub`'s shared `httpClient.Timeout` is 25s (sized for quick proxy calls elsewhere in
    that file, not for this), and the new code did that fetch *and then* a sequential `/ffp` call
    before responding, regularly exceeding 25s and throwing inside our own code. Even when it snuck
    under the timeout, the added latency was enough to make the player's own HLS client abort/retry
    — and TorrServer's GStreamer pipeline-reuse was *already* visibly fragile in `server.log`
    (`gstreamer state change timed out`, `master init failed: segment is not ready`, `seek ... while
    reusing pipeline` — present even for torrents that never touched this new code), so the resulting
    overlapping requests wedged and eventually killed the whole process. Reverted rather than patched
    around (a longer timeout would not have fixed TorrServer's own pipeline-reuse fragility, only
    hidden the symptom) — commit `6c54515`. If audio-track selection is revisited, that server-side
    pipeline-reuse fragility needs its own investigation first, independent of anything in this repo.
  - **The ffprobe codec gate broke in the same GST-introduction commit (`8c0f3a3`) that made GST the
    default transport, found via the review below.** `pickBestFile()` (playback/smart-preload.js)
    now calls `startDirectPlayback()` — which sets `session.clicked = true` synchronously — *before*
    `probeSelectedFile()` even starts its async `/ffp` round trip, so by the time that probe's
    callback resolves, playback has always already begun. The probe's `'bad'`/`'no-video'` verdict
    branches still unconditionally called `notify(...)` + `session.dispose()`, regardless — showing a
    false "формат не поддерживается" toast and tearing down cleanup (killing next-episode preload)
    **on top of video that was already playing correctly through GST**, which transcodes exactly the
    codec class this gate exists to catch. Fixed by making `probeSelectedFile` pure diagnostics
    (`console.warn` only) — consistent with the comment already sitting right above the call site in
    `pickBestFile` ("Playback is not gated on ffprobe"), which this code had silently stopped
    honoring. `startWithPreferredTransport` — the function these branches used to call to *start*
    playback — became dead code once playback was guaranteed to have already started, and was removed.
  - **Two independent review agents (architect on module structure/import graph, lead-programmer on
    runtime races) both read the actual current source** — 37 files at this point, up from 14 at the
    last review pass, having grown through the movie/series split, the whole-work-pool rewrite, and
    GST transcoding (none of which had been written up in this file yet — the gap itself is noted
    above under "no test suite", now corrected, and applies here too: this file's TorrentModPlugin
    section lagged the code by ~9 commits). Findings, fixed:
    - **`customQuery` wasn't threaded into the targets `selectEpisodeBadges`/`openPicker` build**
      (`domain/results-selectors.js`'s `buildEpisodeTarget`, `domain/selection-interactor.js`'s
      `openPicker`/`buildPickerTarget`) — only `selectEpisode`'s own target included it.
      `passesMatchGate` (search/scoring.js) reads `target.customQuery` specifically to skip the
      title-similarity gate once the user has typed a disambiguating name; without it, episode
      badges and the side picker kept gating on the original (possibly mismatched) TMDB title even
      after a customQuery search had already found real matches under the new name — a plain click
      on the episode found them (it goes through `selectEpisode`), but the badge above it said
      "раздачи не найдены" and the picker said the same, visibly contradicting each other. Fixed by
      threading `state.customQuery` into all three target-builders the same way `selectEpisode`
      already did.
    - **A movie customQuery search fired two identical Jackett round trips.**
      `searchWithQuery`'s movie branch called `requery(...)` to refetch the whole-work pool under the
      new name, then its callback called `selectEpisode(0, true)` — which, since `customQuery` was
      now set, unconditionally took the fresh-search branch and searched *again* with the exact same
      query `requery` had just fetched. Extracted `showMoviePool(pickerOnly)` — reads the
      already-fetched pool directly, no network call — and pointed both the post-requery callback and
      `selectEpisode`'s own non-customQuery movie branch at it (a simplification: the two were
      duplicating the same four lines before).
    - **`playback/movie-player.js` re-implemented the GST/transcode-audio/direct URL branching
      inline** instead of receiving it injected the way `series-player.js`'s `buildSeriesPlayerData`
      already does from `smart-preload.js`'s own `streamUrlFor` — including a second, separate
      `Lampa.Torserver.ip()` call. A future change to the real transport logic (GST URL shape, audio
      handling) could silently miss the movie copy. Made `buildMoviePlayerData` accept the same
      injected `streamUrl(file)` callback; `smart-preload.js` is now the single place that decides
      transport for both modes.
    - **`playback/` depended on `search/`** (`smart-preload.js` imported `parseSignals` from
      `search/release-parsing.js` for file-selection scoring), breaking the `shared` →
      `{search,metadata,playback}` → `domain` → `ui` tier symmetry the rest of the codebase holds to
      (`metadata/` has zero edges to/from `search/`, confirmed by the architect; `playback/` should
      be the same). `parseSignals` is pure and self-contained — moved to
      `shared/release-signals.js`; `search/release-parsing.js` now imports and re-exports it (nothing
      importing it from there needed to change) and `playback/smart-preload.js` imports the shared
      copy directly.
    - **`'torrent_mod_last_season'` was a named constant in `episodes-interactor.js` (write side)
      but a separate inline string literal in `filters-interactor.js` (read side)** — nothing enforced
      they stayed in sync; renaming one would have silently broken per-movie season memory with no
      error anywhere. Moved to `shared/state.js` as `SEASON_CACHE_KEY`, imported by both.
    - **`'movie'`/`'series'` mode strings were untyped literals duplicated across ~10 call sites**
      (search/, playback/, domain/) with no shared source of truth — a typo silently falls into
      whichever branch is the `else` rather than erroring (no TypeScript/lint in this project by
      choice). Added `MODE_MOVIE`/`MODE_SERIES` to `shared/state.js`, replaced every literal.
    - **No circular dependencies, and the movie/series domain+view split is not duplicated logic**
      (both explicitly checked and confirmed by the architect): `domain/movie-results-viewmodel.js`/
      `series-results-viewmodel.js` are 22-line pass-throughs to the one `createResultsDomain`, and
      `ui/movie-results-view.js`/`series-results-view.js` are 9-line pass-throughs to the one
      `createResultsView` — `hasSeasons` is a plain branch parameter, not a second mechanism.
    - All 93 existing tests (`npm run test:plugin`) still pass unchanged after every fix above.
  - **The ffprobe gate and the ffmpeg audio-transcode endpoint were both removed outright, replaced
    by Lampa's own native `url_reserve` fallback** — a real API confirmed by reading
    `vendor/lampa-source/src/interaction/player.js` directly rather than guessed. `Lampa.Player.play(data)`
    assigns `data` to its internal `work` reference; the native `<video>` element's own `'error'`
    listener checks `work.url_reserve` on a *fatal* decode error and automatically retries with it
    (destroying and rebuilding the video element first) — no custom error-listening code needed on
    our side. Playlist navigation (next episode) re-enters the same `play()` function per item, so
    setting `url_reserve` on every `data.playlist` entry, not just the top-level `data`, makes the
    fallback apply across a whole season pack too. `playback/smart-preload.js`'s `urlsFor(session,
    file)` now returns `{url, url_reserve}`: `url` is always the direct `Lampa.Torserver.stream()`
    link (instant for anything the browser can decode natively), `url_reserve` is the GST
    transcoding URL (`gstStreamUrl`), omitted entirely when TorrServer's own address can't be
    determined so Lampa is never handed a reserve it can't use. `buildMoviePlayerData`/
    `buildSeriesPlayerData` (movie-player.js/series-player.js) both take a `urlsFor(file)` callback
    now instead of a bare `streamUrl(file)` string-returning one.
    - **Why this replaces ffprobe entirely, not just fixes its bug**: a prior fix (documented above,
      the "gate fired after playback already started" entry) made `probeSelectedFile` diagnostics-only
      since GST was already unconditional by the time it ran. That raised the real question — an
      ffprobe verdict is a guess about whether the browser *would* decode a file, checked via a slow
      network round trip; the native player's own decode attempt is a direct answer, not a guess, and
      it was already sitting right there as a built-in Lampa mechanism. Once decode-success detection
      moved to the player itself, ffprobe (`classifyVideoCodec`, `BAD_VIDEO_CODECS`,
      `needsAudioTranscode`, `probeSelectedFile`, TorrServer's own `/ffp` call) had nothing left to do.
    - **Why not make GST unconditional instead** (the simpler-looking alternative — GST's own
      stream-copy mode is cheap on CPU when no real transcoding is needed): rejected because the cost
      of "always GST" isn't CPU load, it's *latency*, and copy mode doesn't fix that. Measured live:
      a bare `curl` against a fresh torrent's `/gst/{hash}/master.m3u8` took **~20 seconds** to
      respond — TorrServer has to actually warm the real GStreamer pipeline and probe the source
      before it can report a valid manifest (`BANDWIDTH`/`RESOLUTION`/`CODECS`), regardless of
      whether GST ends up doing a cheap remux or a real transcode. Making GST the default would tax
      every ordinary H.264/H.265 torrent with the same ~20s wait a genuinely incompatible file needs,
      for files that would otherwise start instantly via direct streaming.
    - **The ffmpeg `/transcode/{hash}/{fileId}` endpoint in `Services/PluginHub.cs`
      (`StreamAudioTranscodedAsync`) is now fully redundant, not just unreachable**: it existed to
      re-encode incompatible audio tracks (AC-3/E-AC-3/DTS/TrueHD, common in Russian BDRips) to AAC
      via ffmpeg for the direct-stream path. GST's own HLS output already declares AAC audio
      (`mp4a.40.2` in its manifest's `CODECS` attribute — observed live on a real fetch) regardless of
      the source file's actual audio codec, so once a file needs the reserve at all, GST already
      handles its audio too. Removed the route and the method; `hubBase`'s import in
      `smart-preload.js` was dropped since nothing else in that file used it.
    - Verified: all 92 remaining tests (`npm run test:plugin`, one dropped —
      `classifyVideoCodec`'s own test, for a function that no longer exists) pass unchanged.
  - **`ffmpeg.exe` installation removed as a follow-up** once it was confirmed to have zero callers
    anywhere in the codebase (the only one, Plugin Hub's `/transcode/` endpoint, was removed in the
    `url_reserve` change above). `Services/FfprobeService.cs` downloads a single BtbN FFmpeg-Builds
    zip that happens to contain both `ffprobe.exe` and `ffmpeg.exe` — `EnsureInstalledAsync` now
    extracts and verifies only `ffprobe.exe` from it, since that one still backs TorrServer's own
    `/ffp` endpoint (unrelated to GST — `Services/GStreamerService.cs` has no ffmpeg/ffprobe
    dependency of its own). `AppPaths.FfmpegExecutable` removed too, its only reader. `/ffp` itself is
    left installed and working even though nothing in this plugin calls it right now — it stays
    available as TorrServer's own diagnostic endpoint (e.g. for the `data.ffprobe` native track-picker
    path documented in `docs/reference/lampa-player-api.md`, if that's ever built) at effectively zero
    ongoing cost, unlike `ffmpeg.exe`, which had no plausible future caller once its one consumer was
    gone.
  - **`url_reserve` playback was hitting a real ~20s-cancel-then-retry pattern in production**, found
    from a user-provided DevTools network capture: a `master.m3u8?index=...&audio=0` request showing
    `(canceled)` at exactly 20.00s, followed immediately by a second, identical request that succeeded
    in ~8s. Root-caused by reading `vendor/lampa-source` directly rather than guessing: hls.js's own
    manifest-load timeout defaults to **10000ms**
    (`Player.playdata().hls_manifest_timeout || 10000`, `interaction/player/video.js`) with one
    internal retry before hls.js gives up — matching the observed ~20s-then-retry shape exactly.
    `player.js` (`interaction/player.js:1200`) already extends this to `60000` automatically, but only
    `if(data.torrent_hash && Torserver.gstWork())` — and `Torserver.gstWork()`
    (`interaction/torserver.js:137-139`) checks the **global** `torrserver_gts` Lampa setting, which
    this plugin never touches (GST is decided per-file via `url_reserve`, not that toggle). So every
    GST reserve playback was running hls.js's un-extended 10s(×~2) budget against TorrServer's own
    genuinely slow (~20s+, measured live) `/gst/.../master.m3u8` pipeline warm-up — the request that
    got canceled wasn't wasted work either: TorrServer kept warming server-side regardless of the
    client giving up, which is why the immediate retry succeeded faster. Fixed by having `urlsFor()`
    (`playback/smart-preload.js`) set `hls_manifest_timeout: 60000` alongside `url_reserve` whenever a
    GST reserve URL exists — same value Lampa's own code would apply for a GST torrent, just triggered
    by `url_reserve`'s presence instead of the global setting nobody here uses. Threaded onto the
    top-level player data (`movie-player.js`/`series-player.js`) and onto every `data.playlist` entry
    (`buildPlaylist`), for the same reason `url_reserve` itself needed to be on every entry — playlist
    navigation re-enters `play()` per item and reassigns `work`, so a per-item field is the only kind
    that survives an episode switch.
  - **`shared/core/` — a small set of genuinely reusable reliability primitives, introduced after the
    user rejected another round of point fixes as "местячковое мероприятие" and asked for real
    architecture: domain-level error handling with retry/fallback as first-class concepts, not
    scattered `if`s across files ("лапшекод"). Preceded by a verified-live inventory of every
    error/retry/fallback pattern already in the plugin (read in full, not guessed), then a four-role
    design council (architect/product/designer/lead-programmer, same pattern as the earlier
    movie/series composition consilium) evaluating the target shape before any code was written —
    the plan itself lives at the top of a Claude Code plan file this session used, referenced here for
    anyone continuing the work.** Found: four near-identical, hand-rolled staleness-guard sites
    (generation-counter bump → patch loading → await → `isDestroyed()||generation mismatch` guard →
    commit) in `domain/episodes-interactor.js`/`domain/selection-interactor.js`; two independently
    invented lifecycle-guard mechanisms doing the same job (`results-domain.js`'s `isDestroyed()` vs.
    `playback/smart-preload.js`'s `session.alive`); no structured error type anywhere — `notify()`
    (`shared/utils.js`) takes a bare string, and retryability was decided ad hoc per call site,
    **already inconsistently**: `startMovie()` and `showMoviePool()` showed the identical "раздачи ещё
    загружаются" message for the identical precondition, but only one of them scheduled a retry
    (fixed as part of this pass). Also found, while migrating: `metadata/tmdb.js`'s `fetchSeason` had
    a `.catch(() => [])` that was **dead code** — `shared/utils.js`'s `request()` is built on a
    Promise that never rejects (a network failure resolves to `null`, same shape as "no data"), so a
    TMDB network error and a legitimately empty season were structurally indistinguishable, not just
    inconvenient to tell apart.
    - **`shared/core/result.js`** — `ok(value)`/`err(kind, message, {retryable, cause})`, a Result
      shape applied only where it actually closes a gap (`fetchSeason`, above) — deliberately **not**
      applied to `search/search-backend.js`'s `{results, indexers, failed}`, which is already
      informationally equivalent to a two-outcome Result for its three current callers; converting it
      would be churn with no bug fixed.
    - **`shared/core/generation-guard.js`** — one function, `isCurrentGeneration(store, generationKey,
      generation, isDestroyed, isStillValid)`, replacing the four hand-rolled checks above verbatim
      (`loadEpisodes`, `loadAllTorrents`, `ensureSeasonLoaded`, `selection-interactor.js`'s
      `freshSearch` — the only one of the four that needs the optional `isStillValid` hook, since a
      generation match alone isn't enough there: `setSeason()` bumps `seasonGeneration` but not
      `searchGeneration`, so a customQuery search made for the old season could otherwise still pass).
      Deliberately **not** a bigger "guarded task" wrapper bundling the bump/patch/commit steps too —
      what each site actually commits to the store on success differs too much (a flat status field vs.
      a `seasonLoads[season]` map entry vs. `loadAllTorrents`'s own separate in-flight dedup unrelated
      to generations at all) to force through one `onStart`/`onResult` shape without adding indirection
      over code that already read fine inline.
    - **`message.retry` widened from `boolean` to `Function|null`** (`domain/results-state.js`) — the
      one place in the whole codebase that already did retryable-error UX correctly (`stage:'message'`
      + `showMessage()`'s real "Повторить" row, `ui/results-screen.js`) hardcoded WHICH function a
      `true` meant (`domain.episodes.loadEpisodes`, unconditionally) rather than carrying the actual
      function to call — meaning only one producer could ever exist. Widening it (a plain function
      reference is no different in kind from the `onLoaded`/`onComplete` callbacks already flowing
      through this codebase everywhere — the state shape's own "plain data only" rule was about never
      storing a *live Promise*, not about banning functions) let `freshSearch`'s Jackett-failure branch
      become a second producer, replacing a bare `notify()` toast that just faded away with the same
      retry affordance `loadEpisodes`'s TMDB failure already had — two failures that are the same thing
      to the user ("couldn't load data, try again") now get the same UX.
    - **`shared/core/lifecycle.js`** — `createLifecycle()` → `{isAlive, dispose}`, unifying the *shape*
      of `isDestroyed()`/`session.alive`, not their lifetimes (`results-domain.js`'s own header
      comment already explains why playback deliberately outlives the results screen — that stays
      true). Migrated `results-domain.js`'s `destroyed` flag onto it in this pass; `playback/
      smart-preload.js`'s half is deliberately **not** touched here — see below.
    - **Why `playback/smart-preload.js` (`session.alive`, `pollFiles`'s bounded retry, `registerTorrent`'s
      unabstracted 3-level fallback chain) was left alone this pass, not forgotten**: it has no open
      bug today (this is architectural symmetry, not a fix), it has **zero** automated test coverage
      (confirmed by grep) and is named in this file as "verified live" territory, and the actual
      user-motivating problem — inconsistent retry/error UX — lived entirely in `domain/`, which *is*
      test-covered. When it's done, do it as one pass (`shared/core/poll.js` + the `playback/` half of
      `lifecycle.js` + a `registerTorrent` readability refactor to flat Promise steps, together, not
      three separate changes), with a full manual playback smoke pass at the end, matching how every
      other touch to this file has been verified in this project.
    - Verified: `npm run test:plugin` green throughout (new file `test/core.test.mjs` — 13 unit tests
      for `result.js`/`generation-guard.js`/`lifecycle.js` against a real `createStore()`, no Lampa
      mocks needed; two new `smoke.test.mjs` cases exercising the TMDB-failure and Jackett-failure
      retryable-message paths end to end including calling the stored `retry()` and confirming
      recovery; one new `smoke.test.mjs` case — previously entirely uncovered — calling `destroy()`
      mid-flight against two deliberately delayed mock responses and confirming neither one mutates
      the store after teardown).
  - **`shared/core/log.js` — a consistent lifecycle-logging helper (`log(scope, message, data)`/
    `warn(scope, message, data)`, format `Torrent Mod [scope]: message`), added after the user asked
    for detailed console-visible lifecycle logging across the whole plugin ("сделай мне подробное
    логирование жизненного цикла... хочу по консоли отслеживать что происходит") having just fixed a
    debug `console.log` line themselves. Replaces every scattered ad hoc `console.log('Torrent Mod:
    ...')`/`console.warn(...)` call (inconsistent prefixing, no scope) with one helper called from
    every layer that has a lifecycle worth watching in the console: `index.js` (plugin boot),
    `ui/torrent-mod-component.js` (component create/start/destroy, movie-vs-series mode), `domain/
    results-domain.js` (domain start/destroy, idempotent-destroy noted explicitly),
    `domain/episodes-interactor.js` (season load/pool load/lazy per-season load — start, stale-discard
    via generation, success-with-count, error — plus `setSeason`'s old→new transition and `requery`'s
    pool reset), `domain/selection-interactor.js` (every entry point — `selectEpisode`, `openPicker`,
    `playPickerCandidate`, `closePicker`, `startMovie`, `showMoviePool`, `searchWithQuery`,
    `playCandidate` — plus `freshSearch`'s full stale/failure/empty/success set), and
    `playback/smart-preload.js` (`startDownload` as the actual playback-session entry point —
    previously had zero logging despite being the most important point to see in the console;
    `registerTorrent`'s full 3-way fallback chain — cached-hash validate/reuse/expire, list-lookup
    found/missing, fresh add — `pollFiles`'s metadata-wait progress and timeout, `pickBestFile`,
    `startDirectPlayback`'s built player-data shape (url/url_reserve/playlist length presence, not the
    URLs themselves), and `startNextEpisodePreload`'s actual fire point). Deliberately left alone:
    `shared/utils.js`'s `notify()` (`console.log` fallback only when `Lampa.Noty` itself is
    unavailable — a UI-notification fallback, not a lifecycle log point) and its separate
    `torrent_mod_debug`-gated scored-candidates table (an opt-in diagnostic feature with a different
    purpose and audience than always-on lifecycle tracing). Verified live via `npm run test:plugin`
    (all 108 tests still green — `smoke.test.mjs`'s existing scenarios now also print the full
    lifecycle trace for every domain-flow test, itself a live demonstration the logging covers the
    intended surface end to end).
  - **Fast JS-only iteration without rebuilding the .NET app**: `npm run dev:plugin`
    (`scripts/watch-plugin.mjs`, esbuild's watch API) rebuilds on every save under
    `Plugins/TorrentModPlugin/` and writes straight to
    `%LocalAppData%\TorrServer\dev-plugins\TorrentModPlugin.js` — `BuiltInPlugins.Read` checks that
    path first and only falls back to the embedded resource if it's absent. `POST
    /api/plugins/refresh` (loopback-only) then picks up the new content via the normal SHA-256
    cache-diff path — no `dotnet build`/`publish`/process-restart needed. The dev-override
    mechanism itself (`BuiltInPlugins.Read` checking `dev-plugins/<file>` first) applies to any
    built-in plugin, not just this one — only the `npm run dev:plugin` watch script is
    TorrentModPlugin-specific. `npm run install:plugin-dev`
    (`scripts/build-plugin-dev.mjs`) is the one-shot, non-watching counterpart — same dev-override
    output, but a script that actually exits, needed for a completing VS Code task rather than
    `watch-plugin.mjs`'s `ctx.watch()` which never returns. Both share the override path via
    `scripts/plugin-target.mjs` so it's computed in exactly one place. `.vscode/tasks.json` wires
    this up as the default build task ("Собрать и установить плагин (dev)"), plus a watch variant
    and a task that POSTs `/api/plugins/refresh` against the already-running app afterward.
  - **Right-arrow on a CANDIDATE row (the primary torrent list — a movie from the first frame, or a
    series after picking a low-confidence episode) used to reopen the exact same list in a slide-in
    picker panel** — reported directly by the user ("зачем при навигации вправо мне список торрентов
    открывается? Мне там фильтры нужны"). Root cause: the picker (right-arrow on an EPISODE row)
    exists because an episode row has no torrent info of its own — the panel is the only way to see
    candidates for it. A candidate row IS already a torrent list; Enter on it already plays the
    torrent AND persists it as the season/movie default (`playCandidate`), so the picker's "Выбрано"
    marker showed zero information the row didn't already have — pure redundant screen-within-a-screen,
    not a deliberate feature (confirmed via `git log`: introduced deliberately in `1145920` to reuse
    the picker's persistence infra for movies, but the redundancy with `playCandidate` already doing
    the same persistence wasn't caught at the time). Fixed in `ui/results-screen.js`'s `right` handler
    for `'content'`: a focused candidate row now triggers the toolbar's `.filter--filter` chip
    directly (`toolbar.find('.filter--filter').trigger('hover:enter')`, the same `hover:enter` Lampa's
    own Filter widget binds internally — confirmed by reading `vendor/lampa-source/src/interaction/
    filter.js`) instead of calling `openPicker(0)`. `openPicker` itself is untouched — an EPISODE
    row's right-arrow still opens it, that path was never the problem. The now-dead
    `focusedCandidateNode` bookkeeping (only ever set by the removed branch, read by `hidePickerDom`
    as a fallback focus-restore target) was deleted along with it rather than left as an unreachable
    fallback. Verified live end to end via the actual running app (not guessed): opened a movie's
    Torrent Mod screen, confirmed focus lands on a `.torrent-mod-candidate` row
    (`Lampa.Controller.enabled().name === 'content'`), called the registered `right()` handler
    directly, confirmed a real `Lampa.Select` overlay opened (`Lampa.Controller.enabled().name ===
    'select'`, a genuine `.selectbox` in the DOM — not a lookalike), then called `back()` and
    confirmed focus correctly returns to `'content'` with the same candidate row still focused (no
    dead-focus regression of the kind documented earlier in this section for `Lampa.Select`).
  - **Returning to the episode list — from the player, from closing a Filter/Select panel, or via
    "← К списку серий" — used to always reset focus to the FIRST episode of the season**, reported
    directly by the user ("захожу в сезон, пролистываю ниже... возвращаюсь назад. Меня всегда
    сбрасывает на первую серию... список постоянный сброс на первую идет. Бесит.") — first suspected
    as a wrong-episode-playback bug, but the user's own follow-up correction confirmed the actually
    selected episode DOES play correctly (`pickSeriesFile`'s episode-aware file scoring inside a
    season pack works, real per-file names from a live-registered torrent carry explicit `S01 E0X`
    markers — checked directly against a real torrent's `file_stats` on this project's own
    TorrServer, not assumed); this was purely a focus-restoration bug in `ui/results-screen.js`.
    Root cause: `Lampa.Controller.toggle(name)` (confirmed by reading `vendor/lampa-source/src/core/
    controller.js`) unconditionally re-runs the controller's own `toggle()` callback on every call,
    even when that controller is already active — and this screen's own `'content'` controller's
    `toggle()`, plus `refreshGrid()`'s direct fallback, both called the blind
    `Controller.collectionFocus(false, scroll.render(true))` ("focus the first row"), correct only
    for the very first entry into the screen. Every later trigger of `Controller.toggle('content')`
    — the player's own `Lampa.Player.callback` returning here, `restoreContentFocus()` after closing
    Lampa.Filter's Select overlay, `refreshGrid()` running while 'content' was already active — reset
    the same way, with nothing to restore the real position afterward (unlike the picker's own
    close path, `hidePickerDom`, which already explicitly restored focus via `activeEpisode` — the
    one path that was NOT broken). Fixed with two complementary mechanisms, since the two situations
    differ in whether the DOM rows survive: **(1) `lastFocusedNode`** — a plain UI-local variable
    (not domain state) set by `row()`'s own `hover:focus` handler for every row (episode AND
    candidate), consumed by a new `restoreFocus()` helper that both `refreshGrid()` and `'content'`'s
    `toggle()` now call instead of the blind focus-first — covers every case where the grid's DOM
    nodes are untouched (return from the player, closing a Filter panel), validated live: focused
    episode 8 via real `Navigator.move('down')` presses (not a synthetic focus call), called
    `Lampa.Controller.toggle('content')` directly (the exact call the player's own callback makes),
    confirmed focus stayed on episode 8. **(2) `lastEpisodeGridSeason`** — `renderEpisodes` rebuilds
    every row as a fresh DOM node on every call (season switch, or "← К списку серий"), so
    `lastFocusedNode` can't help there; compares the season being rendered against the season of the
    PREVIOUS `renderEpisodes` call — same season (rebuilt for another reason, DOM replaced but the
    episode NUMBERS are the same) restores to `state.activeEpisode` (the reactive last-focused-episode
    tracker every row already dispatches via its own `hover:focus`, previously only used to open/
    restore the side picker); season actually changed falls back to the existing per-season
    `getSavedEpisode` restoration (unchanged) so a stale `activeEpisode` number from the OLD season
    can't be misread as a meaningful position in the new one. Verified live: switching Season 2 →
    Season 3 correctly landed on episode 1 (not a coincidentally-numbered leftover), switching back
    to Season 2 correctly used the existing per-movie last-episode memory (unaffected, pre-existing
    behaviour, not per-season — a separate, not-yet-raised design question, see `readSeasonDefault`'s
    own comment on the picker's "Выбрано" marker being per-season for the same reason).
  - **The "not-yet-raised design question" above got raised and resolved the same session**: the
    user asked for the picker's cursor to land directly on the already-selected torrent on open,
    and for the persisted choice's info to actually show up in the main episode list (not just the
    picker). A brief detour explored making the persisted default per-EPISODE instead of
    per-season — reverted within the same exchange on explicit correction ("Посезонный блин" /
    "Запоминать выбор на весь сезон - хорошая практика"): per-season stays the design, a season
    pack is one torrent for the whole season and shouldn't need re-picking per episode.
    Two real fixes landed instead, both season-default-compatible:
    - **Picker initial cursor** (`ui/results-screen.js`'s `openPickerPanel`) — `selectedNode` is
      captured while building the item rows (the same `selected` flag that already drove the
      "Выбрано" marker) and consumed by the picker's own `toggle()`, replacing the previous blind
      `collectionFocus(false, ...)` (always the first item) with `collectionFocus(selectedNode ||
      false, ...)`. Verified live: picked a season-pack candidate at index 1 of 23, closed and
      reopened the panel — cursor landed exactly on index 1, not index 0.
    - **Episode badge shows what a click would actually play, not just the top-ranked candidate**
      (`domain/results-core.js`'s `badgeText`, `domain/results-selectors.js`'s
      `selectEpisodeBadges`) — both gained an optional `saved`/`seasonDefault` parameter,
      preferred over `matches[0]` via the already-existing `findSavedDefault` (same function
      `selectEpisode`'s own auto-play decision already uses, so the badge and the actual play
      choice can no longer visibly disagree). The domain layer stays Lampa-agnostic on purpose —
      `selection-interactor.js` gained a `getSeasonDefault(season)` read-only accessor (thin
      wrapper over the already-private `readSeasonDefault`) so the view can pass the value in
      without either pure module touching `Lampa.Storage` directly. `ui/results-screen.js`'s
      `render()` widened the badge-recompute condition to also fire on a `stage` change (covers
      "← К списку серий" rebuilding episode rows with stale badge text) and whenever the picker
      just closed (`previous.picker.open && !state.picker.open` — a pick there updates the
      persisted default directly via `Lampa.Storage`, bypassing the reactive store entirely, so
      `pool`/`episodesCache` alone can never signal it changed; recomputing on every close is cheap
      and correct even when it was just a cancel). Two new `domain.test.mjs` cases lock in the
      preference (`badgeText` with vs. without `saved`, `selectEpisodeBadges` threading it through
      per episode) using the suite's existing season-pack/single fixtures. Verified live: picked a
      non-top-ranked candidate for episode 1 — its badge (5 сид.) replaced the previous top-ranked
      one's (4 сид.) immediately, with no unrelated regression to the picker-close focus-restore or
      back-navigation fixes from earlier the same session.
  - **The persistence itself turned out to be broken for a whole class of torrents — found while
    verifying the above two fixes across a real browser reload, not guessed.** The user reported
    it directly right after the picker/badge fixes shipped: "Персист-то не настоящий. После
    перезагрузки браузера я снова на первой серии и на автовыборе." Root cause, confirmed live:
    `candidateIdentity()` (`domain/results-core.js`) preferred `item.link` over `title+size` when
    `item.magnet` was empty — and at least one real indexer (NoNaMe Club, already flagged
    elsewhere in this file as magnet-less) returns that link through Jackett's own download-proxy
    with an encoded `path` query param that **differs between two separate searches for the exact
    same release** (confirmed by comparing the raw `torrent_mod_default_torrent` localStorage
    entry against a fresh `/api/torrent-search` pool fetch for the same episode — same title/size,
    different `path` token). Every magnet-less save was therefore silently unmatchable the moment
    the pool was re-fetched from scratch, i.e. on every browser reload — `season` persistence
    looked fine only because `torrent_mod_last_season` is keyed by a plain season NUMBER, immune
    to this. Fixed by reordering `candidateIdentity` to `magnet || title+'|'+size` — dropping
    `link` entirely, since a string concatenation of title+size is always truthy and so `link`
    could never actually be reached anyway (removed as dead code rather than left in). Diverges
    on purpose from `search/search-backend.js`'s own dedup identity (magnet → link → title+size,
    unchanged) — dedup only needs consistency **within one response**, where `link` is harmless;
    a persisted pick needs identity stable **across separate searches over time**, a strictly
    stronger requirement `link` doesn't meet for this indexer. Also fixed in the same pass, found
    while reading this exact code path: `selectEpisode`'s own diagnostic log compared `chosen ===
    saved` to decide whether to print "(сохранённый дефолт)" — `chosen` is always a pool candidate
    object and `saved` the raw persisted `{id,title,size}` record, never the same reference even on
    a genuine match, so the label had silently always printed "(лучший по рейтингу)" regardless of
    which one actually launched; now compares against `findSavedDefault`'s own return value
    directly. New `domain.test.mjs` case asserts `candidateIdentity` returns the same value for two
    magnet-less items sharing title+size but different `link`. Verified live end to end, the exact
    reported scenario: picked a non-top-ranked torrent for episode 1, confirmed the new id in
    `localStorage` is title+size-based (no embedded apikey/path), did a real page reload (not a
    simulated re-render), and confirmed both the badge (5 сид., not the top-ranked 4 сид.) and the
    console log itself ("сохранённый дефолт") reflect the persisted pick post-reload.
  - **A second, independent persistence bug in the same area, reported right after the one above
    shipped**: "Осталась бага с запоминанием серии сезона. Запускаю 5 серию, перезагружую браузер,
    захожу в сериал и вот я на первой серии." — the per-movie last-watched-episode memory
    (`torrent_mod_last_episode`, `saveLastEpisode`/`getSavedEpisode` in `selection-interactor.js`)
    looked identical in shape to the torrent-default bug just fixed, but the root cause here was
    entirely different — found by adding temporary `console.log` instrumentation
    (`ui/results-screen.js`'s `renderEpisodes`) and reading the actual values at runtime rather
    than guessing twice: `localStorage` correctly held `{season:2, episode:5}` all the way up to
    the moment `renderEpisodes` ran on the reloaded page, but by the time that function's own
    restore logic called `getSavedEpisode()`, the stored value had ALREADY become `{season:2,
    episode:1}` — clobbered inside the very same function, one line earlier. Cause:
    `Lampa.Controller.toggle('content')` (called once per screen, to move focus off the left
    Explorer card) unconditionally re-runs `'content'`'s own `toggle()` handler regardless of
    whether it's already active (confirmed by reading `vendor/lampa-source/src/core/
    controller.js` in an earlier session pass) — which calls `restoreFocus()`, which found
    `lastFocusedNode` still `null` on a fresh page load and fell back to focusing the FIRST row.
    That fallback isn't inert: the row's own `hover:focus` handler synchronously dispatches
    `setActiveEpisode(1)`, which persists `{season:2, episode:1}` via `saveLastEpisode` —
    overwriting the real saved value (5) BEFORE the explicit restore-to-saved-episode code a few
    lines below ever got to read it. A self-inflicted race within a single synchronous function,
    not a storage bug at all. Fixed by reordering `renderEpisodes`: compute the target
    `focusNumber`/`node` FIRST, pre-seed `lastFocusedNode` with it, and only THEN call
    `Controller.toggle('content')` — so `restoreFocus()`'s fallback path is never taken, the
    correct row gets real focus (and therefore the correct, harmless re-save) on the first attempt,
    and the explicit `collectionFocus` call right after just confirms the same target. Verified
    live end to end with the debug logging in place first (confirming the exact clobbering
    sequence), then again after the fix with logging removed: cleared `torrent_mod_last_episode`,
    opened Season 2, clicked episode 5 (confirmed saved), destroyed the player, did a REAL page
    reload (`navigate`, not a simulated re-render), reopened the same series — season chip read
    "Сезон 2" and the focused row was genuinely `data-episode="5"`, with `localStorage` still
    intact and unclobbered afterward.
- **`AppPaths.cs`** — single source of truth for every on-disk path and port used across the app
  (install dir under `%LocalAppData%\Programs\TorrServer`, state/data/logs under
  `%LocalAppData%\TorrServer`, Jackett's install dir under `%ProgramData%\Jackett`, and the three ports:
  TorrServer 8090, Plugin Hub 8095, Jackett 9117). The hosted Lampa app lives at `LampaAppDirectory`
  (`lampa-app/` under the state dir) with its own `LampaAppState` JSON file.
- **`AppLog.cs`** — a tiny best-effort file logger (`manager.log`); logging failures are swallowed since
  logging must never crash the tray app.
- **`IconFactory.cs`** — renders the tray icon (a "T" badge with a colored status dot) in-memory via
  GDI+; color reflects current server status (green/amber/red).
- **`FirewallService.cs`** — on startup, checks (non-elevated `Get-NetFirewallRule`) whether the two
  named inbound rules TorrServer/Plugin Hub need for LAN access already exist; if either is missing, runs
  one elevated `New-NetFirewallRule` script (`-EncodedCommand`, single UAC prompt) to create them, scoped
  to `Private,Domain`. Jackett needs no rule — it only ever listens on `127.0.0.1`.

## Conventions worth knowing

- All user-facing strings (UI labels, error messages, exceptions surfaced via `MessageBox`) are in
  Russian. Keep new user-facing text consistent with this.
- External processes (TorrServer, Jackett) are managed by locating the running process by name + exact
  executable path rather than keeping a live `Process` handle across calls — status checks always
  re-query by process name / HTTP health check, since the manager itself may restart while the child
  keeps running.
- Anything that writes shared state to disk (`PluginHub` config/cache, `UpdateService`'s binary swap)
  writes to a temp path first and then renames/moves into place.
- **A built-in plugin definition being removed from `BuiltInPlugins.cs` must not turn into config data
  loss for unrelated plugins.** Found live, the hard way: removing Smart TS from `Definitions` made
  `PluginHub.Validate()` reject the orphaned `builtin://smart-ts` entry still sitting in an existing
  user's `lampa-plugins.json` as "not a valid URL" (it only special-cased *currently-known* built-ins,
  not the `builtin://` scheme generally) — `LoadConfiguration()`'s catch-all responded to that exception
  by discarding the *entire* configuration and starting over empty, then immediately persisting that
  empty config over the good one on the very next startup. Online Mod's entry, completely unrelated,
  was collateral damage. Two independent fixes, both worth keeping in mind for any future built-in
  removal or config-shape change: (1) `Validate()` now accepts any `builtin://`-scheme URL as
  structurally fine regardless of whether it's still a registered definition — whether it's *actually*
  servable is `BuiltInPlugins.Read`'s job at actual use time, which already fails narrowly for just that
  one plugin; (2) `RefreshAllAsync`'s per-plugin loop now catches per-plugin exceptions individually
  (previously a single throw — e.g. from that same orphaned-builtin case — aborted the rest of the
  batch too, silently starving every plugin after the broken one of its scheduled refresh).
- Version strings from TorrServer follow the `MatriX.x.x.x` format and are parsed/compared with a
  dedicated regex + numeric part comparison (`UpdateService.IsNewer`); Jackett versions are standard
  `System.Version` strings compared with `JackettController.IsNewer`.
- Commit messages are in Russian, following Conventional Commits (`тип(область): суть`, e.g.
  `fix(jackett): ...`, `feat(hub): ...`). Keep the description short and to the point — no padding, no
  restating the diff line by line.
- The app itself (TorrServerManager, not TorrServer/Jackett) is versioned per SemVer2 via
  `<Version>` in `TorrServerManager.csproj`. Bump it on every user-visible change. The version must be
  surfaced in the UI (main window) and in the tray icon's hover tooltip (`NotifyIcon.Text`) — not just
  buried in the assembly metadata.
