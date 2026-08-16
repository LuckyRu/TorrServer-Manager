// Регрессии на дефекты, найденные прогоном по живой выдаче девяти трекеров.
// Разбор и замеры — docs/system-design/torrent-mod-search-architecture.md.

import './helpers/mock-lampa.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

import { parseRelease, parseSignals } from '../search/parse/release-parsing.js';
import { parseYear, yearMatches } from '../search/parse/release-year.js';
import { extractCredits } from '../search/parse/release-credits.js';
import { registerCredits, creditInfo, CREDIT_KINDS } from '../search/parse/credits-registry.js';
import { titleSimilarity, evaluateTitleMatch, passesSearchTitleGate, extractSearchTitleSegments, evaluateMediaTypeGate } from '../search/gates/search-gates.js';
import { profileFor, indexersInGroup, registerTrackerRules } from '../search/rules/tracker-profiles.js';
import { evaluateIdentityGate, narrowToExactMatches, targetYear } from '../search/gates/gate-identity.js';
import { evaluateCandidatePool } from '../search/rank/scoring.js';
import { workFamily, isAnimeTarget } from '../search/profile/work-profile.js';
import { compileReleaseSelection, coverageDecision } from '../search/profile/release-selection.js';
import { buildQueries } from '../search/plan/query-building.js';
import { buildMovieQueries } from '../search/plan/movie-query-building.js';
import { buildSeriesQueries } from '../search/plan/series-query-building.js';
import { buildSearchPlan } from '../search/plan/indexer-search-strategies.js';
import { funnelText, buildFilterItems } from '../domain/results-core.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log('  ok  ' + name);
    } catch (e) {
        failed++;
        console.error('  FAIL ' + name + '\n       ' + String(e.message).split('\n').join('\n       '));
    }
}

// ---------- год ----------

test('год читается из всех трёх синтаксисов трекеров', () => {
    assert.equal(parseYear('Игра / Squid Game / S3E1-6 of 6 [2025, Южная Корея, драма, WEB-DL 2160p]').value, 2025);
    assert.equal(parseYear('Дюна / Dune: Part One (2021) BDRip 1080p').value, 2021);
    assert.equal(parseYear('Дюна: Часть вторая | Dune: Part Two | 2024 | WEB-DL (1080p) | DUB').value, 2024);
    assert.equal(parseYear('Неукротимый / The Untamed [50/50] [Китай, 2019, фэнтези, HDTV]').value, 2019);
    assert.equal(parseYear('Дюна: Часть вторая (Дени Вильнёв) [2024 г., фантастика, BDRemux 2160p]').value, 2024);
});

test('многолетний пак сохраняет диапазон', () => {
    const range = parseYear('Футурама / Futurama (2008-2013) BDRip (S1-5E1-62 of 62)');
    assert.equal(range.value, 2008);
    assert.equal(range.to, 2013);
    assert.equal(range.isRange, true);
    // Пак покрывает любой свой сезон.
    assert.equal(yearMatches(range, 2011), true);
    assert.equal(yearMatches(range, 2001), false);
});

test('год не выдумывается из разрешения, битрейта и названия-числа', () => {
    assert.equal(parseYear('Сериал / Series S01 1920x1080 H.264').value, null);
    assert.equal(parseYear('Аниме [TV] [1-12 из 12] 1080p WEB-DL').value, null);
    assert.equal(parseYear('Название / Title 2160p HDR10 10-bit').value, null);
    // «1917» — название фильма, год берётся из скобок.
    assert.equal(parseYear('1917 (2019) WEB-DL 1080p').value, 2019);
});

test('у аниме-трекеров года нет, и это не ошибка', () => {
    const parsed = parseYear('Не издевайся, Нагаторо / E01-E12 Ijiranaide, Nagatoro-san - AniLiberty.TOP [WEBRip 1080p][HEVC][1-12]');
    assert.equal(parsed.value, null);
    assert.equal(parsed.from, 'absent');
    // Неизвестный год никогда не отбраковывает кандидата.
    assert.equal(yearMatches(parsed, 2021), null);
});

// ---------- нумерация серий ----------

test('азиатская нотация [16/16] читается как серии 1-16', () => {
    const dorama = parseSignals('Королева слёз | Queen of Tears (Ким Хи Вон) [16/16] [2024, Южная Корея, драма, HDTV]');
    assert.equal(dorama.explicitEpisode, true);
    assert.equal(dorama.episodeFrom, 1);
    assert.equal(dorama.episodeTo, 16);

    const chinese = parseSignals('Неукротимый: Повелитель Чэньцин / The Untamed [50/50] [Китай, 2019, фэнтези, HDTV]');
    assert.equal(dorama.explicitEpisode, true);
    assert.equal(chinese.episodeTo, 50);
});

test('голый диапазон в скобках AniLibria читается, а технические скобки — нет', () => {
    assert.equal(parseSignals('Title - AniLiberty.TOP [WEBRip 1080p][HEVC][1-12]').episodeTo, 12);
    assert.equal(parseSignals('Дюна / Dune (1984) BDRip [AV1/2160p] [4K, HDR10, 10-bit]').explicitEpisode, false);
    assert.equal(parseSignals('Фильм (2024) WEBRip [H.264/1080p]').explicitEpisode, false);
    assert.equal(parseSignals('Сериал [S1-8] (2011-2019) 2160p').episodeFrom, 0);
});

// ---------- перевод ----------

test('раздача с несколькими переводами несёт их все', () => {
    const many = parseRelease('Игра / Squid Game / S3E1-6 of 6 [2025, WEB-DL 2160p] 2x Dub + 5 x MVO + AVO (Ю. Сербин) + Sub');
    assert.deepEqual(many.voiceTypes.sort(), ['Дубляж', 'Многоголосый', 'Одноголосый']);
    // Одиночное значение остаётся для бейджей.
    assert.equal(many.voiceType, 'Дубляж');
});

test('однобуквенные коды rutor и megapeer читаются как перевод', () => {
    assert.deepEqual(parseRelease('Дюна: Пророчество / Dune: Prophecy [S01] (2024) WEB-DL 1080p | D, P, L').voiceTypes,
        ['Дубляж', 'Многоголосый']);
    assert.deepEqual(parseRelease('Дюна / Dune (1984) UHD BDRip 2160p | 4K | P, P2, A, L1').voiceTypes,
        ['Многоголосый', 'Одноголосый']);
    // Поле из кодов не должно порождаться обычным текстом с заглавной D.
    assert.deepEqual(parseRelease('Фильм / Movie (2024) BDRip 1080p').voiceTypes, []);
});

// ---------- студии и релиз-группы ----------

const studiosOf = (title, profile) => extractCredits(title, profile).translators;
const groupsOf = (title, profile) => extractCredits(title, profile).releaseGroups;

test('студии извлекаются по грамматике трекера, а не по словарю', () => {
    assert.deepEqual(studiosOf('S1E1-6 of 6 (2024) WEB-DL 1080p] 6 x MVO (LostFilm, HDrezka, TVShows, Продубляж)'),
        ['LostFilm', 'HDrezka', 'TVShows', 'Продубляж']);
    assert.deepEqual(studiosOf('[2024, WEB-DL 1080p] [MVO|Сербин]'), ['Ю. Сербин']);
});

