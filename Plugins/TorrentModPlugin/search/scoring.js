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

    // A believable "good enough for this resolution" bitrate per tier (H.264-ish; real releases
    // vary, this only needs to be roughly right since qualityScore below is a peak, not a cliff).
    // HEVC/H.265 gets scaled down — same perceived quality at a lower bitrate, so judging it
    // against the H.264 reference would unfairly punish well-encoded HEVC releases.
    var REFERENCE_BITRATE_MBPS = { '2160p': 18, '1080p': 6, '720p': 3, '480p': 1.5 };

    function referenceBitrateMbps(release) {
        var base = REFERENCE_BITRATE_MBPS[release.resolution] || REFERENCE_BITRATE_MBPS['1080p'];
        return release.codec === 'H.265' ? base * 0.6 : base;
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
        if (titleSimilarity(item.title, target.movie) < MIN_TITLE_SIMILARITY) return false;
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
    // latent risk: `item` is a shared pool entry (state.seasonPool), and this function gets called
    // once per episode per candidate (see results-viewmodel.js's candidatesFor/getEpisodeBadges),
    // so item.bitrateMbps only ever reflects whatever episode's target this function was *last*
    // called with for that item, not necessarily the one currently on screen. Nothing reads
    // item.bitrateMbps back off the pool today (only the freshly-returned score object's own
    // .bitrateMbps is used), so this is dormant, not an active bug — but don't start trusting
    // item.bitrateMbps as "this candidate's bitrate" without re-deriving it fresh first.
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

        return {
            passes: passes,
            value: qualityScore + availabilityScore,
            matchScore: matchScore,
            qualityScore: qualityScore,
            availabilityScore: availabilityScore,
            bitrateMbps: bitrateMbps
        };
    }

    function matchesTranslation(item, voiceType) {
        if (!voiceType || voiceType === 'any') return true;
        return item.release.voiceType === voiceType;
    }

    // Shared by both the season-pool reuse path and a fresh per-episode search — translation and
    // quality are narrowing filters, not gates: if narrowing would leave nothing, fall back to the
    // unfiltered pool rather than showing an empty result for a filter combination nothing matches.
    export function applyStateFilters(pool, state) {
        var byVoice = pool.filter(function (item) { return matchesTranslation(item, state.voiceType); });
        if (byVoice.length) pool = byVoice;
        if (state.resolution !== 'any') {
            var byQuality = pool.filter(function (item) { return item.release.resolution === state.resolution; });
            if (byQuality.length) pool = byQuality;
        }
        return pool;
    }
