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
    stored API key.
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
- **`BuiltInPlugins.cs`** — registers the embedded `SmartTsPlugin.js` (see below) as a pseudo-plugin with
  a synthetic `builtin://smart-ts` URL, served from the assembly's embedded resources rather than
  downloaded, but otherwise flowing through the same PluginHub caching/serving path.
- **`SmartTsPlugin.js`** — the actual Lampa plugin, embedded as a resource (see
  `<EmbeddedResource>` in the `.csproj`) and injected into TorrServerManager's assembly under the
  logical name `TorrServerManager.SmartTsPlugin.js`. Adds season/episode-aware playback UI and
  pre-buffering behavior on top of Lampa's torrent player, by wrapping `Lampa.Torserver.stream` /
  `Lampa.Player.play` / `Lampa.Player.playlist` / `Lampa.Player.callback` / `Lampa.Player.stat`.
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