test('релиз-группа не смешивается со студией перевода', () => {
    // «от X» на rutor — тот, кто собрал раздачу; студия стоит в поле за кодом перевода.
    const rutor = profileFor('rutor');
    const credits = extractCredits('Дюна / Dune (2024) WEB-DL 1080p от Scarabey | D | Red Head Sound', rutor);
    assert.deepEqual(credits.releaseGroups, ['Scarabey']);
    assert.deepEqual(credits.translators, ['Red Head Sound']);
});

test('роль имени решает реестр, а не слот', () => {
    // Jaskier и озвучивает, и заливает: в слоте релиза он группа, в слоте перевода — студия.
    const rutor = profileFor('rutor');
    assert.deepEqual(groupsOf('Фильм / Movie (2024) WEB-DL 1080p от Jaskier | P', rutor), ['Jaskier']);
    assert.deepEqual(studiosOf('Фильм (2024) 1080p] MVO (Jaskier)'), ['Jaskier']);
    // ExKinoRay в слоте студии всё равно остаётся релиз-группой: так сказал реестр.
    assert.deepEqual(groupsOf('Фильм / Movie (2024) WEB-DL 1080p | D-ExKinoRay', rutor), ['ExKinoRay']);
});

test('код перевода не приклеивается к имени студии', () => {
    const rutor = profileFor('rutor');
    assert.deepEqual(studiosOf('Сериал / Series [S02] (2024) WEBRip | P2-ViruseProject', rutor), ['ViruseProject']);
    assert.deepEqual(studiosOf('Фильм / Movie (2024) WEB-DL 1080p | P-Продубляж', profileFor('megapeer')), ['Продубляж']);
});

test('в авторов не попадают языки, пометки и сами типы перевода', () => {
    const noise = extractCredits('Фильм (2024) BDRip 1080p | DUB, MVO, AVO - ExKinoRay + Sub (Rus, Eng, Ukr) + Original');
    const all = noise.translators.concat(noise.releaseGroups);
    ['Rus', 'Eng', 'Ukr', 'MVO', 'AVO', 'Original'].forEach((word) => {
        assert.equal(all.indexOf(word), -1, 'в авторы попало «' + word + '»: ' + JSON.stringify(all));
    });
});

test('разные написания одной студии схлопываются в каноническое', () => {
    assert.deepEqual(studiosOf('Сериал (2024) 1080p] MVO (HDRezka Studio)'), ['HDrezka']);
    assert.deepEqual(studiosOf('Сериал (2024) 1080p] MVO (кубик в кубе)'), ['Кубик в Кубе']);
});

test('тип перевода берётся из реестра, когда заголовок о нём молчит', () => {
    // noname-club почти никогда не пишет перевод, но студию называет: LostFilm — всегда МВО.
    assert.deepEqual(parseRelease('Сериал / Series (2024) WEB-DL 1080p LostFilm', profileFor('noname-club')).voiceTypes,
        ['Многоголосый']);
    // Явный маркер в заголовке всегда важнее реестра.
    assert.deepEqual(parseRelease('Фильм (2024) BDRip 1080p Дубляж (LostFilm)').voiceTypes, ['Дубляж']);
});

// ---------- гейт по названию ----------

test('однословное название больше не матчится подстрокой', () => {
    const it = { title: 'Оно', original_title: 'It' };
    ['Кукушонок', 'Звонок', 'Метроном', 'Безсоновъ'].forEach((noise) => {
        assert.equal(titleSimilarity(noise, it, 'It'), 0, 'шум «' + noise + '» совпал с «Оно»');
    });
    assert.equal(titleSimilarity('Оно', it, 'It'), 1);
});

test('служебное поле трекера не считается названием', () => {
    // rutor разделяет метаданные вертикальной чертой, и «D» — код дубляжа, а не заголовок.
    const dune = { title: 'Дюна', original_title: 'Dune' };
    assert.equal(titleSimilarity('D', dune, 'Dune'), 0);
    assert.equal(titleSimilarity('P, L', dune, 'Dune'), 0);
});

test('расширенное название совпадает слабее точного, и только как продолжение', () => {
    const squid = { name: 'Игра в кальмара', original_name: '오징어 게임' };
    const extended = evaluateTitleMatch(
        { title: 'Игра в кальмара: Вызов / Squid Game: The Challenge / S2E1-9 of 9 [2025]' },
        { movie: squid, englishTitle: 'Squid Game' });
    assert.equal(extended.extended, true);
    assert.ok(extended.similarity < 1, 'расширенное название не должно совпадать точно');

    const exact = evaluateTitleMatch(
        { title: 'Игра в кальмара / Ojingeo geim / Squid Game / S2E1-7 of 7 [2024]' },
        { movie: squid, englishTitle: 'Squid Game' });
    assert.equal(exact.extended, false);
    assert.equal(exact.similarity, 1);

    // Слова цели, рассыпанные по чужому заголовку, — не расширение.
    assert.equal(titleSimilarity('The Beach Boys - The Pet Sounds Sessions',
        { title: 'The Boys', original_title: 'The Boys' }, 'The Boys'), 0);
    assert.equal(titleSimilarity('Когда дьявол назовёт твоё имя',
        { title: 'Твоё имя', original_title: '君の名は。' }, 'Your Name.'), 0);
});

test('слово Season в хвосте не мешает совпадению', () => {
    const boys = { title: 'The Boys', original_title: 'The Boys' };
    assert.equal(titleSimilarity('The Boys Season 4 1080p WEB-DL', boys, 'The Boys'), 1);
    assert.equal(passesSearchTitleGate({ title: 'The Boys Season 4 1080p WEB-DL' }, { movie: boys, englishTitle: 'The Boys' }), true);
});

// ---------- гейт идентичности ----------

test('гейт идентичности различает сезон, серию и сезонный пак под фильмом', () => {
    const series = { mode: 'series', season: 2, movie: {} };
    const wrongSeason = { title: 'Сериал S03E01', release: parseRelease('Сериал S03E01 1080p') };
    assert.equal(evaluateIdentityGate(wrongSeason, series).reason, 'season-mismatch');

    const outOfRange = { title: 'Сериал S02E01-E05', release: parseRelease('Сериал S02E01-E05 1080p') };
    assert.equal(evaluateIdentityGate(outOfRange, Object.assign({}, series, { episode: 9 })).reason, 'episode-out-of-range');
    assert.equal(evaluateIdentityGate(outOfRange, Object.assign({}, series, { episode: 3 })).passes, true);

    const pack = { title: 'Сериал / Series S01E01-E10 1080p', release: parseRelease('Сериал / Series S01E01-E10 1080p') };
    assert.equal(evaluateIdentityGate(pack, { mode: 'movie', movie: {} }).reason, 'series-pack-for-movie');
    const movie = { title: 'Фильм / Movie (2021) BDRip 1080p', release: parseRelease('Фильм / Movie (2021) BDRip 1080p') };
    assert.equal(evaluateIdentityGate(movie, { mode: 'movie', movie: {} }).passes, true);
});

