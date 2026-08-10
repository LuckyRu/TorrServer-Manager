---
name: release-a-change
description: Ship a user-visible change to TorrServerManager or its TorrentModPlugin — version bump, build, test, publish, deploy to the live install, plugin cache refresh. Use whenever a change is ready to go out, not just committed.
---

# Release a change

Full checklist and rationale: [`docs/how-to/release-a-change.md`](../../../docs/how-to/release-a-change.md).
For JS-only iteration that doesn't need this full cycle, see
[`docs/how-to/iterate-on-a-plugin-without-rebuilding.md`](../../../docs/how-to/iterate-on-a-plugin-without-rebuilding.md) instead.

1. Bump `<Version>` in `TorrServerManager.csproj` (SemVer2, every user-visible change).
2. If `Plugins/TorrentModPlugin/` changed: `npm run test:plugin` must pass first.
3. `git commit` — Russian, Conventional Commits, short.
4. `dotnet publish TorrServerManager.csproj -c Release` (bundles the JS plugin automatically).
5. **If a JS dev-override exists at `%LocalAppData%\TorrServer\dev-plugins\TorrentModPlugin.js`, delete
   it first** — otherwise the deployed `.exe` silently keeps serving stale dev JS over the fresh embedded
   resource.
6. Stop the running `TorrServerManager.exe`, back it up in place as `TorrServerManager.v<old>.bak.exe`,
   copy the freshly published exe over `%LocalAppData%\Programs\TorrServer\TorrServerManager.exe`, start
   it again with `--background`.
7. If the JS plugin changed: refresh Plugin Hub's cache on the now-running instance —
   `curl -s -X POST -H "Content-Length: 0" http://127.0.0.1:8095/api/plugins/refresh`.
8. Verify live (see the `verify-lampa-live` skill) before considering the change shipped.

`TorrServer.exe`/`JackettConsole.exe` are independent processes — no restart needed for a manager-only
deploy.
