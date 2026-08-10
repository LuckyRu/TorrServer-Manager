    // Episodes interactor: episode list + whole-work torrent pool (season-independent — see
    // docs/system-design/torrent-mod-unified-pool.md).
    import { fetchSeason, fetchEnglishTitle, episodeCounts } from '../metadata/tmdb.js';
    import { searchMovieTorrents, searchMovieTorrentsProgressive } from '../search/movie-search.js';
    import { searchSeriesTorrents, searchSeriesTorrentsProgressive } from '../search/series-search.js';
    import { compact, notify } from '../shared/utils.js';
    import { SEASON_CACHE_KEY, MODE_MOVIE, MODE_SERIES, POOL_RETRY_DELAYS_MS } from '../shared/state.js';
    import { isCurrentGeneration } from '../shared/core/generation-guard.js';
    import { log, warn } from '../shared/core/log.js';

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
        // Shared lifecycle scope — see docs/system-design/torrent-mod-parallel-search.md.
        var scope = options.scope;

        // Kept as plain variables, not just scope-tracked, since requery() needs to cancel a
        // still-ticking retry on its own (a manual retry superseding an auto-retry in progress).
        var poolRetryTimerId = null;
        var poolSearchHandle = null; // {cancel} from the currently in-flight progressive search, if any
        var seasonAutoRetryTimers = {}; // season -> timer id

        // Reads whichever search handle is current at dispose time, so this also cancels the
        // server-side per-indexer requests, not just the client's own poll loop.
        scope.track(function () { if (poolSearchHandle) poolSearchHandle.cancel(); });

        // Fetched once, cached in state.englishTitle, so defaultSearchName can search Asian-language
        // shows by their English title; englishTitleFetch dedupes concurrent callers while in flight.
        var englishTitleFetch = null;
        function ensureEnglishTitle() {
            var state = store.get();
            if (state.englishTitle !== null) return Promise.resolve(state.englishTitle);
            if (englishTitleFetch) return englishTitleFetch;
            englishTitleFetch = fetchEnglishTitle(object.movie, hasSeasons ? MODE_SERIES : MODE_MOVIE).then(function (result) {
                englishTitleFetch = null;
                var title = result.ok ? result.value : '';
                log('episodes', 'ensureEnglishTitle: "' + title + '"');
                if (!isDestroyed()) store.patch({ englishTitle: title });
                return title;
            });
            return englishTitleFetch;
        }

        function loadEpisodes() {
            var state = store.get();
            var requestedSeason = state.season;
            var generation = state.seasonGeneration;
            log('episodes', 'loadEpisodes старт, сезон=' + requestedSeason + ', generation=' + generation);
            store.patch({ episodesStatus: 'loading', statusText: 'Загрузка списка серий…' });

            fetchSeason(movie, requestedSeason).then(function (result) {
                if (!isCurrentGeneration(store, 'seasonGeneration', generation, isDestroyed)) {
                    log('episodes', 'loadEpisodes отброшен как устаревший, сезон=' + requestedSeason + ', generation=' + generation);
                    return;
                }

                // fetchSeason returns a Result so a network failure surfaces its own retryable
                // message instead of silently falling through to the empty-season fallback below.
                if (!result.ok) {
                    warn('episodes', 'loadEpisodes ошибка (' + result.error.kind + '): ' + result.error.message, { retryable: result.error.retryable });
                    store.patch({ episodesStatus: 'error', stage: 'message', message: { text: result.error.message, retry: result.error.retryable ? loadEpisodes : null } });
                    return;
                }
                var episodes = result.value;
                var runtimes = episodes.map(function (e) { return parseInt(e.runtime, 10) || 0; }).filter(Boolean);
                var seasonEpisodeCount = episodes.length || (episodeCounts(movie)[requestedSeason] || 0);
                var avgRuntimeMinutes = runtimes.length ? runtimes.reduce(function (a, b) { return a + b; }, 0) / runtimes.length : 0;

                if (!episodes.length) {
                    var fallbackCount = episodeCounts(movie)[requestedSeason] || 0;
                    for (var i = 1; i <= fallbackCount; i++) episodes.push({ episode_number: i, name: 'Серия ' + i });
                }
                if (!episodes.length) {
                    warn('episodes', 'loadEpisodes: TMDB не вернул ни одной серии для сезона ' + requestedSeason);
                    store.patch({ episodesStatus: 'error', stage: 'message', message: { text: 'Список серий недоступен', retry: loadEpisodes } });
                    return;
                }
                log('episodes', 'loadEpisodes успех, сезон=' + requestedSeason + ', серий=' + episodes.length);
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

        // The ONE torrent fetch for the whole work (season: 0 → plain title query, spans every
        // season — see docs/system-design/torrent-mod-unified-pool.md). Progressive, per-indexer
        // (docs/system-design/torrent-mod-parallel-search.md): each tracker merges into `pool` the
        // moment it answers instead of waiting on the slowest one.
        var pendingOnLoaded = null;
        function loadAllTorrents(onLoaded) {
            var state = store.get();
            if (state.poolStatus === 'loading') {
                // Already in flight: queue the caller's callback rather than dropping it.
                log('episodes', 'loadAllTorrents уже в процессе, callback добавлен в очередь');
                if (typeof onLoaded === 'function') pendingOnLoaded = onLoaded;
                return;
            }
            var generation = state.poolGeneration;
            log('episodes', 'loadAllTorrents старт, generation=' + generation + (state.customQuery ? ', customQuery=' + state.customQuery : ''));
            // poolStartedAt is cosmetic (drives selectSearchProgress's escalating wording), set
            // before the englishTitle wait so "searching" feedback appears immediately.
            store.patch({ poolStatus: 'loading', poolStartedAt: Date.now(), pool: [], poolIndexers: [], poolAllIndexers: [] });
            ensureEnglishTitle().then(function (englishTitle) {
                // Re-check staleness after the async englishTitle wait before firing the real search.
                if (!isCurrentGeneration(store, 'poolGeneration', generation, isDestroyed)) return;
                var target = {
                    movie: object.movie,
                    mode: hasSeasons ? MODE_SERIES : MODE_MOVIE,
                    season: 0,
                    episode: 0,
                    customQuery: store.get().customQuery,
                    englishTitle: englishTitle
                };
                var search = hasSeasons ? searchSeriesTorrentsProgressive : searchMovieTorrentsProgressive;
                poolSearchHandle = search(target, function (entry) {
                if (!isCurrentGeneration(store, 'poolGeneration', generation, isDestroyed)) return;
                var current = store.get();
                log('episodes', 'loadAllTorrents: трекер "' + entry.name + '" ' +
                    (entry.ok ? ('ответил за ' + entry.elapsedMs + 'мс, +' + entry.items.length) : ('провалился (' + entry.error + ') за ' + entry.elapsedMs + 'мс')));
                // reportedAt is a plain fact; how long a chip stays visible before fading is
                // presentation policy owned by ui/results-screen.js, not this layer (see
                // docs/system-design/torrent-mod-parallel-search.md).
                store.patch({
                    pool: mergePools(current.pool, entry.items),
                    poolIndexers: current.poolIndexers.concat([{ id: entry.id, name: entry.name, ok: entry.ok, error: entry.error, elapsedMs: entry.elapsedMs, reportedAt: Date.now() }])
                });
            }, function (startFailed) {
                poolSearchHandle = null;
                if (!isCurrentGeneration(store, 'poolGeneration', generation, isDestroyed)) return;
                var current = store.get();
                var anyOk = current.poolIndexers.some(function (indexer) { return indexer.ok; });
                // Reached only when not one configured indexer answered — retried automatically with
                // escalating delays, visible via selectSearchProgress's 'retrying' stage (never
                // silent), then falls back to the manual "Повторить" surfaces once exhausted.
                if (startFailed || !anyOk) {
                    var attempt = current.poolAttempt || 1;
                    var retryIndex = attempt - 1;
                    if (retryIndex < POOL_RETRY_DELAYS_MS.length) {
                        var delayMs = POOL_RETRY_DELAYS_MS[retryIndex];
                        warn('episodes', 'loadAllTorrents: ни один трекер не ответил, авто-повтор через ' + delayMs + 'мс (попытка ' + (attempt + 1) + ')');
                        store.patch({ poolStatus: 'error', poolAutoRetryAt: Date.now() + delayMs });
                        if (poolRetryTimerId !== null) clearTimeout(poolRetryTimerId);
                        poolRetryTimerId = scope.setTimeout(function () {
                            poolRetryTimerId = null;
                            requery(onLoaded, true);
                        }, delayMs);
                        return;
                    }
                    warn('episodes', 'loadAllTorrents: авто-повторы исчерпаны, ни один трекер не ответил');
                    notify('Не удалось получить раздачи — проверьте Jackett или повторите позже');
                    store.patch({ poolStatus: 'error', poolAutoRetryAt: null });
                } else {
                    log('episodes', 'loadAllTorrents успех, раздач в пуле=' + current.pool.length);
                    store.patch({ poolStatus: 'ready', poolAutoRetryAt: null });
                }
                if (typeof onLoaded === 'function') onLoaded();
                var pending = pendingOnLoaded;
                pendingOnLoaded = null;
                if (pending && pending !== onLoaded) pending();
            }, scope, function (indexerList) {
                if (!isCurrentGeneration(store, 'poolGeneration', generation, isDestroyed)) return;
                store.patch({ poolAllIndexers: indexerList });
            });
            });
        }

        function setSeason(season) {
            var state = store.get();
            if (season === state.season) return false;
            log('episodes', 'setSeason: ' + state.season + ' → ' + season);
            rememberSeason(movie, season);
            // Season flip is LOCAL — the pool already holds every season's releases, only the TMDB
            // episode list is re-fetched. Also bumps searchGeneration to discard an in-flight
            // customQuery search made for the old season.
            store.patch({
                season: season,
                seasonGeneration: state.seasonGeneration + 1,
                searchGeneration: state.searchGeneration + 1,
                searchStatus: 'idle'
            });
            loadEpisodes();
            return true;
        }

        // Lazy per-season fetch, used only when the whole-work pool has zero candidates for a season
        // the user opened (Jackett's per-query result cap can miss season-specific releases). Merges
        // into the existing pool; fire-and-forget with no completion callback — a prior callback-based
        // retry chain here caused two separate infinite-recursion crashes (see
        // docs/reference/torrent-mod-gotchas.md and docs/system-design/torrent-mod-domain-architecture.md).
        // seasonLoads[season] stays 'loading' through its whole retry ladder, only flipping to
        // 'error' once exhausted, so the badge doesn't flicker between states on each retry.
        var SEASON_RETRY_DELAYS_MS = [2500];
        var seasonAttempts = {};

        function ensureSeasonLoaded(season) {
            var state = store.get();
            if (!hasSeasons || state.customQuery) return;
            if (state.poolStatus !== 'ready' && state.poolStatus !== 'error') return;
            if (state.seasonLoads && state.seasonLoads[season]) return; // already loading/ready/error

            var generation = state.poolGeneration;
            var loads = Object.assign({}, state.seasonLoads || {});
            loads[season] = 'loading';
            store.patch({ seasonLoads: loads });
            log('episodes', 'ensureSeasonLoaded: дозагрузка сезона ' + season + ' (в общем пуле для него пусто)');
            delete seasonAttempts[season]; // fresh start, including for a manual retrySeasonLoad
            runSeasonSearch(season, generation);
        }

        function runSeasonSearch(season, generation) {
            // Safe to read englishTitle directly here — ensureSeasonLoaded only runs after
            // loadAllTorrents' own englishTitle fetch has already resolved.
            var target = { movie: object.movie, season: season, episode: 0, englishTitle: store.get().englishTitle };
            searchSeriesTorrents(target).then(function (response) {
                if (!isCurrentGeneration(store, 'poolGeneration', generation, isDestroyed)) {
                    log('episodes', 'ensureSeasonLoaded(' + season + ') отброшен как устаревший');
                    delete seasonAttempts[season];
                    return;
                }
                if (response.failed) {
                    var attempt = seasonAttempts[season] || 1;
                    if (attempt - 1 < SEASON_RETRY_DELAYS_MS.length) {
                        var delayMs = SEASON_RETRY_DELAYS_MS[attempt - 1];
                        seasonAttempts[season] = attempt + 1;
                        warn('episodes', 'ensureSeasonLoaded(' + season + ') не удался, авто-повтор через ' + delayMs + 'мс');
                        if (seasonAutoRetryTimers[season] !== undefined) clearTimeout(seasonAutoRetryTimers[season]);
                        // scope.setTimeout cancels itself automatically if the screen closes first.
                        seasonAutoRetryTimers[season] = scope.setTimeout(function () {
                            delete seasonAutoRetryTimers[season];
                            runSeasonSearch(season, generation);
                        }, delayMs);
                        return;
                    }
                    delete seasonAttempts[season];
                    warn('episodes', 'ensureSeasonLoaded(' + season + ') авто-повторы исчерпаны');
                    var current = store.get();
                    var loadsFailed = Object.assign({}, current.seasonLoads || {});
                    loadsFailed[season] = 'error';
                    store.patch({ seasonLoads: loadsFailed });
                    return;
                }
                delete seasonAttempts[season];
                var current = store.get();
                var merged = mergePools(current.pool, response.results);
                var loadsReady = Object.assign({}, current.seasonLoads || {});
                loadsReady[season] = 'ready';
                log('episodes', 'ensureSeasonLoaded(' + season + ') успех, пул после мержа=' + merged.length);
                store.patch({ pool: merged, seasonLoads: loadsReady });
            });
        }

        // Manual retry only (no auto-retry): ensureSeasonLoaded is a no-op once a season has any
        // status, so retrying means clearing it first.
        function retrySeasonLoad(season) {
            var state = store.get();
            var loads = Object.assign({}, state.seasonLoads || {});
            delete loads[season];
            log('episodes', 'retrySeasonLoad: сброс статуса сезона ' + season + ', повторная попытка');
            store.patch({ seasonLoads: loads });
            ensureSeasonLoaded(season);
        }

        // Same identity as search-backend's dedup (magnet → link → title+size); pool only grows.
        function mergePools(existing, incoming) {
            var seen = {};
            var out = [];
            existing.concat(incoming).forEach(function (item) {
                var id = compact(item.magnet || item.link || (item.title + '|' + item.size));
                if (!id || seen[id]) return;
                seen[id] = true;
                out.push(item);
            });
            return out;
        }

        // The "К списку серий" back action — reuses the already-loaded episodesCache, no refetch.
        function showEpisodeList() {
            store.patch({ stage: 'episodes', statusText: '' });
        }

        // Re-fetch the whole-work pool under a new query context (episode list stays put, TMDB
        // data). `isRetry` only affects the display attempt counter — poolGeneration alone guards
        // staleness — since a fresh query resets the count while a manual retry climbs it.
        function requery(onLoaded, isRetry) {
            var state = store.get();
            log('episodes', 'requery: сброс пула под новым запросом, customQuery=' + state.customQuery + (isRetry ? ', попытка ' + ((state.poolAttempt || 1) + 1) : ''));
            // Cancel any still-ticking auto-retry and any in-flight progressive search (which also
            // best-effort cancels the server-side per-indexer requests) so a manual retry can't race
            // the old search into two overlapping loadAllTorrents calls.
            if (poolRetryTimerId !== null) { clearTimeout(poolRetryTimerId); poolRetryTimerId = null; }
            if (poolSearchHandle) { poolSearchHandle.cancel(); poolSearchHandle = null; }
            // New query context: old pool and per-season coverage are both invalid.
            store.patch({
                pool: [], poolStatus: 'idle', poolGeneration: state.poolGeneration + 1, seasonLoads: {}, poolIndexers: [], poolAllIndexers: [],
                poolAttempt: isRetry ? (state.poolAttempt || 1) + 1 : 1, poolAutoRetryAt: null
            });
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
            ensureSeasonLoaded: ensureSeasonLoaded,
            retrySeasonLoad: retrySeasonLoad,
            setSeason: setSeason,
            showEpisodeList: showEpisodeList,
            requery: requery
        };
    }
