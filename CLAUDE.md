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

Publish a self-contained single-file win-x64 executable (matches the `publish/` output already checked in):
```bash
dotnet publish TorrServerManager.csproj -c Release
```

Run locally (starts the tray app):
```bash
dotnet run --project TorrServerManager.csproj
```

Run hidden/minimized to tray (same flag the app uses for autostart):
```bash
dotnet run --project TorrServerManager.csproj -- --background
```

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
  updates, configure RuTracker credentials), and manages the tray icon/menu. Closing the window hides it
  to the tray instead of exiting; only the tray menu's "Выход" actually exits.
- **`ServerController.cs`** — manages the external `TorrServer.exe` child process: start/stop/restart,
  HTTP health checks against `http://127.0.0.1:8090`, installed-version detection (parses `MatriX.x.x.x`
  version strings out of `--version` output), and LAN IP address discovery for handing out an address
  reachable from other devices (e.g. a TV running Lampa).
- **`JackettController.cs`** — same idea for Jackett, but Jackett runs as a Windows *service*
  (`sc.exe start/stop`, `Restart-Service` via PowerShell), so all control operations require UAC
  elevation (`Process.Start` with `Verb = "runas"`). Also handles triggering Jackett's built-in
  self-update over HTTP and programmatically saving RuTracker.org indexer credentials through Jackett's
  config API.
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
  - Plugin configuration persists to `lampa-plugins.json`; download cache metadata persists to
    `lampa-cache/cache-state.json`. Both are written atomically (write to `.tmp`, then `File.Move`).
  - Runs a periodic background refresh (`RefreshInterval` = 6h) of all enabled plugins in addition to
    on-demand refresh from the panel.
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
  TorrServer 8090, Plugin Hub 8095, Jackett 9117).
- **`AppLog.cs`** — a tiny best-effort file logger (`manager.log`); logging failures are swallowed since
  logging must never crash the tray app.
- **`IconFactory.cs`** — renders the tray icon (a "T" badge with a colored status dot) in-memory via
  GDI+; color reflects current server status (green/amber/red).
- **`RutrackerCredentialsDialog.cs`** — simple modal dialog for entering RuTracker.org username/password,
  which `JackettController.SaveRutrackerCredentialsAsync` then pushes into Jackett's RuTracker indexer
  config over HTTP.

## Conventions worth knowing

- All user-facing strings (UI labels, error messages, exceptions surfaced via `MessageBox`) are in
  Russian. Keep new user-facing text consistent with this.
- External processes (TorrServer, Jackett) are managed by locating the executable/service rather than
  keeping a live `Process` handle across calls — status checks always re-query by process name / HTTP
  health check, since the manager itself may restart while the child keeps running.
- Anything that writes shared state to disk (`PluginHub` config/cache, `UpdateService`'s binary swap)
  writes to a temp path first and then renames/moves into place.
- Version strings from TorrServer follow the `MatriX.x.x.x` format and are parsed/compared with a
  dedicated regex + numeric part comparison (`UpdateService.IsNewer`); Jackett versions are standard
  `System.Version` strings compared with `JackettController.IsNewer`.