test('год цели берётся из года сезона, а не из премьеры сериала', () => {
    const movie = {
        first_air_date: '2021-09-17',
        seasons: [{ season_number: 1, air_date: '2021-09-17' }, { season_number: 2, air_date: '2024-12-26' }]
    };
    assert.equal(targetYear({ mode: 'series', season: 2, movie: movie }), 2024);
    assert.equal(targetYear({ mode: 'series', season: 1, movie: movie }), 2021);
    assert.equal(targetYear({ mode: 'movie', movie: { release_date: '2017-09-06' } }), 2017);
});

test('год и расширенное название отсеивают только при наличии замены', () => {
    const target = { mode: 'movie', movie: { release_date: '2017-09-06', title: 'Оно' }, englishTitle: 'It' };
    const make = (title, extended) => ({
        title: title, release: parseRelease(title), _titleExtended: extended === true
    });

    const withReplacement = [make('Оно / It (2017) BDRip 1080p', false), make('Оно / It (1990) VHSRip', false)];
    const narrowed = narrowToExactMatches(withReplacement, target);
    assert.equal(narrowed.items.length, 1);
    assert.equal(narrowed.items[0].release.year.value, 2017);
    assert.equal(narrowed.rejected[0].reason, 'year-mismatch');

    // Без точного совпадения пул остаётся как есть — гейт не имеет права его опустошить.
    const onlyWrongYear = [make('Оно / It (1990) VHSRip', false)];
    assert.equal(narrowToExactMatches(onlyWrongYear, target).items.length, 1);

    // То же правило для расширенных названий.
    const mixed = [make('Оно / It (2017) BDRip', false), make('Оно 2 / It Chapter Two (2019) BDRip', true)];
    assert.equal(narrowToExactMatches(mixed, target).items.length, 1);
    assert.equal(narrowToExactMatches([make('Оно 2 / It Chapter Two (2019) BDRip', true)], target).items.length, 1);
});

test('аниме со сквозной нумерацией: E27 покрывает второй сезон', () => {
    const movie = {
        genre_ids: [16], original_language: 'ja',
        seasons: [
            { season_number: 1, episode_count: 26 },
            { season_number: 2, episode_count: 25 }
        ]
    };
    const target = { mode: 'series', season: 2, episode: 1, movie };
    // Релиз без сезона, серии 27-39 — это серии 1-13 второго сезона.
    const absolute = { title: 'Аниме E27-E39 [1080p]', release: parseRelease('Аниме E27-E39 [1080p]') };
    assert.equal(evaluateIdentityGate(absolute, target).passes, true);

    // На азиатском релизе без сезона локальная E01-E13 означает первый сезон, не второй.
    const inSeason = { title: 'Аниме E01-E13 [1080p]', release: parseRelease('Аниме E01-E13 [1080p]') };
    assert.equal(evaluateIdentityGate(inSeason, target).reason, 'season-mismatch');

    // Сквозной номер не спасает, если сезон в релизе назван явно и он чужой.
    const wrongSeason = { title: 'Аниме S03E27-E39 [1080p]', release: parseRelease('Аниме S03E27-E39 [1080p]') };
    assert.equal(evaluateIdentityGate(wrongSeason, target).reason, 'season-mismatch');

    // И не превращает гейт в решето: серии 60-70 не покрывают сквозную серию 27, а local claim — S1.
    const other = { title: 'Аниме E60-E70 [1080p]', release: parseRelease('Аниме E60-E70 [1080p]') };
    assert.equal(evaluateIdentityGate(other, target).reason, 'season-mismatch');
});

test('selection metadata хранит coverage отдельно от сырого release', () => {
    const target = {
        mode: 'series', season: 0, episode: 0,
        movie: {
            genre_ids: [16], original_language: 'ja', name: 'Тестовое аниме', original_name: 'Test Anime',
            seasons: [{ season_number: 1, episode_count: 12 }, { season_number: 2, episode_count: 13 }]
        },
        englishTitle: 'Test Anime'
    };
    const title = 'Тестовое аниме / E01-E12 Test Anime - AniLiberty.TOP [WEBRip 1080p][HEVC]';
    const item = { title, tracker: 'Anilibria', trackerId: 'anilibria', release: parseRelease(title) };
    item.selection = compileReleaseSelection(item, target, undefined, true);

    assert.equal(item.selection.family, 'anime');
    assert.equal(item.selection.tracker.group, 'anime');
    assert.deepEqual(item.selection.coverage.claims.map((claim) => claim.kind), ['season-local', 'absolute']);
    assert.equal(item.selection.coverage.claims[0].confidence, 'high');
    assert.equal(item.selection.coverage.claims[0].seasons[0], 1);
    assert.equal(coverageDecision(item, { ...target, season: 1, episode: 1 }).match, 'exact');
    assert.equal(coverageDecision(item, { ...target, season: 2, episode: 1 }).match, 'none');
    const absoluteTitle = 'Тестовое аниме / E13-E25 Test Anime - AniLiberty.TOP [WEBRip 1080p][HEVC]';
    const absoluteItem = { title: absoluteTitle, tracker: 'Anilibria', trackerId: 'anilibria', release: parseRelease(absoluteTitle) };
    absoluteItem.selection = compileReleaseSelection(absoluteItem, target, undefined, true);
    assert.equal(coverageDecision(absoluteItem, { ...target, season: 2, episode: 1 }).match, 'exact');
    // Новый слой не меняет контракт ручной разметки parser-а.
    assert.equal(Object.prototype.hasOwnProperty.call(item.release, 'coverage'), false);
});

test('на любом трекере seasonless азиатского семейства означает первый сезон', () => {
    const families = [
        { expected: 'anime', movie: { genre_ids: [16], original_language: 'ja' } },
        { expected: 'donghua', movie: { genre_ids: [16], origin_country: ['CN'] } },
        { expected: 'asian-live', movie: { genre_ids: [18], origin_country: ['KR'] } }
    ];
    families.forEach(({ expected, movie }) => {
        const target = {
            mode: 'series', season: 0, episode: 0,
            movie: { ...movie, name: 'Азиатский сериал', original_name: 'Asian Series' },
            englishTitle: 'Asian Series'
        };
        const title = 'Азиатский сериал / Asian Series E01-E12 1080p WEB-DL';
        const item = { title, tracker: 'RuTracker.org', trackerId: 'rutracker', release: parseRelease(title) };
        item.selection = compileReleaseSelection(item, target, undefined, true);
        assert.equal(item.selection.family, expected);
        assert.deepEqual(item.selection.coverage.claims[0].seasons, [1]);
        assert.equal(item.selection.coverage.claims[0].confidence, 'high');
        assert.equal(coverageDecision(item, { ...target, season: 2, episode: 1 }).match, 'none');
    });

    const generalTarget = {
        mode: 'series', season: 0, episode: 0,
        movie: { genre_ids: [18], origin_country: ['US'], name: 'Series' }
    };
    const generalTitle = 'Series E01-E12 1080p WEB-DL';
    const generalItem = { title: generalTitle, trackerId: 'rutracker', release: parseRelease(generalTitle) };
    generalItem.selection = compileReleaseSelection(generalItem, generalTarget, undefined, true);
    assert.equal(generalItem.selection.coverage.claims[0].kind, 'seasonless-local');
    assert.equal(coverageDecision(generalItem, { ...generalTarget, season: 2, episode: 1 }).match, 'ambiguous');
});

