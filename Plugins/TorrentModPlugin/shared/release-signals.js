
    export function parseSignals(title) {
        var source = String(title || '').replace(/_/g, ' ');
        var result = { seasons: [], episodeFrom: 0, episodeTo: 0, explicitEpisode: false, explicitSeason: false };
        var match;

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

        // Matches Russian/Ukrainian/English episode-marker phrasing plus "E01-E12" and "x of N" ranges.
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
