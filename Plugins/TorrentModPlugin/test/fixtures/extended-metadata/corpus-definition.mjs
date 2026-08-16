import { catalogs } from './source-catalogs.mjs';

export const TRACKERS = [
    'rutracker', 'tapochek', 'exkinoray', 'rutor', 'megapeer',
    'noname-club', 'bigfangroup', 'anidub', 'anilibria'
];

export const FAMILIES = ['anime', 'donghua', 'asian-live', 'western-animation', 'general'];

// Hand-authored semantic labels. These are deliberately independent of parseRelease: the generator
// may copy them, but it must never calculate expected values by invoking production parsing code.
export const SEMANTICS = [
    {
        signal: '[Movie]', seasons: [], episodeFrom: 0, episodeTo: 0,
        explicitSeason: false, explicitEpisode: false, finalSeason: false, releaseType: 'movie',
        quality: 'BDRemux 2160p Dolby Vision H.265 MKV 7.1 3 x audio',
        resolution: '2160p', sourceType: 'Remux', hdr: 'DV', audioChannels: '7.1', audioTracks: 3,
        voiceTypes: ['Дубляж', 'Многоголосый', 'Одноголосый', 'Оригинал'],
        voiceText: 'Dub + MVO + AVO + Original', subtitles: true, videoCodec: 'H.265', container: 'MKV',
        compatibility: 'likely', compatibilityReason: '', credits: true, releaseGroup: true
    },
    {
        signal: '[TV] S02E03-E10', seasons: [2], episodeFrom: 3, episodeTo: 10,
        explicitSeason: true, explicitEpisode: true, finalSeason: false, releaseType: 'tv',
        quality: 'WEB-DL 1080p HDR10 H.264 MP4 5.1 dual audio',
        resolution: '1080p', sourceType: 'WEB-DL', hdr: 'HDR', audioChannels: '5.1', audioTracks: 2,
        voiceTypes: ['Многоголосый'], voiceText: 'MVO', subtitles: true,
        videoCodec: 'H.264', container: 'MP4', compatibility: 'likely', compatibilityReason: '',
        credits: true, releaseGroup: false
    },
    {
        signal: '[OVA] S1-3E1-24', seasons: [1, 2, 3], episodeFrom: 1, episodeTo: 24,
        explicitSeason: true, explicitEpisode: true, finalSeason: false, releaseType: 'ova',
        quality: 'WEBRip 720p AV1 WebM 2.0 1 x audio',
        resolution: '720p', sourceType: 'WEBRip', hdr: '', audioChannels: '2.0', audioTracks: 1,
        voiceTypes: ['Одноголосый'], voiceText: 'AVO', subtitles: false,
        videoCodec: 'AV1', container: 'WebM', compatibility: 'risky', compatibilityReason: 'AV1',
        credits: true, releaseGroup: false
    },
    {
        signal: '[Special] The Final Season E01-E02', seasons: [], episodeFrom: 1, episodeTo: 2,
        explicitSeason: false, explicitEpisode: true, finalSeason: true, releaseType: 'special',
        quality: 'DVDRip 480p XviD AVI 2.0 2 x audio',
        resolution: '480p', sourceType: 'DVDRip', hdr: '', audioChannels: '2.0', audioTracks: 2,
        voiceTypes: ['Оригинал'], voiceText: 'Original', subtitles: true,
        videoCodec: 'XviD', container: 'AVI', compatibility: 'risky', compatibilityReason: 'XviD',
        credits: true, releaseGroup: true
    },
    {
        signal: '[TV] [16/16]', seasons: [], episodeFrom: 1, episodeTo: 16,
        explicitSeason: false, explicitEpisode: true, finalSeason: false, releaseType: 'tv',
        quality: 'HDTV 1080p HDR H.264 M2TS 5.1 4 x audio',
        resolution: '1080p', sourceType: 'HDTV', hdr: 'HDR', audioChannels: '5.1', audioTracks: 4,
        voiceTypes: ['Дубляж'], voiceText: 'Dub', subtitles: true,
        videoCodec: 'H.264', container: 'TS', compatibility: 'likely', compatibilityReason: '',
        credits: true, releaseGroup: false
    },
    {
        signal: '[Movie]', seasons: [], episodeFrom: 0, episodeTo: 0,
        explicitSeason: false, explicitEpisode: false, finalSeason: false, releaseType: 'movie',
        quality: 'Blu-ray BDRip 2160p HDR10+ HEVC MKV 7.1 dual audio',
        resolution: '2160p', sourceType: 'BDRip', hdr: 'HDR', audioChannels: '7.1', audioTracks: 2,
        voiceTypes: ['Многоголосый', 'Оригинал'], voiceText: 'MVO + Original', subtitles: false,
        videoCodec: 'H.265', container: 'MKV', compatibility: 'likely', compatibilityReason: '',
        credits: true, releaseGroup: false
    },
    {
        signal: '[TV] TV-3 [1-12 из 12]', seasons: [3], episodeFrom: 1, episodeTo: 12,
        explicitSeason: true, explicitEpisode: true, finalSeason: false, releaseType: 'tv',
        quality: 'SDTV MPEG-2 MPG 2.0',
        resolution: '', sourceType: 'SDTV', hdr: '', audioChannels: '2.0', audioTracks: 0,
        voiceTypes: [], voiceText: '', subtitles: false,
        videoCodec: 'MPEG-2', container: 'MPG', compatibility: 'risky', compatibilityReason: 'MPEG-2',
        credits: false, releaseGroup: false
    },
    {
        signal: '[ONA] 2x07', seasons: [2], episodeFrom: 7, episodeTo: 7,
        explicitSeason: true, explicitEpisode: true, finalSeason: false, releaseType: 'ova',
        quality: 'HDRip 1080p AVC MP4 5.1 dual audio',
        resolution: '1080p', sourceType: 'HDRip', hdr: '', audioChannels: '5.1', audioTracks: 2,
        voiceTypes: ['Дубляж', 'Оригинал'], voiceText: 'Dub + Original', subtitles: true,
        videoCodec: 'H.264', container: 'MP4', compatibility: 'likely', compatibilityReason: '',
        credits: true, releaseGroup: true
    },
    {
        signal: '[Movie]', seasons: [], episodeFrom: 0, episodeTo: 0,
        explicitSeason: false, explicitEpisode: false, finalSeason: false, releaseType: 'movie',
        quality: 'CAMRip 480p H.263 FLV 2.0',
        resolution: '480p', sourceType: 'CAM', hdr: '', audioChannels: '2.0', audioTracks: 0,
        voiceTypes: ['Одноголосый'], voiceText: 'AVO', subtitles: false,
        videoCodec: 'H.263', container: 'FLV', compatibility: 'risky', compatibilityReason: 'H.263',
        credits: true, releaseGroup: false
    },
    {
        signal: '[Special] E22', seasons: [], episodeFrom: 22, episodeTo: 22,
        explicitSeason: false, explicitEpisode: true, finalSeason: false, releaseType: 'special',
        quality: 'WEB-DLRip 2160p Dolby Vision AV1 WebM 7.1 5 x audio',
        resolution: '2160p', sourceType: 'WEBRip', hdr: 'DV', audioChannels: '7.1', audioTracks: 5,
        voiceTypes: ['Многоголосый'], voiceText: 'MVO', subtitles: true,
        videoCodec: 'AV1', container: 'WebM', compatibility: 'risky', compatibilityReason: 'AV1',
        credits: true, releaseGroup: false
    }
];

