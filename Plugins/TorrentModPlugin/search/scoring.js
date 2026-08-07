    // ---------- candidate scoring ----------
    // matchScore-as-gate (passesMatchGate), then qualityScore+availabilityScore for ranking —
    // see CLAUDE.md's TorrentModPlugin.js section for the full rationale behind this split.
    import { baseTitles } from './query-building.js';
    import { field, compact } from '../shared/utils.js';

    function titleSimilarity(title, movie) {
        var haystack = ' ' + compact(title) + ' ';
        var best = 0;
        baseTitles(movie).forEach(function (name) {
            var tokens = compact(name).split(' ').filter(function (token) { return token.length > 2; });
            if (!tokens.length) return;
            var hits = tokens.filter(function (token) { return haystack.indexOf(' ' + token + ' ') >= 0; }).length;
            best = Math.max(best, hits / tokens.length);
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

    // Coarse user-facing bitrate buckets (Etap 3: bitrate is the primary quality signal for people
    // who understand it, more than file size). Computed from the ESTIMATED per-episode bitrate —
    // no real measurement, but consistent with what qualityScore already ranks by. Keys are stable
    // state values; labels live in results-core (BITRATE_LABELS) so the panel can render them.
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

    // A believable "good enough for this resolution" bitrate per tier (H.264-ish; real releases
    // vary, this only needs to be roughly right since qualityScore below is a peak, not a cliff).
    // HEVC/H.265 gets scaled down — same perceived quality at a lower bitrate, so judging it
    // against the H.264 reference would unfairly punish well-encoded HEVC releases.
    var REFERENCE_BITRATE_MBPS = { '2160p': 18, '1080p': 6, '720p': 3, '480p': 1.5 };

    function referenceBitrateMbps(release) {
        var base = REFERENCE_BITRATE_MBPS[release.resolution] || REFERENCE_BITRATE_MBPS['1080p'];
        return release.videoCodec === 'H.265' ? base * 0.6 : base;
    }

    // matchScore is a hard gate, not a scored component: title has to plausibly be this movie/show,
    // and if the release states a season/episode at all, it has to be the right one. Candidates that
    // fail this don't get ranked lower, they don't participate — a "Заражённая земля 2019" torrent
    // should never be an option when the target is "Игра престолов" S1E1, no matter how many seeds
    // it has. Releases that *don't* state season/episode explicitly (ambiguous naming, common on
    // some trackers) are let through for qualityScore/availabilityScore to sort out.
    var MIN_TITLE_SIMILARITY = 0.34;

    function passesMatchGate(item, target) {
        var release = item.release;
        // A manual name override (customQuery) replaces the movie's own titles in the Jackett query,
        // so a title-similarity check against target.movie (the *original* card name) is meaningless
        // for those results — the query itself is now the title filter. Season/episode checks still
        // apply, because customQuery only disambiguates the name, it does not change the target
        // season/episode the user is searching torrents for.
        if (!target.customQuery && titleSimilarity(item.title, target.movie) < MIN_TITLE_SIMILARITY) return false;
        if (release.explicitSeason && release.seasons.indexOf(target.season) < 0) return false;
        if (target.episode && release.explicitEpisode &&
            !(target.episode >= release.episodeFrom && target.episode <= release.episodeTo)) return false;
        return true;
    }

    // Once a candidate clears the matchScore gate, ranking is qualityScore + availabilityScore only
    // (matchScore already did its job as a filter, it doesn't also weigh in here). qualityScore peaks
    // near a sane bitrate for the release's own resolution instead of rewarding "bigger is better" —
    // a 1080p release at 80 Mbps is a bloated remux, not a better watch, and would always win a
    // monotonic score. availabilityScore folds seeders and peers into one log-scaled figure with
    // peers weighted higher — peers are the live swarm that actually drives download *speed*, seeders
    // alone can be idle. Auto-play additionally requires availabilityScore above a floor (see
    // MIN_AVAILABILITY_FOR_AUTOPLAY below) — a perfect title/season/episode match with an empty swarm
    // must never auto-play, that's a hang, not "feels like an online service".
    //
    // Mutates `item` (writes item.bitrateMbps) — flagged during an independent review pass as a
    // latent risk: `item` is a shared pool entry (state.pool), and this function gets called
    // once per episode per candidate (see domain/results-selectors.js candidatesForEpisode),
    // so item.bitrateMbps only ever reflects whatever episode's target this function was *last*
    // called with for that item. Since Etap 3 the UI also reads item._score.bitrateMbps for the
    // candidate card's `~X Mbps` line: for a freshly-picked candidate list that score is correct
    // (recomputed on every selectEpisode), but don't trust it after OTHER scoring passes ran over
    // the same pool objects (e.g. row-badge computation for a different season) without
    // re-deriving it fresh.
    export function scoreCandidate(item, target) {
        var release = item.release;
        var passes = passesMatchGate(item, target);
        var matchScore = Math.round(titleSimilarity(item.title, target.movie) * 40) +
            (release.explicitSeason && release.seasons.indexOf(target.season) >= 0 ? 20 : 0) +
            (target.episode && release.explicitEpisode &&
                target.episode >= release.episodeFrom && target.episode <= release.episodeTo ? 40 : 0);

        var bitrateMbps = estimateBitrateMbps(item, target);
        item.bitrateMbps = bitrateMbps;
        var reference = referenceBitrateMbps(release);
        // Triangular peak at `reference`: full marks right on target, falling off in both
        // directions (over-encoded remux and under-encoded transcode both lose points).
        var deviation = Math.abs(bitrateMbps - reference) / reference;
        var qualityScore = Math.max(0, 20 * (1 - deviation));
        var preferred = field('torrent_mod_preferred_quality', 'any');
        if (preferred !== 'any' && release.resolution === preferred) qualityScore += 10;

        var availabilityScore = Math.min(24, Math.log(item.seeders + item.peers * 1.5 + 1) * 6);

        // Title-level compatibility penalty (see release-parsing.computeCompatibility): old
        // containers/codecs WebOS can't play without TorrServer transcoding are ranked DOWN but
        // not gated out — the title is only a heuristic, and with GST even an AVI might play.
        // Kept OUT of qualityScore: quality and playability are orthogonal axes, and mixing them
        // would corrupt the bitrate peak's meaning.
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

    // Format penalty policy: explicit 'risky' codec/container — big hit (ancient AVI/XviD/MPEG-2/
    // VC-1/WMV/RealVideo), AV1 — moderate (older WebOS sets lack AV1 decode, newer ones are fine),
    // likely/unknown — no penalty.
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

    // Shared by both the season-pool reuse path and a fresh per-episode search — translation,
    // quality and bitrate are narrowing filters, not gates: if narrowing would leave nothing, fall
    // back to the unfiltered pool rather than showing an empty result for a filter combination
    // nothing matches.
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
