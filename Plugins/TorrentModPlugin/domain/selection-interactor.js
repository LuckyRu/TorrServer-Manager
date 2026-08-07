    // ---------- domain: selection interactor ----------
    //
    // selectEpisode/searchWithQuery/playCandidate grouped together: all terminate in either
    // finishSelection (candidate list or auto-play) or a direct startDownload; all populate
    // candidates/stage/searchGeneration. searchWithQuery is the manual name-override path — it
    // re-fetches data under the new name instead of starting playback, see its own comment below.
    import { searchTorrentMod } from '../search/search-backend.js';
    import { applyStateFilters, scoreCandidate } from '../search/scoring.js';
    import { startDownload } from '../playback/smart-preload.js';
    import { enabled, notify, debugLogCandidates } from '../shared/utils.js';
    import { searchQueryText, isConfidentMatch, candidateIdentity, findSavedDefault } from './results-core.js';
    import { selectCandidatesForEpisode } from './results-selectors.js';

    var DEFAULT_KEY = 'torrent_mod_default_torrent';
    var PER_MOVIE_CACHE_MAX = 200;

    export function createSelectionInteractor(options) {
        var store = options.store;
        var object = options.object;
        var hasSeasons = options.hasSeasons;
        var isDestroyed = options.isDestroyed;
        var requery = options.requery;
        var ensureSeasonLoaded = options.ensureSeasonLoaded;

        // The LAST episode the user picked while a season fetch was in flight ('loading'). The
        // fetch's own onComplete only knows the FIRST pick; replaying that one would ignore a
        // newer pick made during loading (found in review). Reset once replayed.
        var pendingEpisode = null;

        // Pending click while the whole-work pool is still loading: replay it once ready.
        var pendingSelection = null;
        var pendingRetryTimer = null;

        function schedulePendingRetry() {
            if (pendingRetryTimer) clearTimeout(pendingRetryTimer);
            pendingRetryTimer = setTimeout(function () {
                if (isDestroyed()) { pendingSelection = null; return; }
                var state = store.get();
                if (pendingSelection && (state.poolStatus === 'ready' || state.poolStatus === 'error')) {
                    var pending = pendingSelection;
                    pendingSelection = null;
                    if (pending.picker) openPicker(pending.episode);
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

        // Saved per-season default torrent, keyed movie.id → season. Only set by an explicit pick in
        // the side picker — NOT by an auto-click (the user asked for it to be "remembered").
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

        function selectEpisode(episode, pickerOnly) {
            var state = store.get();
            var target = {
                movie: object.movie,
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

            // Explicit manual query — the ONLY network search left.
            if (state.customQuery) { freshSearch(target, pickerOnly); return; }

            // Movie: no episode list; keep the old auto-play-or-full-candidates behaviour.
            if (!hasSeasons) {
                if (state.poolStatus === 'loading' || state.poolStatus === 'idle') { notify('Раздачи ещё загружаются…'); return; }
                var movieCandidates = selectCandidatesForEpisode(object, state, 0);
                if (movieCandidates.length) { finishSelection(movieCandidates, target, pickerOnly); return; }
                store.patch({ stage: 'message', message: { text: 'Раздач не нашлось' } });
                return;
            }

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
                var chosen = findSavedDefault(candidates, saved) || candidates[0];
                startDownload(chosen, target);
                return;
            }
            // Zero candidates → lazy season fetch → retry the click.
            var loadStatus = state.seasonLoads && state.seasonLoads[state.season];
            if (loadStatus === 'loading') {
                pendingEpisode = { season: state.season, episode: episode, pickerOnly: pickerOnly };
                notify('Ищем раздачи для сезона…');
                return;
            }
            if (loadStatus === 'ready' || loadStatus === 'error') { notify('Раздач не нашлось'); return; }
            if (ensureSeasonLoaded) {
                ensureSeasonLoaded(state.season, function () {
                    var current = store.get();
                    var pending = pendingEpisode;
                    pendingEpisode = null;
                    if (current.season !== state.season) return;
                    var pick = pending || { episode: episode, pickerOnly: pickerOnly };
                    selectEpisode(pick.episode, pick.pickerOnly);
                });
            } else {
                notify('Раздач не нашлось');
            }
        }

        // Side picker panel: right-arrow on an episode row shows the candidate list for THAT episode
        // in a slide-in panel. Builds candidates (same local pipeline as the click) into state.picker.
        function openPicker(episode) {
            var state = store.get();
            var target = {
                movie: object.movie,
                season: state.season,
                episode: episode,
                seasonEpisodeCount: state.seasonEpisodeCount,
                avgRuntimeMinutes: state.avgRuntimeMinutes
            };
            store.patch({ picker: { open: true, episode: episode, items: [], target: target, status: 'loading' } });
            if (state.poolStatus === 'loading' || state.poolStatus === 'idle') {
                // Pool not ready yet — replay the picker once it is.
                pendingSelection = { season: state.season, episode: episode, picker: true };
                schedulePendingRetry();
                return;
            }
            fillPicker(episode);
        }

        function fillPicker(episode) {
            var state = store.get();
            var candidates = selectCandidatesForEpisode(object, state, episode);
            if (candidates.length) {
                store.patch({ picker: { open: true, episode: episode, items: candidates, target: buildPickerTarget(episode), status: 'ready' } });
                return;
            }
            var loadStatus = state.seasonLoads && state.seasonLoads[state.season];
            if (loadStatus === 'ready' || loadStatus === 'error') {
                store.patch({ picker: { open: true, episode: episode, items: [], target: null, status: 'error' } });
                return;
            }
            if (ensureSeasonLoaded) {
                ensureSeasonLoaded(state.season, function () { fillPicker(episode); });
            } else {
                store.patch({ picker: { open: true, episode: episode, items: [], target: null, status: 'error' } });
            }
        }

        function buildPickerTarget(episode) {
            var state = store.get();
            return {
                movie: object.movie,
                season: state.season,
                episode: episode,
                seasonEpisodeCount: state.seasonEpisodeCount,
                avgRuntimeMinutes: state.avgRuntimeMinutes
            };
        }

        function playPickerCandidate(item, target) {
            saveSeasonDefault(object.movie, target.season, item);
            store.patch({ picker: { open: false, episode: target.episode, items: [], target: null, status: 'idle' } });
            startDownload(item, target);
        }

        function closePicker() {
            var state = store.get();
            store.patch({ picker: { open: false, episode: 0, items: [], target: null, status: 'idle' } });
        }

        function freshSearch(target, pickerOnly) {
            var generation = store.get().searchGeneration + 1;
            store.patch({
                searchGeneration: generation,
                searchStatus: 'loading',
                statusText: 'Ищем по названию…'
            });

            searchTorrentMod(target).then(function (response) {
                // Screen closed, or a newer selectEpisode()/season switch has since taken over —
                // don't paint a stale result (or a misleading "Jackett недоступен" toast caused by
                // this exact request being the one cancelSearch() just cancelled on destroy, not by
                // an actual Jackett problem) over whatever the user is looking at now. The generation
                // check alone is not enough: setSeason() bumps only seasonGeneration (the search's
                // own generation stays put), so also re-check that the season/query this request was
                // made for are still the current ones — otherwise a late season-2 search response
                // could surface candidates for season 2 on a screen now showing season 3 (found in
                // review).
                if (isDestroyed() || store.get().searchGeneration !== generation) return;
                var current = store.get();
                if (current.season !== target.season || current.customQuery !== target.customQuery) return;
                if (response.failed) {
                    notify('Jackett недоступен или не ответил');
                    store.patch({ searchStatus: 'idle', statusText: '' });
                    return;
                }
                var pool = applyStateFilters(response.results, store.get());
                if (!pool.length) {
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
                if (!candidates.length) { notify('Похожих раздач не нашлось'); return; }

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
                // auto-play while the user is actively searching).
                if (requery) requery(function () { selectEpisode(0, true); });
            }
        }

        function playCandidate(item, target) {
            startDownload(item, target);
        }

        return {
            selectEpisode: selectEpisode,
            searchWithQuery: searchWithQuery,
            playCandidate: playCandidate,
            openPicker: openPicker,
            closePicker: closePicker,
            playPickerCandidate: playPickerCandidate
        };
    }
