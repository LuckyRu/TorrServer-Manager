    export const VERSION = '0.1.0';
    const scriptUrl = document.currentScript && document.currentScript.src ? document.currentScript.src : '';
    export const hubBase = scriptUrl.replace(/\/plugins\/[^/?]+\.js(?:\?.*)?$/i, '');
    export const searchRequests = [];

    // Written by domain/episodes-interactor.js (per-movie season memory), read by
    // domain/filters-interactor.js (applyPersistedPreferences, at composition time). Two files
    // relying on an inline string literal to independently agree on the same value had no way to
    // catch a mismatch (found in review) — a shared constant makes that structurally impossible.
    export const SEASON_CACHE_KEY = 'torrent_mod_last_season';

    // 'movie'/'series' target.mode — branched on directly (not through a lookup table) in ~10 files
    // across search/, playback/, and domain/ since the movie/series split. A typo in a raw string
    // literal (no TypeScript, no lint in this project by choice) fails silently into whichever
    // branch is the `else`, usually series-shaped, instead of erroring (found in review).
    export const MODE_MOVIE = 'movie';
    export const MODE_SERIES = 'series';

    // Bounded auto-retry for a failed whole-work pool search (network/Jackett failure) — a real
    // user complaint drove this: a search that fails on the first attempt often succeeds on a
    // later one (transient Jackett/indexer hiccup), and requiring a manual "back out and reopen
    // the plugin" every time was the actual reported pain, not a hypothetical one. Delays escalate
    // (3s/6s/12s/20s) rather than hammering Jackett at a fixed interval. Shared here (not just
    // local to episodes-interactor.js, which schedules them) because results-selectors.js's
    // selectSearchProgress needs the total attempt count too, for the honest "попытка N из M"
    // status-line wording — a single source of truth so the two can't silently drift apart.
    export const POOL_RETRY_DELAYS_MS = [3000, 6000, 12000, 20000];
    export const POOL_MAX_ATTEMPTS = POOL_RETRY_DELAYS_MS.length + 1; // + the initial attempt
