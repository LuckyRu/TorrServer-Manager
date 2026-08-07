    // ---------- domain: episodes interactor ----------
    //
    // loadEpisodes/ensureSeasonPool/setSeason/showEpisodeList grouped together because
    // ensureSeasonPool is *called from inside* loadEpisodes (a direct call edge, not just "both are
    // about seasons"), and both share the same season-scoped resource set
    // (episodesCache/seasonPool/seasonEpisodeCount/avgRuntimeMinutes/seasonGeneration).
    //
    // setSeason() now triggers the reload itself instead of the caller (the View, in the old code)
    // having to remember to call loadEpisodes() right after — the actual "UI shouldn't orchestrate
    // async sequencing" requirement made concrete: the View calls one method and reacts to whatever
    // state results, it doesn't decide what happens next.
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
                ensureSeasonPool();
            });
        }

        // As soon as we know the season (title + season number + TMDB's own runtime/episode-count
        // data for a correct per-episode bitrate estimate), there's nothing episode-specific left to
        // wait for — every episode's own torrent search would use the same season-wide query terms
        // anyway (see buildQueries: no `episode` on the target means season-pack-style queries only).
        // So search once, in the background, right when the episode list loads, instead of once per
        // click: the results enrich the episode list (availability badges) and the Перевод/Фильтры
        // chips (only offer voice/quality options that actually exist in this season) *before* the
        // user commits to anything, and let a click resolve instantly instead of waiting out another
        // Jackett round trip when the pool already covers it (see selection-interactor.js).
        function ensureSeasonPool() {
            var state = store.get();
            if (!hasSeasons) return;
            if (state.seasonPoolStatus === 'loading') return; // already in flight for this generation
            var generation = state.seasonGeneration;
            var target = {
                movie: object.movie,
                season: state.season,
                episode: 0,
                seasonEpisodeCount: state.seasonEpisodeCount,
                avgRuntimeMinutes: state.avgRuntimeMinutes,
                customQuery: state.customQuery
            };
            store.patch({ seasonPoolStatus: 'loading' });
            searchTorrentMod(target).then(function (response) {
                if (isDestroyed() || store.get().seasonGeneration !== generation) return;
                store.patch({
                    seasonPool: response.failed ? [] : response.results,
                    seasonPoolStatus: response.failed ? 'error' : 'ready'
                });
            });
        }

        function setSeason(season) {
            var state = store.get();
            if (season === state.season) return false;
            rememberSeason(movie, season);
            store.patch({
                season: season,
                seasonGeneration: state.seasonGeneration + 1,
                seasonPool: null,
                seasonPoolStatus: 'idle'
            });
            loadEpisodes();
            return true;
        }

        // The "К списку серий" back action — reuses the already-loaded episodesCache, no refetch.
        function showEpisodeList() {
            store.patch({ stage: 'episodes', statusText: '' });
        }

        // Re-run the season-wide background search under a new query context (e.g. the user typed a
        // disambiguating name override in the toolbar search). The episode list itself is TMDB data
        // and stays put — only the torrent pool (and therefore the row badges) is re-fetched, the
        // same way Online Mod re-fetches its balancer's data for a re-worded query without leaving
        // its screen. ensureSeasonPool builds its target from current state, so a fresh call here
        // already picks up state.customQuery.
        function requery() {
            var state = store.get();
            store.patch({ seasonPool: null, seasonPoolStatus: 'idle' });
            ensureSeasonPool();
        }

        function start() {
            if (!hasSeasons) return;
            loadEpisodes();
        }

        return {
            start: start,
            loadEpisodes: loadEpisodes,
            ensureSeasonPool: ensureSeasonPool,
            setSeason: setSeason,
            showEpisodeList: showEpisodeList,
            requery: requery
        };
    }
