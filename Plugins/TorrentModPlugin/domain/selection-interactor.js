    // ---------- domain: selection interactor ----------
    //
    // selectEpisode/searchWithQuery/playCandidate grouped together: all terminate in either
    // finishSelection (candidate list or auto-play) or a direct startDownload; all populate
    // candidates/stage/searchGeneration. searchWithQuery is the manual name-override path — it
    // re-fetches data under the new name instead of starting playback, see its own comment below.
    import { searchTorrentMod } from '../search/search-backend.js';
    import { applyStateFilters, scoreCandidate } from '../search/scoring.js';
    import { startDownload } from '../playback/smart-preload.js';
    import { enabled, notify, debugLogCandidates, pad } from '../shared/utils.js';
    import { searchQueryText, isConfidentMatch } from './results-core.js';
    import { selectCandidatesForEpisode } from './results-selectors.js';

    export function createSelectionInteractor(options) {
        var store = options.store;
        var object = options.object;
        var movie = options.movie;
        var hasSeasons = options.hasSeasons;
        var isDestroyed = options.isDestroyed;
        var requery = options.requery;

        // `pickerOnly` means "present the candidate list, do NOT auto-play the top match". Used for
        // a manual name override on a movie (user re-worded the search, wants to see what's there —
        // like Online Mod re-fetching its balancer's data for a new query instead of starting
        // playback). Ordinary episode/movie picks keep auto-play.
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
            var hadCustomQuery = !!state.customQuery;
            store.patch({
                lastEpisode: episode,
                searchText: state.customQuery || searchQueryText(target)
            });

            // The season-wide background search (kicked off when the episode list loaded, see
            // episodes-interactor.js) already covers exactly this query shape for anything without
            // an explicit episode tag — reuse it instead of a fresh multi-second Jackett round trip
            // when it already has a gate-passing match for this episode. Skipped for a custom query
            // (an explicit override always gets its own fresh search) or when the pool has nothing
            // usable for this specific episode — a targeted SxxExx query can surface single-episode
            // torrents the season-level query terms missed, so falling through to a real search here
            // is a recall safety net, not just a loading-state fallback.
            var reused = !hadCustomQuery && state.seasonPool ? selectCandidatesForEpisode(object, state, episode) : [];
            if (reused.length) { finishSelection(reused, target, pickerOnly); return; }

            var generation = store.get().searchGeneration + 1;
            store.patch({
                searchGeneration: generation,
                searchStatus: 'loading',
                statusText: target.customQuery ? 'Ищем по названию…' : ('Ищем' + (episode ? ' S' + pad(state.season) + 'E' + pad(episode) : '') + '…')
            });

            searchTorrentMod(target).then(function (response) {
                // Screen closed, or a newer selectEpisode()/season switch has since taken over —
                // don't paint a stale result (or a misleading "Jackett недоступен" toast caused by
                // this exact request being the one cancelSearch() just cancelled on destroy, not by
                // an actual Jackett problem) over whatever the user is looking at now.
                if (isDestroyed() || store.get().searchGeneration !== generation) return;
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
        // re-fetch the torrent data for this same season/episode under a better-matched name", like
        // Online Mod re-fetching its balancer for a re-worded query instead of leaving the screen.
        // It is NOT a request to switch to a different movie (we'd have no TMDB data for that), and
        // it is NOT a request to start playback of the top match right now.
        function searchWithQuery(value) {
            if (!value) return;
            store.patch({ customQuery: value, searchText: value });
            if (hasSeasons) {
                // Stay on the episode list (it's TMDB data, independent of the query) and just
                // re-fetch the torrent pool under the new name — the row badges then reflect it.
                var state = store.get();
                if (state.episodesCache) store.patch({ stage: 'episodes', statusText: '', searchStatus: 'idle' });
                if (requery) requery();
            } else {
                // Movie: no episode list, the candidate list IS the primary content — re-fetch it
                // under the new name, picker-only (no auto-play while the user is actively searching).
                selectEpisode(0, true);
            }
        }

        function playCandidate(item, target) {
            startDownload(item, target);
        }

        return {
            selectEpisode: selectEpisode,
            searchWithQuery: searchWithQuery,
            playCandidate: playCandidate
        };
    }
