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
    import { searchMovieTorrents } from '../search/movie-search.js';
    import { searchSeriesTorrents } from '../search/series-search.js';
    import { compact, notify } from '../shared/utils.js';
    import { SEASON_CACHE_KEY, MODE_MOVIE, MODE_SERIES } from '../shared/state.js';
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

        // Callbacks queued behind an ALREADY-in-flight per-season fetch (ensureSeasonLoaded called
        // again for a season whose seasonLoads status is already 'loading'), keyed by season. See
        // ensureSeasonLoaded's own comment on why these must be queued, not fired synchronously.
        var pendingSeasonCallbacks = {};

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

                // fetchSeason now returns a Result (shared/core/result.js): a network failure and a
                // legitimately empty TMDB season used to be indistinguishable here (fetchSeason's own
                // request() never rejects), both silently producing an empty array. A real failure now
                // surfaces as its own retryable message instead of falling through to the synthetic
                // fallback-episode-count branch below, which is for the genuinely-empty case only.
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
                log('episodes', 'loadAllTorrents уже в процессе, callback добавлен в очередь');
                if (typeof onLoaded === 'function') pendingOnLoaded = onLoaded;
                return;
            }
            var generation = state.poolGeneration;
            var target = {
                movie: object.movie,
                mode: hasSeasons ? MODE_SERIES : MODE_MOVIE,
                season: 0,
                episode: 0,
                customQuery: state.customQuery
            };
            log('episodes', 'loadAllTorrents старт, generation=' + generation + (state.customQuery ? ', customQuery=' + state.customQuery : ''));
            store.patch({ poolStatus: 'loading' });
            var search = hasSeasons ? searchSeriesTorrents : searchMovieTorrents;
            search(target).then(function (response) {
                if (!isCurrentGeneration(store, 'poolGeneration', generation, isDestroyed)) {
                    log('episodes', 'loadAllTorrents отброшен как устаревший, generation=' + generation);
                    return;
                }
                // A silent warn() log used to be the ONLY signal a failed whole-work search ever
                // produced — pool just became [] and poolStatus 'error', visually identical to a
                // search that genuinely ran and found nothing (badges/messages downstream couldn't
                // tell the two apart either, see their own comments). Reported directly by the
                // user testing this exact path live: a Jackett 502/timeout on the aggregate
                // all-indexers query left them with no idea anything had gone wrong at all. An
                // explicit toast the moment the FIRST-ever whole-work search fails is cheap and
                // immediate — the lazy per-season retry (ensureSeasonLoaded) stays silent on its
                // own failure as before, that one's a narrower, expected-to-sometimes-fail path,
                // not the primary "did the search even work" signal.
                if (response.failed) {
                    warn('episodes', 'loadAllTorrents: поиск не удался');
                    notify('Не удалось получить раздачи — проверьте Jackett или повторите позже');
                } else {
                    log('episodes', 'loadAllTorrents успех, раздач в пуле=' + response.results.length);
                }
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
            log('episodes', 'setSeason: ' + state.season + ' → ' + season);
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

        // Lazy per-season fetch, only when the whole-work pool has ZERO candidates for a season the
        // user actually opened (Jackett's per-query result limit can leave season-specific releases
        // out of the title-only pool — no pagination to page through them). The query is the same
        // buildQueries(season) already used elsewhere: «Имя Sxx» + «Имя N сезон» (two formats, per
        // live checks; season-range packs like S1-5 are NOT reachable this way — they live in the
        // title pool, and parseSignals matches them against any covered season). Results are MERGED
        // into the existing pool (never replacing it), dedup by magnet/link/title+size, and the
        // season is marked ready/error so it is never re-fetched until requery resets the map.
        function ensureSeasonLoaded(season, onComplete) {
            var state = store.get();
            // Both of these are conditions under which this function fundamentally cannot do
            // anything (no per-season query makes sense without seasons/outside a customQuery
            // context, or the whole-work pool itself hasn't settled enough yet to know if a
            // per-season top-up is even needed) — deliberately do NOT call onComplete()
            // synchronously here (the original behaviour). Both real callers (fillPicker,
            // selectEpisode's lazy-load branch) treat "onComplete fired" as "something may have
            // changed, re-check state and retry the same operation" — firing it here with nothing
            // having changed bounces straight back into an identical call, an unbounded
            // *synchronous* recursion with no base case. Confirmed live, twice, via two different
            // bail branches on two separate days: opening the side picker right after the
            // whole-work pool search failed (that path fell into the 'error' branch below, now
            // fixed by treating 'error' as settled instead of bailing here), then reopening the
            // picker for another episode while an earlier per-season fetch was still pending (see
            // the 'loading' branch below). Both crashed with `RangeError: Maximum call stack size
            // exceeded`. Callers now pre-check these same conditions themselves before ever calling
            // this function (see fillPicker's own comment) — these two checks stay here only as a
            // defensive backstop for any future caller that doesn't, and silence is the only safe
            // thing to do for a caller that skips its own check: a fake synchronous "done" is what
            // caused the crash in the first place, and there's nothing correct to promise it either.
            if (!hasSeasons || state.customQuery) return;
            if (state.poolStatus === 'loading' || state.poolStatus === 'idle') return;
            var status = state.seasonLoads && state.seasonLoads[season];
            if (status === 'ready' || status === 'error') {
                if (typeof onComplete === 'function') onComplete();
                return;
            }
            if (status === 'loading') {
                // A fetch for this season is ALREADY running (started by an earlier call, not yet
                // resolved) — queue this caller's callback instead of firing it synchronously with
                // nothing having changed. Firing immediately here (the original behaviour) bounced
                // straight back into the caller's own "retry the same thing" callback
                // (fillPicker/selectEpisode), which re-enters this exact function with status still
                // 'loading' — an unbounded *synchronous* recursion, crashed live a second time
                // (RangeError: Maximum call stack size exceeded) reopening the side picker for
                // another episode while an earlier openPicker's lazy per-season fetch was still
                // pending (the first such crash, fixed earlier, was the poolStatus==='error' bail
                // just above doing the same thing — this is the same bug class via a different
                // early-bail branch). Every queued callback fires once, in the order queued, when
                // the real fetch actually resolves below.
                if (typeof onComplete === 'function') {
                    pendingSeasonCallbacks[season] = pendingSeasonCallbacks[season] || [];
                    pendingSeasonCallbacks[season].push(onComplete);
                }
                return;
            }
            var generation = state.poolGeneration;
            var loads = Object.assign({}, state.seasonLoads || {});
            loads[season] = 'loading';
            store.patch({ seasonLoads: loads });
            log('episodes', 'ensureSeasonLoaded: дозагрузка сезона ' + season + ' (в общем пуле для него пусто)');

            var target = { movie: object.movie, season: season, episode: 0 };
            searchSeriesTorrents(target).then(function (response) {
                if (!isCurrentGeneration(store, 'poolGeneration', generation, isDestroyed)) {
                    log('episodes', 'ensureSeasonLoaded(' + season + ') отброшен как устаревший');
                    // Same "silently drop" behaviour the primary onComplete already had on
                    // staleness — a stale generation invalidates whatever these callbacks were
                    // waiting to react to (e.g. requery() reset the whole pool since they queued).
                    delete pendingSeasonCallbacks[season];
                    return;
                }
                var current = store.get();
                var merged = mergePools(current.pool || [], response.failed ? [] : response.results);
                var loads2 = Object.assign({}, current.seasonLoads || {});
                loads2[season] = response.failed ? 'error' : 'ready';
                log('episodes', 'ensureSeasonLoaded(' + season + ') ' + (response.failed ? 'ошибка' : 'успех') + ', пул после мержа=' + merged.length);
                store.patch({ pool: merged, seasonLoads: loads2 });
                if (typeof onComplete === 'function') onComplete();
                var queued = pendingSeasonCallbacks[season] || [];
                delete pendingSeasonCallbacks[season];
                queued.forEach(function (cb) { cb(); });
            });
        }

        // Same identity as search-backend's dedup: magnet first, then link, then title+size.
        // The pool must grow monotonically within one query context — never shrink or replace.
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

        // Re-fetch the whole-work pool under a new query context (the user typed a disambiguating
        // name override in the toolbar search). The episode list is TMDB data and stays put — only
        // the pool (and therefore the row badges) is re-fetched, the same way Online Mod re-fetches
        // its balancer's data for a re-worded query without leaving its screen. `onLoaded` fires
        // after the fresh pool lands (movie flow: then show the local candidate pick).
        function requery(onLoaded) {
            var state = store.get();
            log('episodes', 'requery: сброс пула под новым запросом, customQuery=' + state.customQuery);
            // New query context: old pool and per-season coverage are both invalid.
            store.patch({ pool: null, poolStatus: 'idle', poolGeneration: state.poolGeneration + 1, seasonLoads: {} });
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
            setSeason: setSeason,
            showEpisodeList: showEpisodeList,
            requery: requery
        };
    }
