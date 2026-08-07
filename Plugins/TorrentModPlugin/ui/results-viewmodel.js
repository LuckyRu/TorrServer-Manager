    // ---------- results screen: viewmodel ----------
    //
    // Owns the mutable screen state and orchestrates results-core.js's pure functions plus the
    // search/metadata/playback data-layer modules. Talks to the view only through the small `view`
    // port passed in at construction — no $/DOM/Lampa.Explorer/Filter/Controller/Scroll references
    // here at all. Lampa itself has no reactivity of any kind (confirmed against its real source,
    // see docs/reference/lampa-plugin-api.md) — there's no way to "subscribe" to a state change, so
    // this binding is entirely our own convention: synchronous actions let the caller (the view's
    // own event handler) pull fresh data right after calling a mutator; async completions (a TMDB
    // or Jackett fetch resolving with nobody synchronously waiting) push through the `view` port
    // instead, at exactly the point the pre-split code updated the DOM directly.
    import { fetchSeason, episodeCounts } from '../metadata/tmdb.js';
    import { searchTorrentMod } from '../search/search-backend.js';
    import { applyStateFilters, scoreCandidate } from '../search/scoring.js';
    import { startDownload } from '../playback/smart-preload.js';
    import { enabled, notify, debugLogCandidates, pad } from '../shared/utils.js';
    import {
        createInitialState,
        searchQueryText,
        candidatesForEpisode,
        badgeText,
        isConfidentMatch,
        currentSeasonLabel,
        activeFilterLabels,
        buildFilterItems
    } from './results-core.js';

    // Two-tier persistence, same shape Online Mod uses for its own balancer choice
    // (Storage.get('online_balanser', ...) + Storage.cache('online_last_balanser', 200, {}),
    // confirmed live in vendor/lampa-source/plugins/online/component.js): a global default plus a
    // per-movie override cache that takes priority when present. Storage.cache(name, max, empty)
    // only *reads* (and prunes down to `max` entries if over) — confirmed against the real source,
    // core/storage/storage.js — it does not auto-persist further mutations, so every write below
    // still needs its own explicit Storage.set() call, same as Online Mod's own read-mutate-set
    // sequence. Season has no sensible *global* default (season numbers don't transfer between
    // shows) so it only gets the per-movie tier, layered on top of the existing initialSeason()
    // continue-watching guess (season-picker.js) as a fallback, not a replacement for it.
    var SEASON_CACHE_KEY = 'torrent_mod_last_season';
    var VOICE_DEFAULT_KEY = 'torrent_mod_voice';
    var VOICE_CACHE_KEY = 'torrent_mod_last_voice';
    var QUALITY_DEFAULT_KEY = 'torrent_mod_quality';
    var QUALITY_CACHE_KEY = 'torrent_mod_last_quality';
    var PER_MOVIE_CACHE_MAX = 200;

    export function createResultsViewModel(options) {
        var object = options.object;
        var movie = options.movie;
        var hasSeasons = options.hasSeasons;
        var view = options.view;
        var state = createInitialState(object);
        applyPersistedPreferences();

        // Unconditional override, same as Online Mod's own `if (last_bls[movie.id]) balanser =
        // last_bls[movie.id]` — the per-movie memory always wins over both the just-computed
        // initial state and the global default when it exists, not just as a first-run fallback.
        function applyPersistedPreferences() {
            try {
                var lastSeason = Lampa.Storage.cache(SEASON_CACHE_KEY, PER_MOVIE_CACHE_MAX, {});
                if (lastSeason[movie.id]) state.season = lastSeason[movie.id];

                state.voiceType = Lampa.Storage.get(VOICE_DEFAULT_KEY, 'any');
                var lastVoice = Lampa.Storage.cache(VOICE_CACHE_KEY, PER_MOVIE_CACHE_MAX, {});
                if (lastVoice[movie.id]) state.voiceType = lastVoice[movie.id];

                state.resolution = Lampa.Storage.get(QUALITY_DEFAULT_KEY, 'any');
                var lastQuality = Lampa.Storage.cache(QUALITY_CACHE_KEY, PER_MOVIE_CACHE_MAX, {});
                if (lastQuality[movie.id]) state.resolution = lastQuality[movie.id];
            } catch (e) {}
        }

        function rememberSeason(season) {
            try {
                var last = Lampa.Storage.cache(SEASON_CACHE_KEY, PER_MOVIE_CACHE_MAX, {});
                last[movie.id] = season;
                Lampa.Storage.set(SEASON_CACHE_KEY, last);
            } catch (e) {}
        }

        function rememberVoice(value) {
            try {
                Lampa.Storage.set(VOICE_DEFAULT_KEY, value);
                var last = Lampa.Storage.cache(VOICE_CACHE_KEY, PER_MOVIE_CACHE_MAX, {});
                last[movie.id] = value;
                Lampa.Storage.set(VOICE_CACHE_KEY, last);
            } catch (e) {}
        }

        function rememberQuality(value) {
            try {
                Lampa.Storage.set(QUALITY_DEFAULT_KEY, value);
                var last = Lampa.Storage.cache(QUALITY_CACHE_KEY, PER_MOVIE_CACHE_MAX, {});
                last[movie.id] = value;
                Lampa.Storage.set(QUALITY_CACHE_KEY, last);
            } catch (e) {}
        }

        // Same target shape candidatesForEpisode's own pre-split closure used to build itself —
        // kept as one place now that the function takes `target` as an explicit parameter.
        function candidatesFor(pool, number) {
            var target = {
                movie: object.movie,
                season: state.season,
                episode: number,
                seasonEpisodeCount: state.seasonEpisodeCount,
                avgRuntimeMinutes: state.avgRuntimeMinutes
            };
            return candidatesForEpisode(pool, target, state);
        }

        function getFilterChipData() {
            return {
                seasonLabel: currentSeasonLabel(movie, hasSeasons, state),
                activeLabels: activeFilterLabels(state),
                filterItems: buildFilterItems(movie, hasSeasons, state)
            };
        }

        function getFilterItems() {
            return buildFilterItems(movie, hasSeasons, state);
        }

        // Computed from state.episodesCache (what we know exists), not from any DOM map — the view
        // only ever writes into rows it actually has, silently skipping numbers it doesn't (e.g.
        // while a candidate list, not an episode list, is showing). Traced against every call site
        // this replaces (renderEpisodes's own tail call, ensureSeasonPool's `.then()`, all three
        // onSelect branches) — same badge text for the same episode number in every case.
        function getEpisodeBadges() {
            if (!state.seasonPool) return {};
            var map = {};
            (state.episodesCache || []).forEach(function (episode) {
                var number = parseInt(episode.episode_number, 10);
                map[number] = badgeText(candidatesFor(state.seasonPool, number));
            });
            return map;
        }

        // Shared by loadEpisodes and showEpisodeList (the "К списку серий" back action) — both did
        // the identical status-clear → render → badge-push sequence before this was pulled out.
        function showEpisodes(episodes) {
            state.episodesCache = episodes;
            view.setStatus('');
            view.renderEpisodes(episodes, state.season);
            view.updateEpisodeBadges(getEpisodeBadges());
        }

        function loadEpisodes() {
            view.setStatus('Загрузка списка серий…');
            fetchSeason(movie, state.season).catch(function (error) {
                console.warn('Torrent Mod: TMDB season fetch failed', error);
                return [];
            }).then(function (episodes) {
                episodes = episodes || [];
                var runtimes = episodes.map(function (e) { return parseInt(e.runtime, 10) || 0; }).filter(Boolean);
                state.seasonEpisodeCount = episodes.length || (episodeCounts(movie)[state.season] || 0);
                state.avgRuntimeMinutes = runtimes.length ? runtimes.reduce(function (a, b) { return a + b; }, 0) / runtimes.length : 0;

                if (!episodes.length) {
                    var fallbackCount = episodeCounts(movie)[state.season] || 0;
                    for (var i = 1; i <= fallbackCount; i++) episodes.push({ episode_number: i, name: 'Серия ' + i });
                }
                if (!episodes.length) { view.showMessage('Список серий недоступен', loadEpisodes); return; }
                showEpisodes(episodes);
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
        // Jackett round trip when the pool already covers it (see selectEpisode).
        //
        // Pushes only the filter *options* (view.refreshFilterOptions), not a full chip re-sync —
        // the user's already-picked values haven't changed here, only what's available has. Don't
        // "simplify" this to the full syncFilterChips the way onSelect uses; that would also touch
        // the collapsed-chip summary text for no reason and is the easiest way to introduce a subtle
        // regression in this file.
        function ensureSeasonPool() {
            if (!hasSeasons) return Promise.resolve([]);
            if (state.seasonPoolPromise && state.seasonPoolSeason === state.season) return state.seasonPoolPromise;
            state.seasonPoolSeason = state.season;
            state.seasonPool = null;
            var target = {
                movie: object.movie,
                season: state.season,
                episode: 0,
                seasonEpisodeCount: state.seasonEpisodeCount,
                avgRuntimeMinutes: state.avgRuntimeMinutes
            };
            state.seasonPoolPromise = searchTorrentMod(target).then(function (response) {
                if (state.seasonPoolSeason !== state.season) return []; // season changed mid-flight
                state.seasonPool = response.failed ? [] : response.results;
                view.refreshFilterOptions(getFilterItems());
                view.updateEpisodeBadges(getEpisodeBadges());
                return state.seasonPool;
            });
            return state.seasonPoolPromise;
        }

        function finishSelection(candidates, target) {
            var best = candidates[0];
            var next = candidates[1];
            if (isConfidentMatch(best, next)) startDownload(best, target);
            else view.renderCandidateList(candidates.slice(0, 15), target, hasSeasons && !!state.episodesCache);
        }

        function selectEpisode(episode) {
            state.lastEpisode = episode;
            var target = {
                movie: object.movie,
                season: state.season,
                episode: episode,
                seasonEpisodeCount: state.seasonEpisodeCount,
                avgRuntimeMinutes: state.avgRuntimeMinutes,
                customQuery: state.customQuery
            };
            view.setSearchText(state.customQuery || searchQueryText(target));
            var hadCustomQuery = !!state.customQuery;
            state.customQuery = null;

            // The season-wide background search (kicked off when the episode list loaded, see
            // ensureSeasonPool) already covers exactly this query shape for anything without an
            // explicit episode tag — reuse it instead of a fresh multi-second Jackett round trip when
            // it already has a gate-passing match for this episode. Skipped for a custom query (an
            // explicit override always gets its own fresh search) or when the pool has nothing usable
            // for this specific episode — a targeted SxxExx query can surface single-episode torrents
            // the season-level query terms missed, so falling through to a real search here is a
            // recall safety net, not just a loading-state fallback.
            var reused = !hadCustomQuery && state.seasonPool ? candidatesFor(state.seasonPool, episode) : [];
            if (reused.length) { finishSelection(reused, target); return; }

            view.setStatus('Ищем' + (episode ? ' S' + pad(state.season) + 'E' + pad(episode) : '') + '…');
            searchTorrentMod(target).then(function (response) {
                if (response.failed) { notify('Jackett недоступен или не ответил'); view.setStatus(''); return; }
                var pool = applyStateFilters(response.results, state);
                if (!pool.length) { notify('Ничего не найдено'); view.setStatus(''); return; }

                // matchScore is a hard gate here, not a ranking input (see scoreCandidate): wrong
                // title/season/episode candidates are dropped entirely, never just ranked lower.
                pool.forEach(function (item) { item._score = scoreCandidate(item, target); });
                if (enabled('torrent_mod_debug', false)) debugLogCandidates(pool, target);
                var candidates = pool.filter(function (item) { return item._score.passes; });
                candidates.sort(function (a, b) { return b._score.value - a._score.value || b.seeders - a.seeders; });
                view.setStatus('');
                if (!candidates.length) { notify('Похожих раздач не нашлось'); return; }

                finishSelection(candidates, target);
            });
        }

        function searchWithQuery(value) {
            if (!value) return;
            state.customQuery = value;
            selectEpisode(state.lastEpisode || 0);
        }

        // "Reset" is an explicit choice too, same as picking a value — persisting 'any' here is
        // what makes reset actually *stick* next time this movie's screen opens, instead of the
        // per-movie memory silently overriding it right back on the next visit.
        function resetFilters() {
            state.voiceType = 'any';
            state.resolution = 'any';
            rememberVoice('any');
            rememberQuality('any');
        }

        function setVoiceFilter(value) {
            state.voiceType = value;
            rememberVoice(value);
        }

        function setResolutionFilter(value) {
            state.resolution = value;
            rememberQuality(value);
        }

        function setSeason(season) {
            if (season === state.season) return false;
            state.season = season;
            rememberSeason(season);
            return true;
        }

        function playCandidate(item, target) {
            startDownload(item, target);
        }

        function showEpisodeList() {
            showEpisodes(state.episodesCache);
        }

        function start() {
            if (!hasSeasons) { view.setStatus(''); selectEpisode(0); return; }
            loadEpisodes();
        }

        return {
            start: start,
            loadEpisodes: loadEpisodes,
            selectEpisode: selectEpisode,
            searchWithQuery: searchWithQuery,
            resetFilters: resetFilters,
            setSeason: setSeason,
            setVoiceFilter: setVoiceFilter,
            setResolutionFilter: setResolutionFilter,
            playCandidate: playCandidate,
            showEpisodeList: showEpisodeList,
            getFilterChipData: getFilterChipData,
            getFilterItems: getFilterItems,
            getEpisodeBadges: getEpisodeBadges
        };
    }
