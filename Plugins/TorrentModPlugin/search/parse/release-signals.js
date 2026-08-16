
    // Аниме-трекеры помечают тип релиза отдельно от нумерации: «[Фильм]», «[П-ф]», «Movie-»,
    // «Gekijouban» (театральная версия), «[OVA]», «[ТВ]». Без этого полнометражка неотличима от
    // серии, у которой просто не разобрался номер, — и попадает в кандидаты на серию сериала.
    function releaseTypeOf(source) {
        if (/\[(?:ova|ona)\]/i.test(source)) return 'ova';
        if (/\[(?:спешл|special)s?\]/i.test(source)) return 'special';
        if (/\[(?:фильм|movie)\]|\[П-ф\]|\bgekijouban\b|\bmovie\s*[-–]/i.test(source)) return 'movie';
        if (/(?:^|[\s(\[])(?:TV|ТВ)(?:[\s)\]]|$)/i.test(source)) return 'tv';
        return '';
    }

    export function parseSignals(title) {
        var source = String(title || '').replace(/_/g, ' ');
        var result = {
            seasons: [], episodeFrom: 0, episodeTo: 0, explicitEpisode: false, explicitSeason: false,
            finalSeason: false, releaseType: releaseTypeOf(source)
        };
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

        // Anime often labels cours/seasons as TV-1, ТВ-1, TV-2, ТВ-2.
        // A bare [TV] is only a release type and must not create a season signal.
        match = source.match(/(?:^|[\s(\[])(?:TV|ТВ)\s*[-–—]?\s*(\d{1,2})(?!\d)/i);
        if (match) {
            var tvSeason = parseInt(match[1], 10);
            if (tvSeason > 0 && tvSeason <= 50) {
                result.seasons = [tvSeason];
                result.explicitSeason = true;
            }
        }

        // Аниме называет сезон словом чаще, чем номером: «3rd Season», «The Final Season»,
        // «Kanketsu-hen» (заключительная часть). Порядковое числительное даёт номер сразу,
        // «финальный» — только признак: какой это сезон, знает TMDB, а не заголовок.
        if (/final\s+season|последний\s+сезон|финал(?:ьный)?\s+сезон|kanketsu/i.test(source)) {
            result.finalSeason = true;
        }

        match = source.match(/(?:сезон(?:ы|а|ов)?|seasons?)\s*[:№]?\s*(\d{1,2})(?!\d)(?:\s*[-–]\s*(\d{1,2})(?!\d))?/i) ||
            source.match(/(\d{1,2})(?:st|nd|rd|th)\s+seasons?/i) ||
            source.match(/(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\s*(?:сезон(?:ы|а|ов)?|seasons?)/i) ||
            source.match(/\bS(\d{1,2})(?:\s*[-–]\s*S?(\d{1,2}))?\b/i);
        if (match) {
            var seasonFrom = parseInt(match[1], 10);
            var seasonTo = parseInt(match[2] || match[1], 10);
            for (var season = seasonFrom; season <= seasonTo && season <= seasonFrom + 50; season++) result.seasons.push(season);
            result.explicitSeason = true;
        }

        // Азиатские раздачи считают серии как «вышло/всего»: [16/16], [30/30], [50/50]. Пак
        // покрывает серии с первой по вышедшую. Ограничение в три цифры не даёт спутать это с
        // годом или разрешением; второе число должно быть не меньше первого.
        match = source.match(/[\[(](\d{1,3})\s*\/\s*(\d{1,3})[\])]/);
        if (match) {
            var aired = parseInt(match[1], 10);
            var total = parseInt(match[2], 10);
            if (aired > 0 && total >= aired) {
                result.episodeFrom = 1;
                result.episodeTo = aired;
                result.explicitEpisode = true;
                return result;
            }
        }

        // Matches Russian/Ukrainian/English episode-marker phrasing plus "E01-E12" and "x of N" ranges.
        match = source.match(/(?:серии|серия|серії|серія|episodes?|эпизоды?)\s*[:№]?\s*(\d{1,3})(?!\d)(?:\s*[-–]\s*(\d{1,3})(?!\d))?/i) ||
            source.match(/(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?\s*(?:серии|серия|серії|серія|episodes?|эпизоды?)(?:\s*(?:из|of|з)\s*(?:\d{1,3}|\?{1,3}))?/i) ||
            source.match(/[\[(](\d{1,3})\s*[-–]\s*(\d{1,3})\s*(?:из|of|з)\s*(?:\d{1,3}|\?{1,3}|[xх]{2,3})/i) ||
            // AniLibria закрывает заголовок голым диапазоном серий: «…[HEVC][1-12]».
            source.match(/[\[(](\d{1,3})\s*[-–]\s*(\d{1,3})[\])]/) ||
            source.match(/\bE(\d{1,3})(?:\s*[-–]\s*E?(\d{1,3}))?\b/i);
        if (match) {
            result.episodeFrom = parseInt(match[1], 10);
            result.episodeTo = parseInt(match[2] || match[1], 10);
            result.explicitEpisode = true;
        }
        return result;
    }
