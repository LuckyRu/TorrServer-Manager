    import { parseSignals } from '../shared/release-signals.js';
    import { parseYear } from './release-year.js';
    import { extractStudios } from './release-studios.js';
    export { parseSignals };

    function matchOne(source, pairs) {
        for (var i = 0; i < pairs.length; i++) {
            if (pairs[i][0].test(source)) return pairs[i][1];
        }
        return '';
    }

    // Раздача почти всегда несёт несколько переводов сразу («2x Dub + 5 x MVO + AVO»), поэтому
    // тип перевода — множество. Одно значение по приоритету объявляло такую раздачу «Дубляж»
    // и делало фильтр по переводу неверным, а не просто неполным.
    var VOICE_MARKERS = [
        [/дубляж|дублированный|\bdub\b|\bdubbing\b/i, 'Дубляж'],
        [/\bmvo\b|\bdvo\b|многоголос|двухголос/i, 'Многоголосый'],
        [/\bavo\b|одноголос|авторский/i, 'Одноголосый'],
        [/\borig(?:inal)?\b|ориг(?:инал)?/i, 'Оригинал']
    ];

    // rutor и megapeer пишут перевод однобуквенными кодами в поле после вертикальной черты:
    // «| D, P, L». На этих трекерах текстовых маркеров нет вообще — без кодов фильтр слеп.
    var VOICE_CODES = { D: 'Дубляж', P: 'Многоголосый', L: 'Многоголосый', A: 'Одноголосый', O: 'Оригинал' };
    var CODE_FIELD = /^[\s]*[DPLAO]\d?(?:\s*,\s*[DPLAO]\d?)*[\s]*$/;

    function voiceCodes(source) {
        var found = [];
        String(source).split('|').forEach(function (field) {
            if (!CODE_FIELD.test(field)) return;
            field.split(',').forEach(function (code) {
                var letter = code.trim().charAt(0).toUpperCase();
                // L1 — любительский одноголосый, в отличие от многоголосого L.
                var name = letter === 'L' && /1/.test(code) ? 'Одноголосый' : VOICE_CODES[letter];
                if (name && found.indexOf(name) < 0) found.push(name);
            });
        });
        return found;
    }

    function extractVoiceTypes(source) {
        var found = [];
        VOICE_MARKERS.forEach(function (marker) {
            if (marker[0].test(source) && found.indexOf(marker[1]) < 0) found.push(marker[1]);
        });
        voiceCodes(source).forEach(function (name) {
            if (found.indexOf(name) < 0) found.push(name);
        });
        return found;
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
        var voiceTypes = extractVoiceTypes(source);
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
            voiceTypes: voiceTypes,
            // voiceType остаётся первым по приоритету значением — бейджи и старые фильтры
            // читают одно значение, множество живёт рядом в voiceTypes.
            voiceType: voiceTypes[0] || '',
            translators: extractStudios(source),
            year: parseYear(source),
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