test('неоднозначный seasonless coverage вытесняется точным, но остаётся единственным fallback', () => {
    const exact = { title: 'exact', _coverageMatch: 'exact', _titleExtended: false };
    const ambiguous = { title: 'ambiguous', _coverageMatch: 'ambiguous', _titleExtended: false };
    const narrowed = narrowToExactMatches([exact, ambiguous], { mode: 'series', movie: {} });
    assert.deepEqual(narrowed.items.map((item) => item.title), ['exact']);
    assert.equal(narrowed.rejected[0].reason, 'seasonless-coverage-shadowed');
    assert.deepEqual(narrowToExactMatches([ambiguous], { mode: 'series', movie: {} }).items, [ambiguous]);
});

test('title extension сравнивается внутри tracker family и matched title key', () => {
    const exact = {
        title: 'точное общее', _titleExtended: false,
        _titleEvidence: { kind: 'exact', matchedTitleKey: 'hell mode', trackerGroup: 'general' }
    };
    const animeLongTitle = {
        title: 'полное ромадзи', _titleExtended: true,
        _titleEvidence: { kind: 'extension', matchedTitleKey: 'hell mode', trackerGroup: 'anime' }
    };
    const generalSpinOff = {
        title: 'спин-офф', _titleExtended: true,
        _titleEvidence: { kind: 'extension', matchedTitleKey: 'hell mode', trackerGroup: 'general' }
    };
    const narrowed = narrowToExactMatches([exact, animeLongTitle, generalSpinOff], { mode: 'series', movie: {} });
    assert.deepEqual(narrowed.items.map((item) => item.title), ['точное общее', 'полное ромадзи']);
    assert.equal(narrowed.rejected[0].item, generalSpinOff);
});

test('регрессия Hell Mode: AniLibria первого сезона остаётся рядом с Tapochek', () => {
    const movie = {
        name: 'Адский режим: Геймер, который любит спидран, становится бесподобным в параллельном мире с устаревшими настройками',
        original_name: 'ヘルモード ～やり込み好きのゲーマーは廃設定の異世界で無双する～ はじまりの召喚士',
        genre_ids: [16], original_language: 'ja',
        seasons: [{ season_number: 1, episode_count: 12 }, { season_number: 2, episode_count: 13 }]
    };
    const searchTarget = {
        movie, mode: 'series', season: 0, episode: 0,
        englishTitle: 'HELL MODE: The Hardcore Gamer Dominates in Another World with Garbage Balancing',
        aliases: ['Адский режим']
    };
    const rows = [
        ['tapochek', 'Tapochek', 'Адский режим: Геймер, который любит спидран, становится бесподобным в параллельном мире с устаревшими настройками (ТВ-1) | Hell Mode: Yarikomizuki no Gamer wa Hai Settei no Isekai de Musou suru | The Hardcore Gamer Dominates [TV] [1-12 из 12] [2026] [WEB-DL] [1080p]'],
        ['anilibria', 'Anilibria', 'Адский режим: Хардкорный геймер отправляется в другой мир на высоком уровне сложности / E01-E12 Hell Mode- Yarikomizuki no Gamer wa Hai Settei no Isekai de Musou suru - AniLiberty.TOP [WEBRip 1080p][HEVC][1-12]'],
        ['anilibria', 'Anilibria', 'Адский режим: Хардкорный геймер отправляется в другой мир на высоком уровне сложности / E01-E12 Hell Mode- Yarikomizuki no Gamer wa Hai Settei no Isekai de Musou suru - AniLiberty.TOP [WEBRip 1080p][AVC][1-12]']
    ];
    const items = rows.map(([trackerId, tracker, title]) => {
        const item = { trackerId, tracker, title, size: 2_000_000_000, seeders: 5, peers: 0, release: parseRelease(title) };
        item.selection = compileReleaseSelection(item, searchTarget, undefined, true);
        return item;
    });
    assert.equal(items[1].selection.title.kind, 'extension');
    assert.equal(items[1].selection.coverage.claims[0].source, 'tracker-default-season-1');

    const evaluation = evaluateCandidatePool(items, {
        ...searchTarget, season: 1, episode: 1, seasonEpisodeCount: 12, avgRuntimeMinutes: 24
    }, { filters: {} });
    assert.equal(evaluation.items.length, 3);
    assert.equal(evaluation.gateFilteredCount, 0);
});

test('UI selector не перечитывает название принятой раздачи', () => {
    const target = {
        mode: 'series', season: 1, episode: 1, seasonEpisodeCount: 12, avgRuntimeMinutes: 24,
        movie: { name: 'Правильный сериал', genre_ids: [18], origin_country: ['US'] }
    };
    const acceptedTitle = 'Правильный сериал S01E01-E12 1080p WEB-DL';
    const item = {
        title: acceptedTitle, trackerId: 'rutracker', tracker: 'RuTracker.org',
        size: 2_000_000_000, seeders: 5, peers: 0, release: parseRelease(acceptedTitle)
    };
    item.selection = compileReleaseSelection(item, target, undefined, true);
    assert.equal(item.selection.title.accepted, true);

    // Строка после intake используется только для отображения/identity записи. Совместимость уже
    // зафиксирована метаданными и не должна внезапно измениться при рендере или выборе серии.
    item.title = 'Совершенно чужая строка без совпадения';
    const evaluation = evaluateCandidatePool([item], target, { filters: {} });
    assert.equal(evaluation.items.length, 1);
    assert.equal(evaluation.items[0]._score.identityPasses, true);

    const legacy = { ...item };
    delete legacy.selection;
    const legacyEvaluation = evaluateCandidatePool([legacy], target, { filters: {} });
    assert.equal(legacyEvaluation.items.length, 1, 'compatibility path тоже не должен читать title');
});

// ---------- профиль произведения ----------

