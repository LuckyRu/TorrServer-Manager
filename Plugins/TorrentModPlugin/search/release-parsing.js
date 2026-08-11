    import { parseSignals } from '../shared/release-signals.js';
    export { parseSignals };

    function matchOne(source, pairs) {
        for (var i = 0; i < pairs.length; i++) {
            if (pairs[i][0].test(source)) return pairs[i][1];
        }
        return '';
    }

    function wordPattern(word) {
        var pattern = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s._-]+');
        return new RegExp('(?:^|[^a-zа-яё0-9])' + pattern + '(?:[^a-zа-яё0-9]|$)', 'i');
    }

    function containsWord(source, word) {
        return wordPattern(word).test(source);
    }

    var TRANSLATOR_STUDIOS = [
        'LostFilm', 'NewStudio', 'Jaskier', 'AlexFilm', 'Jetvis Studio', 'HDrezka', 'ColdFilm',
        'FocusStudio', 'Red Head Sound', 'RHS', 'Кубик в Кубе', 'Кураж-Бамбей', 'NewComers',
        'FreedomDub', 'SkySound', 'Wednesday Films', 'Гоблин', 'GoblinRUS', 'Пифагор',
        'ViruseProject', 'START', 'ПКино', 'ProFilms', 'RuDub', 'Vodnerilo'
    ];

    function extractTranslators(source) {
        var found = [];
        for (var i = 0; i < TRANSLATOR_STUDIOS.length; i++) {
            var studio = TRANSLATOR_STUDIOS[i];
            var match = wordPattern(studio).exec(source);
            if (!match) continue;
            var index = match.index + match[0].indexOf(studio.charAt(0));
            var duplicate = found.some(function (item) { return item.name.toLowerCase() === studio.toLowerCase(); });
            if (!duplicate) found.push({ name: studio, index: index });
        }
        found.sort(function (a, b) { return a.index - b.index; });
        return found.map(function (item) { return item.name; });
    }

    function extractAudioTracks(source) {
        if (/\bdual[\s._-]*audio\b/i.test(source)) return 2;
        var match = source.match(/\b(\d{1,2})\s*x\s*(?:audio|mvo|dvo|dub(?:bing)?|voice[\s_-]*over)\b/i) ||
            source.match(/\b(\d{1,2})\s*audio\s*track/i);
        return match ? parseInt(match[1], 10) || 0 : 0;
    }

    export function parseRelease(title) {
        var source = String(title || '');
        var signals = parseSignals(source);
        var release = {
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
            sourceType: matchOne(source, [
                [/\bbdremux\b|\bremux\b/i, 'Remux'],
                [/\bblu-?ray\b|\bbdrip\b/i, 'BDRip'],
                [/\bweb-?dl\s*rip\b/i, 'WEBRip'],
                [/\bweb-?dl\b/i, 'WEB-DL'],
                [/\bwebrip\b/i, 'WEBRip'],
                [/\bhdtv(?:rip)?\b/i, 'HDTV'],
                [/\bsdtv(?:rip)?\b/i, 'SDTV'],
                [/\bdvdrip\b/i, 'DVDRip'],
                [/\bhdrip\b/i, 'HDRip'],
                [/\bcamrip\b|\bts\b/i, 'CAM']
            ]),
            hdr: /\bdolby ?vision\b|\bdv\b/i.test(source) ? 'DV' : (/\bhdr(?:10)?\+?\b/i.test(source) ? 'HDR' : ''),
            audioChannels: matchOne(source, [[/\b7\.1\b/, '7.1'], [/\b5\.1\b/, '5.1'], [/\b2\.0\b/, '2.0']]),
            audioTracks: extractAudioTracks(source),
            voiceType: matchOne(source, [
                [/дубляж|\bdub\b/i, 'Дубляж'],
                [/\bmvo\b|многоголос/i, 'Многоголосый'],
                [/\bavo\b|одноголос/i, 'Одноголосый'],
                [/\borig(inal)?\b|ориг(инал)?/i, 'Оригинал']
            ]),
            translators: extractTranslators(source),
            subtitles: /\bsub\b|\bsubs\b|субтитр/i.test(source),
            videoCodec: matchOne(source, [
                [/\bav1\b/i, 'AV1'],
                [/\bh\.?265\b|\bhevc\b/i, 'H.265'],
                [/\bh\.?264\b|\bavc\b/i, 'H.264'],
                [/\bxvid\b/i, 'XviD'],
                [/\bdivx\b/i, 'DivX'],
                [/\bmpeg-?2\b|\bmp2\b/i, 'MPEG-2'],
                [/\bvc-?1\b/i, 'VC-1'],
                [/\bwmv[1-9]?\b|\basf\b/i, 'WMV'],
                [/\brealvideo\b|\brv(?:10|20|30|40)\b/i, 'RealVideo'],
                [/\bh\.?263\b|\bsorenson\b/i, 'H.263']
            ]),
            container: matchOne(source, [
                [/\bwebm\b/i, 'WebM'],
                [/\bavi\b/i, 'AVI'],
                [/\bmkv\b/i, 'MKV'],
                [/\bmp4\b/i, 'MP4'],
                [/\bmpe?g\b/i, 'MPG'],
                [/\bvob\b/i, 'VOB'],
                [/\bflv\b/i, 'FLV'],
                [/\brmvb\b|\brm\b/i, 'RM'],
                [/\b(?:m2ts|mts)\b/i, 'TS']
            ]),
            compatibility: null,
            compatibilityReason: ''
        };
        release.compatibility = computeCompatibility(release, source);
        release.compatibilityReason = compatibilityReason(release, source);
        return release;
    }

    var RISKY_CONTAINERS = ['AVI', 'MPG', 'VOB', 'WMV', 'FLV', 'RM'];
    var RISKY_CODECS = ['XviD', 'DivX', 'MPEG-2', 'VC-1', 'WMV', 'RealVideo', 'H.263'];

    export function computeCompatibility(release, source) {
        if (release.videoCodec === 'H.264' || release.videoCodec === 'H.265') return 'likely';
        if (RISKY_CODECS.indexOf(release.videoCodec) >= 0) return 'risky';
        if (release.videoCodec === 'AV1') return 'risky'; // GST can decode it, but transcoding cost is higher than remuxing H.264/H.265.
        if (RISKY_CONTAINERS.indexOf(release.container) >= 0) return 'risky';
        if (release.sourceType === 'DVDRip') return 'risky'; // raw DVD rip without stated codec
        if (/\b(?:raw|video_ts|iso|dvd5|dvd9)\b/i.test(source)) return 'risky';
        return 'unknown';
    }

    export function compatibilityReason(release, source) {
        if (RISKY_CODECS.indexOf(release.videoCodec) >= 0) return release.videoCodec;
        if (release.videoCodec === 'AV1') return 'AV1';
        if (RISKY_CONTAINERS.indexOf(release.container) >= 0) return release.container;
        if (release.sourceType === 'DVDRip') return 'DVDRip без кодека';
        if (/\b(?:raw|video_ts|iso|dvd5|dvd9)\b/i.test(source)) return 'RAW DVD';
        return '';
    }
