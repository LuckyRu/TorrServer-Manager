    // ---------- release parsing ----------
    //
    // parseSignals itself now lives in shared/release-signals.js — playback/file-selection.js needs
    // it too (via smart-preload.js) to score which file inside a multi-file torrent matches the
    // target episode, which made playback/ import from search/ (a layer violation: found in review).
    // Re-exported here so parseRelease (below, search-only) and existing importers of it from this
    // file keep working unchanged.
    import { parseSignals } from '../shared/release-signals.js';
    export { parseSignals };

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
            // Encoding lineage — distinct from resolution: a 1080p WEB-DL and a 1080p Remux are not
            // the same thing to sit through, even at the same nominal resolution/bitrate estimate.
            sourceType: matchOne(source, [
                [/\bbdremux\b|\bremux\b/i, 'Remux'],
                [/\bblu-?ray\b|\bbdrip\b/i, 'BDRip'],
                // WEB-DLRip must win over plain WEB-DL — without this branch, "WEB-DL" matches as a
                // substring of "WEB-DLRip" first (the \b before a following letter never forms, but
                // the shorter word itself does), mislabeling the lower-grade WEBRip as WEB-DL.
                [/\bweb-?dl\s*rip\b/i, 'WEBRip'],
                [/\bweb-?dl\b/i, 'WEB-DL'],
                [/\bwebrip\b/i, 'WEBRip'],
                [/\bhdtv\b/i, 'HDTV'],
                [/\bdvdrip\b/i, 'DVDRip'],
                [/\bhdrip\b/i, 'HDRip'],
                [/\bcamrip\b|\bts\b/i, 'CAM']
            ]),
            hdr: /\bdolby ?vision\b|\bdv\b/i.test(source) ? 'DV' : (/\bhdr10?\+?\b/i.test(source) ? 'HDR' : ''),
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
            // Video codec — extended beyond H.264/H.265 to catch "древнее говно" (XviD/DivX/MPEG-2/
            // VC-1/WMV/RealVideo) that WebOS cannot play without TorrServer transcoding. The word
            // boundary is deliberately ASCII-safe on codec names (they're latin).
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
            // Container from the title (AVI/MP4/MKV/...) — a title-level heuristic, NOT proof (AVI
            // can hold H.264, MP4 doesn't guarantee it). 'TS' is deliberately not parsed as a
            // container: in release titles it means телесинк (a source type), not Transport Stream.
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
            // Title-level compatibility guess: 'risky' for old containers/codecs WebOS won't play
            // without transcoding (and AV1 on older sets), 'likely' for explicit H.264/H.265,
            // 'unknown' when the title says nothing reliable. Real compatibility is only known
            // after the file is picked (ffprobe) — see smart-preload.js.
            compatibility: null,
            compatibilityReason: ''
        };
        release.compatibility = computeCompatibility(release, source);
        release.compatibilityReason = compatibilityReason(release, source);
        return release;
    }

    var RISKY_CONTAINERS = ['AVI', 'MPG', 'VOB', 'WMV', 'FLV', 'RM'];
    var RISKY_CODECS = ['XviD', 'DivX', 'MPEG-2', 'VC-1', 'WMV', 'RealVideo', 'H.263'];

    // Title-level compatibility guess — a heuristic, NOT proof (the real codec is only known from
    // ffprobe of the picked file, see smart-preload.js's probe gate). Order matters: an explicit
    // H.264/H.265 wins (even a "DVDRip" re-encode is fine), then known-bad containers/codecs, then
    // raw-DVD hints (a "DVDRip" with NO codec/container stated is almost always MPEG-2 in VOB).
    export function computeCompatibility(release, source) {
        if (release.videoCodec === 'H.264' || release.videoCodec === 'H.265') return 'likely';
        if (RISKY_CODECS.indexOf(release.videoCodec) >= 0) return 'risky';
        if (release.videoCodec === 'AV1') return 'risky'; // old WebOS sets lack AV1 decode
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