test('семейство произведения различает аниме, дунхуа, дораму и западную анимацию', () => {
    const family = (movie, mode) => workFamily({ mode: mode || 'series', movie: movie });
    assert.equal(family({ genre_ids: [16], original_language: 'ja' }), 'anime');
    assert.equal(family({ genre_ids: [16], original_language: 'ja' }, 'movie'), 'anime');
    assert.equal(family({ genre_ids: [16], origin_country: ['CN'] }), 'donghua');
    assert.equal(family({ genre_ids: [18], origin_country: ['KR'] }), 'asian-live');
    assert.equal(family({ genre_ids: [18], origin_country: ['CN'] }), 'asian-live');
    assert.equal(family({ genre_ids: [16], origin_country: ['US'] }), 'western-animation');
    assert.equal(family({ genre_ids: [18], origin_country: ['US'] }), 'general');

    // Аниме-фильм больше не выпадает из аниме-профиля.
    assert.equal(isAnimeTarget({ mode: 'movie', movie: { genre_ids: [16], original_language: 'ja' } }), true);
    // Дорама на аниме-трекеры не маршрутизируется — их там нет.
    assert.equal(isAnimeTarget({ mode: 'series', movie: { genre_ids: [18], origin_country: ['KR'] } }), false);
});

// ---------- запросы ----------

test('заглушка Lampa в поле title не уходит в поисковый запрос', () => {
    // Живой прогон: открывая карточку сериала, Lampa дописывает title='Фильм не найден',
    // а настоящее название держит в name.
    const movie = {
        name: 'Королева слёз', title: 'Фильм не найден', original_name: '눈물의 여왕',
        origin_country: ['KR'], genres: [{ id: 18 }]
    };
    const queries = buildSeriesQueries({ mode: 'series', season: 0, movie, englishTitle: 'Queen of Tears' });
    assert.ok(queries.length > 0);
    queries.forEach((query) => {
        assert.ok(!/не найден/i.test(query), 'заглушка ушла в запрос: ' + JSON.stringify(queries));
    });
    assert.ok(/Королева слёз/.test(queries[0]), JSON.stringify(queries));
});

test('запрос по дораме начинается с локального названия', () => {
    const queries = buildSeriesQueries({
        mode: 'series',
        season: 1,
        movie: { name: 'Королева слёз', original_name: '눈물의 여왕', origin_country: ['KR'], genre_ids: [18] },
        englishTitle: ''
    });
    assert.ok(queries.length > 0);
    assert.ok(/Королева/.test(queries[0]), 'первым должен идти локальный запрос, получено ' + JSON.stringify(queries));
});

test('произведение с непоисковым оригиналом не остаётся без запросов', () => {
    // parse_lang по умолчанию даёт оригинальное название; для CJK оно вырезалось в пустую строку.
    const anime = buildMovieQueries({
        mode: 'movie',
        movie: { title: 'Твоё имя', original_title: '君の名は。', genre_ids: [16], original_language: 'ja' },
        englishTitle: ''
    });
    assert.ok(anime.length > 0, 'аниме-фильм остался без запросов');
    assert.ok(anime.some((query) => /Твоё имя/.test(query)));

    const chinese = buildQueries({
        mode: 'series',
        season: 0,
        movie: { name: 'Неукротимый', original_name: '陈情令', origin_country: ['CN'], genre_ids: [18] },
        englishTitle: ''
    });
    assert.ok(chinese.some((query) => /Неукротимый/.test(query)), JSON.stringify(chinese));
});

// ---------- онгоинги: вариативный перевод названия ----------

test('у онгоинга оригинальное название идёт вторым запросом, у завершённого — нет', () => {
    const movie = { name: 'Целитель', original_name: 'The Healer', origin_country: ['US'], genre_ids: [18] };
    const ongoing = buildQueries({ mode: 'series', season: 0, movie, englishTitle: 'The Healer', ongoing: true });
    const finished = buildQueries({ mode: 'series', season: 0, movie, englishTitle: 'The Healer', ongoing: false });

    assert.ok(ongoing.some((query) => /Целитель/.test(query)), JSON.stringify(ongoing));
    assert.ok(ongoing.some((query) => /The Healer/.test(query)), JSON.stringify(ongoing));
    // Завершённому второй запрос не нужен: каждый рецепт — это job на каждый трекер.
    assert.equal(finished.length, 1, JSON.stringify(finished));
});

test('раздача с чужим вариантом перевода совпадает через alternative_titles', () => {
    const movie = { name: 'Целитель', original_name: 'The Healer' };
    const target = { mode: 'series', movie, englishTitle: 'The Healer' };
    const release = { title: 'Врачеватель душ / The Healer / S01E01-E08 [2026, WEB-DL 1080p]' };

    // Английский сегмент спасает, пока он в заголовке есть.
    assert.equal(passesSearchTitleGate(release, target), true);

    // А если трекер дал только свой перевод — без вариантов названия совпадать нечему.
    const russianOnly = { title: 'Врачеватель душ [RUS] [WEB-DL 1080p]' };
    assert.equal(passesSearchTitleGate(russianOnly, target), false);
    assert.equal(passesSearchTitleGate(russianOnly, Object.assign({}, target, { aliases: ['Врачеватель душ'] })), true);
});

test('послабление для вариантного перевода не открывает дорогу чужим произведениям', () => {
    // Оба заголовка на одном языке — это по-прежнему конфликт, а не перевод.
    const got = { name: 'Игра престолов', original_name: 'Game of Thrones' };
    assert.equal(passesSearchTitleGate(
        { title: 'Настоящая война / Игра престолов [2019, документальный, WEB-DL 1080p]' },
        { mode: 'series', movie: got, englishTitle: 'Game of Thrones' }), false);

    // Оригинал совпал лишь как расширение — послабление не применяется.
    const boys = { name: 'The Boys', original_name: 'The Boys' };
    assert.equal(passesSearchTitleGate(
        { title: 'Парни в лодке / The Boys in the Boat (Джордж Клуни) [2023, драма, WEB-DL 1080p]' },
        { mode: 'series', movie: boys, englishTitle: 'The Boys' }), false);
});

// ---------- правила трекеров ----------

test('вертикальная черта — название у одних трекеров и поле метаданных у других', () => {
    const title = 'Дюна: Часть вторая / Dune: Part Two (2024) BDRip 1080p от селезень | D';
    // rutor: черта отделяет метаданные, поэтому «D» не должно стать сегментом названия.
    assert.deepEqual(extractSearchTitleSegments(title, profileFor('rutor')),
        ['Дюна: Часть вторая', 'Dune: Part Two']);
    // exkinoray: черта разделяет и названия тоже.
    assert.ok(extractSearchTitleSegments('Дюна | Dune | 2024 | WEB-DL', profileFor('exkinoray')).indexOf('Dune') >= 0);
});

test('техническая приставка аниме-трекера срезается до разбора', () => {
    const title = 'Не издевайся, Нагаторо / E01-E12 Ijiranaide, Nagatoro-san - AniLiberty.TOP [WEBRip 1080p][HEVC][1-12]';
    const segments = extractSearchTitleSegments(title, profileFor('anilibria'));
    assert.ok(segments.some((segment) => /Ijiranaide/.test(segment)), JSON.stringify(segments));
    assert.ok(!segments.some((segment) => /AniLiberty/.test(segment)), JSON.stringify(segments));
});

test('однобуквенные коды перевода читаются только там, где трекер ими пользуется', () => {
    const title = 'Дюна: Пророчество / Dune: Prophecy [S01] (2024) WEB-DL 1080p | D, P, L';
    assert.deepEqual(parseRelease(title, profileFor('rutor')).voiceTypes, ['Дубляж', 'Многоголосый']);
    // На rutracker коды не значат перевод — там он написан словами.
    assert.deepEqual(parseRelease(title, profileFor('rutracker')).voiceTypes, []);
});

