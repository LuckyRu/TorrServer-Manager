    import { buildFilterItems, activeFilterLabels, currentSeasonLabel, candidatesForEpisode, badgeTextForBest,
        candidateIdentity, candidateBadgeText, candidateSubtitleText } from './results-core.js';
    import { buildSeasonItems } from '../metadata/season-picker.js';
    import { MODE_SERIES, POOL_MAX_ATTEMPTS } from '../shared/state.js';
    import { applyStateFilters, createCandidateScoreBase, scoreCandidateFromBase } from '../search/scoring.js';

    export function selectBusy(state) {
        return state.episodesStatus === 'loading' || state.poolStatus === 'loading';
    }

    export function selectFilterChipData(state, movie, hasSeasons) {
        return {
            seasonLabel: currentSeasonLabel(movie, hasSeasons, state),
            seasonItems: buildSeasonItems(movie, state.season),
            activeLabels: activeFilterLabels(state),
            filterItems: buildFilterItems(movie, hasSeasons, state)
        };
    }

    export function selectFilterItems(state, movie, hasSeasons) {
        return buildFilterItems(movie, hasSeasons, state);
    }

    export function buildEpisodeTarget(object, state, number, mode) {
        return {
            movie: object.movie,
            mode: mode || MODE_SERIES,
            season: state.season,
            episode: number,
            seasonEpisodeCount: state.seasonEpisodeCount,
            avgRuntimeMinutes: state.avgRuntimeMinutes,
            episodes: state.episodesCache || [],
            englishTitle: state.englishTitle,
            aliases: state.titleAliases,
            negativeAliases: state.negativeAliases,
            ongoing: state.ongoing
        };
    }

    export function selectCandidatesForEpisode(object, state, number, mode) {
        var target = buildEpisodeTarget(object, state, number, mode);
        return candidatesForEpisode(state.pool, target, state);
    }

    export function selectEpisodeBadges(object, state, seasonDefault, metrics) {
        var poolSettling = state.poolStatus === 'loading' || state.poolStatus === 'idle';
        var seasonLoading = !!(state.seasonLoads && state.seasonLoads[state.season] === 'loading');
        var poolFailed = state.poolStatus === 'error';
        var seasonFailed = !!(state.seasonLoads && state.seasonLoads[state.season] === 'error');
        var baseTarget = buildEpisodeTarget(object, state, 0);
        var entries = applyStateFilters(state.pool, state, baseTarget).map(function (item) {
            if (metrics) metrics.baseScores = (metrics.baseScores || 0) + 1;
            return { item: item, base: createCandidateScoreBase(item, baseTarget) };
        });
        var savedId = seasonDefault && seasonDefault.id;
        var map = {};
        (state.episodesCache || []).forEach(function (episode) {
            var number = parseInt(episode.episode_number, 10);
            if (!isFinite(number) || number < 1) return;
            var target = Object.assign({}, baseTarget, { episode: number });
            var count = 0;
            var bestItem = null;
            var bestScore = null;
            var savedItem = null;
            entries.forEach(function (entry) {
                if (metrics) metrics.episodeScores = (metrics.episodeScores || 0) + 1;
                var score = scoreCandidateFromBase(entry.item, target, entry.base);
                if (!score.passes) return;
                count++;
                if (savedId && candidateIdentity(entry.item) === savedId) savedItem = entry.item;
                if (!bestScore || score.value > bestScore.value ||
                    (score.value === bestScore.value && entry.item.seeders > bestItem.seeders)) {
                    bestItem = entry.item;
                    bestScore = score;
                }
            });
            if (count) {
                map[number] = { text: badgeTextForBest(savedItem || bestItem, count), loading: false, canPick: count > 1 };
            } else if (poolSettling || seasonLoading) {
                map[number] = { text: 'поиск…', loading: true, canPick: false };
            } else if (poolFailed || seasonFailed) {
                map[number] = { text: 'ошибка поиска', loading: false, canPick: false };
            } else {
                map[number] = { text: 'раздачи не найдены', loading: false, canPick: false };
            }
        });
        return map;
    }

    export function selectPoolIndexers(state) {
        var reported = {};
        (state.poolIndexers || []).forEach(function (indexer) { reported[indexer.id] = indexer; });
        var trackers = [];
        var pending = 0;
        (state.poolAllIndexers || []).forEach(function (configured) {
            var indexer = reported[configured.id];
            if (!indexer) {
                pending++;
                trackers.push({ id: configured.id, name: configured.name, status: 'pending', error: null, elapsedMs: null, reportedAt: null });
                return;
            }
            trackers.push({
                id: indexer.id, name: indexer.name, status: indexer.ok ? 'ok' : 'error',
                error: indexer.error, elapsedMs: indexer.elapsedMs, reportedAt: indexer.reportedAt
            });
        });
        return { trackers: trackers, pending: pending, total: (state.poolAllIndexers || []).length };
    }

    var SLOW_SEARCH_THRESHOLD_MS = 15000;

    export function selectSearchProgress(state) {
        var seasonStatus = state.seasonLoads && state.seasonLoads[state.season];
        var loading = state.poolStatus === 'loading' || seasonStatus === 'loading';
        if (loading) {
            var elapsedMs = (state.poolStatus === 'loading' && state.poolStartedAt) ? Date.now() - state.poolStartedAt : null;
            return { stage: 'loading', elapsedMs: elapsedMs, slow: elapsedMs !== null && elapsedMs >= SLOW_SEARCH_THRESHOLD_MS };
        }
        if (state.poolAutoRetryAt && state.poolAutoRetryAt > Date.now()) {
            return {
                stage: 'retrying', elapsedMs: null, slow: false,
                retryInMs: state.poolAutoRetryAt - Date.now(),
                attempt: state.poolAttempt || 1, maxAttempts: POOL_MAX_ATTEMPTS
            };
        }
        var failed = state.poolStatus === 'error' || seasonStatus === 'error';
        if (failed) return { stage: 'error', elapsedMs: null, slow: false, attempt: state.poolAttempt || 1 };
        return { stage: 'idle', elapsedMs: null, slow: false };
    }

    export function selectStatusText(state) {
        if (state.statusText) return state.statusText;
        var progress = selectSearchProgress(state);
        if (progress.stage === 'loading') {
            return progress.slow
                ? 'Опрашиваем трекеры — некоторые отвечают медленно, обычно до 40 секунд'
                : 'Ищем раздачи по всем трекерам…';
        }
        if (progress.stage === 'retrying') {
            var seconds = Math.max(1, Math.ceil(progress.retryInMs / 1000));
            return 'Не удалось получить раздачи — повтор через ' + seconds + ' с (попытка ' + (progress.attempt + 1) + ' из ' + progress.maxAttempts + ')';
        }
        if (progress.stage === 'error') {
            return 'Не удалось получить раздачи — Jackett не ответил' + (progress.attempt > 1 ? ' (попытка ' + progress.attempt + ' из ' + POOL_MAX_ATTEMPTS + ')' : '');
        }
        return '';
    }

    export function selectPickerData(object, state, seasonDefault) {
        var episode = state.picker.episode;
        var items = selectCandidatesForEpisode(object, state, episode);
        var selectedId = seasonDefault ? seasonDefault.id : null;
        if (items.length) {
            return {
                status: 'ready',
                items: items,
                rows: items.map(function (item) {
                    var id = candidateIdentity(item);
                    return {
                        id: id,
                        item: item,
                        title: item.title || '',
                        badge: candidateBadgeText(item),
                        details: candidateSubtitleText(item),
                        selected: !!(selectedId && id === selectedId)
                    };
                }),
                target: buildEpisodeTarget(object, state, episode),
                selectedId: selectedId
            };
        }
        var poolSettling = state.poolStatus === 'loading' || state.poolStatus === 'idle';
        var seasonLoading = !!(state.seasonLoads && state.seasonLoads[state.season] === 'loading');
        if (poolSettling || seasonLoading) return { status: 'loading', items: [], target: null, selectedId: null };
        var poolFailed = state.poolStatus === 'error';
        var seasonFailed = !!(state.seasonLoads && state.seasonLoads[state.season] === 'error');
        if (poolFailed || seasonFailed) return { status: 'error', items: [], target: null, selectedId: null, retrySeason: true };
        return { status: 'empty', items: [], target: null, selectedId: null };
    }
