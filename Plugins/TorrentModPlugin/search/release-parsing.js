    // ---------- release parsing ----------

    export function parseSignals(title) {
        var source = String(title || '').replace(/_/g, ' ');
        var result = { seasons: [], episodeFrom: 0, episodeTo: 0, explicitEpisode: false, explicitSeason: false };
        var match;

        match = source.match(/\bS(\d{1,2})[ ._-]*E(\d{1,3})(?:\s*[-–]\s*(?:E)?(\d{1,3}))?/i);
        if (match) {
            result.seasons = [parseInt(match[1], 10)];
            result.episodeFrom = parseInt(match[2], 10);
            result.episodeTo = parseInt(match[3] || match[2], 10);
            result.explicitSeason = result.explicitEpisode = true;
            return result;
        }

        match = source.match(/\b(\d{1,2})x(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?/i);
        if (match) {
            result.seasons = [parseInt(match[1], 10)];
            result.episodeFrom = parseInt(match[2], 10);
            result.episodeTo = parseInt(match[3] || match[2], 10);
            result.explicitSeason = result.explicitEpisode = true;
            return result;
        }

        match = source.match(/(?:сезон|season)\s*[:№]?\s*(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?/i) ||
            source.match(/(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\s*(?:сезон|season)/i) ||
            source.match(/\bS(\d{1,2})(?:\s*[-–]\s*S?(\d{1,2}))?\b/i);
        if (match) {
            var fromSeason = parseInt(match[1], 10);
            var toSeason = parseInt(match[2] || match[1], 10);
            for (var season = fromSeason; season <= toSeason && season <= fromSeason + 50; season++) result.seasons.push(season);
            result.explicitSeason = true;
        }

        match = source.match(/(?:серии|серия|episodes?|эпизоды?)\s*[:№]?\s*(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?/i) ||
            source.match(/[\[(](\d{1,3})\s*[-–]\s*(\d{1,3})\s*(?:из|of)\s*\d{1,3}/i) ||
            source.match(/\bE(\d{1,3})(?:\s*[-–]\s*E?(\d{1,3}))?\b/i);
        if (match) {
            result.episodeFrom = parseInt(match[1], 10);
            result.episodeTo = parseInt(match[2] || match[1], 10);
            result.explicitEpisode = true;
        }
        return result;
    }

    // Quality/audio/subtitle tag extraction, tuned against real Torznab titles pulled from
    // this app's own Jackett instance (RuTracker/NoNaMe/BigFANGroup mixed results) —
    // needs-verification note: exact wording should be cross-checked against Lampa's own
    // native torrent/item.js badge set if it ever diverges visibly from what users expect.
    function matchOne(source, pairs) {
        for (var i = 0; i < pairs.length; i++) {
            if (pairs[i][0].test(source)) return pairs[i][1];
        }
        return '';
    }

    // JS \b is defined against \w ([A-Za-z0-9_] only) — it never forms a boundary next to a
    // Cyrillic character, so \bИМЯ\b silently never matches (this cost a real bug once already,
    // see CLAUDE.md). Manual boundary via "not a word character on either side" instead, safe for
    // both scripts.
    function containsWord(source, word) {
        // Multi-word studio names ("Кубик в Кубе") commonly show up with dots/underscores/hyphens
        // standing in for spaces in real release titles, not literal spaces — matched flexibly.
        var pattern = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s._-]+');
        return new RegExp('(?:^|[^a-zа-яё0-9])' + pattern + '(?:[^a-zа-яё0-9]|$)', 'i').test(source);
    }

    // Best-effort list of common Russian-scene voice-over studios/authors, matched by literal name
    // rather than mapped to a generic category (voiceType) — genuinely more useful than "Многоголосый"
    // for someone choosing between releases, the same way Online Mod's "Балансер" list names real
    // sources instead of generic buckets. Not exhaustive — extend here as new studios show up in
    // debug logging (torrent_mod_debug) rather than trying to guess a complete list up front.
    var TRANSLATOR_STUDIOS = [
        'LostFilm', 'NewStudio', 'Jaskier', 'AlexFilm', 'HDrezka', 'HDRezka', 'ColdFilm',
        'FocusStudio', 'Red Head Sound', 'RHS', 'Кубик в Кубе', 'Кураж-Бамбей', 'NewComers',
        'FreedomDub', 'SkySound', 'Wednesday Films', 'Гоблин', 'GoblinRUS', 'Пифагор',
        'ViruseProject', 'START', 'ПКино', 'ProFilms'
    ];

    function extractTranslator(source) {
        for (var i = 0; i < TRANSLATOR_STUDIOS.length; i++) {
            if (containsWord(source, TRANSLATOR_STUDIOS[i])) return TRANSLATOR_STUDIOS[i];
        }
        return '';
    }

    // "NxAudio"/"dual audio" style tags — how many audio tracks the release actually bundles, not
    // just what one of them is. Distinct from audioChannels (5.1/7.1 — channel layout of one track).
    function extractAudioTracks(source) {
        if (/\bdual[\s._-]*audio\b/i.test(source)) return 2;
        var match = source.match(/\b(\d)\s*x\s*audio\b/i) || source.match(/\b(\d)\s*audio\s*track/i);
        return match ? parseInt(match[1], 10) || 0 : 0;
    }

    export function parseRelease(title) {
        var source = String(title || '');
        var signals = parseSignals(source);
        return {
            seasons: signals.seasons,
            episodeFrom: signals.episodeFrom,
            episodeTo: signals.episodeTo,
            explicitSeason: signals.explicitSeason,
            explicitEpisode: signals.explicitEpisode,
            resolution: matchOne(source, [
                [/\b(2160p|4k|uhd)\b/i, '2160p'],
                [/\b1080p\b/i, '1080p'],
                [/\b720p\b/i, '720p'],
                [/\b480p\b/i, '480p']
            ]),
            // Encoding lineage — distinct from resolution: a 1080p WEB-DL and a 1080p Remux are not
            // the same thing to sit through, even at the same nominal resolution/bitrate estimate.
            sourceType: matchOne(source, [
                [/\bbdremux\b|\bremux\b/i, 'Remux'],
                [/\bblu-?ray\b|\bbdrip\b/i, 'BDRip'],
                [/\bweb-?dl\b/i, 'WEB-DL'],
                [/\bwebrip\b/i, 'WEBRip'],
                [/\bhdtv\b/i, 'HDTV'],
                [/\bdvdrip\b/i, 'DVDRip'],
                [/\bhdrip\b/i, 'HDRip'],
                [/\bcamrip\b|\bts\b/i, 'CAM']
            ]),
            hdr: /\bhdr10?\+?\b/i.test(source) ? 'HDR' : (/\bdolby ?vision\b|\bdv\b/i.test(source) ? 'DV' : ''),
            audioChannels: matchOne(source, [[/\b7\.1\b/, '7.1'], [/\b5\.1\b/, '5.1'], [/\b2\.0\b/, '2.0']]),
            audioTracks: extractAudioTracks(source),
            voiceType: matchOne(source, [
                [/дубляж|\bdub\b/i, 'Дубляж'],
                [/\bmvo\b|многоголос/i, 'Многоголосый'],
                [/\bavo\b|одноголос/i, 'Одноголосый'],
                [/\borig(inal)?\b|ориг(инал)?/i, 'Оригинал']
            ]),
            translator: extractTranslator(source),
            subtitles: /\bsub\b|\bsubs\b|субтитр/i.test(source),
            codec: matchOne(source, [[/\bh\.?265\b|\bhevc\b/i, 'H.265'], [/\bh\.?264\b|\bavc\b/i, 'H.264']])
        };
    }