test('у аниме-трекеров студия — сам трекер, а года нет вовсе', () => {
    const anidub = parseRelease('Атака титанов: финал [RUS] [HDTV 1080p]', profileFor('anidub'));
    assert.deepEqual(anidub.translators, ['AniDUB']);
    assert.equal(anidub.year.value, null);
    assert.equal(anidub.year.from, 'tracker-has-no-year');

    const anilibria = parseRelease('Название - AniLiberty.TOP [WEBRip 1080p][HEVC][1-12]', profileFor('anilibria'));
    assert.deepEqual(anilibria.translators, ['AniLibria']);
});

test('слот автора выбирается по трекеру', () => {
    // rutor пишет сборщика в «от X», rutracker — студию в скобках после типа перевода.
    assert.deepEqual(parseRelease('Дюна / Dune (2024) WEB-DL 1080p от Scarabey | D', profileFor('rutor')).releaseGroups, ['Scarabey']);
    assert.deepEqual(parseRelease('Сериал S01E01 (2024) 1080p] MVO (TVShows)', profileFor('rutracker')).translators, ['TVShows']);
});

test('неизвестный индексатор получает общий профиль и не ломает поиск', () => {
    const unknown = profileFor('какой-то-новый-трекер');
    assert.equal(unknown.group, 'general');
    assert.equal(unknown.titleSeparators, 'slash-pipe');
    assert.equal(parseRelease('Фильм / Movie (2024) BDRip 1080p', unknown).year.value, 2024);
    // Маршрутизация аниме берётся из группы реестра, а не из списка в коде.
    assert.deepEqual(indexersInGroup('anime'), ['anidub', 'anilibria']);
});

test('правила трекера можно переопределить файлом, не трогая код', () => {
    registerTrackerRules([{ id: 'megapeer', voices: 'text' }]);
    // Коды перестали читаться там, где пользователь это запретил.
    assert.deepEqual(parseRelease('Фильм / Movie (2024) WEB-DL 1080p | D, P', profileFor('megapeer')).voiceTypes, []);

    // Сериализатор менеджера пишет незаполненные поля как null — они не должны сбрасывать
    // встроенные значения: правка одного поля у аниме-трекера не может выкинуть его из группы.
    registerTrackerRules([{ id: 'anidub', studioSlots: 'tail', group: null, year: null }]);
    assert.equal(profileFor('anidub').group, 'anime');
    assert.equal(profileFor('anidub').year, 'never');

    registerTrackerRules([{ id: 'новый-аниме-трекер', group: 'anime', studioDefault: 'NewFansub' }]);
    assert.ok(indexersInGroup('anime').indexOf('новый-аниме-трекер') >= 0);
    assert.deepEqual(parseRelease('Аниме [1080p]', profileFor('новый-аниме-трекер')).translators, ['NewFansub']);
});

// ---------- cours и соседние работы франшизы ----------

test('аниме называет сезон словом: «3rd Season» и «The Final Season»', () => {
    assert.deepEqual(parseSignals('Attack on Titan 3rd Season [TV] [E22 of 22]').seasons, [3]);
    assert.deepEqual(parseSignals('Jujutsu Kaisen 2nd Season [TV]').seasons, [2]);

    const final = parseSignals('Shingeki no Kyojin: The Final Season - Kanketsu-hen | Атака титанов');
    assert.equal(final.finalSeason, true);
    assert.deepEqual(final.seasons, [], 'номер сезона из слова «финальный» не выводится');

    // «Часть вторая» в названии фильма сезоном не является.
    assert.equal(parseSignals('Дюна: Часть вторая / Dune: Part Two (2024)').finalSeason, false);
});

test('финальный сезон сопоставляется с последним сезоном по TMDB', () => {
    const movie = { seasons: [{ season_number: 1 }, { season_number: 2 }, { season_number: 3 }, { season_number: 4 }] };
    const item = { title: 'Аниме The Final Season [1080p]', release: parseRelease('Аниме The Final Season [1080p]') };

    assert.equal(evaluateIdentityGate(item, { mode: 'series', season: 4, movie }).passes, true);
    assert.equal(evaluateIdentityGate(item, { mode: 'series', season: 2, movie }).reason, 'season-mismatch');
    // Когда сезоны неизвестны, отказывать не за что.
    assert.equal(evaluateIdentityGate(item, { mode: 'series', season: 2, movie: {} }).passes, true);
});

test('соседняя работа франшизы не подменяет произведение', () => {
    const target = {
        mode: 'movie', movie: { title: 'Дюна', original_title: 'Dune' }, englishTitle: 'Dune',
        negativeAliases: ['Дюна: Пророчество', 'Дюна: Часть вторая']
    };
    assert.equal(passesSearchTitleGate({ title: 'Дюна: Пророчество / Dune: Prophecy [2024] WEB-DL 1080p' }, target), false);
    // Само произведение проходит по-прежнему.
    assert.equal(passesSearchTitleGate({ title: 'Дюна / Dune (2021) BDRip 1080p' }, target), true);
    // Без списка соседних работ поведение прежнее — гейт их не выдумывает.
    assert.equal(passesSearchTitleGate({ title: 'Дюна: Пророчество / Dune: Prophecy [2024] WEB-DL 1080p' },
        { mode: 'movie', movie: { title: 'Дюна', original_title: 'Dune' }, englishTitle: 'Dune' }), true);
});

test('воронка поиска считается по стадиям', () => {
    assert.equal(funnelText({ funnel: null }), '');
    assert.equal(funnelText({ funnel: { raw: 412, video: 380, title: 96, pool: 74 } }),
        'Найдено 412 → видео 380 → это произведение 96 → в списке 74');

    const items = buildFilterItems({ number_of_seasons: 1 }, true,
        { pool: [], filters: {}, season: 1, funnel: { raw: 10, video: 8, title: 3, pool: 3 } });
    assert.ok(items.some((item) => item.kind === 'diagnostics'), JSON.stringify(items.map((i) => i.title)));
    // Без данных строка не появляется — пустой пункт меню хуже, чем его отсутствие.
    assert.ok(!buildFilterItems({ number_of_seasons: 1 }, true, { pool: [], filters: {}, season: 1 })
        .some((item) => item.kind === 'diagnostics'));
});

