---
name: verify-lampa-live
description: Verify Lampa/TorrentModPlugin UI, navigation, or search behavior live by scripting real Lampa.* API calls through the browser instead of guessing from source or relying on screenshots alone. Use when testing or debugging anything in Torrent Mod's UI, navigation, playback, or search — Lampa has no public docs, its own source is the only ground truth.
---

# Verify Lampa behavior live

Full technique with examples: [`docs/how-to/verify-lampa-behavior-live.md`](../../../docs/how-to/verify-lampa-behavior-live.md).
Lampa has no public API docs — the minified source (`app.min.js`) and a live instance are the only
reliable sources of truth. This has repeatedly found real bugs that guessing from source alone missed;
see [`docs/system-design/lampa-navigation-contract.md`](../../../docs/system-design/lampa-navigation-contract.md)
for the resulting list.

## Core loop

1. Open `http://127.0.0.1:8095/app/` (loopback — LAN addresses trigger a per-action approval prompt on
   every browser tool call; ask the user to switch to localhost if that happens).
2. Script real actions through the actual `Lampa.*` API via the browser's JS-execution tool, not
   synthetic clicks:
   ```js
   Lampa.Activity.push({ url:'', component:'torrent_mod', movie: Lampa.Activity.active().card });
   Lampa.Controller.enabled().controller.right();   // the real per-direction handler, not .right (bare)
   Lampa.Controller.enabled().name;                 // current named controller
   document.querySelector('.focus');                // what's really focused
   ```
3. Pull only small, targeted source excerpts when checking Lampa's own behavior (`indexOf` a function
   name, slice ~200–900 chars) — never large dumps, and never reproduce them verbatim outside code.
4. **When something looks like a plugin bug, reproduce it on vanilla Lampa first** (no plugin code
   involved) — this has found real bugs that turned out to be Lampa's own, not the plugin's.
5. If a result looks like a bug but doesn't fully add up, recount the actual steps taken before calling
   it one — a miscounted repro step has produced false bug reports before.

## Read-tool restrictions on non-loopback origins

`computer`/`read_page`/`get_page_text`/`read_console_messages` all fail with "requires per-action
approval" on a LAN IP (e.g. `192.168.x.x:8095`) inside this harness. The JS-execution tool still works
there. Prefer navigating to `127.0.0.1` for a verification session to avoid the approval friction
entirely.
