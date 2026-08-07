    // ---------- domain: episodes interactor ----------
    //
    // loadEpisodes/loadAllTorrents/setSeason/showEpisodeList grouped together: both loaders live
    // here because they share the same season-scoped resource set
    // (episodesCache/pool/seasonEpisodeCount/avgRuntimeMinutes/seasonGeneration/poolGeneration).
    //
    // The torrent pool is WHOLE-WORK, not season-scoped: loadAllTorrents() searches the title once
    // (buildQueries with season=0 → plain title + year variants) and gets releases of *all*
    // seasons back — season packs, single episodes, everything. Everything downstream (row badges,
    // filters, episode clicks) filters this one pool locally via selectors; changing season is
    // purely a state.season flip with zero network traffic. See
    // docs/system-design/torrent-mod-unified-pool.md (Этап 1).
    import { fetchSeason, episodeCounts } from '../metadata/tmdb.js';
    import { searchTorrentMod } from '../search/search-backend.js';

    var SEASON_CACHE_KEY = 'torrent_mod_last_season';
    var PER_MOVIE_CACHE_MAX = 200;

    function rememberSeason(movie, season) {
        try {
            var last = Lampa.Storage.cache(SEASON_CACHE_KEY, PER_MOVIE_CACHE_MAX, {});
            last[movie.id] = season;
            Lampa.Storage.set(SEASON_CACHE_KEY, last);
        } catch (e) {}
    }

    export function createEpisodesInteractor(options) {
        var store = options.store;
        var object = options.object;
        var movie = options.movie;
        var hasSeasons = options.hasSeasons;
        var isDestroyed = options.isDestroyed;

        function loadEpisodes() {
            var state = store.get();
            var requestedSeason = state.season;
            var generation = state.seasonGeneration;
            store.patch({ episodesStatus: 'loading', statusText: 'Загрузка списка серий…' });

            fetchSeason(movie, requestedSeason).catch(function (error) {
                console.warn('Torrent Mod: TMDB season fetch failed', error);
                return [];
            }).then(function (episodes) {
                // Generation check closes a gap plain value comparison can't: switching season
                // 2 -> 3 -> 2 again quickly, the *first* season-2 request's late response would pass
                // a naive "season !== requestedSeason" check (season really is 2 again) even though a
                // second, newer season-2 fetch is also in flight and should win. The counter
                // distinguishes "same season number, asked a second time" from "still waiting on the
                // first ask" in a way a value comparison structurally cannot.
                if (isDestroyed() || store.get().seasonGeneration !== generation) return;
                episodes = episodes || [];
                var runtimes = episodes.map(function (e) { return parseInt(e.runtime, 10) || 0; }).filter(Boolean);
                var seasonEpisodeCount = episodes.length || (episodeCounts(movie)[requestedSeason] || 0);
                var avgRuntimeMinutes = runtimes.length ? runtimes.reduce(function (a, b) { return a + b; }, 0) / runtimes.length : 0;

                if (!episodes.length) {
                    var fallbackCount = episodeCounts(movie)[requestedSeason] || 0;
                    for (var i = 1; i <= fallbackCount; i++) episodes.push({ episode_number: i, name: 'Серия ' + i });
                }
                if (!episodes.length) {
                    store.patch({ episodesStatus: 'error', stage: 'message', message: { text: 'Список серий недоступен', retry: true } });
                    return;
                }
                store.patch({
                    episodesCache: episodes,
                    seasonEpisodeCount: seasonEpisodeCount,
                    avgRuntimeMinutes: avgRuntimeMinutes,
                    stage: 'episodes',
                    statusText: '',
                    episodesStatus: 'ready'
                });
            });
        }

        // The ONE torrent fetch for the whole work. `season: 0` makes buildQueries emit plain title
        // (+ year) queries — no season/episode suffixes — so the pool spans every season's releases
        // (season packs like "S1-5E1-62 of 62" now matter: parseSignals handles season ranges, and
        // the gate/scoring in scoring.js matches such a pack against any of its seasons). Everything
        // else — badges, filters, clicks — is local filtering over this pool (see selectors and
        // selection-interactor.js). `onLoaded` fires after the pool lands (used by the movie flow
        // to kick off the local candidate pick once data is actually there).
        var pendingOnLoaded = null;
        function loadAllTorrents(onLoaded) {
            var state = store.get();
            if (state.poolStatus === 'loading') {
                // Already in flight: don't lose a caller's callback (e.g. the movie flow's first
                // selectEpisode(0)) if loadAllTorrents is re-invoked mid-load (found in review).
                if (typeof onLoaded === 'function') pendingOnLoaded = onLoaded;
                return;
            }
            var generation = state.poolGeneration;
            var target = {
                movie: object.movie,
                season: 0,
                episode: 0,
                customQuery: state.customQuery
            };
            store.patch({ poolStatus: 'loading' });
            searchTorrentMod(target).then(function (response) {
                if (isDestroyed() || store.get().poolGeneration !== generation) return;
                store.patch({
                    pool: response.failed ? [] : response.results,
                    poolStatus: response.failed ? 'error' : 'ready'
                });
                if (typeof onLoaded === 'function') onLoaded();
                var pending = pendingOnLoaded;
                pendingOnLoaded = null;
                if (pending && pending !== onLoaded) pending();
            });
        }

        function setSeason(season) {
            var state = store.get();
            if (season === state.season) return false;
            rememberSeason(movie, season);
            // Season flip is LOCAL: the pool already holds every season's releases, so nothing is
            // re-fetched — only the TMDB episode list for the new season, which re-derives badges
            // from the same pool via selectors. Also bump searchGeneration: an in-flight freshSearch
            // (only possible with an active customQuery) was made for the OLD season and must be
            // discarded, not shown on the new season's screen (found in review).
            store.patch({
                season: season,
                seasonGeneration: state.seasonGeneration + 1,
                searchGeneration: state.searchGeneration + 1,
                searchStatus: 'idle'
            });
            loadEpisodes();
            return true;
        }

        // The "К списку серий" back action — reuses the already-loaded episodesCache, no refetch.
        function showEpisodeList() {
            store.patch({ stage: 'episodes', statusText: '' });
        }

        // Re-fetch the whole-work pool under a new query context (the user typed a disambiguating
        // name override in the toolbar search). The episode list is TMDB data and stays put — only
        // the pool (and therefore the row badges) is re-fetched, the same way Online Mod re-fetches
        // its balancer's data for a re-worded query without leaving its screen. `onLoaded` fires
        // after the fresh pool lands (movie flow: then show the local candidate pick).
        function requery(onLoaded) {
            var state = store.get();
            store.patch({ pool: null, poolStatus: 'idle', poolGeneration: state.poolGeneration + 1 });
            loadAllTorrents(onLoaded);
        }

        function start() {
            if (!hasSeasons) return;
            loadEpisodes();
            loadAllTorrents();
        }

        return {
            start: start,
            loadEpisodes: loadEpisodes,
            loadAllTorrents: loadAllTorrents,
            setSeason: setSeason,
            showEpisodeList: showEpisodeList,
            requery: requery
        };
    }
