    import { baseTitles } from './query-building.js';
    import { field, compact } from '../shared/utils.js';

    // Near-zero-signal words (EN+RU) — a bare word like "the" must never fake title similarity on its own.
    var STOPWORDS = {};
    ['the', 'a', 'an', 'of', 'and', 'in', 'on', 'to', 'for', 'is', 'it'].forEach(function (w) { STOPWORDS[w] = true; });
    ['и', 'в', 'на', 'о', 'из', 'для', 'по', 'с', 'а', 'к', 'у'].forEach(function (w) { STOPWORDS[w] = true; });

    function extractTitleSegments(rawTitle) {
        return String(rawTitle || '').split('/').map(function (piece) {
            var bracketIndex = piece.search(/[([]/);
            if (bracketIndex >= 0) piece = piece.slice(0, bracketIndex);
            return piece.trim();
        }).filter(Boolean);
    }

    function titleSimilarity(title, movie, englishTitle) {
        var segments = extractTitleSegments(title);
        var best = 0;
        baseTitles(movie, englishTitle).forEach(function (name) {
            var compactName = compact(name);
            if (!compactName) return;
            var nameTokens = compactName.split(' ');
            var significantTokens = nameTokens.filter(function (t) { return t.length > 2 && !STOPWORDS[t]; });
            segments.forEach(function (segment) {
                var compactSegment = compact(segment);
                if (!compactSegment) return;
                if (compactSegment === compactName) { best = Math.max(best, 1); return; }
                var segmentTokens = compactSegment.split(' ');
                // Word count must match exactly — rules out a longer title containing the target as a substring.
                if (segmentTokens.length !== nameTokens.length) return;
                if (!significantTokens.length) return;
                var hits = significantTokens.filter(function (t) { return segmentTokens.indexOf(t) >= 0; }).length;
                best = Math.max(best, hits / significantTokens.length);
            });
        });
        return best;
    }

    function estimateBitrateMbps(item, target) {
        var release = item.release;
        var covered = (release.explicitEpisode && release.episodeTo >= release.episodeFrom)
            ? (release.episodeTo - release.episodeFrom + 1)
            : Math.max(1, target.seasonEpisodeCount || 1);
        var perEpisodeBytes = item.size / covered;
        var runtimeSeconds = (target.avgRuntimeMinutes || 42) * 60;
        return runtimeSeconds > 0 ? (perEpisodeBytes * 8) / (runtimeSeconds * 1000000) : 0;
    }

    var BITRATE_BUCKETS = [
        { key: 'b2', max: 2 },
        { key: 'b2-5', max: 5 },
        { key: 'b5-12', max: 12 },
        { key: 'b12', max: Infinity }
    ];

    export function bitrateBucket(mbps) {
        if (!mbps || mbps <= 0) return '';
        for (var i = 0; i < BITRATE_BUCKETS.length; i++) {
            if (mbps < BITRATE_BUCKETS[i].max) return BITRATE_BUCKETS[i].key;
        }
        return 'b12';
    }

    export function estimateBitrateForState(item, state) {
        return estimateBitrateMbps(item, {
            seasonEpisodeCount: state.seasonEpisodeCount,
            avgRuntimeMinutes: state.avgRuntimeMinutes
        });
    }

    // H.265 reference is halved — roughly matches H.264 perceived quality at half the bitrate.
    var REFERENCE_BITRATE_MBPS = { '2160p': 18, '1080p': 6, '720p': 3, '480p': 1.5 };

    function referenceBitrateMbps(release) {
        var base = REFERENCE_BITRATE_MBPS[release.resolution] || REFERENCE_BITRATE_MBPS['1080p'];
        return release.videoCodec === 'H.265' ? base * 0.6 : base;
    }

    // Hard gate, not a scored component — see docs/reference/torrent-mod-scoring-model.md.
    var MIN_TITLE_SIMILARITY = 0.34;

    function passesMatchGate(item, target) {
        var release = item.release;
        // customQuery replaces the title match (the query itself is the filter now) but season/episode checks still apply.
        if (!target.customQuery && titleSimilarity(item.title, target.movie, target.englishTitle) < MIN_TITLE_SIMILARITY) return false;
        if (release.explicitSeason && release.seasons.indexOf(target.season) < 0) return false;
        if (target.episode && release.explicitEpisode &&
            !(target.episode >= release.episodeFrom && target.episode <= release.episodeTo)) return false;
        return true;
    }

    export function scoreCandidate(item, target) {
        var release = item.release;
        var passes = passesMatchGate(item, target);
        var matchScore = Math.round(titleSimilarity(item.title, target.movie, target.englishTitle) * 40) +
            (release.explicitSeason && release.seasons.indexOf(target.season) >= 0 ? 20 : 0) +
            (target.episode && release.explicitEpisode &&
                target.episode >= release.episodeFrom && target.episode <= release.episodeTo ? 40 : 0);

        var bitrateMbps = estimateBitrateMbps(item, target);
        item.bitrateMbps = bitrateMbps;
        var reference = referenceBitrateMbps(release);
        // Triangular peak at `reference` — full marks on target, penalizing both bloat and under-encoding.
        var deviation = Math.abs(bitrateMbps - reference) / reference;
        var qualityScore = Math.max(0, 20 * (1 - deviation));
        var preferred = field('torrent_mod_preferred_quality', 'any');
        if (preferred !== 'any' && release.resolution === preferred) qualityScore += 10;

        var availabilityScore = Math.min(24, Math.log(item.seeders + item.peers * 1.5 + 1) * 6);

        // Compatibility is ranked, not gated (title is only a heuristic, GST may still play a risky file) — kept out of qualityScore so the two axes don't mix.
        var formatPenalty = formatPenaltyFor(release);

        return {
            passes: passes,
            value: qualityScore + availabilityScore - formatPenalty,
            matchScore: matchScore,
            qualityScore: qualityScore,
            availabilityScore: availabilityScore,
            formatPenalty: formatPenalty,
            bitrateMbps: bitrateMbps
        };
    }

    // AV1 gets a moderate penalty (older WebOS lacks decode); other risky codecs/containers get a bigger one.
    function formatPenaltyFor(release) {
        if (!release || release.compatibility !== 'risky') return 0;
        return release.videoCodec === 'AV1' ? 6 : 12;
    }

    function matchesTranslation(item, voiceType) {
        if (!voiceType || voiceType === 'any') return true;
        return item.release.voiceType === voiceType;
    }

    function matchesBitrate(item, state) {
        if (!state.bitrate || state.bitrate === 'any') return true;
        return bitrateBucket(estimateBitrateForState(item, state)) === state.bitrate;
    }

    // Voice/quality/bitrate are narrowing filters, not gates — fall back to the unfiltered pool if a filter would leave nothing.
    export function applyStateFilters(pool, state) {
        var byVoice = pool.filter(function (item) { return matchesTranslation(item, state.voiceType); });
        if (byVoice.length) pool = byVoice;
        if (state.resolution !== 'any') {
            var byQuality = pool.filter(function (item) { return item.release.resolution === state.resolution; });
            if (byQuality.length) pool = byQuality;
        }
        if (state.bitrate && state.bitrate !== 'any') {
            var byBitrate = pool.filter(function (item) { return matchesBitrate(item, state); });
            if (byBitrate.length) pool = byBitrate;
        }
        return pool;
    }