test('меню «Релиз-группа» появляется только там, где группы есть', () => {
    const movie = { number_of_seasons: 1 };
    const poolItem = (release) => ({ title: 'Раздача', tracker: 'rutor', size: 1, release: release });

    const withGroups = buildFilterItems(movie, false, {
        filters: {},
        pool: [poolItem({ translators: ['Red Head Sound'], releaseGroups: ['Scarabey'], resolution: '1080p' })]
    });
    const groupMenu = withGroups.filter((item) => item.kind === 'release-group')[0];
    assert.ok(groupMenu, 'меню релиз-группы не построено');
    assert.deepEqual(groupMenu.items.map((item) => item.value), ['any', 'Scarabey']);
    // Студия и группа стоят в разных меню, а не в одном списке.
    const studioMenu = withGroups.filter((item) => item.kind === 'translator')[0];
    assert.deepEqual(studioMenu.items.map((item) => item.value), ['any', 'Red Head Sound']);

    // Трекеры без сборщика в заголовке не получают пустое меню.
    assert.ok(!buildFilterItems(movie, false, {
        filters: {},
        pool: [poolItem({ translators: ['AniLibria'], releaseGroups: [], resolution: '1080p' })]
    }).some((item) => item.kind === 'release-group'));
});

test('оценка из правил поднимает студию в меню и подписывает её', () => {
    registerCredits([{ name: 'Оценённая', rating: 9.5, votes: 10, voice: 'Дубляж', profanity: true }], CREDIT_KINDS.STUDIO);
    const menu = buildFilterItems({}, false, {
        filters: {},
        pool: [
            { title: 'a', tracker: 't', size: 1, release: { translators: ['Безоценочная'], releaseGroups: [] } },
            { title: 'b', tracker: 't', size: 2, release: { translators: ['Оценённая'], releaseGroups: [] } }
        ]
    }).filter((item) => item.kind === 'translator')[0];
    assert.deepEqual(menu.items.map((item) => item.value), ['any', 'Оценённая', 'Безоценочная']);
    assert.equal(menu.items[1].subtitle, 'Дубляж · мат · ★ 9.5 (10)');
    // О чём реестр молчит — то и в подписи молчит.
    assert.equal(menu.items[2].subtitle, '');
});

// ---------- формат аниме-трекеров ----------

test('тип релиза аниме читается отдельно от нумерации', () => {
    const type = (title) => parseSignals(title).releaseType;
    assert.equal(type('Твоё имя / Kimi no Na wa - AniLiberty.TOP [BDRip 1080p][HEVC][Фильм]'), 'movie');
    assert.equal(type('Баскетбол Куроко / Kuroko no Basket - AniLiberty.TOP [BDRip 1080p][AVC][П-ф]'), 'movie');
    assert.equal(type('Волейбол!! / Haikyuu!! Movie- Gomisuteba no Kessen - AniLiberty.TOP [WEB-DLRip]'), 'movie');
    assert.equal(type('Мастера меча / Gekijouban Sword Art Online [RUS] [BDRip 1080p]'), 'movie');
    assert.equal(type('Аниме [OVA] [1080p]'), 'ova');
    assert.equal(type('Аниме [TV] [1-12 из 12] 1080p'), 'tv');
    assert.equal(type('Дюна / Dune: Part Two (2024) BDRip'), '');
});

test('полнометражка не может быть кандидатом на конкретную серию', () => {
    const title = 'Твоё имя / Kimi no Na wa - AniLiberty.TOP [BDRip 1080p][HEVC][Фильм]';
    const item = { title: title, release: parseRelease(title, profileFor('anilibria')) };
    const target = { mode: 'series', season: 1, movie: {} };

    assert.equal(evaluateIdentityGate(item, Object.assign({}, target, { episode: 3 })).reason, 'movie-release-for-episode');
    // В общем пуле произведения место ей есть — отказ только при запросе конкретной серии.
    assert.equal(evaluateIdentityGate(item, target).passes, true);
});

test('аниме-трекер объявляет тип перевода профилем, раз не пишет его в заголовке', () => {
    // На 211 живых заголовках anilibria и anidub тип перевода не разобрался ни разу.
    const anilibria = parseRelease('Название - AniLiberty.TOP [WEB-DL 1080p][HEVC][1-12]', profileFor('anilibria'));
    assert.deepEqual(anilibria.voiceTypes, ['Многоголосый']);

    const anidub = parseRelease('Атака титанов: финал [RUS] [HDTV 1080p]', profileFor('anidub'));
    assert.deepEqual(anidub.voiceTypes, ['Многоголосый']);

    // Явно названный перевод сильнее умолчания трекера.
    const explicit = parseRelease('Название [Дубляж] - AniLiberty.TOP [1080p]', profileFor('anilibria'));
    assert.deepEqual(explicit.voiceTypes, ['Дубляж']);
    // На общих трекерах умолчания нет — там перевод пишут словами.
    assert.deepEqual(parseRelease('Фильм / Movie (2024) BDRip 1080p', profileFor('rutracker')).voiceTypes, []);
});

test('срез технической приставки не склеивает соседние названия', () => {
    // Приставка «E01-E06» у AniLibria стоит сразу после разделителя названий. Если срез съедает
    // сам разделитель, два названия становятся одним сегментом, а склейка читается гейтом как
    // «название плюс добавка» — и раздача выбрасывается, как только у общего трекера есть точное
    // совпадение. Так все раздачи аниме-трекеров пропадали из списка.
    const title = 'История о перекуре за супермаркетом / E01-E06 Super no Ura de Yani Suu Futari - AniLiberty.TOP [WEB-DL 1080p][HEVC][1-6]';
    assert.deepEqual(extractSearchTitleSegments(title, profileFor('anilibria')),
        ['История о перекуре за супермаркетом', 'Super no Ura de Yani Suu Futari']);

    const target = {
        mode: 'series', season: 1,
        movie: { name: 'История о перекуре за супермаркетом', original_name: 'スーパーの裏でヤニ吸うふтари' },
        englishTitle: 'Smoking Behind the Supermarket with You'
    };
    const match = evaluateTitleMatch({ title: title, trackerId: 'anilibria', tracker: 'Anilibria' }, target);
    assert.equal(match.similarity, 1);
    assert.equal(match.extended, false, 'раздача аниме-трекера не должна выглядеть расширением названия');
});

// ---------- эскалация запросов ----------

test('запасное название не уходит сразу, а помечается «если пусто»', () => {
    const movie = { name: 'Атака титанов', original_name: '進撃の巨人', genre_ids: [16], original_language: 'ja' };
    const target = { mode: 'series', season: 0, movie, englishTitle: 'Attack on Titan' };
    const plan = buildSearchPlan(target, buildSeriesQueries(target));

    const immediate = plan.filter((entry) => entry.when !== 'if-empty');
    const deferred = plan.filter((entry) => entry.when === 'if-empty');

    assert.ok(immediate.length > 0);
    assert.equal(deferred.length, 1, JSON.stringify(plan));
    // Запасной запрос идёт на общие трекеры — аниме-группа из него исключена. Сравниваем с
    // текущим составом группы: другие тесты в этом файле её пополняют.
    assert.deepEqual(deferred[0].excludeIndexerIds, indexersInGroup('anime'));
    assert.ok(deferred[0].excludeIndexerIds.indexOf('anidub') >= 0);
    // Русское название в первой волне уходит только на аниме-трекеры; на общие оно попадает
    // именно запасным запросом — маршрут другой, поэтому совпадение текста здесь не дубль.
    assert.ok(!immediate.some((entry) => entry.query === deferred[0].query && entry.excludeIndexerIds),
        'запасной запрос дублирует первую волну: ' + JSON.stringify(plan));
    assert.ok(immediate.some((entry) => entry.query === deferred[0].query && entry.indexerIds),
        'русское название должно уходить на аниме-трекеры сразу: ' + JSON.stringify(plan));
});