const MOVIE_SEMANTICS = [SEMANTICS[0], SEMANTICS[5], SEMANTICS[8]];
const SERIES_SEMANTICS = [
    SEMANTICS[1], SEMANTICS[2], SEMANTICS[3], SEMANTICS[4],
    SEMANTICS[6], SEMANTICS[7], SEMANTICS[9]
];

export function semanticFor(work) {
    var compatible = work.mode === 'movie' ? MOVIE_SEMANTICS : SERIES_SEMANTICS;
    return compatible[(work.rank - 1) % compatible.length];
}

const ANIME_TRACKERS = { anidub: true, anilibria: true };

function yearLabel(year, variant) {
    if (variant === 1) return '(' + year + ')';
    if (variant === 2) return '[' + year + ', video]';
    if (variant === 3) return '| ' + year + ' |';
    if (variant === 4) return '[США, ' + year + ', video]';
    return '(' + year + ' г.)';
}

function codesFor(voiceTypes) {
    var codes = {
        'Дубляж': 'D', 'Многоголосый': 'P', 'Одноголосый': 'L1', 'Оригинал': 'O'
    };
    return voiceTypes.map(function (voice) { return codes[voice]; }).join(', ');
}

function textCredits(semantic) {
    if (!semantic.credits) return semantic.voiceText;
    return (semantic.voiceText + ' (LostFilm)').trim();
}

function commonParts(work, semantic, variant) {
    return {
        namesSlash: work.title + ' / ' + work.title + ' Alt',
        namesPipe: work.title + ' | ' + work.title + ' Alt',
        signal: semantic.signal,
        year: yearLabel(work.year, variant),
        quality: semantic.quality,
        sub: semantic.subtitles ? 'Sub' : '',
        group: semantic.releaseGroup ? 'от Scarabey,' : ''
    };
}

