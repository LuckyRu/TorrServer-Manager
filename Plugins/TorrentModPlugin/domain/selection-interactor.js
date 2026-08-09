    // ---------- domain: selection interactor ----------
    //
    // selectEpisode/searchWithQuery/playCandidate grouped together: all terminate in either
    // finishSelection (candidate list or auto-play) or a direct startDownload; all populate
    // candidates/stage/searchGeneration. searchWithQuery is the manual name-override path — it
    // re-fetches data under the new name instead of starting playback, see its own comment below.
    import { searchMovieTorrents } from '../search/movie-search.js';
    import { searchSeriesTorrents } from '../search/series-search.js';
    import { applyStateFilters, scoreCandidate } from '../search/scoring.js';
    import { startDownload } from '../playback/smart-preload.js';
    import { enabled, notify, debugLogCandidates } from '../shared/utils.js';
    import { searchQueryText, isConfidentMatch, candidateIdentity, findSavedDefault } from './results-core.js';
    import { selectCandidatesForEpisode } from './results-selectors.js';
    import { MODE_MOVIE, MODE_SERIES } from '../shared/state.js';
    import { isCurrentGeneration } from '../shared/core/generation-guard.js';
    import { log, warn } from '../shared/core/log.js';

    var DEFAULT_KEY = 'torrent_mod_default_torrent';
    var LAST_EPISODE_KEY = 'torrent_mod_last_episode';
    var PER_MOVIE_CACHE_MAX = 200;

    export function createSelectionInteractor(options) {
        var store = options.store;
        var object = options.object;
        var hasSeasons = options.hasSeasons;
        var isDestroyed = options.isDestroyed;
        var requery = options.requery;
        var ensureSeasonLoaded = options.ensureSeasonLoaded;
        // Shared lifecycle scope (shared/core/lifecycle.js, results-domain.js) — the watcher
        // subscription and the pending-retry timer below register into it instead of each keeping
        // its own destroy()-method bookkeeping (see the scope's own header comment for why: two
        // separately hand-written destroy() methods across this file and episodes-interactor.js
        // were exactly the kind of thing a future timer is one missed edit away from outliving its
        // screen — this happened for real, twice).
        var scope = options.scope;

        // A click made while its season's lazy fetch was still in flight — replayed by the watcher
        // below once seasonLoads[season] settles. The LAST such click wins (a newer pick made while
        // still waiting overwrites an earlier one — replaying the first would ignore it). Not domain
        // state: it's an internal retry intent, not renderable UI (same reasoning as pendingSelection
        // just below).
        var pendingClick = null; // { season, episode, pickerOnly }

        // Pending click while the whole-work pool is still loading: replay it once ready.
        var pendingSelection = null;
        var pendingRetryTimer = null;

        // ---------- reactive watcher: replaces the old callback-threading pattern ----------
        //
        // ensureSeasonLoaded (episodes-interactor.js) is fire-and-forget now — it only ever writes
        // seasonLoads[season]/pool to the store, it has no idea pickers or pending clicks exist.
        // This is the ONE place that reacts to that write to decide what UI-facing thing, if any,
        // needs to happen next — subscribing to state changes, not being threaded a "call me back"
        // callback. This directly closes the bug class documented in CLAUDE.md (two separate
        // `RangeError: Maximum call stack size exceeded` crashes, both from a caller's retry-via-
        // callback assumption that "the callback fired" always means "something changed" — an
        // assumption that broke whenever ensureSeasonLoaded's own early-bail branches fired the
        // callback with nothing having changed). A task that only ever writes state, plus a watcher
        // that only ever reacts to state, cannot recurse into itself — there is no callback chain
        // left to loop. Cheap to run on every state change (a TV remote UI, a few transitions a
        // minute at most — see store.js's own header comment) since both checks below are a handful
        // of property reads, `ensureSeasonLoaded` itself is idempotent, and this only matters at all
        // while a picker is open or a click is pending.
        scope.subscribe(store, function () {
            if (isDestroyed()) return;
            var state = store.get();
            // Picker open with nothing to show for its episode yet — make sure that season's lazy
            // fetch is running. Safe to call unconditionally: ensureSeasonLoaded no-ops once it's
            // already loading or settled.
            if (state.picker.open && hasSeasons && !state.customQuery && ensureSeasonLoaded &&
                (state.poolStatus === 'ready' || state.poolStatus === 'error')) {
                var pickerCandidates = selectCandidatesForEpisode(object, state, state.picker.episode);
                if (!pickerCandidates.length) ensureSeasonLoaded(state.season);
            }
            // A click made while its season was still loading — replay it now that it settled.
            // Dropped (not replayed) if the user has since switched to a different season, same as
            // the old pendingEpisode's own season check.
            if (pendingClick && state.seasonLoads &&
                (state.seasonLoads[pendingClick.season] === 'ready' || state.seasonLoads[pendingClick.season] === 'error')) {
                var pending = pendingClick;
                pendingClick = null;
                if (state.season === pending.season) selectEpisode(pending.episode, pending.pickerOnly);
            }
        });

        function schedulePendingRetry() {
            if (pendingRetryTimer) clearTimeout(pendingRetryTimer);
            pendingRetryTimer = scope.setTimeout(function () {
                var state = store.get();
                if (pendingSelection && (state.poolStatus === 'ready' || state.poolStatus === 'error')) {
                    var pending = pendingSelection;
                    pendingSelection = null;
                    // startMovie() and showMoviePool() are different selection policies (startMovie
                    // only auto-plays a persisted default, never on confidence alone; showMoviePool
                    // can auto-play via finishSelection's normal confidence check unless pickerOnly
                    // forces the list) — 'pickerOnly' in pending distinguishes which one this deferred
                    // intent actually came from, so replaying it doesn't silently switch policy.
                    if (pending.movie && 'pickerOnly' in pending) showMoviePool(pending.pickerOnly);
                    else if (pending.movie) startMovie();
                    else selectEpisode(pending.episode, pending.pickerOnly);
                } else if (pendingSelection) {
                    schedulePendingRetry();
                }
            }, 400);
        }

        // `pickerOnly` means "present the candidate list, do NOT auto-play the top match". Only the
        // movie/customQuery flows still use it; a series click now plays immediately (see below).
        function finishSelection(candidates, target, pickerOnly) {
            var best = candidates[0];
            var next = candidates[1];
            if (!pickerOnly && isConfidentMatch(best, next)) {
                startDownload(best, target);
                return;
            }
            var state = store.get();
            store.patch({
                stage: 'candidates',
                candidates: { items: candidates.slice(0, 15), target: target, canReturnToEpisodeList: hasSeasons && !!state.episodesCache }
            });
        }

        // Saved per-season default torrent, keyed movie.id → season. Only set by an explicit pick
        // — a plain Enter on a candidate row (playCandidate) or a pick from the side picker
        // (playPickerCandidate) — NEVER by an auto-play (the user asked for it to be "remembered").
        // Deliberately season-wide, not per-episode: confirmed directly by the user ("Запоминать
        // выбор на весь сезон - хорошая практика") after a brief detour into a per-episode design —
        // a season pack is one torrent for the whole season, and remembering it once should cover
        // every episode, not need re-picking per episode. "As long as it still exists":
        // findSavedDefault (results-core.js) only returns a saved pick that's still present in the
        // CURRENT candidates list, so a torrent that drops out of search results naturally stops
        // being auto-played/marked without any extra expiry logic here.
        function readSeasonDefault(movie, season) {
            try {
                var all = Lampa.Storage.cache(DEFAULT_KEY, PER_MOVIE_CACHE_MAX, {});
                var byMovie = all && all[movie.id];
                return (byMovie && byMovie[season]) || null;
            } catch (e) { return null; }
        }

        function saveSeasonDefault(movie, season, item) {
            try {
                var all = Lampa.Storage.cache(DEFAULT_KEY, PER_MOVIE_CACHE_MAX, {});
                all = all || {};
                all[movie.id] = all[movie.id] || {};
                all[movie.id][season] = { id: candidateIdentity(item), title: item.title, size: item.size, savedAt: Date.now() };
                Lampa.Storage.set(DEFAULT_KEY, all);
            } catch (e) {}
        }

        // Public read-only accessor for the view — it needs the saved default to show the picker's
        // initial cursor on the right row and to make the main episode list's badges reflect what a
        // click would actually play, not just the top-ranked candidate (both this module's own
        // domain state, `results-core.js`/`results-selectors.js` stay Lampa-agnostic on purpose).
        function getSeasonDefault(season) {
            return readSeasonDefault(object.movie, season);
        }

        // Remember where the user was (season + episode) so the screen can restore focus there on
        // reopen — the season half already lives in torrent_mod_last_season (filters-interactor);
        // this is the episode half, written together with the season it belonged to.
        function saveLastEpisode(movie, season, episode) {
            try {
                var all = Lampa.Storage.cache(LAST_EPISODE_KEY, PER_MOVIE_CACHE_MAX, {});
                all = all || {};
                all[movie.id] = { season: season, episode: episode };
                Lampa.Storage.set(LAST_EPISODE_KEY, all);
            } catch (e) {}
        }

        function getSavedEpisode(movie) {
            try {
                var all = Lampa.Storage.cache(LAST_EPISODE_KEY, PER_MOVIE_CACHE_MAX, {});
                return (all && all[movie.id]) || null;
            } catch (e) { return null; }
        }

        // Shared by startMovie/showMoviePool's zero-candidates branch: a genuinely FAILED
        // whole-work search (Jackett 502/timeout) used to show the exact same "Раздач не нашлось"
        // as a search that ran cleanly and found nothing — reported directly by the user testing
        // this live. When it's the pool that actually failed (not just empty), offer a real retry
        // via requery() (the same re-fetch searchWithQuery already uses) instead of a dead end.
        // The attempt suffix ("попытка N") uses state.poolAttempt — requery's own isRetry=true bumps
        // it, so pressing "Повторить" repeatedly climbs the counter visibly (product decision,
        // search-progress-widget consilium: a display-only counter, no gating role — poolGeneration
        // alone still protects against a stale response, see requery's own comment).
        function emptyPoolMessage(onRetryComplete) {
            var state = store.get();
            if (state.poolStatus === 'error') {
                var attempt = state.poolAttempt || 1;
                return {
                    text: 'Не удалось получить раздачи — Jackett не ответил' + (attempt > 1 ? ' (попытка ' + attempt + ')' : ''),
                    retry: requery ? function () { requery(onRetryComplete, true); } : null
                };
            }
            return { text: 'Раздач не нашлось', retry: null };
        }

        // MOVIE flow — a movie's primary content IS its torrents (no episode list). On entry:
        // auto-play ONLY a previously picked (persisted season-0 default) torrent if it's still a
        // valid candidate; otherwise show the torrent list so the user can actually pick one (the
        // old unconditional auto-play made it impossible to choose on first entry — found by the
        // architect). Reuses the same candidates/persistence/picker primitives as the series flow.
        function startMovie() {
            log('selection', 'startMovie()');
            var state = store.get();
            if (state.poolStatus === 'loading' || state.poolStatus === 'idle') {
                pendingSelection = { season: 0, episode: 0, movie: true };
                notify('Раздачи ещё загружаются…');
                schedulePendingRetry();
                return;
            }
            var target = buildMovieTarget();
            var candidates = selectCandidatesForEpisode(object, state, 0, MODE_MOVIE);
            if (!candidates.length) {
                log('selection', 'startMovie: подходящих раздач не найдено в пуле' + (state.poolStatus === 'error' ? ' (ошибка поиска)' : ''));
                store.patch({ stage: 'message', message: emptyPoolMessage(function () { startMovie(); }) });
                return;
            }
            var saved = readSeasonDefault(object.movie, 0);
            var chosen = findSavedDefault(candidates, saved);
            if (chosen) {
                log('selection', 'startMovie: автозапуск сохранённого дефолта — ' + chosen.title);
                startDownload(chosen, target);
                return;
            }
            log('selection', 'startMovie: показываю список торрентов (' + candidates.length + ' кандидатов), дефолта нет');
            store.patch({ stage: 'candidates', candidates: { items: candidates.slice(0, 15), target: target, canReturnToEpisodeList: false } });
        }

        function buildMovieTarget() {
            var state = store.get();
            return {
                movie: object.movie,
                mode: MODE_MOVIE,
                season: 0,
                episode: 0,
                seasonEpisodeCount: 0,
                avgRuntimeMinutes: state.avgRuntimeMinutes,
                customQuery: state.customQuery
            };
        }

        // Shows the movie candidate list straight from the already-fetched whole-work pool — no
        // network call. Shared by selectEpisode's non-customQuery movie branch and by
        // searchWithQuery's post-requery callback, which used to call selectEpisode(0, true) instead:
        // since customQuery was already set by then, that re-entered selectEpisode's customQuery
        // branch and fired a second, identical freshSearch on top of the requery() that just ran —
        // every manual-name movie search cost two full Jackett round trips for the same query
        // (found in review).
        function showMoviePool(pickerOnly) {
            var state = store.get();
            if (state.poolStatus === 'loading' || state.poolStatus === 'idle') {
                // startMovie() (above) already schedules a retry for this exact condition and
                // message; this call site didn't, silently leaving the screen stuck if the pool
                // hadn't finished loading yet when a manual name search landed here (found during the
                // generation-guard migration — the two functions handle the same precondition
                // differently for no principled reason).
                pendingSelection = { season: 0, episode: 0, movie: true, pickerOnly: pickerOnly };
                notify('Раздачи ещё загружаются…');
                schedulePendingRetry();
                return;
            }
            var target = buildMovieTarget();
            var candidates = selectCandidatesForEpisode(object, state, 0, MODE_MOVIE);
            if (!candidates.length) {
                store.patch({ stage: 'message', message: emptyPoolMessage(function () { showMoviePool(pickerOnly); }) });
                return;
            }
            log('selection', 'showMoviePool: ' + candidates.length + ' кандидатов, pickerOnly=' + !!pickerOnly);
            finishSelection(candidates, target, pickerOnly);
        }

        function selectEpisode(episode, pickerOnly) {
            log('selection', 'selectEpisode(' + episode + '), pickerOnly=' + !!pickerOnly);
            var state = store.get();
            var target = {
                movie: object.movie,
                mode: hasSeasons ? MODE_SERIES : MODE_MOVIE,
                season: state.season,
                episode: episode,
                seasonEpisodeCount: state.seasonEpisodeCount,
                avgRuntimeMinutes: state.avgRuntimeMinutes,
                customQuery: state.customQuery
            };
            store.patch({
                lastEpisode: episode,
                searchText: state.customQuery || searchQueryText(target)
            });
            saveLastEpisode(object.movie, state.season, episode);

            // Explicit manual query — the ONLY network search left.
            if (state.customQuery) { freshSearch(target, pickerOnly); return; }

            // Movie: no episode list; keep the old auto-play-or-full-candidates behaviour.
            if (!hasSeasons) { showMoviePool(pickerOnly); return; }

            // Series click = PLAY NOW: the saved season default if it's still a valid candidate,
            // otherwise the top-ranked one. No full-screen candidate list anymore.
            if (state.poolStatus === 'loading' || state.poolStatus === 'idle') {
                pendingSelection = { season: state.season, episode: episode, pickerOnly: pickerOnly };
                notify('Раздачи ещё загружаются…');
                schedulePendingRetry();
                return;
            }
            var candidates = selectCandidatesForEpisode(object, state, episode);
            if (candidates.length) {
                var saved = readSeasonDefault(object.movie, state.season);
                var savedMatch = findSavedDefault(candidates, saved);
                var chosen = savedMatch || candidates[0];
                // `chosen === saved` never worked here (found while chasing the persistence bug
                // below) — `chosen` is a pool candidate, `saved` the persisted {id,title,size}
                // record itself, always a different object even on a genuine match; the label was
                // silently always "лучший по рейтингу" regardless of which one actually launched.
                log('selection', 'selectEpisode(' + episode + '): запуск — ' + chosen.title + (savedMatch ? ' (сохранённый дефолт)' : ' (лучший по рейтингу)'));
                startDownload(chosen, target);
                return;
            }
            // Zero candidates. A season already settled with nothing for it → dead end.
            var loadStatus = state.seasonLoads && state.seasonLoads[state.season];
            if (loadStatus === 'ready' || loadStatus === 'error') { notify('Раздач не нашлось'); return; }
            // Not yet settled (undefined, or already 'loading' from an earlier click/picker open) —
            // make sure the lazy fetch is running (ensureSeasonLoaded is idempotent, safe to call
            // either way) and remember to replay this click once it does; the reactive watcher above
            // does the replay, not a callback threaded through ensureSeasonLoaded itself.
            log('selection', 'selectEpisode(' + episode + '): раздач в пуле нет для сезона ' + state.season + ', жду дозагрузки');
            pendingClick = { season: state.season, episode: episode, pickerOnly: pickerOnly };
            notify('Ищем раздачи для сезона…');
            if (ensureSeasonLoaded) ensureSeasonLoaded(state.season);
        }

        // The episode currently under focus — dispatched by the view on row focus. This is the
        // reactive source of truth for "where the user is": the picker opens for it, and the picker
        // close restores the cursor to it (no view-closure bookkeeping). Persisted for reopen.
        function setActiveEpisode(episode) {
            var state = store.get();
            if (!episode || episode === state.activeEpisode) return;
            store.patch({ activeEpisode: episode });
            saveLastEpisode(object.movie, state.season, episode);
        }

        // Side picker panel: right-arrow on an episode row shows the candidate list for THAT episode
        // in a slide-in panel. The episode normally comes from reactive state (activeEpisode, set by
        // the row's hover:focus before the picker opens); an explicit `episode` argument is used by
        // the deferred path (panel requested while the pool was still loading). Its actual content
        // (items/status/target/selectedId) is NOT computed here — selectPickerData
        // (results-selectors.js) derives it fresh from state.pool/seasonLoads on every render, the
        // same way selectEpisodeBadges already does for the row badges. This function's only job is
        // recording the UI intent (open, for which episode); the watcher above independently makes
        // sure that episode's season actually gets loaded if needed.
        function openPicker(episode) {
            var state = store.get();
            if (episode === undefined) episode = state.activeEpisode || state.lastEpisode || 0;
            log('selection', 'openPicker(' + episode + ')');
            store.patch({ picker: { open: true, episode: episode } });
        }

        function playPickerCandidate(item, target) {
            log('selection', 'playPickerCandidate: ' + item.title + ' (эпизод ' + target.episode + ', сезон ' + target.season + ')');
            saveSeasonDefault(object.movie, target.season, item);
            store.patch({ picker: { open: false, episode: 0 } });
            startDownload(item, target);
        }

        function closePicker() {
            log('selection', 'closePicker()');
            store.patch({ picker: { open: false, episode: 0 } });
        }

        function freshSearch(target, pickerOnly) {
            var generation = store.get().searchGeneration + 1;
            log('selection', 'freshSearch: "' + (target.customQuery || '') + '", сезон=' + target.season + ', эпизод=' + target.episode + ', generation=' + generation);
            store.patch({
                searchGeneration: generation,
                searchStatus: 'loading',
                statusText: 'Ищем по названию…'
            });

            var search = target.mode === MODE_MOVIE ? searchMovieTorrents : searchSeriesTorrents;
            // The generation check alone is not enough here: setSeason() bumps only seasonGeneration
            // (freshSearch's own searchGeneration stays put), so a late response also has to be
            // re-checked against the season/query it was actually made for — otherwise a late
            // season-2 search response could surface candidates for season 2 on a screen now showing
            // season 3 (found in review). isStillValid carries exactly that extra check.
            var stillTargeted = function (state) { return state.season === target.season && state.customQuery === target.customQuery; };
            search(target).then(function (response) {
                // Screen closed, or a newer selectEpisode()/season switch has since taken over —
                // don't paint a stale result (or a misleading "Jackett недоступен" toast caused by
                // this exact request being the one cancelSearch() just cancelled on destroy, not by
                // an actual Jackett problem) over whatever the user is looking at now.
                if (!isCurrentGeneration(store, 'searchGeneration', generation, isDestroyed, stillTargeted)) {
                    log('selection', 'freshSearch отброшен как устаревший, generation=' + generation);
                    return;
                }
                if (response.failed) {
                    // Was a bare notify() toast that just faded away — now the same retryable-message
                    // pattern loadEpisodes' TMDB failure already uses (results-state.js's
                    // message.retry), so two failures that are the same thing to the user ("couldn't
                    // load data, try again") get the same UX instead of one having a real "Повторить"
                    // affordance and the other just a disappearing toast (found in review).
                    warn('selection', 'freshSearch: поиск не удался (Jackett недоступен)');
                    store.patch({
                        searchStatus: 'error', stage: 'message',
                        message: { text: 'Jackett недоступен или не ответил', retry: function () { freshSearch(target, pickerOnly); } }
                    });
                    return;
                }
                var pool = applyStateFilters(response.results, store.get());
                if (!pool.length) {
                    log('selection', 'freshSearch: пул пуст после фильтров');
                    notify('Ничего не найдено');
                    store.patch({ searchStatus: 'idle', statusText: '' });
                    return;
                }

                // matchScore is a hard gate here, not a ranking input (see scoreCandidate): wrong
                // title/season/episode candidates are dropped entirely, never just ranked lower.
                pool.forEach(function (item) { item._score = scoreCandidate(item, target); });
                if (enabled('torrent_mod_debug', false)) debugLogCandidates(pool, target);
                var candidates = pool.filter(function (item) { return item._score.passes; });
                candidates.sort(function (a, b) { return b._score.value - a._score.value || b.seeders - a.seeders; });
                store.patch({ searchStatus: 'ready', statusText: '' });
                if (!candidates.length) { log('selection', 'freshSearch: похожих раздач не нашлось (гейт отсеял все)'); notify('Похожих раздач не нашлось'); return; }

                log('selection', 'freshSearch успех: ' + candidates.length + ' кандидатов прошли гейт');
                finishSelection(candidates, target, pickerOnly);
            });
        }

        // A manual name override (customQuery) is persistent *query context* — the plugin was
        // launched from an already-found TMDB card, so re-wording the name means "keep this screen,
        // re-fetch the torrent data for this same work under a better-matched name", like Online
        // Mod re-fetching its balancer for a re-worded query instead of leaving the screen.
        // It is NOT a request to switch to a different movie (we'd have no TMDB data for that), and
        // it is NOT a request to start playback of the top match right now.
        function searchWithQuery(value) {
            if (!value) return;
            log('selection', 'searchWithQuery: "' + value + '"');
            // Bump searchGeneration: any in-flight freshSearch (e.g. an episode click made while a
            // customQuery was already active) belongs to the previous query context and must be
            // discarded, not painted over the new one (found in review).
            var current = store.get();
            store.patch({ customQuery: value, searchText: value, searchGeneration: current.searchGeneration + 1, searchStatus: 'idle' });
            if (hasSeasons) {
                // Stay on the episode list (it's TMDB data, independent of the query) and just
                // re-fetch the whole-work pool under the new name — the row badges then reflect it.
                var state = store.get();
                if (state.episodesCache) store.patch({ stage: 'episodes', statusText: '', searchStatus: 'idle' });
                if (requery) requery();
            } else {
                // Movie: no episode list, the candidate list IS the primary content — re-fetch the
                // pool under the new name, then show the local candidate pick (picker-only: no
                // auto-play while the user is actively searching). showMoviePool reads the pool
                // requery() just populated directly — it must NOT go through selectEpisode, whose
                // customQuery branch would fire a second, identical network search on top of it.
                if (requery) requery(function () { showMoviePool(true); });
            }
        }

        function playCandidate(item, target) {
            // Picking a torrent from a list is an explicit user choice — persist it as the default
            // for this season (0 for movies), so the next entry auto-plays it (found by the architect:
            // movie picks from the full list were never remembered before).
            log('selection', 'playCandidate: ' + item.title + ' (сезон ' + (target.season || 0) + ')');
            saveSeasonDefault(object.movie, target.season || 0, item);
            startDownload(item, target);
        }

        return {
            startMovie: startMovie,
            selectEpisode: selectEpisode,
            searchWithQuery: searchWithQuery,
            playCandidate: playCandidate,
            setActiveEpisode: setActiveEpisode,
            openPicker: openPicker,
            closePicker: closePicker,
            playPickerCandidate: playPickerCandidate,
            getSavedEpisode: getSavedEpisode,
            getSeasonDefault: getSeasonDefault
        };
    }
