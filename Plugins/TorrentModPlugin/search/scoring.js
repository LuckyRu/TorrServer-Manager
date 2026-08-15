    import { titleSimilarity, passesSearchTitleGate as passesTitleGate, evaluateTitleMatch } from './search-gates.js';
    import { evaluateIdentityGate, narrowToExactMatches } from './gate-identity.js';
    import { filtersOf } from '../domain/filter-state.js';

    var CONFIDENCE_ORDER = { none: 0, low: 1, medium: 2, high: 3 };

    function lowerConfidence(left, right) {
        return CONFIDENCE_ORDER[left] <= CONFIDENCE_ORDER[right] ? left : right;
    }

    function episodeCountsFor(movie) {
        var counts = {};
        ((movie && movie.seasons) || []).forEach(function (season) {
            var number = parseInt(season.season_number, 10);
            var count = parseInt(season.episode_count, 10);
            if (number > 0 && count > 0) counts[number] = count;
        });
        return counts;
    }

    function parsedSeasons(release, target) {
        if (release.explicitSeason && release.seasons && release.seasons.length) return release.seasons;
        return target.season ? [target.season] : [];
    }

    function coverageEstimate(release, target) {
        if (target.mode === 'movie' || (!target.season && !target.seasonEpisodeCount)) {
            return { episodes: 1, confidence: 'high', reason: 'movie' };
        }

        var seasons = parsedSeasons(release, target);
        var counts = episodeCountsFor(target.movie);
        var knownCounts = seasons.map(function (season) { return counts[season] || 0; });
        var knownTotal = knownCounts.reduce(function (sum, count) { return sum + count; }, 0);
        var allSeasonCountsKnown = seasons.length > 0 && knownCounts.every(function (count) { return count > 0; });
        var maxSeasonCount = knownCounts.reduce(function (max, count) { return Math.max(max, count); }, 0);

        if (release.explicitEpisode && release.episodeTo >= release.episodeFrom) {
            var rangeCount = release.episodeTo - release.episodeFrom + 1;
            if (seasons.length > 1 && allSeasonCountsKnown && rangeCount <= maxSeasonCount) {
                return { episodes: knownTotal, confidence: 'medium', reason: 'multi-season per-season episode range' };
            }
            return {
                episodes: rangeCount,
                confidence: seasons.length > 1 ? 'medium' : 'high',
                reason: seasons.length > 1 ? 'multi-season explicit episode range' : 'explicit episode range'
            };
        }

        if (release.explicitSeason && seasons.length) {
            if (allSeasonCountsKnown) {
                return {
                    episodes: knownTotal,
                    confidence: seasons.length > 1 ? 'medium' : 'high',
                    reason: seasons.length > 1 ? 'TMDB multi-season episode counts' : 'TMDB season episode count'
                };
            }
            if (seasons.length === 1 && target.seasonEpisodeCount > 0) {
                return { episodes: target.seasonEpisodeCount, confidence: 'medium', reason: 'current season episode count' };
            }
            return { episodes: 0, confidence: 'none', reason: 'season coverage unavailable' };
        }

        if (target.seasonEpisodeCount > 0) {
            return { episodes: target.seasonEpisodeCount, confidence: 'low', reason: 'release coverage not stated' };
        }
        return { episodes: 0, confidence: 'none', reason: 'episode coverage unavailable' };
    }

    function episodeRuntimeMinutes(episodes, from, to) {
        var selected = (episodes || []).filter(function (episode) {
            var number = parseInt(episode.episode_number, 10);
            return number >= from && number <= to;
        });
        if (!selected.length || selected.length !== to - from + 1) return 0;
        var runtimes = selected.map(function (episode) { return parseInt(episode.runtime, 10) || 0; });
        if (runtimes.some(function (runtime) { return runtime <= 0; })) return 0;
        return runtimes.reduce(function (sum, runtime) { return sum + runtime; }, 0);
    }

    function durationEstimate(release, target, coverage) {
        if (target.mode === 'movie' || (!target.season && !target.seasonEpisodeCount)) {
            var movieRuntime = parseFloat(target.avgRuntimeMinutes || (target.movie && target.movie.runtime) || 0);
            return movieRuntime > 0
                ? { minutes: movieRuntime, confidence: 'high', reason: 'TMDB movie runtime' }
                : { minutes: 0, confidence: 'none', reason: 'movie runtime unavailable' };
        }

        var seasons = parsedSeasons(release, target);
        var currentSeasonOnly = seasons.length <= 1 && (!seasons.length || seasons[0] === target.season);
        if (currentSeasonOnly && release.explicitEpisode) {
            var exactRangeRuntime = episodeRuntimeMinutes(target.episodes, release.episodeFrom, release.episodeTo);
            if (exactRangeRuntime > 0) return { minutes: exactRangeRuntime, confidence: 'high', reason: 'TMDB episode runtimes' };
        }
        if (currentSeasonOnly && release.explicitSeason && !release.explicitEpisode && coverage.episodes > 0) {
            var exactSeasonRuntime = episodeRuntimeMinutes(target.episodes, 1, coverage.episodes);
            if (exactSeasonRuntime > 0) return { minutes: exactSeasonRuntime, confidence: 'high', reason: 'TMDB season runtimes' };
        }

        var average = parseFloat(target.avgRuntimeMinutes || 0);
        if (!average && target.movie && Array.isArray(target.movie.episode_run_time)) {
            var known = target.movie.episode_run_time.map(Number).filter(function (runtime) { return runtime > 0; });
            if (known.length) average = known.reduce(function (sum, runtime) { return sum + runtime; }, 0) / known.length;
        }
        if (average > 0 && coverage.episodes > 0) {
            return {
                minutes: average * coverage.episodes,
                confidence: coverage.confidence === 'high' ? 'medium' : coverage.confidence,
                reason: 'average episode runtime'
            };
        }
        return { minutes: 0, confidence: 'none', reason: 'episode runtime unavailable' };
    }

    export function estimatePayload(item, target) {
        var release = item && item.release;
        var size = Number(item && item.size) || 0;
        if (!release || size <= 0) {
            return { mbps: null, confidence: 'none', coverageEpisodes: 0, durationMinutes: 0, reason: 'torrent size unavailable' };
        }
        target = target || {};
        var coverage = coverageEstimate(release, target);
        var duration = durationEstimate(release, target, coverage);
        if (coverage.episodes <= 0 || duration.minutes <= 0) {
            return {
                mbps: null,
                confidence: 'none',
                coverageEpisodes: coverage.episodes,
                durationMinutes: duration.minutes,
                reason: coverage.episodes <= 0 ? coverage.reason : duration.reason
            };
        }
        return {
            mbps: (size * 8) / (duration.minutes * 60 * 1000000),
            confidence: lowerConfidence(coverage.confidence, duration.confidence),
            coverageEpisodes: coverage.episodes,
            durationMinutes: duration.minutes,
            reason: coverage.reason + '; ' + duration.reason
        };
    }

    var PAYLOAD_BUCKETS = [
        { key: 'b2', max: 2 },
        { key: 'b2-5', max: 5 },
        { key: 'b5-12', max: 12 },
        { key: 'b12', max: Infinity }
    ];

    export function payloadBucket(mbps) {
        if (!mbps || mbps <= 0) return '';
        for (var i = 0; i < PAYLOAD_BUCKETS.length; i++) {
            if (mbps < PAYLOAD_BUCKETS[i].max) return PAYLOAD_BUCKETS[i].key;
        }
        return 'b12';
    }

    export function estimatePayloadForState(item, state, movie, mode) {
        return estimatePayload(item, {
            movie: movie || state.movie || {},
            mode: mode,
            season: state.season,
            seasonEpisodeCount: state.seasonEpisodeCount,
            avgRuntimeMinutes: state.avgRuntimeMinutes,
            episodes: state.episodesCache || []
        });
    }

    var RESOLUTION_SCORE = { '2160p': 16, '1080p': 12, '720p': 7, '480p': 3 };
    var SOURCE_SCORE = { 'Remux': 4, 'BDRip': 3, 'WEB-DL': 3, 'WEBRip': 2, 'HDTV': 1, 'HDRip': 1, 'SDTV': 0 };
    var MIN_PAYLOAD_MBPS = { '2160p': 10, '1080p': 3.5, '720p': 1.8, '480p': 0.8 };

    function minimumPayloadMbps(release) {
        var base = MIN_PAYLOAD_MBPS[release.resolution] || MIN_PAYLOAD_MBPS['1080p'];
        if (release.videoCodec === 'H.265') base *= 0.6;
        if (release.hdr) base *= 1.15;
        return base;
    }

    function qualityScoreFor(release, payload) {
        var score = RESOLUTION_SCORE[release.resolution] || 6;
        score += SOURCE_SCORE[release.sourceType] || 0;
        if (release.hdr) score += 2;

        if (payload.mbps && payload.confidence !== 'none') {
            var reference = minimumPayloadMbps(release);
            if (payload.mbps < reference) {
                var confidenceWeight = { high: 1, medium: 0.65, low: 0.25 }[payload.confidence] || 0;
                score -= Math.min(8, 8 * (1 - payload.mbps / reference)) * confidenceWeight;
            }
        }
        return Math.max(0, score);
    }

    function availabilityScoreFor(item) {
        var seeders = Math.max(0, Number(item.seeders) || 0);
        if (!seeders) return 0;
        var leechers = Math.max(0, Number(item.leechers !== undefined ? item.leechers : item.peers) || 0);
        var seedScore = Math.min(20, Math.log(seeders + 1) * 5);
        var demandSignal = Math.min(2, Math.log(leechers + 1) * 0.4);
        return seedScore + demandSignal;
    }

    function streamingRiskPenaltyFor(item, payload) {
        if (!payload.mbps || payload.confidence === 'none' || payload.confidence === 'low') return 0;
        var seeders = Math.max(0, Number(item.seeders) || 0);
        var requiredSeeders = Math.max(3, payload.mbps * 1.25);
        if (seeders >= requiredSeeders) return 0;
        var confidenceWeight = payload.confidence === 'high' ? 1 : 0.65;
        return Math.min(8, 8 * (1 - seeders / requiredSeeders) * confidenceWeight);
    }

    function pipelinePenaltyFor(release) {
        if (!release || release.compatibility !== 'risky') return 0;
        if (release.compatibilityReason === 'RAW DVD') return 8;
        if (release.videoCodec === 'AV1') return 3;
        return 5;
    }

    export function passesSearchTitleGate(item, target) {
        return passesTitleGate(item, target);
    }

    function passesMatchGate(item, target, titlePasses) {
        if (titlePasses === undefined ? !passesSearchTitleGate(item, target) : !titlePasses) return false;
        return evaluateIdentityGate(item, target).passes;
    }

    export function createCandidateScoreBase(item, target) {
        var release = item.release;
        var payload = estimatePayload(item, target);
        var titleMatch = evaluateTitleMatch(item, target);
        return {
            titlePasses: passesSearchTitleGate(item, target),
            titleExtended: titleMatch.extended,
            titleScore: Math.round(titleMatch.similarity * 40),
            qualityScore: qualityScoreFor(release, payload),
            availabilityScore: availabilityScoreFor(item),
            streamingRiskPenalty: streamingRiskPenaltyFor(item, payload),
            pipelinePenalty: pipelinePenaltyFor(release),
            payload: payload
        };
    }

    export function scoreCandidateFromBase(item, target, base) {
        var release = item.release;
        var passes = passesMatchGate(item, target, base.titlePasses);
        var matchScore = base.titleScore +
            (release.explicitSeason && release.seasons.indexOf(target.season) >= 0 ? 20 : 0) +
            (target.episode && release.explicitEpisode &&
                target.episode >= release.episodeFrom && target.episode <= release.episodeTo ? 40 : 0);
        var matchConfidenceScore = Math.max(0, Math.min(4, matchScore / 25));

        return {
            passes: passes,
            value: base.qualityScore + base.availabilityScore + matchConfidenceScore - base.streamingRiskPenalty - base.pipelinePenalty,
            matchScore: matchScore,
            matchConfidenceScore: matchConfidenceScore,
            qualityScore: base.qualityScore,
            availabilityScore: base.availabilityScore,
            streamingRiskPenalty: base.streamingRiskPenalty,
            pipelinePenalty: base.pipelinePenalty,
            formatPenalty: base.pipelinePenalty,
            payloadMbps: base.payload.mbps,
            payloadConfidence: base.payload.confidence,
            payloadCoverageEpisodes: base.payload.coverageEpisodes,
            payloadDurationMinutes: base.payload.durationMinutes,
            payloadReason: base.payload.reason
        };
    }

    export function scoreCandidate(item, target) {
        return scoreCandidateFromBase(item, target, createCandidateScoreBase(item, target));
    }

    function matchesTranslation(item, voiceType) {
        if (!voiceType || voiceType === 'any') return true;
        var release = item.release || {};
        // Раздача с несколькими переводами подходит под выбор любого из них.
        var present = release.voiceTypes && release.voiceTypes.length
            ? release.voiceTypes
            : (release.voiceType ? [release.voiceType] : []);
        return present.indexOf(voiceType) >= 0;
    }

    function matchesTranslator(item, translator) {
        if (!translator || translator === 'any') return true;
        return ((item.release && item.release.translators) || []).indexOf(translator) >= 0;
    }

    function matchesBitrate(item, state, filters, target) {
        if (!filters.bitrate || filters.bitrate === 'any') return true;
        var payload = target ? estimatePayload(item, target) : estimatePayloadForState(item, state);
        if (payload.confidence === 'none' || payload.confidence === 'low') return false;
        return payloadBucket(payload.mbps) === filters.bitrate;
    }

    function titles(items) {
        return items.map(function (item) { return item && item.title ? item.title : 'Без названия'; });
    }

    function applyStateFiltersDetailed(pool, state, target) {
        var current = pool || [];
        var stages = [];
        state = state || {};
        var filters = filtersOf(state);

        function narrow(name, predicate, enabled) {
            if (!enabled) return;
            var matching = current.filter(predicate);
            var fallback = matching.length === 0;
            var next = fallback ? current : matching;
            stages.push({
                stage: name,
                input: current.length,
                output: next.length,
                filtered: fallback ? 0 : current.length - next.length,
                // Откат — это «фильтр проигнорирован», а не «фильтр ничего не отсеял». Без
                // отдельного признака лог утверждал второе, и расхождение списка с выбранным
                // фильтром выглядело необъяснимым.
                fallback: fallback,
                wouldFilter: fallback ? current.length : 0,
                rejectedTitles: fallback ? [] : titles(current.filter(function (item) { return !predicate(item); }))
            });
            current = next;
        }

        narrow('voice', function (item) { return matchesTranslation(item, filters.voiceType); }, filters.voiceType && filters.voiceType !== 'any');
        narrow('translator', function (item) { return matchesTranslator(item, filters.translator); }, filters.translator && filters.translator !== 'any');
        narrow('resolution', function (item) { return item.release.resolution === filters.resolution; }, filters.resolution && filters.resolution !== 'any');
        narrow('bitrate', function (item) { return matchesBitrate(item, state, filters, target); }, filters.bitrate && filters.bitrate !== 'any');

        return {
            items: current,
            stages: stages,
            filteredCount: stages.reduce(function (sum, stage) { return sum + stage.filtered; }, 0),
            rejectedTitles: stages.reduce(function (all, stage) { return all.concat(stage.rejectedTitles); }, [])
        };
    }

    // State filters are narrowing filters, not gates — fall back to the previous pool if one would leave nothing.
    export function applyStateFilters(pool, state, target) {
        return applyStateFiltersDetailed(pool, state, target).items;
    }

    export function evaluateCandidatePool(pool, target, state) {
        var filtered = applyStateFiltersDetailed(pool, state, target);
        var rejectedByGate = [];
        var scoredItems = filtered.items.map(function (item) {
            var base = createCandidateScoreBase(item, target);
            var scored = Object.assign({}, item, {
                _score: scoreCandidateFromBase(item, target, base),
                _titleExtended: base.titleExtended
            });
            if (!scored._score.passes) rejectedByGate.push(scored);
            return scored;
        });
        var passing = scoredItems.filter(function (item) { return item._score.passes; });
        var narrowed = narrowToExactMatches(passing, target);
        var candidates = narrowed.items;
        candidates.sort(function (a, b) { return b._score.value - a._score.value || b.seeders - a.seeders; });
        var gateStage = {
            stage: 'matchGate',
            input: scoredItems.length,
            output: candidates.length,
            filtered: rejectedByGate.length + narrowed.rejected.length,
            rejectedTitles: titles(rejectedByGate).concat(narrowed.rejected.map(function (entry) {
                return (entry.item && entry.item.title ? entry.item.title : 'Без названия') + ' [' + entry.reason + ']';
            }))
        };

        return {
            items: candidates,
            scoredItems: scoredItems,
            stages: filtered.stages.concat([gateStage]),
            inputCount: (pool || []).length,
            afterStateFilters: filtered.items.length,
            stateFilteredCount: filtered.filteredCount,
            stateFilteredTitles: filtered.rejectedTitles,
            gateFilteredCount: rejectedByGate.length + narrowed.rejected.length,
            gateFilteredTitles: gateStage.rejectedTitles,
            filteredCount: filtered.filteredCount + rejectedByGate.length + narrowed.rejected.length,
            rejectedTitles: filtered.rejectedTitles.concat(gateStage.rejectedTitles)
        };
    }