function join(parts, separator) {
    return parts.filter(Boolean).join(separator || ' ').replace(/\s{2,}/g, ' ').trim();
}

export function renderTitle(tracker, work, semantic, variant) {
    var p = commonParts(work, semantic, variant);
    var credits = textCredits(semantic);
    var parts;

    if (tracker === 'rutracker') {
        parts = [variant === 5 ? '[SERIAL]' : '', variant % 2 ? p.namesSlash : p.namesPipe,
            p.signal, p.year, p.quality, credits, p.group, p.sub];
        return join(parts);
    }
    if (tracker === 'tapochek') {
        var bracketCredit = semantic.credits
            ? '[' + (semantic.voiceText.split(' + ')[0] || 'MVO') + '|LostFilm]'
            : semantic.voiceText;
        var remainingVoice = semantic.credits ? semantic.voiceText.split(' + ').slice(1).join(' + ') : '';
        return join([variant % 2 ? p.namesSlash : p.namesPipe, p.signal, p.year, p.quality,
            bracketCredit, remainingVoice, p.group, p.sub]);
    }
    if (tracker === 'exkinoray') {
        return join([p.namesPipe, p.signal, p.year, p.quality, credits, p.group, p.sub, '- ExKinoRay']);
    }
    if (tracker === 'rutor' || tracker === 'megapeer') {
        var codeField = semantic.voiceTypes.length ? '| ' + codesFor(semantic.voiceTypes) + ' |' : '';
        var studioField = semantic.credits ? 'LostFilm |' : '';
        return join([p.namesSlash, p.signal, p.year, p.quality, codeField, studioField, p.group, p.sub]);
    }
    if (tracker === 'noname-club') {
        var nnNames = variant % 2 ? p.namesSlash : p.namesPipe;
        return join([nnNames, p.signal, p.year, '[' + semantic.videoCodec + '/' +
            (semantic.resolution || 'SD') + ']', p.quality, credits, p.group, p.sub]);
    }
    if (tracker === 'bigfangroup') {
        var tail = semantic.credits ? '| LostFilm' : '';
        return join([p.namesSlash + ',', p.signal, p.year, p.quality, semantic.voiceText,
            p.group, p.sub, tail, '…']);
    }
    if (tracker === 'anidub') {
        return join([p.namesSlash, p.signal, '[RUS]', '[' + p.quality + ']', credits, p.group, p.sub]);
    }
    if (tracker === 'anilibria') {
        return join([work.title + ' / E01-E12 ' + work.title + ' Alt - AniLiberty.TOP',
            '[' + p.quality + ']', p.signal, credits, p.group, p.sub]);
    }
    throw new Error('Unknown tracker: ' + tracker);
}

export function expectedRelease(tracker, semantic, year) {
    var noYear = ANIME_TRACKERS[tracker] === true;
    var voiceTypes = semantic.voiceTypes.slice();
    var translators = semantic.credits ? ['LostFilm'] : [];
    if (!voiceTypes.length && noYear) voiceTypes = ['Многоголосый'];
    if (!translators.length && noYear) translators = [tracker === 'anidub' ? 'AniDUB' : 'AniLibria'];
    return {
        seasons: semantic.seasons.slice(),
        episodeFrom: semantic.episodeFrom,
        episodeTo: semantic.episodeTo,
        explicitSeason: semantic.explicitSeason,
        explicitEpisode: semantic.explicitEpisode,
        finalSeason: semantic.finalSeason,
        releaseType: semantic.releaseType,
        resolution: semantic.resolution,
        sourceType: semantic.sourceType,
        hdr: semantic.hdr,
        audioChannels: semantic.audioChannels,
        audioTracks: semantic.audioTracks,
        voiceTypes: voiceTypes,
        voiceType: voiceTypes[0] || '',
        translators: translators,
        releaseGroups: semantic.releaseGroup ? ['Scarabey'] : [],
        year: noYear
            ? { value: null, to: null, isRange: false, from: 'tracker-has-no-year', confidence: 'none' }
            : { value: year, to: year, isRange: false, from: 'delimited', confidence: 'high' },
        subtitles: semantic.subtitles,
        videoCodec: semantic.videoCodec,
        container: semantic.container,
        compatibility: semantic.compatibility,
        compatibilityReason: semantic.compatibilityReason
    };
}

const FAMILY_PROFILE = {
    anime: { language: 'ja', countries: ['JP'], genreIds: [16], original: '進撃作品' },
    donghua: { language: 'zh', countries: ['CN'], genreIds: [16], original: '动画作品' },
    'asian-live': { language: 'ko', countries: ['KR'], genreIds: [18], original: '인기 작품' },
    'western-animation': { language: 'en', countries: ['US'], genreIds: [16], original: '' },
    general: { language: 'en', countries: ['US'], genreIds: [18], original: '' }
};

