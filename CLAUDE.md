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

There is no test suite and no linter configured in this repo.

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
  orthogonal to both search and screen rendering, not because every folder needs >1 file), `ui/`
  (the three Lampa-registration files `card-button.js`/`settings.js`/`styles.js`, plus the results
  screen itself split three ways — see below), and `index.js` at the folder root as the entry point
  (mirrors `Program.cs` staying at the C# project root). `npm run build:plugin` (esbuild,
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
    bugs. `Lampa.Torrent.start(...)` is still called (it's what actually registers the magnet with
    TorrServer and drives the native file-list UI our own file-picking listens to via the `torrent_file`
    event), but playback readiness is our own: a full-screen `torrent-mod-preload` overlay polls
    TorrServer's `/cache` for the picked file's infohash, with a **duration-based**, not fixed-size,
    target — `targetBytes = bitrateMbps(from estimateBitrateMbps) × leadSeconds(25)`, i.e. "enough buffer
    for ~25 seconds of this specific release's own bitrate", not a flat MB/timeout. Starts early
    (`keepsUpWithPlayback`) the moment observed download speed already exceeds ~90% of that bitrate, since
    at that point the buffer can't be outrun even short of the nominal target. Surfaces an explicit
    stall-risk warning in the overlay (not just silently waiting out the timeout) once speed has held
    below half the required bitrate for a few seconds — a stall *during* playback is a worse experience
    than an honest heads-up before it starts.
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
  - **Fast JS-only iteration without rebuilding the .NET app**: `npm run dev:plugin`
    (`scripts/watch-plugin.mjs`, esbuild's watch API) rebuilds on every save under
    `Plugins/TorrentModPlugin/` and writes straight to
    `%LocalAppData%\TorrServer\dev-plugins\TorrentModPlugin.js` — `BuiltInPlugins.Read` checks that
    path first and only falls back to the embedded resource if it's absent. `POST
    /api/plugins/refresh` (loopback-only) then picks up the new content via the normal SHA-256
    cache-diff path — no `dotnet build`/`publish`/process-restart needed. The dev-override
    mechanism itself (`BuiltInPlugins.Read` checking `dev-plugins/<file>` first) applies to any
    built-in plugin, not just this one — only the `npm run dev:plugin` watch script is
    TorrentModPlugin-specific.
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
