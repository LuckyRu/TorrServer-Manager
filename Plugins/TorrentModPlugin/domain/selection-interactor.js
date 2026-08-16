    // ---------- domain: selection interactor ----------
    import { evaluateCandidatePool } from '../search/scoring.js';
    import { startDownload } from '../playback/smart-preload.js';
    import { notify } from '../shared/utils.js';
    import { isConfidentMatch, candidateIdentity, findSavedDefault } from './results-core.js';
    import { selectCandidatesForEpisode } from './results-selectors.js';
    import { MODE_MOVIE, MODE_SERIES } from '../shared/state.js';
    import { log, debug, debugEnabled } from '../shared/core/log.js';

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
        // Shared lifecycle scope — see docs/system-design/torrent-mod-domain-architecture.md.
        var scope = options.scope;

        // Replayed by the watcher once seasonLoads[season] settles; a newer click overwrites an older pending one.
        var pendingClick = null; // { season, episode, pickerOnly }

        // Re-evaluated on every pool growth, not just once poolStatus is ready — a still-loading pool can already have a usable match.
        var pendingSelection = null;
        var replayingPendingSelection = false;

        // Kept alive while the pool grows so a fast tracker's results can render before the whole job settles.
        var moviePresentation = null;

        function logCandidateEvaluation(label, target, evaluation) {
            if (!debugEnabled()) return;
            debug('search', label + ': фильтрация результатов', {
                query: target.englishTitle || target.movie.title || target.movie.name || '',
                season: target.season,
                episode: target.episode,
                input: evaluation.inputCount,
                afterStateFilters: evaluation.afterStateFilters,
                stateFiltered: evaluation.stateFilteredCount,
                matchGateFiltered: evaluation.gateFilteredCount,
                filtered: evaluation.filteredCount,
                candidates: evaluation.items.length,
                ranking: evaluation.items.slice(0, 15).map(function (item, index) {
                    var score = item._score || {};
                    return {
                        rank: index + 1,
                        title: item.title,
                        seeders: item.seeders,
                        leechers: item.leechers !== undefined ? item.leechers : item.peers,
                        payloadMbps: score.payloadMbps ? Math.round(score.payloadMbps * 100) / 100 : null,
                        payloadConfidence: score.payloadConfidence || 'none',
                        payloadCoverageEpisodes: score.payloadCoverageEpisodes || 0,
                        payloadDurationMinutes: score.payloadDurationMinutes || 0,
                        payloadReason: score.payloadReason || '',
                        match: score.matchScore,
                        matchBonus: score.matchConfidenceScore,
                        quality: score.qualityScore,
                        availability: score.availabilityScore,
                        streamingRiskPenalty: score.streamingRiskPenalty,
                        pipelinePenalty: score.pipelinePenalty,
                        value: score.value
                    };
                }),
                stages: evaluation.stages,
                rejectedTitles: evaluation.rejectedTitles
            });
        }

        function sameTuple(left, right) {
            if (left === right) return true;
            if (!left || !right || left.length !== right.length) return false;
            for (var i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
            return true;
        }

        scope.subscribe(store, function (state, previous) {
            if (isDestroyed()) return;
            // ensureSeasonLoaded no-ops once already loading/settled, safe to call unconditionally.
            if (state.picker.open && hasSeasons && ensureSeasonLoaded &&
                (state.poolStatus === 'ready' || state.poolStatus === 'error')) {
                var pickerCandidates = selectCandidatesForEpisode(object, state, state.picker.episode);
                if (!pickerCandidates.length) ensureSeasonLoaded(state.season);
            }
            // Dropped, not replayed, if the user switched season while waiting.
            if (pendingClick && state.seasonLoads &&
                (state.seasonLoads[pendingClick.season] === 'ready' || state.seasonLoads[pendingClick.season] === 'error')) {
                var pending = pendingClick;
                pendingClick = null;
                if (state.season === pending.season) selectEpisode(pending.episode, pending.pickerOnly);
            }

            // Consumed before replay so a nested store.patch stays re-entrancy-safe; selectEpisode re-queues it if still unmatched.
            if (pendingSelection && (state.pool !== previous.pool || state.poolStatus !== previous.poolStatus)) {
                var selection = pendingSelection;
                pendingSelection = null;
                if (state.season === selection.season && state.poolGeneration === selection.poolGeneration) {
                    replayingPendingSelection = true;
                    try { selectEpisode(selection.episode, selection.pickerOnly); }
                    finally { replayingPendingSelection = false; }
                }
            }
        });

        scope.subscribeSelector(store,
            function (state) { return [state.pool, state.poolStatus, state.filters, state.avgRuntimeMinutes]; },
            function () { if (!hasSeasons && moviePresentation) syncMoviePresentation(); },
            sameTuple
        );

        // pickerOnly: show the candidate list without auto-playing the top match.
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
                candidates: { items: candidates.slice(0, 15), target: target, canReturnToEpisodeList: hasSeasons && Array.isArray(state.episodesCache) && state.episodesCache.length > 0 }
            });
        }

        // Season-wide (not per-episode) default, set only by an explicit pick, never by auto-play; expires naturally once the saved item drops out of the current candidate list.
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
                return true;
            } catch (e) { return false; }
        }

        // Read-only accessor so the view can show the picker cursor and episode badges without results-core.js/results-selectors.js touching Lampa.Storage directly.
        function getSeasonDefault(season) {
            return readSeasonDefault(object.movie, season);
        }

        // Episode half of focus-restore-on-reopen; the season half lives in torrent_mod_last_season (filters-interactor.js).
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

        // Distinguishes a genuinely failed pool search (offers retry) from a clean search that found nothing.
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

        // Movie entry auto-plays only a previously saved default; otherwise shows the list so a first-time pick is possible.
        function syncMoviePresentation() {
            if (!moviePresentation || isDestroyed()) return;
            var state = store.get();
            var target = buildMovieTarget();
            var evaluation = evaluateCandidatePool(state.pool, target, state);
            logCandidateEvaluation('movie pool', target, evaluation);
            var candidates = evaluation.items;
            var saved = readSeasonDefault(object.movie, 0);
            var chosen = moviePresentation.autoPlaySaved ? findSavedDefault(candidates, saved) : null;
            if (chosen) {
                log('selection', 'startMovie: автозапуск сохранённого дефолта — ' + chosen.title);
                moviePresentation = null;
                startDownload(chosen, target);
                return;
            }
            if (candidates.length && moviePresentation.allowConfidenceAutoplay && isConfidentMatch(candidates[0], candidates[1])) {
                moviePresentation = null;
                startDownload(candidates[0], target);
                return;
            }
            if (candidates.length) {
                debug('selection', 'movie pool: показываю ' + candidates.length + ' кандидатов, poolStatus=' + state.poolStatus);
                store.patch({ stage: 'candidates', candidates: { items: candidates.slice(0, 15), target: target, canReturnToEpisodeList: false } });
                return;
            }
            if (state.poolStatus === 'loading' || state.poolStatus === 'idle') {
                // Mirrors results-domain's initial message so retry paths never render a blank list.
                store.patch({ stage: 'message', message: { text: 'Ищем раздачи по всем трекерам…', retry: null } });
                return;
            }
            log('selection', 'movie pool: подходящих раздач не найдено' + (state.poolStatus === 'error' ? ' (ошибка поиска)' : ''));
            store.patch({ stage: 'message', message: emptyPoolMessage(function () { syncMoviePresentation(); }) });
        }

        function startMovie() {
            log('selection', 'startMovie()');
            moviePresentation = { autoPlaySaved: true, allowConfidenceAutoplay: false };
            syncMoviePresentation();
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
                episodes: [],
                englishTitle: state.englishTitle,
                aliases: state.titleAliases,
                negativeAliases: state.negativeAliases,
                ongoing: state.ongoing
            };
        }

        // Reads the already-fetched pool directly (no network call).
        function showMoviePool(pickerOnly) {
            moviePresentation = { autoPlaySaved: false, allowConfidenceAutoplay: !pickerOnly };
            syncMoviePresentation();
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
                episodes: state.episodesCache || [],
                englishTitle: state.englishTitle,
                aliases: state.titleAliases,
                negativeAliases: state.negativeAliases,
                ongoing: state.ongoing
            };
            store.patch({ lastEpisode: episode });
            saveLastEpisode(object.movie, state.season, episode);
            // A newer explicit click always supersedes older pending pool/season intents.
            pendingSelection = null;
            pendingClick = null;

            // Movie: no episode list; keep the old auto-play-or-full-candidates behaviour.
            if (!hasSeasons) { showMoviePool(pickerOnly); return; }

            // На сериальном пути pickerOnly принимался и молча игнорировался — выбор запускался
            // всегда. Сейчас это не расходится с намерением вызывающего.
            if (pickerOnly) { openPicker(episode); return; }

            // Pool settlement status is checked only after candidates — a still-loading pool can already have a valid match.
            var evaluation = evaluateCandidatePool(state.pool, target, state);
            logCandidateEvaluation('selectEpisode(' + episode + ')', target, evaluation);
            var candidates = evaluation.items;
            if (candidates.length) {
                var saved = readSeasonDefault(object.movie, state.season);
                var savedMatch = findSavedDefault(candidates, saved);
                var chosen = savedMatch || candidates[0];
                // `chosen` is a pool candidate object, `saved` the persisted record — never the same reference, so compare via savedMatch, not `===`.
                log('selection', 'selectEpisode(' + episode + '): запуск — ' + chosen.title + (savedMatch ? ' (сохранённый дефолт)' : ' (лучший по рейтингу)'));
                startDownload(chosen, target);
                return;
            }
            if (state.poolStatus === 'loading' || state.poolStatus === 'idle') {
                pendingSelection = {
                    season: state.season, episode: episode, pickerOnly: pickerOnly,
                    poolGeneration: state.poolGeneration
                };
                if (!replayingPendingSelection) notify('Раздачи ещё загружаются…');
                return;
            }
            // Zero candidates. A season already settled with nothing for it → dead end.
            var loadStatus = state.seasonLoads && state.seasonLoads[state.season];
            if (loadStatus === 'ready' || loadStatus === 'error') { notify('Раздач не нашлось'); return; }
            // Not yet settled — ensureSeasonLoaded is idempotent; the watcher above replays this click once it settles.
            log('selection', 'selectEpisode(' + episode + '): раздач в пуле нет для сезона ' + state.season + ', жду дозагрузки');
            pendingClick = { season: state.season, episode: episode, pickerOnly: pickerOnly };
            notify('Ищем раздачи для сезона…');
            if (ensureSeasonLoaded) ensureSeasonLoaded(state.season);
        }

        // Reactive source of truth for "where the user is" — the picker opens for and restores to this on close.
        function setActiveEpisode(episode) {
            var state = store.get();
            if (!episode || episode === state.activeEpisode) return;
            store.patch({ activeEpisode: episode });
            saveLastEpisode(object.movie, state.season, episode);
        }

        // Records only the open/episode intent — content is derived fresh by selectPickerData (results-selectors.js), not stored here.
        function openPicker(episode) {
            var state = store.get();
            if (episode === undefined) episode = state.activeEpisode || state.lastEpisode || 0;
            log('selection', 'openPicker(' + episode + ')');
            store.patch({ picker: { open: true, episode: episode } });
        }

        function playPickerCandidate(item, target, options) {
            log('selection', 'playPickerCandidate: ' + item.title + ' (эпизод ' + target.episode + ', сезон ' + target.season + ')');
            pendingSelection = null;
            pendingClick = null;
            var saved = saveSeasonDefault(object.movie, target.season, item);
            store.patch({
                picker: { open: false, episode: 0 },
                defaultsRevision: store.get().defaultsRevision + (saved ? 1 : 0)
            });
            if (options && options.deferUntilPickerClosed) {
                scope.setTimeout(function () {
                    if (scope.isAlive()) startDownload(item, target);
                }, 50);
            } else {
                startDownload(item, target);
            }
        }

        function closePicker() {
            debug('selection', 'closePicker()');
            store.patch({ picker: { open: false, episode: 0 } });
        }

        function playCandidate(item, target) {
            log('selection', 'playCandidate: ' + item.title + ' (сезон ' + (target.season || 0) + ')');
            moviePresentation = null;
            pendingSelection = null;
            pendingClick = null;
            if (saveSeasonDefault(object.movie, target.season || 0, item)) {
                store.patch({ defaultsRevision: store.get().defaultsRevision + 1 });
            }
            startDownload(item, target);
        }

        return {
            startMovie: startMovie,
            selectEpisode: selectEpisode,
            playCandidate: playCandidate,
            setActiveEpisode: setActiveEpisode,
            openPicker: openPicker,
            closePicker: closePicker,
            playPickerCandidate: playPickerCandidate,
            getSavedEpisode: getSavedEpisode,
            getSeasonDefault: getSeasonDefault
        };
    }