export function targetFor(family, work, semantic) {
    var profile = FAMILY_PROFILE[family];
    var date = work.year + '-01-01';
    var original = profile.original ? profile.original + ' ' + work.rank : work.title;
    var movie = {
        title: work.title,
        name: work.title,
        original_title: original,
        original_name: original,
        original_language: profile.language,
        origin_country: profile.countries.slice(),
        genre_ids: profile.genreIds.slice(),
        release_date: date,
        first_air_date: date,
        seasons: [1, 2, 3].map(function (number) {
            return { season_number: number, air_date: date, episode_count: 24 };
        })
    };
    var season = 0;
    var episode = 0;
    if (work.mode === 'series') {
        season = semantic.seasons.length ? semantic.seasons[0] : (semantic.finalSeason ? 3 : 1);
        episode = semantic.explicitEpisode ? semantic.episodeFrom : 1;
    }
    return {
        mode: work.mode,
        season: season,
        episode: episode,
        movie: movie,
        englishTitle: work.title,
        aliases: [work.title + ' Alias']
    };
}

function manualTitleKey(value) {
    return String(value || '').toLowerCase()
        .replace(/[^a-z0-9а-яё\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]+/gi, ' ')
        .trim();
}

// Ручной oracle нового слоя selection. Он строится только из таблицы SEMANTICS, семейства и
// задокументированного профиля трекера; production compileReleaseSelection не импортируется.
export function expectedSelection(family, tracker, work, semantic, target) {
    var animeTracker = ANIME_TRACKERS[tracker] === true;
    var claims = [];
    if (work.mode === 'movie') {
        claims.push({ kind: 'movie', confidence: 'high', source: 'work-mode' });
    } else if (semantic.explicitSeason && semantic.seasons.length) {
        claims.push({
            kind: 'season-local', seasons: semantic.seasons.slice(),
            episodeFrom: semantic.explicitEpisode ? semantic.episodeFrom : 0,
            episodeTo: semantic.explicitEpisode ? semantic.episodeTo : 0,
            confidence: 'high', source: 'title-season-episode'
        });
    } else if (semantic.finalSeason) {
        claims.push({
            kind: 'final-season', season: 3,
            episodeFrom: semantic.explicitEpisode ? semantic.episodeFrom : 0,
            episodeTo: semantic.explicitEpisode ? semantic.episodeTo : 0,
            confidence: 'high', source: 'title-final-season'
        });
    } else if (semantic.explicitEpisode) {
        var asian = family === 'anime' || family === 'donghua' || family === 'asian-live';
        if (asian || animeTracker) {
            claims.push({
                kind: 'season-local', seasons: [1],
                episodeFrom: semantic.episodeFrom, episodeTo: semantic.episodeTo,
                confidence: 'high', source: 'tracker-default-season-1'
            });
        } else {
            claims.push({
                kind: 'seasonless-local', episodeFrom: semantic.episodeFrom, episodeTo: semantic.episodeTo,
                confidence: 'medium', source: 'title-episode-without-season'
            });
        }
        if (family === 'anime' || family === 'donghua' || animeTracker) {
            claims.push({
                kind: 'absolute', episodeFrom: semantic.episodeFrom, episodeTo: semantic.episodeTo,
                confidence: 'medium', source: 'anime-seasonless-episode'
            });
        }
    } else {
        claims.push({ kind: 'unknown-series-coverage', confidence: 'low', source: 'title-no-season-episode' });
    }
    return {
        version: 1,
        family: family,
        tracker: { id: tracker, group: animeTracker ? 'anime' : 'general' },
        title: {
            accepted: true, kind: 'exact', score: 1, matchedTitle: work.title,
            matchedTitleKey: manualTitleKey(work.title), matchedTitleKind: 'canonical', matchedSegment: work.title
        },
        coverage: { claims: claims }
    };
}

export function familyTracker(family, variant) {
    var anime = ['anilibria', 'anidub', 'rutracker', 'tapochek', 'noname-club'];
    var general = ['rutracker', 'tapochek', 'rutor', 'exkinoray', 'noname-club'];
    return (family === 'anime' || family === 'donghua' ? anime : general)[variant - 1];
}

export function trackerFamily(tracker) {
    return ANIME_TRACKERS[tracker] ? 'anime' : 'general';
}

export function trackerCatalog(tracker) {
    return ANIME_TRACKERS[tracker] ? catalogs.anime : catalogs.general;
}

export { catalogs };
