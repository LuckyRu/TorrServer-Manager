    // ---------- release title signals (season/episode) ----------
    //
    // Split out of search/release-parsing.js: this one function is also needed by
    // playback/file-selection.js (via smart-preload.js, to score which file inside a multi-file
    // torrent matches the target episode) — a playback concern, not a search concern. Importing it
    // from search/ made playback/ depend on search/, breaking the shared -> {search,metadata,playback}
    // -> domain -> ui tier symmetry (metadata/ has never depended on search/ or vice versa; playback/
    // depending on search/ was the one exception — found in review). parseRelease() itself (quality/
    // audio/subtitle tag extraction) stays in search/release-parsing.js — nothing outside search/
    // needs it, so it isn't a shared concern.

    export function parseSignals(title) {
        var source = String(title || '').replace(/_/g, ' ');
        var result = { seasons: [], episodeFrom: 0, episodeTo: 0, explicitEpisode: false, explicitSeason: false };
        var match;

        // Combined season-range + episode-range: "S1-5E1-62 of 62" — both ranges in one tag.
        // Must be tried before the plain SxxExx pattern, which would match the leading "S1" and
        // stop at the dash (its trailing \b fails between a digit and "E" anyway, so the season
        // range was silently lost before — season packs like "Breaking Bad (S1-5E1-62 of 62)"
        // only ever matched season 1). Common on long-series season packs.
        match = source.match(/\bS(\d{1,2})\s*[-–]\s*S?(\d{1,2})\s*E(\d{1,3})(?:\s*[-–]\s*E?(\d{1,3}))?/i);
        if (match) {
            var fromSeason = parseInt(match[1], 10);
            var toSeason = parseInt(match[2], 10);
            for (var s = fromSeason; s <= toSeason && s <= fromSeason + 50; s++) result.seasons.push(s);
            result.episodeFrom = parseInt(match[3], 10);
            result.episodeTo = parseInt(match[4] || match[3], 10);
            result.explicitSeason = result.explicitEpisode = true;
            return result;
        }

        match = source.match(/\bS(\d{1,2})[ ._-]*E(\d{1,3})(?:\s*[-–]\s*(?:E)?(\d{1,3}))?/i);
        if (match) {
            result.seasons = [parseInt(match[1], 10)];
            result.episodeFrom = parseInt(match[2], 10);
            result.episodeTo = parseInt(match[3] || match[2], 10);
            result.explicitSeason = result.explicitEpisode = true;
            return result;
        }

        // "4x01-07", "04x01-07" — requires a 2+ digit episode number: single-digit "2x2" is a
        // release-group tag on many Russian/anime releases, not a season x episode marker
        // (confirmed live: "Naruto ... 2x2 [H.265/2160p]" used to parse as S2E2).
        match = source.match(/\b(\d{1,2})x(\d{2,3})(?:\s*[-–]\s*(\d{1,3}))?/i);
        if (match) {
            result.seasons = [parseInt(match[1], 10)];
            result.episodeFrom = parseInt(match[2], 10);
            result.episodeTo = parseInt(match[3] || match[2], 10);
            result.explicitSeason = result.explicitEpisode = true;
            return result;
        }

        match = source.match(/(?:сезон|season)\s*[:№]?\s*(\d{1,2})(?!\d)(?:\s*[-–]\s*(\d{1,2})(?!\d))?/i) ||
            source.match(/(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\s*(?:сезон|season)/i) ||
            source.match(/\bS(\d{1,2})(?:\s*[-–]\s*S?(\d{1,2}))?\b/i);
        if (match) {
            var seasonFrom = parseInt(match[1], 10);
            var seasonTo = parseInt(match[2] || match[1], 10);
            for (var season = seasonFrom; season <= seasonTo && season <= seasonFrom + 50; season++) result.seasons.push(season);
            result.explicitSeason = true;
        }

        // Episode markers: Russian ("серия 1-4", "1-4 серия", "серии"), Ukrainian ("серія 4 з 8"),
        // English ("episodes 1-4"), "E01-E12", and bracketed "x из N"/"x of N" ranges.
        match = source.match(/(?:серии|серия|серії|серія|episodes?|эпизоды?)\s*[:№]?\s*(\d{1,3})(?!\d)(?:\s*[-–]\s*(\d{1,3})(?!\d))?/i) ||
            source.match(/(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?\s*(?:серии|серия|серії|серія|episodes?|эпизоды?)(?:\s*(?:из|of|з)\s*\d{1,3})?/i) ||
            source.match(/[\[(](\d{1,3})\s*[-–]\s*(\d{1,3})\s*(?:из|of|з)\s*\d{1,3}/i) ||
            source.match(/\bE(\d{1,3})(?:\s*[-–]\s*E?(\d{1,3}))?\b/i);
        if (match) {
            result.episodeFrom = parseInt(match[1], 10);
            result.episodeTo = parseInt(match[2] || match[1], 10);
            result.explicitEpisode = true;
        }
        return result;
    }
