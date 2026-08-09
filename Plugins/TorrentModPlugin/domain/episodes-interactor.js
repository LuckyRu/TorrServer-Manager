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

        // Pending auto-retry timers — cancelled on destroy() so a screen the user already left
        // doesn't keep silently retrying (and, for the pool one, doesn't fire requery() against a
        // destroyed store).
        var poolAutoRetryTimer = null;
        var seasonAutoRetryTimers = {}; // season -> timer

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
            // poolStartedAt: plain wall-clock timestamp, read only by selectSearchProgress to
            // escalate the head status line's wording past ~15s of a cold search — not a
            // generation/staleness concern, just cosmetic timing data (still "plain data only" per
            // this file's own state-shape rule: a number, not a timer/Promise).
            store.patch({ poolStatus: 'loading', poolStartedAt: Date.now() });
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
                // all-indexers query left them with no idea anything had gone wrong at all.
                //
                // A network/Jackett failure is now retried automatically, with escalating delays
                // (POOL_RETRY_DELAYS_MS, shared/state.js) — required directly by the user after a
                // real repeated-failure report ("сбой поиска был 2 раза, два раза переходил назад
                // и запускал плагин заново"): a transient failure that a manual relaunch fixes is
                // exactly the case auto-retry exists for, and making the user do that dance by hand
                // every time is the actual product failure, not a hypothetical one. Kept HONEST per
                // the same conversation ("можно честно информировать пользователя") — every retry
                // is visible in the status line via selectSearchProgress's 'retrying' stage (a live
                // countdown + "попытка N из M"), never silent. Once POOL_RETRY_DELAYS_MS is
                // exhausted, this falls back to exactly the old behaviour: a toast, poolStatus
                // 'error', and the existing manual "Повторить" surfaces (emptyPoolMessage for
                // movies; badges/status text for series) — auto-retry raises the floor, it doesn't
                // replace the escape hatch for a genuinely persistent outage.
                if (response.failed) {
                    var current = store.get();
                    var attempt = current.poolAttempt || 1;
                    var retryIndex = attempt - 1;
                    if (retryIndex < POOL_RETRY_DELAYS_MS.length) {
                        var delayMs = POOL_RETRY_DELAYS_MS[retryIndex];
                        warn('episodes', 'loadAllTorrents: поиск не удался, авто-повтор через ' + delayMs + 'мс (попытка ' + (attempt + 1) + ')');
                        store.patch({ pool: [], poolStatus: 'error', poolAutoRetryAt: Date.now() + delayMs });
                        if (poolAutoRetryTimer) clearTimeout(poolAutoRetryTimer);
                        poolAutoRetryTimer = setTimeout(function () {
                            poolAutoRetryTimer = null;
                            if (isDestroyed()) return;
                            requery(onLoaded, true);
                        }, delayMs);
                        return;
                    }
                    warn('episodes', 'loadAllTorrents: поиск не удался, авто-повторы исчерпаны');
                    notify('Не удалось получить раздачи — проверьте Jackett или повторите позже');
                    store.patch({ pool: [], poolStatus: 'error', poolAutoRetryAt: null });
                } else {
                    log('episodes', 'loadAllTorrents успех, раздач в пуле=' + response.results.length);
                    store.patch({ pool: response.results, poolStatus: 'ready', poolAutoRetryAt: null });
                }
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
        // Fire-and-forget, idempotent: no completion callback of any kind. This function's ONLY job
        // is "make sure this season's lazy fetch is running (or already ran)" — it writes
        // pool/seasonLoads to the store and stops there. It used to take an `onComplete` callback
        // that both real callers (fillPicker/selectEpisode's lazy-load branch) threaded a "call me
        // back and I'll retry the same thing" chain through — the shared root cause of two separate
        // `RangeError: Maximum call stack size exceeded` crashes (see CLAUDE.md): every one of this
        // function's own early-bail branches that fired the callback synchronously with nothing
        // having changed bounced straight back into an identical call from the caller's retry shape,
        // an unbounded synchronous recursion. Removing the callback entirely (not just making it
        // safer to call) removes the recursion structurally: there is no "retry via callback" concept
        // left for a caller to get wrong. Callers that need to react to this season eventually
        // settling now do so by subscribing to the store (selection-interactor's own watcher), the
        // same way the View reacts to it for the row badges — reading state, not being called back.
        // Short, fewer-attempts retry ladder than the pool's own (SEASON_RETRY_DELAYS_MS vs.
        // POOL_RETRY_DELAYS_MS) — this is a background operation (per-season lazy top-up, never its
        // own visible stage per product decision — see selectSearchProgress), not the main blocking
        // search the pool one is. seasonLoads[season] deliberately stays 'loading' for the WHOLE
        // retry ladder, only flipping to 'error' once exhausted — a badge reading "поиск…" that
        // occasionally takes a bit longer is honest; flickering to "ошибка поиска" and back on every
        // retry attempt would not be. seasonAttempts is closure-local, not stored in domain state:
        // nothing downstream needs to render "попытка N" for this particular retry (unlike the pool
        // one), so there's no reason to make it observable state.
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
            var target = { movie: object.movie, season: season, episode: 0 };
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
                        if (seasonAutoRetryTimers[season]) clearTimeout(seasonAutoRetryTimers[season]);
                        seasonAutoRetryTimers[season] = setTimeout(function () {
                            delete seasonAutoRetryTimers[season];
                            if (isDestroyed()) return;
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
                var merged = mergePools(current.pool || [], response.results);
                var loadsReady = Object.assign({}, current.seasonLoads || {});
                loadsReady[season] = 'ready';
                log('episodes', 'ensureSeasonLoaded(' + season + ') успех, пул после мержа=' + merged.length);
                store.patch({ pool: merged, seasonLoads: loadsReady });
            });
        }

        // Manual retry for a season whose lazy fetch already settled as 'error' — ensureSeasonLoaded
        // itself is a no-op once a season has a status at all (by design, to stay idempotent for its
        // normal callers), so retrying means explicitly clearing that status first. User-triggered
        // only (a picker's "Повторить" row), never automatic — product decision, no auto-retry.
        function retrySeasonLoad(season) {
            var state = store.get();
            var loads = Object.assign({}, state.seasonLoads || {});
            delete loads[season];
            log('episodes', 'retrySeasonLoad: сброс статуса сезона ' + season + ', повторная попытка');
            store.patch({ seasonLoads: loads });
            ensureSeasonLoaded(season);
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
        // `isRetry` distinguishes WHY requery is being called, for the attempt counter only (it has
        // no gating role — poolGeneration alone is what protects against a stale response landing,
        // same as before): a fresh query context (searchWithQuery, a new customQuery) resets the
        // counter to 1, since it's not "trying the same search again," it's a different search. A
        // user pressing "Повторить" on a failed search (emptyPoolMessage) IS retrying the same
        // thing, so that counter should climb — shown as "попытка N" in the retry message.
        function requery(onLoaded, isRetry) {
            var state = store.get();
            log('episodes', 'requery: сброс пула под новым запросом, customQuery=' + state.customQuery + (isRetry ? ', попытка ' + ((state.poolAttempt || 1) + 1) : ''));
            // A manual "Повторить" press can land while an auto-retry for the SAME failure is
            // already ticking (e.g. the user didn't want to wait) — cancel it so the two don't both
            // fire and race each other into two overlapping loadAllTorrents calls.
            if (poolAutoRetryTimer) { clearTimeout(poolAutoRetryTimer); poolAutoRetryTimer = null; }
            // New query context: old pool and per-season coverage are both invalid.
            store.patch({
                pool: null, poolStatus: 'idle', poolGeneration: state.poolGeneration + 1, seasonLoads: {},
                poolAttempt: isRetry ? (state.poolAttempt || 1) + 1 : 1, poolAutoRetryAt: null
            });
            loadAllTorrents(onLoaded);
        }

        function start() {
            if (!hasSeasons) return;
            loadEpisodes();
            loadAllTorrents();
        }

        // Cancels every pending auto-retry timer (pool + all seasons) — without this, a screen the
        // user already backed out of would keep silently retrying in the background and eventually
        // call requery()/store.patch() against a destroyed store.
        function destroy() {
            if (poolAutoRetryTimer) { clearTimeout(poolAutoRetryTimer); poolAutoRetryTimer = null; }
            Object.keys(seasonAutoRetryTimers).forEach(function (season) {
                clearTimeout(seasonAutoRetryTimers[season]);
            });
            seasonAutoRetryTimers = {};
        }

        return {
            start: start,
            loadEpisodes: loadEpisodes,
            loadAllTorrents: loadAllTorrents,
            ensureSeasonLoaded: ensureSeasonLoaded,
            retrySeasonLoad: retrySeasonLoad,
            setSeason: setSeason,
            showEpisodeList: showEpisodeList,
            requery: requery,
            destroy: destroy
        };
    }
