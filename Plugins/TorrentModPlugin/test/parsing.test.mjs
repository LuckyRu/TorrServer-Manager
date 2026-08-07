// ---------- parsing tests (npm run test:plugin) ----------
//
// Node harness for the pure parsing functions (search/release-parsing.js). The plugin sources are
// real ES modules in .js files without a package.json "type" — Node 22+ auto-detects the module
// syntax, so no bundling step is needed; run from the repo root:  node Plugins/TorrentModPlugin/test/parsing.test.mjs
//
// Fixtures (test/fixtures/*.json) were collected live from this project's own Jackett instance
// (RuTracker/NoNaMe/BigFANGroup/MegaPeer/Anilibria) in 2026-08 — one set per use case: fresh
// movies, decade-top movies, classic movies, series, anime. Only Russian. See
// docs/system-design/torrent-mod-unified-pool.md (Этап 0).
import { parseSignals, parseRelease } from '../search/release-parsing.js';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const fixturesDir = path.join(import.meta.dirname, 'fixtures');
const GROUPS = ['movies-new', 'movies-decade', 'movies-classic', 'series', 'anime'];

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log('  ok  ' + name);
    } catch (e) {
        failed++;
        failures.push({ name, error: e });
        console.error('  FAIL ' + name + '\n       ' + String(e.message).split('\n').join('\n       '));
    }
}

// ---------- 1. зоопарк не падает ----------
for (const group of GROUPS) {
    const titles = JSON.parse(fs.readFileSync(path.join(fixturesDir, group + '.json'), 'utf8'));
    test(`зоопарк "${group}" (${titles.length} заголовков) — без исключений`, () => {
        for (const title of titles) {
            assert.ok(parseSignals(title), 'parseSignals вернул пусто');
            assert.ok(parseRelease(title), 'parseRelease вернул пусто');
        }
    });
}

// ---------- 2. parseSignals: сезоны/эпизоды, золотые кейсы с реальных раздач ----------
const signalCases = [
    ['Во все тяжкие / Breaking Bad (2008-2013) BDRip (S1-5E1-62 of 62) Селена Интернэшнл',
        { seasons: [1, 2, 3, 4, 5], epFrom: 1, epTo: 62, explicitSeason: true, explicitEpisode: true }],
    ['Наруто / Naruto (2002-2007, TV) DVDRip (E111-220 of 220) 2x2 [H.265/2160p] [4K, SDR, 10-bit]',
        { seasons: [], epFrom: 111, epTo: 220, explicitSeason: false, explicitEpisode: true }],
    ['Наруто / Naruto (2003-2004) DVDRip [AV1/2160p] [4K, SDR, 10-bit] (S4-5E1-5,11,89) 2x2 [handmade Upscale AI] [MVO]',
        { seasons: [4, 5], epFrom: 1, epTo: 5, explicitSeason: true, explicitEpisode: true }],
    ['Игра престолов / Game of Thrones [S1-8] (2011-2019) BDRip, WEB-DL-LostFilm',
        { seasons: [1, 2, 3, 4, 5, 6, 7, 8], epFrom: 0, epTo: 0, explicitSeason: true, explicitEpisode: false }],
    ['Игра престолов / Game of Thrones  / S8E1-6 of 6 (2019) WEB-DL  Kravec',
        { seasons: [8], epFrom: 1, epTo: 6, explicitSeason: true, explicitEpisode: true }],
    ['Злодейка наслаждается своей седьмой жизнью / E01-E12 Loop 7-kaime no Akuyaku Reijou [WEBRip 1080p][HEVC][1-12]',
        { seasons: [], epFrom: 1, epTo: 12, explicitSeason: false, explicitEpisode: true }],
    ['Дюна: Пророчество / Dune: Prophecy [S1] (2024) WEB-DL-HEVC 2160p | 4K | Dolby Vision P5',
        { seasons: [1], epFrom: 0, epTo: 0, explicitSeason: true, explicitEpisode: false }],
    ['Футурама / Futurama, S7E1-26 of 26 (2012-2013) WEB-DL 720p',
        { seasons: [7], epFrom: 1, epTo: 26, explicitSeason: true, explicitEpisode: true }]
];
for (const [title, expected] of signalCases) {
    test('signals: ' + title.slice(0, 60) + '…', () => {
        const s = parseSignals(title);
        assert.deepEqual(s.seasons, expected.seasons);
        assert.equal(s.episodeFrom, expected.epFrom);
        assert.equal(s.episodeTo, expected.epTo);
        assert.equal(s.explicitSeason, expected.explicitSeason);
        assert.equal(s.explicitEpisode, expected.explicitEpisode);
    });
}

