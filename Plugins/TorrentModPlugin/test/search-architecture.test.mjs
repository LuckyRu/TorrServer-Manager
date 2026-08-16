// Регрессии на дефекты, найденные прогоном по живой выдаче девяти трекеров.
// Разбор и замеры — docs/system-design/torrent-mod-search-architecture.md.

import './helpers/mock-lampa.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

import { parseRelease, parseSignals } from '../search/release-parsing.js';
import { parseYear, yearMatches } from '../search/release-year.js';
import { extractStudios, registerStudioRules } from '../search/release-studios.js';
import { titleSimilarity, evaluateTitleMatch, passesSearchTitleGate } from '../search/search-gates.js';
import { evaluateIdentityGate, narrowToExactMatches, targetYear } from '../search/gate-identity.js';
import { workFamily, isAnimeTarget } from '../search/work-profile.js';
import { buildQueries } from '../search/query-building.js';
import { buildMovieQueries } from '../search/movie-query-building.js';
import { buildSeriesQueries } from '../search/series-query-building.js';

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

// ---------- студии ----------

test('студии извлекаются по грамматике трекера, а не по словарю', () => {
    assert.deepEqual(extractStudios('S1E1-6 of 6 (2024) WEB-DL 1080p] 6 x MVO (LostFilm, HDrezka, TVShows, Продубляж)'),
        ['LostFilm', 'HDrezka', 'TVShows', 'Продубляж']);
    assert.deepEqual(extractStudios('Дюна / Dune (2024) WEB-DL 1080p от Scarabey | D'), ['Scarabey']);
    assert.deepEqual(extractStudios('[2024, WEB-DL 1080p] [MVO|Сербин]'), ['Сербин']);
});

test('в студии не попадают языки, пометки и сами типы перевода', () => {
    const noise = extractStudios('Фильм (2024) BDRip 1080p | DUB, MVO, AVO - ExKinoRay + Sub (Rus, Eng, Ukr) + Original');
    ['Rus', 'Eng', 'Ukr', 'MVO', 'AVO', 'Original'].forEach((word) => {
        assert.equal(noise.indexOf(word), -1, 'в студии попало «' + word + '»: ' + JSON.stringify(noise));
    });
});

test('разные написания одной студии схлопываются в каноническое', () => {
    assert.deepEqual(extractStudios('Сериал (2024) 1080p] MVO (HDRezka Studio)'), ['HDrezka']);
    assert.deepEqual(extractStudios('Сериал (2024) 1080p] MVO (кубик в кубе)'), ['Кубик в Кубе']);
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
    assert.deepEqual(extractStudios('Сериал (2024) 1080p] MVO (Тайм Медиа Групп)'), ['Тайм Медиа Групп']);

    registerStudioRules([{ name: 'Тайм Медиа', aliases: ['Тайм Медиа Групп', 'TimeMedia'], disabled: false }]);
    // Оба написания сводятся к каноническому имени из правил.
    assert.deepEqual(extractStudios('Сериал (2024) 1080p] MVO (Тайм Медиа Групп)'), ['Тайм Медиа']);
    assert.deepEqual(extractStudios('Сериал (2024) 1080p от TimeMedia'), ['Тайм Медиа']);

    // Встроенную студию можно погасить, не пересобирая плагин.
    registerStudioRules([{ name: 'ProFilms', disabled: true }]);
    assert.deepEqual(extractStudios('Фильм (2024) BDRip 1080p ProFilms'), []);
});

console.log('\nИтог: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
