// Нормализованные метаданные выбора раздачи. Сырой release остаётся результатом разбора
// заголовка, а здесь факты разных трекеров приводятся к одному контракту для selector-а.
// Неоднозначность сохраняется явно: отсутствие Sxx не превращается молча в любой сезон.

import { evaluateTitleMatch } from '../gates/search-gates.js';
import { profileFor } from '../rules/tracker-profiles.js';
import { workFamily, FAMILY_ANIME, FAMILY_DONGHUA, FAMILY_ASIAN_LIVE } from './work-profile.js';
import { MODE_MOVIE } from '../../shared/state.js';

function number(value) {
    var parsed = parseInt(value, 10);
    return isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function lastSeasonNumber(target) {
    var last = 0;
    (((target && target.movie) || {}).seasons || []).forEach(function (season) {
        last = Math.max(last, number(season && season.season_number));
    });
    return last;
}

export function absoluteEpisodeNumber(target) {
    var season = number(target && target.season);
    var episode = number(target && target.episode);
    if (season <= 1 || !episode) return 0;
    var offset = 0;
    var foundPrevious = false;
    ((((target && target.movie) || {}).seasons) || []).forEach(function (entry) {
        var entrySeason = number(entry && entry.season_number);
        var count = number(entry && entry.episode_count);
        if (entrySeason > 0 && entrySeason < season && count) {
            offset += count;
            foundPrevious = true;
        }
    });
    return foundPrevious && offset > 0 ? offset + episode : 0;
}

function titleEvidence(item, target, analysis, accepted) {
    if (analysis === false) {
        return {
            accepted: accepted === true, kind: 'unknown', score: 0,
            matchedTitle: '', matchedTitleKey: '', matchedTitleKind: '', matchedSegment: ''
        };
    }
    analysis = analysis || evaluateTitleMatch(item, target);
    return {
        accepted: accepted === true,
        kind: analysis.matchKind || (analysis.extended ? 'extension' : 'exact'),
        score: analysis.similarity || 0,
        matchedTitle: analysis.matchedTitle || '',
        matchedTitleKey: analysis.matchedTitleKey || '',
        matchedTitleKind: analysis.matchedTitleKind || '',
        matchedSegment: analysis.matchedSegment || ''
    };
}

function episodeBounds(release) {
    return {
        episodeFrom: release.explicitEpisode ? number(release.episodeFrom) : 0,
        episodeTo: release.explicitEpisode ? number(release.episodeTo) : 0
    };
}

export function compileReleaseSelection(item, target, analysis, accepted) {
    item = item || {};
    target = target || {};
    var release = item.release || {};
    var profile = profileFor(item.trackerId, item.tracker);
    var family = workFamily(target);
    var bounds = episodeBounds(release);
    var claims = [];

    if (target.mode === MODE_MOVIE) {
        claims.push({ kind: 'movie', confidence: 'high', source: 'work-mode' });
    } else if (release.explicitSeason && Array.isArray(release.seasons) && release.seasons.length) {
        claims.push({
            kind: 'season-local',
            seasons: release.seasons.map(number).filter(Boolean),
            episodeFrom: bounds.episodeFrom,
            episodeTo: bounds.episodeTo,
            confidence: 'high',
            source: 'title-season-episode'
        });
    } else if (release.finalSeason) {
        claims.push({
            kind: 'final-season',
            season: lastSeasonNumber(target),
            episodeFrom: bounds.episodeFrom,
            episodeTo: bounds.episodeTo,
            confidence: lastSeasonNumber(target) ? 'high' : 'medium',
            source: 'title-final-season'
        });
    } else if (release.explicitEpisode) {
        var asianFamily = family === FAMILY_ANIME || family === FAMILY_DONGHUA || family === FAMILY_ASIAN_LIVE;
        var defaultSeason = number(profile.seasonlessSeason) || (profile.group === 'anime' || asianFamily ? 1 : 0);
        if (defaultSeason) {
            // У азиатских сериалов сезон молча опускают именно у первого сезона — в том числе
            // на общих трекерах. Это правило семейства/формата, а не догадка selector-а.
            claims.push({
                kind: 'season-local',
                seasons: [defaultSeason],
                episodeFrom: bounds.episodeFrom,
                episodeTo: bounds.episodeTo,
                confidence: 'high',
                source: 'tracker-default-season-' + defaultSeason
            });
        } else {
            claims.push({
                kind: 'seasonless-local',
                episodeFrom: bounds.episodeFrom,
                episodeTo: bounds.episodeTo,
                confidence: 'medium',
                source: 'title-episode-without-season'
            });
        }
        // Только профильные семейства/трекеры используют сквозную аниме-нумерацию. Сам факт
        // E27 не доказывает её, поэтому это отдельная, а не заменяющая local claim гипотеза.
        if (family === FAMILY_ANIME || family === FAMILY_DONGHUA || profile.group === 'anime') {
            claims.push({
                kind: 'absolute',
                episodeFrom: bounds.episodeFrom,
                episodeTo: bounds.episodeTo,
                confidence: 'medium',
                source: 'anime-seasonless-episode'
            });
        }
    } else {
        claims.push({ kind: 'unknown-series-coverage', confidence: 'low', source: 'title-no-season-episode' });
    }

    return {
        version: 1,
        family: family,
        tracker: { id: item.trackerId || profile.id || '', group: profile.group || 'general' },
        title: titleEvidence(item, target, analysis, accepted),
        coverage: { claims: claims }
    };
}

export function selectionMetadata(item, target) {
    return (item && item.selection && item.selection.version === 1)
        ? item.selection
        // Compatibility path also stays metadata-only: release is already parsed, and the UI
        // must not recover missing selection by re-reading the display title.
        : compileReleaseSelection(item, target, false, false);
}

function within(episode, claim) {
    if (!claim.episodeFrom || !claim.episodeTo) return true;
    return episode >= claim.episodeFrom && episode <= claim.episodeTo;
}

export function coverageDecision(item, target) {
    target = target || {};
    var release = (item && item.release) || {};
    var metadata = selectionMetadata(item, target);
    var claims = (metadata.coverage && metadata.coverage.claims) || [];
    var season = number(target.season);
    var episode = number(target.episode);

    if (target.mode === MODE_MOVIE) {
        return { match: 'exact', claim: claims[0] || null, metadata: metadata };
    }
    if (!episode) {
        if (!season) return { match: 'exact', claim: claims[0] || null, metadata: metadata };
        for (var seasonIndex = 0; seasonIndex < claims.length; seasonIndex++) {
            var seasonClaim = claims[seasonIndex];
            if (seasonClaim.kind === 'season-local' && seasonClaim.seasons.indexOf(season) >= 0) {
                return { match: 'exact', claim: seasonClaim, metadata: metadata };
            }
            if (seasonClaim.kind === 'final-season') {
                if (!seasonClaim.season) return { match: 'ambiguous', claim: seasonClaim, reason: 'final-season-number-unknown', metadata: metadata };
                if (seasonClaim.season === season) return { match: 'exact', claim: seasonClaim, metadata: metadata };
            }
        }
        var declaresSeason = claims.some(function (claim) { return claim.kind === 'season-local' || claim.kind === 'final-season'; });
        return declaresSeason
            ? { match: 'none', reason: 'season-mismatch', claim: null, metadata: metadata }
            : { match: 'exact', claim: claims[0] || null, metadata: metadata };
    }
    if (release.releaseType === 'movie' && !release.explicitEpisode) {
        return { match: 'none', reason: 'movie-release-for-episode', claim: null, metadata: metadata };
    }

    for (var i = 0; i < claims.length; i++) {
        var claim = claims[i];
        if (claim.kind === 'season-local' && claim.seasons.indexOf(season) >= 0 && within(episode, claim)) {
            return { match: 'exact', claim: claim, metadata: metadata };
        }
        if (claim.kind === 'final-season' && claim.season === season && within(episode, claim)) {
            return { match: 'exact', claim: claim, metadata: metadata };
        }
        if (claim.kind === 'final-season' && !claim.season && within(episode, claim)) {
            return { match: 'ambiguous', claim: claim, reason: 'final-season-number-unknown', metadata: metadata };
        }
        if (claim.kind === 'absolute') {
            var absolute = absoluteEpisodeNumber(target);
            if (absolute && within(absolute, claim)) return { match: 'exact', claim: claim, absoluteEpisode: absolute, metadata: metadata };
        }
        if (claim.kind === 'seasonless-local' && within(episode, claim)) {
            return {
                match: season <= 1 ? 'exact' : 'ambiguous',
                claim: claim,
                reason: season <= 1 ? '' : 'seasonless-local',
                metadata: metadata
            };
        }
        if (claim.kind === 'unknown-series-coverage') {
            return { match: 'ambiguous', claim: claim, reason: 'coverage-unknown', metadata: metadata };
        }
    }

    var hasSeasonClaim = claims.some(function (claim) { return claim.kind === 'season-local' || claim.kind === 'final-season'; });
    var hasMatchingSeason = claims.some(function (claim) {
        return (claim.kind === 'season-local' && claim.seasons.indexOf(season) >= 0) ||
            (claim.kind === 'final-season' && claim.season === season);
    });
    return {
        match: 'none',
        reason: hasSeasonClaim && !hasMatchingSeason ? 'season-mismatch' : 'episode-out-of-range',
        claim: null,
        metadata: metadata
    };
}
