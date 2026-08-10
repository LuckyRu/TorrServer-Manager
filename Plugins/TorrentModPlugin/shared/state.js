    export const VERSION = '0.1.0';
    const scriptUrl = document.currentScript && document.currentScript.src ? document.currentScript.src : '';
    export const hubBase = scriptUrl.replace(/\/plugins\/[^/?]+\.js(?:\?.*)?$/i, '');
    export const searchRequests = [];

    // Shared by episodes-interactor.js (write) and filters-interactor.js (read) so the two can't
    // silently drift onto different key strings.
    export const SEASON_CACHE_KEY = 'torrent_mod_last_season';

    // Shared constants for target.mode, branched on directly across ~10 call sites in search/,
    // playback/, domain/ — avoids a typo'd raw string literal failing silently into the `else` branch.
    export const MODE_MOVIE = 'movie';
    export const MODE_SERIES = 'series';

    // Auto-retry ladder for a whole-work pool search where no configured indexer answered at all;
    // see docs/system-design/torrent-mod-parallel-search.md. Shared with results-selectors.js's
    // "попытка N из M" wording so attempt count can't drift between the two.
    export const POOL_RETRY_DELAYS_MS = [5000, 15000];
    export const POOL_MAX_ATTEMPTS = POOL_RETRY_DELAYS_MS.length + 1; // + the initial attempt
