    export const VERSION = '0.1.2';
    const scriptUrl = document.currentScript && document.currentScript.src ? document.currentScript.src : '';
    export const hubBase = scriptUrl.replace(/\/plugins\/[^/?]+\.js(?:\?.*)?$/i, '');
    export const searchRequests = [];

    export const SEASON_CACHE_KEY = 'torrent_mod_last_season';

    export const MODE_MOVIE = 'movie';
    export const MODE_SERIES = 'series';

    export const POOL_RETRY_DELAYS_MS = [5000, 15000];
    export const POOL_MAX_ATTEMPTS = POOL_RETRY_DELAYS_MS.length + 1; // + the initial attempt
