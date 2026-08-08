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
