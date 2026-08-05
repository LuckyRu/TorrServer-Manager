# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

TorrServerManager is a Windows tray application (WinForms, .NET 10) that installs, runs, and updates
[TorrServer](https://github.com/YouROK/TorrServer) and [Jackett](https://github.com/Jackett/Jackett) for
use with the Lampa media center app. It also hosts a small local HTTP service ("Lampa Plugin Hub") that
mirrors Lampa plugin scripts on the LAN, and ships a built-in Lampa plugin (`SmartTsPlugin.js`) for
season/episode browsing and pre-buffering.

There is no `.sln` file, no test project, and no README — this is a single-project WinForms app built
directly from `TorrServerManager.csproj`.

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
- **`TorrentModPlugin.js`** — embedded as `TorrServerManager.TorrentModPlugin.js`. Own card button, own
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
  - **Fast JS-only iteration without rebuilding the .NET app**: drop an updated copy of the file at
    `%LocalAppData%\TorrServer\dev-plugins\TorrentModPlugin.js` (same file name as the
    `EmbeddedResource`) — `BuiltInPlugins.Read` checks that path first and only falls back to the
    embedded resource if it's absent. `POST /api/plugins/refresh` (loopback-only) then picks up the new
    content via the normal SHA-256 cache-diff path — no `dotnet build`/`publish`/process-restart needed.
    Applies to any built-in plugin, not just this one.
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