// ---------- 3. parseRelease: качество/источник/кодек/HDR/перевод, золотые кейсы ----------
const releaseCases = [
    ['Дюна: Часть вторая / Dune: Part Two (2024) Blu-Ray Remux 2160p | 4K | HDR | Dolby Vision P7',
        { resolution: '2160p', sourceType: 'Remux', hdr: 'DV' }],
    ['Дюна / Dune: Part One (Дени Вильнёв) [2021, Фантастика, боевик, драма, приключения, BDRip] Dub (Пифагор) + Sub (Rus/Eng) + hardsub (Rus)',
        { sourceType: 'BDRip', voiceType: 'Дубляж', translator: 'Пифагор', subtitles: true }],
    ['Интерстеллар / Interstellar (2014) BDRip [H.265/1080p] [10-bit] [IMAX Edition]',
        { resolution: '1080p', sourceType: 'BDRip', codec: 'H.265' }],
    ['Гладиатор 2 / Gladiator II (2024) WEBRip [H.264/1080p]',
        { resolution: '1080p', sourceType: 'WEBRip', codec: 'H.264' }],
    ['Дюна: Пророчество / Dune: Prophecy [S1] (2024) WEB-DL-HEVC 2160p | 4K | Dolby Vision P5',
        { resolution: '2160p', sourceType: 'WEB-DL', codec: 'H.265', hdr: 'DV' }],
    ['Во всё тяжкое / Ричард прощается / The Professor (Уэйн Робертс) [2018, Драма, комедия, BDRip] [DUB] [iTunes]',
        { sourceType: 'BDRip', voiceType: 'Дубляж' }],
    ['Сериал S01 1080p WEB-DL Кубик.в.Кубе',
        { resolution: '1080p', sourceType: 'WEB-DL', translator: 'Кубик в Кубе' }]
];
for (const [title, expected] of releaseCases) {
    test('release: ' + title.slice(0, 60) + '…', () => {
        const r = parseRelease(title);
        for (const [key, value] of Object.entries(expected)) {
            assert.equal(r[key], value, `поле "${key}"`);
        }
    });
}

// ---------- 4. Синтетические форматы (зоопарк стандартов оформления) ----------
const formatCases = [
    // SxxExx с диапазоном эпизодов
    ['Сериал.S01E01-E02.720p.WEB-DL', { seasons: [1], epFrom: 1, epTo: 2 }],
    // 4x01-07 (формат "сезон x серия")
    ['Сериал 4x01-07 1080p', { seasons: [4], epFrom: 1, epTo: 7 }],
    // однозначный эпизод в x-формате с ведущим нулём
    ['Сериал 4x05 HDTV', { seasons: [4], epFrom: 5, epTo: 5 }],
    // одиночный "2x2" — рип-группа, НЕ сезон×эпизод
    ['Сериал 2x2 720p', { seasons: [], epFrom: 0, epTo: 0, explicitSeason: false, explicitEpisode: false }],
    // «N сезон» до и после числа, с диапазоном
    ['Сериал 2 сезон 1080p', { seasons: [2] }],
    ['Сериал сезон 3 1080p', { seasons: [3] }],
    ['Сериал 1-4 сезон 1080p', { seasons: [1, 2, 3, 4] }],
    // украинский: «Серія 4 з 8»
    ['Сериал (2024) Серія 4 з 8 WEBRip', { epFrom: 4, epTo: 4, explicitEpisode: true }],
    // «1-4 серия из 10» (число перед словом + «из N»)
    ['Сериал 1-4 серия из 10 (2024) HDTV', { epFrom: 1, epTo: 4 }],
    // E-диапазон без сезона (аниме-паки)
    ['Сериал E01-E11 [WEBRip 1080p][HEVC][1-11]', { epFrom: 1, epTo: 11, explicitSeason: false }],
    // WEB-DLRip не должен поглощаться как WEB-DL
    ['Фильм (2024) WEB-DLRip 1080p', { sourceType: 'WEBRip' }],
    // кириллический \b: «Дубляж» распознаётся
    ['Фильм (2024) 1080p Дубляж', { voiceType: 'Дубляж' }],
    // dual audio
    ['Фильм (2024) 1080p Dual Audio', { audioTracks: 2 }],
    // «NxAudio»
    ['Фильм (2024) 1080p 2xAudio', { audioTracks: 2 }],
    // Dolby Vision
    ['Фильм (2024) 1080p HDR10 Dolby Vision', { hdr: 'DV' }],
    // HDR10
    ['Фильм (2024) 1080p HDR10', { hdr: 'HDR' }],
    // 5.1 каналы
    ['Фильм (2024) 1080p 5.1 AC3', { audioChannels: '5.1' }]
];
for (const [title, expected] of formatCases) {
    test('format: ' + title, () => {
        const s = parseSignals(title);
        const r = parseRelease(title);
        const combined = { seasons: s.seasons, epFrom: s.episodeFrom, epTo: s.episodeTo, explicitSeason: s.explicitSeason, explicitEpisode: s.explicitEpisode, ...r };
        for (const [key, value] of Object.entries(expected)) {
            if (Array.isArray(value)) assert.deepEqual(combined[key], value, `поле "${key}"`);
            else assert.equal(combined[key], value, `поле "${key}"`);
        }
    });
}

console.log(`\nИтог: ${passed} passed, ${failed} failed`);
if (failed) {
    console.log('\nПроваленные тесты:');
    for (const f of failures) console.log(' - ' + f.name);
    process.exit(1);
}