test('эскалация не выдумывает запрос, когда все названия уже использованы', () => {
    const movie = { name: 'The Boys', original_name: 'The Boys', origin_country: ['US'] };
    const target = { mode: 'series', season: 0, movie, englishTitle: 'The Boys' };
    const plan = buildSearchPlan(target, buildSeriesQueries(target));
    assert.equal(plan.filter((entry) => entry.when === 'if-empty').length, 0, JSON.stringify(plan));
});

// ---------- случаи из живого лога ----------

test('раскладка «ромадзи | английское | локализованное» не считается конфликтом', () => {
    const target = {
        mode: 'series',
        movie: { name: 'История о перекуре за супермаркетом', original_name: 'スーパーの裏でヤニ吸うふтари' },
        englishTitle: 'Smoking Behind the Supermarket with You'
    };
    const item = {
        title: 'Super no Ura de Yani Suu Futari | Smoking Behind the Supermarket with You | ' +
               'История о перекуре за супермаркетом [2026, Web, 12] WebRip 1080p raw',
        trackerId: 'noname-club', tracker: 'NoNaMe Club'
    };
    item.release = parseRelease(item.title, profileFor('noname-club'));
    assert.equal(passesSearchTitleGate(item, target), true);

    // Документальный фильм о сериале по-прежнему отсекается: чужой заголовок на том же языке,
    // что и локализованное название цели.
    const got = { mode: 'series', movie: { name: 'Игра престолов', original_name: 'Game of Thrones' }, englishTitle: 'Game of Thrones' };
    assert.equal(passesSearchTitleGate(
        { title: 'Настоящая война / Игра престолов / The Real War of Thrones [2019, WEB-DL 1080p]' }, got), false);
});

test('у онгоинга общее число серий может быть неизвестно', () => {
    const title = 'История о перекуре за супермаркетом / Super no Ura de Yani Suu Futari / YaniSuu ' +
                  '[TV] [1-12 из ??] [RUS(MVO)] [2026, ААС]';
    const signals = parseSignals(title);
    assert.equal(signals.explicitEpisode, true);
    assert.equal(signals.episodeFrom, 1);
    assert.equal(signals.episodeTo, 12);

    // Без сигнала серий такая раздача отсекалась media-гейтом как «нет видеосигнала».
    const target = { mode: 'series', movie: { name: 'История о перекуре за супермаркетом' } };
    const item = { title: title, trackerId: 'rutracker', tracker: 'RuTracker.org' };
    item.release = parseRelease(title, profileFor('rutracker'));
    assert.equal(evaluateMediaTypeGate(item, target).passes, true);
});

test('поля метаданных после вертикальной черты не считаются названиями', () => {
    const segments = extractSearchTitleSegments(
        'Дюна / Dune: Part Two (2024) BDRip 1080p от селезень | D | 4K | 2024 | WEB-DL', profileFor('bigfangroup'));
    assert.deepEqual(segments, ['Дюна', 'Dune: Part Two']);
});

// ---------- живой корпус ----------

const corpus = JSON.parse(fs.readFileSync(
    path.join(import.meta.dirname, 'fixtures', 'live-multitracker.json'), 'utf8'));

test('на живом корпусе год читается почти со всех раздач общих трекеров', () => {
    const general = ['rutracker', 'rutor', 'megapeer', 'noname-club', 'tapochek', 'exkinoray'];
    general.forEach((tracker) => {
        const titles = corpus.trackers[tracker] || [];
        const withYear = titles.filter((title) => parseYear(title).value !== null).length;
        const share = withYear / titles.length;
        assert.ok(share > 0.8, tracker + ': год прочитан только у ' + Math.round(share * 100) + '% раздач');
    });
});

test('на живом корпусе разбор не выдумывает сезоны и серии из технических тегов', () => {
    const titles = [].concat.apply([], Object.keys(corpus.trackers).map((key) => corpus.trackers[key]));
    titles.forEach((title) => {
        const signals = parseSignals(title);
        signals.seasons.forEach((season) => {
            assert.ok(season > 0 && season <= 50, 'нелепый сезон ' + season + ' из «' + title + '»');
        });
        if (signals.explicitEpisode) {
            assert.ok(signals.episodeFrom > 0 && signals.episodeTo >= signals.episodeFrom && signals.episodeTo <= 999,
                'нелепый диапазон серий ' + signals.episodeFrom + '-' + signals.episodeTo + ' из «' + title + '»');
        }
    });
});

// ---------- правила, пополняемые вне кода ----------
// Реестр студий глобален для модуля, поэтому эта проверка идёт последней.

test('студию можно добавить и переименовать правилами, не трогая код', () => {
    assert.deepEqual(studiosOf('Сериал (2024) 1080p] MVO (Тайм Медиа Групп)'), ['Тайм Медиа Групп']);

    registerCredits([{ name: 'Тайм Медиа', aliases: ['Тайм Медиа Групп', 'TimeMedia'] }], CREDIT_KINDS.STUDIO);
    // Оба написания сводятся к каноническому имени из правил.
    assert.deepEqual(studiosOf('Сериал (2024) 1080p] MVO (Тайм Медиа Групп)'), ['Тайм Медиа']);
    // Имя из «от X» по умолчанию релиз-группа, но реестр знает, что это студия перевода.
    assert.deepEqual(studiosOf('Сериал (2024) 1080p от TimeMedia'), ['Тайм Медиа']);

    // Встроенную студию можно погасить, не пересобирая плагин.
    registerCredits([{ name: 'ProFilms', disabled: true }], CREDIT_KINDS.STUDIO);
    assert.deepEqual(studiosOf('Фильм (2024) BDRip 1080p ProFilms'), []);
});

test('релиз-группа и метаданные студии приезжают файлом', () => {
    registerCredits([{ name: 'НоваяГруппа', aliases: ['NewGroup'] }], CREDIT_KINDS.GROUP);
    assert.deepEqual(groupsOf('Фильм (2024) BDRip 1080p от NewGroup'), ['НоваяГруппа']);

    registerCredits([{ name: 'Своя Студия', voice: 'Дубляж', profanity: true, rating: 9.5, votes: 42 }], CREDIT_KINDS.STUDIO);
    const record = creditInfo('своя студия');
    assert.equal(record.kind, CREDIT_KINDS.STUDIO);
    assert.equal(record.voice, 'Дубляж');
    assert.equal(record.profanity, true);
    assert.equal(record.rating, 9.5);
    assert.equal(record.votes, 42);
    // Тип перевода из реестра заполняет молчание заголовка.
    assert.deepEqual(parseRelease('Фильм (2024) BDRip 1080p Своя Студия').voiceTypes, ['Дубляж']);
});

console.log('\nИтог: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
