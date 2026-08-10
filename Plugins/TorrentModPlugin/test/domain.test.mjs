// ---------- domain/search unit tests (npm run test:plugin) ----------
//
// Calls every non-UI function of the plugin (query-building, results-core, results-selectors,
// scoring, metadata, season-picker) with real-shaped data under mocked browser globals. The main
// value: an undefined identifier (like the buildSeasonItems ReferenceError that crashed the real
// screen) throws here, in CI/on the dev machine, instead of at runtime on the TV.
import './helpers/mock-lampa.mjs';
import { createRunner } from './helpers/test-runner.mjs';
import { parseRelease } from '../search/release-parsing.js';
import { baseTitles, defaultSearchName, buildQueries } from '../search/query-building.js';
import { buildMovieQueries } from '../search/movie-query-building.js';
import { buildSeriesQueries } from '../search/series-query-building.js';
import { parseMovieRelease } from '../search/movie-release-parsing.js';
import { parseSeriesRelease } from '../search/series-release-parsing.js';
import { scoreCandidate, applyStateFilters } from '../search/scoring.js';
import {
    createInitialState, isSeriesWithSeasons, searchQueryText, poolValues, currentSeasonLabel,
    buildFilterItems, activeFilterLabels, candidatesForEpisode, badgeText, isConfidentMatch,
    publishedText, candidateBadgeText, candidateSubtitleText, candidateIdentity
} from '../domain/results-core.js';
import {
    selectBusy, selectFilterChipData, selectFilterItems, buildEpisodeTarget,
    selectCandidatesForEpisode, selectEpisodeBadges, selectStatusText, selectSearchProgress,
    selectPickerData, selectPoolIndexers
} from '../domain/results-selectors.js';
import { episodeCounts, getSeasonMeta, fetchEnglishTitle } from '../metadata/tmdb.js';
import { MODE_MOVIE, MODE_SERIES } from '../shared/state.js';
import { initialSeason, buildSeasonItems, openTarget } from '../metadata/season-picker.js';
import { pickBestFile } from '../playback/file-selection.js';
import { createSeriesResultsViewModel } from '../domain/series-results-viewmodel.js';
import { createMovieResultsViewModel } from '../domain/movie-results-viewmodel.js';

const runner = createRunner();

// ---------- data ----------
const tvMovie = {
    id: 615,
    name: 'Футурама',
    original_name: 'Futurama',
    title: 'Футурама',
    original_title: 'Futurama',
    first_air_date: '1999-03-28',
    number_of_seasons: 10,
    seasons: [
        { season_number: 1, episode_count: 13 },
        { season_number: 2, episode_count: 19 },
        { season_number: 3, episode_count: 22 }
    ]
};
const movie = { id: 1, title: 'Дюна', original_title: 'Dune', release_date: '2024-02-01' };

const single = {
    title: 'Футурама / Futurama S02E07 1080p WEB-DL',
    tracker: 'RuTracker', size: 2500000000, seeders: 12, peers: 6,
    publishedAt: Date.now() - 86400000,
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890abcdef1234567890abcdef12', link: '',
    release: null
};
single.release = parseRelease(single.title);

const seasonPack = {
    title: 'Футурама / Futurama (2008-2013) BDRip (S1-5E1-62 of 62)',
    tracker: 'NoNaMe', size: 120000000000, seeders: 30, peers: 10, publishedAt: 0,
    magnet: 'magnet:?xt=urn:btih:1234567890abcdef1234567890abcdef12345678', link: '',
    release: null
};
seasonPack.release = parseRelease(seasonPack.title);

const target = { movie: tvMovie, season: 2, episode: 7, seasonEpisodeCount: 19, avgRuntimeMinutes: 22, customQuery: null };

const state = {
    season: 2, voiceType: 'any', resolution: 'any',
    pool: [single, seasonPack],
    episodesCache: [{ episode_number: 1 }, { episode_number: 7 }, { episode_number: 8 }],
    seasonEpisodeCount: 19, avgRuntimeMinutes: 22,
    poolStatus: 'ready', episodesStatus: 'ready', searchStatus: 'idle',
    stage: 'episodes', statusText: '', searchText: '', lastEpisode: 0, customQuery: null
};

// ---------- query building ----------
runner.test('defaultSearchName использует parse_lang (df → оригинальное название)', () => {
    if (defaultSearchName(tvMovie) !== 'Futurama') throw new Error('expected "Futurama", got "' + defaultSearchName(tvMovie) + '"');
});
runner.test('searchQueryText без сезонного суффикса', () => {
    if (searchQueryText({ movie: tvMovie, season: 2 }) !== 'Futurama') throw new Error(searchQueryText({ movie: tvMovie, season: 2 }));
});
runner.test('buildQueries для пула — один запрос по названию', () => {
    const q = buildQueries({ movie: tvMovie, season: 0, episode: 0 });
    if (q.length !== 1 || q[0] !== 'Futurama') throw new Error(JSON.stringify(q));
});
runner.test('buildQueries для customQuery с суффиксом эпизода', () => {
    const q = buildQueries({ movie: tvMovie, season: 2, episode: 7, customQuery: 'Брат 2' });
    // точный SxxExx + сезонный Sxx — оба валидны для ручного запроса
    if (q.indexOf('Брат 2 S02E07') < 0 || q.indexOf('Брат 2 S02') < 0) throw new Error(JSON.stringify(q));
});
runner.test('режимы поиска: фильм не получает season/episode suffix, сериал получает', () => {
    const movieQueries = buildMovieQueries({ movie, season: 4, episode: 2 });
    if (movieQueries.length !== 1 || /S\d+E\d+/i.test(movieQueries[0])) throw new Error(JSON.stringify(movieQueries));
    const seriesQueries = buildSeriesQueries({ movie: tvMovie, season: 2, episode: 7 });
    if (seriesQueries.indexOf('Futurama S02E07') < 0) throw new Error(JSON.stringify(seriesQueries));
});
runner.test('режимы парсинга: фильм не экспортирует season/episode signals, сериал экспортирует', () => {
    const title = 'Название / Title S02E07 1080p WEB-DL';
    const movieRelease = parseMovieRelease(title);
    const seriesRelease = parseSeriesRelease(title);
    if (movieRelease.explicitSeason || movieRelease.explicitEpisode) throw new Error(JSON.stringify(movieRelease));
    if (!seriesRelease.explicitSeason || !seriesRelease.explicitEpisode) throw new Error(JSON.stringify(seriesRelease));
});
runner.test('baseTitles возвращает оба названия', () => {
    const t = baseTitles(tvMovie);
    if (t.indexOf('Футурама') < 0 || t.indexOf('Futurama') < 0) throw new Error(JSON.stringify(t));
});
runner.test('baseTitles/defaultSearchName с englishTitle: используется вместо native-script original для азиатского тайтла', () => {
    // original_title для азиатского произведения — язык оригинала (тут условно кириллица как
    // заглушка для "не-английского нечитаемого на русских трекерах названия"), а englishTitle —
    // отдельный TMDB en-US lookup (metadata/tmdb.js fetchEnglishTitle). Требование пользователя
    // напрямую: "используя язык оригинала на русских торрентах это пиздец. Надо использовать
    // английский перевод из TMDB для поиска."
    // original_title in a script compact() doesn't tokenize at all (only a-z/а-я/0-9 — see
    // shared/utils.js) compacts to an empty string, and unique() (shared/utils.js) drops any
    // candidate with an empty dedup key — already true before this change, just never surfaced:
    // a Japanese-script original_title was ALREADY useless for search/matching (an empty query,
    // an empty match key), so dropping it outright is correct, not a regression. englishTitle is
    // exactly what makes this show searchable/matchable at all.
    const asianMovie = { id: 999, name: 'Демон-истребитель', original_name: '鬼滅の刃', title: 'Демон-истребитель', original_title: '鬼滅の刃' };
    const withEnglish = baseTitles(asianMovie, 'Demon Slayer');
    if (withEnglish.indexOf('Demon Slayer') < 0) throw new Error('englishTitle отсутствует в baseTitles: ' + JSON.stringify(withEnglish));
    if (withEnglish.indexOf('鬼滅の刃') >= 0) throw new Error('non-Latin/Cyrillic original_title должен отсеиваться unique() как бесполезный ключ: ' + JSON.stringify(withEnglish));

    const name = defaultSearchName(asianMovie, 'Demon Slayer');
    if (name !== 'Demon Slayer') throw new Error('defaultSearchName должен предпочесть englishTitle: ' + name);

    // Западный тайтл: englishTitle совпадает с original_title — не должно давать лишний
    // дублирующий вариант (unique() уже дедуплицирует по compact()).
    const westernWithEnglish = baseTitles(tvMovie, 'Futurama');
    if (westernWithEnglish.length !== 2) throw new Error('дубликат original_title/englishTitle не должен добавлять третий вариант: ' + JSON.stringify(westernWithEnglish));
});

// ---------- results-core ----------
runner.test('isSeriesWithSeasons различает фильм/сериал', () => {
    if (!isSeriesWithSeasons(tvMovie)) throw new Error('сериал не распознан');
    if (isSeriesWithSeasons(movie)) throw new Error('фильм распознан как сериал');
});
runner.test('createInitialState', () => {
    const s = createInitialState({ season: 3 });
    if (s.season !== 3 || s.voiceType !== 'any' || s.resolution !== 'any') throw new Error(JSON.stringify(s));
});
runner.test('poolValues — только реально присутствующие значения', () => {
    const v = poolValues(state, (i) => i.release.resolution);
    if (v.length !== 1 || v[0] !== '1080p') throw new Error(JSON.stringify(v));
});
runner.test('buildFilterItems — структура и не бросает', () => {
    const items = buildFilterItems(tvMovie, true, state);
    if (items.length < 4) throw new Error('мало пунктов: ' + items.length);
    const voice = items.find((i) => i.kind === 'voice');
    if (!voice || !voice.items || voice.items.length === 0) throw new Error('нет пункта Перевод');
});
runner.test('activeFilterLabels', () => {
    const l = activeFilterLabels({ voiceType: 'Дубляж', resolution: '1080p' });
    if (l.join(',') !== 'Дубляж,1080p') throw new Error(JSON.stringify(l));
});
runner.test('currentSeasonLabel', () => {
    if (currentSeasonLabel(tvMovie, true, { season: 2 }) !== 'Сезон 2') throw new Error(currentSeasonLabel(tvMovie, true, { season: 2 }));
});
runner.test('candidatesForEpisode — сингл и сезон-пак оба матчатся с S02E07', () => {
    const c = candidatesForEpisode(state.pool, target, state);
    if (c.length !== 2) throw new Error('ожидал 2 кандидатов, получил ' + c.length + ': ' + JSON.stringify(c.map((i) => i.title)));
    if (!c[0]._score || !c[0]._score.passes) throw new Error('кандидат без score');
});
runner.test('candidatesForEpisode — эпизод вне диапазона пака не матчится', () => {
    // пак S1-5E1-62 покрывает эпизод 7; а вот эпизод 200 — нет
    const c = candidatesForEpisode(state.pool, { movie: tvMovie, season: 2, episode: 200, seasonEpisodeCount: 19, avgRuntimeMinutes: 22 }, state);
    if (c.length !== 0) throw new Error('ожидал пусто, получил ' + c.length);
});
runner.test('badgeText/candidateBadgeText/candidateSubtitleText/publishedText не бросают', () => {
    if (!badgeText([single])) throw new Error('badgeText');
    if (!candidateBadgeText(single)) throw new Error('candidateBadgeText');
    if (!candidateSubtitleText(single)) throw new Error('candidateSubtitleText');
    if (!publishedText(single)) throw new Error('publishedText');
});
runner.test('candidateIdentity: magnet-less раздача стабильна между поисками, magnet приоритетнее', () => {
    // Реальный баг: NoNaMe Club (и другие magnet-less индексаторы) отдают через Jackett
    // download-proxy ссылку с закодированным путём, который отличается между двумя отдельными
    // поисками одной и той же раздачи — link не должен участвовать в identity вообще.
    const first = { title: single.title, size: single.size, magnet: '', link: 'http://jackett/dl?path=AAA111' };
    const second = { title: single.title, size: single.size, magnet: '', link: 'http://jackett/dl?path=ZZZ999' };
    if (candidateIdentity(first) !== candidateIdentity(second)) {
        throw new Error('identity разъехалась между поисками из-за разного link: ' + candidateIdentity(first) + ' vs ' + candidateIdentity(second));
    }
    // Magnet, когда есть, приоритетнее — тоже стабилен и точнее title+size.
    const withMagnet = { title: single.title, size: single.size, magnet: 'magnet:?xt=urn:btih:abc', link: 'http://jackett/dl?path=AAA111' };
    if (candidateIdentity(withMagnet) === candidateIdentity(first)) {
        throw new Error('magnet-кандидат не должен совпадать по identity с magnet-less при том же title+size');
    }
});
runner.test('badgeText предпочитает сохранённый дефолт top-ranked кандидату', () => {
    const c = candidatesForEpisode(state.pool, target, state);
    // seasonPack (30 сидов) ранжируется выше single (12 сидов) по умолчанию — без saved
    // бэйдж должен показывать его.
    if (badgeText(c).indexOf(String(seasonPack.seeders)) < 0) throw new Error('без saved ожидал top-ranked (seasonPack): ' + badgeText(c));
    // saved указывает на single — бэйдж обязан показать именно его данные, не top-ranked,
    // раз клик по серии реально запустит сохранённый дефолт (findSavedDefault), а не лучший
    // по рейтингу.
    const saved = { id: candidateIdentity(single), title: single.title, size: single.size };
    const withSaved = badgeText(c, saved);
    if (withSaved.indexOf(String(single.seeders)) < 0) throw new Error('с saved ожидал данные single: ' + withSaved);
});
runner.test('selectEpisodeBadges прокидывает seasonDefault в каждую серию', () => {
    const saved = { id: candidateIdentity(single), title: single.title, size: single.size };
    const badges = selectEpisodeBadges({ movie: tvMovie }, state, saved);
    if (badges[7].text.indexOf(String(single.seeders)) < 0) throw new Error('серия 7 должна показывать saved-дефолт: ' + JSON.stringify(badges));
});
runner.test('selectEpisodeBadges: "поиск…" вместо пустой строки, пока пул/сезон грузятся', () => {
    // Раньше пустой pool (или poolStatus:'loading') давал ПУСТОЙ бейдж — неотличимо от
    // "ничего не искали" и "искали и не нашли". Первый холодный поиск против всех трекеров
    // Jackett может идти ~40с — на это время бейдж обязан явно сказать "поиск…".
    //
    // state.pool is now STRUCTURALLY always an array (results-state.js) — the pool search is
    // progressive/parallel-per-indexer, so "not settled yet" and "genuinely empty" are both
    // representable as `[]`, distinguished by poolStatus alone. There is no longer a `pool:
    // null` case to cover here — candidatesForEpisode/applyStateFilters assume an array
    // unconditionally now, by construction, not by a defensive check a test needs to exercise.
    //
    // Candidates are now checked FIRST (before loading/error — see this selector's own header
    // comment): the base `state` fixture's pool already has real matches for episode 7, so these
    // two loading sub-cases must ALSO clear `pool` to actually exercise "not settled, nothing yet"
    // rather than "settled loading flag stayed on but data already arrived" (which correctly shows
    // the real data, not a loading placeholder — that's the whole point of the progressive design).
    const loadingByStatus = selectEpisodeBadges({ movie: tvMovie }, Object.assign({}, state, { poolStatus: 'loading', pool: [] }));
    if (loadingByStatus[7].text !== 'поиск…' || !loadingByStatus[7].loading) {
        throw new Error('poolStatus=loading должен давать "поиск…" (loading:true): ' + JSON.stringify(loadingByStatus));
    }

    const loadingBySeason = selectEpisodeBadges({ movie: tvMovie }, Object.assign({}, state, { seasonLoads: { 2: 'loading' }, pool: [] }));
    if (loadingBySeason[7].text !== 'поиск…' || !loadingBySeason[7].loading) {
        throw new Error('seasonLoads[season]=loading должен давать "поиск…" (loading:true): ' + JSON.stringify(loadingBySeason));
    }

    // Пул реально готов и пуст (а не всё ещё грузится) — должно остаться настоящее
    // "раздачи не найдены" от badgeText, не "поиск…", и loading:false.
    const genuinelyEmpty = selectEpisodeBadges({ movie: tvMovie }, Object.assign({}, state, { pool: [] }));
    if (genuinelyEmpty[7].text !== 'раздачи не найдены' || genuinelyEmpty[7].loading) {
        throw new Error('пустой готовый пул должен давать "раздачи не найдены" (loading:false): ' + JSON.stringify(genuinelyEmpty));
    }

    // Обратный случай — данные УЖЕ пришли (быстрый трекер ответил), а poolStatus всё ещё
    // 'loading' (другие трекеры не ответили) — бейдж обязан показать реальные данные, а не
    // "поиск…", иначе прогрессивный поиск ничего не выигрывает у пользователя визуально.
    const arrivedWhileStillLoading = selectEpisodeBadges({ movie: tvMovie }, Object.assign({}, state, { poolStatus: 'loading' }));
    if (arrivedWhileStillLoading[7].loading || arrivedWhileStillLoading[7].text === 'поиск…') {
        throw new Error('данные для серии, уже пришедшие от быстрого трекера, не должны прятаться за "поиск…": ' + JSON.stringify(arrivedWhileStillLoading));
    }
});
runner.test('selectStatusText: статус пула — fallback, не перебивает statusText интеракторов', () => {
    if (selectStatusText(Object.assign({}, state, { statusText: 'Загрузка списка серий…', poolStatus: 'loading' })) !== 'Загрузка списка серий…') {
        throw new Error('statusText интерактора должен побеждать');
    }
    if (selectStatusText(Object.assign({}, state, { statusText: '', poolStatus: 'loading' })) !== 'Ищем раздачи по всем трекерам…') {
        throw new Error('fallback на poolStatus=loading не сработал');
    }
    if (selectStatusText(Object.assign({}, state, { statusText: '', poolStatus: 'ready' })) !== '') {
        throw new Error('пустой statusText при готовом пуле должен остаться пустым');
    }
});
runner.test('selectSearchProgress: loading/error/idle, эскалация формулировки на 15с, номер попытки', () => {
    const idle = selectSearchProgress(Object.assign({}, state, { poolStatus: 'ready' }));
    if (idle.stage !== 'idle') throw new Error('ожидал stage=idle, получил ' + JSON.stringify(idle));

    const freshLoading = selectSearchProgress(Object.assign({}, state, { poolStatus: 'loading', poolStartedAt: Date.now() }));
    if (freshLoading.stage !== 'loading' || freshLoading.slow) {
        throw new Error('свежий поиск (<15с) не должен быть "slow": ' + JSON.stringify(freshLoading));
    }

    const slowLoading = selectSearchProgress(Object.assign({}, state, { poolStatus: 'loading', poolStartedAt: Date.now() - 20000 }));
    if (slowLoading.stage !== 'loading' || !slowLoading.slow) {
        throw new Error('поиск дольше 15с должен быть "slow": ' + JSON.stringify(slowLoading));
    }
    if (selectStatusText(Object.assign({}, state, { statusText: '', poolStatus: 'loading', poolStartedAt: Date.now() - 20000 }))
        .indexOf('до 40 секунд') < 0) {
        throw new Error('эскалированный текст статуса не подтянулся');
    }

    // Сезон, у которого своя ленивая дозагрузка сейчас грузится — тоже 'loading', даже если сам
    // пул уже осел (loading побеждает error/idle — «жив ли поиск», а не «какая именно из трёх
    // независимых операций сейчас идёт»).
    const seasonLoading = selectSearchProgress(Object.assign({}, state, { poolStatus: 'error', seasonLoads: { 2: 'loading' } }));
    if (seasonLoading.stage !== 'loading') throw new Error('loading сезона должен перебивать error пула: ' + JSON.stringify(seasonLoading));

    const failed = selectSearchProgress(Object.assign({}, state, { poolStatus: 'error', poolAttempt: 3 }));
    if (failed.stage !== 'error' || failed.attempt !== 3) throw new Error('ожидал stage=error, attempt=3: ' + JSON.stringify(failed));
});
runner.test('selectSearchProgress/selectStatusText: стадия retrying с честным отсчётом до авто-повтора', () => {
    const retrying = selectSearchProgress(Object.assign({}, state, {
        poolStatus: 'error', poolAttempt: 2, poolAutoRetryAt: Date.now() + 4200
    }));
    if (retrying.stage !== 'retrying') throw new Error('ожидал stage=retrying, получил ' + JSON.stringify(retrying));
    if (retrying.retryInMs <= 0 || retrying.retryInMs > 4200) throw new Error('retryInMs вне ожидаемого диапазона: ' + JSON.stringify(retrying));
    if (typeof retrying.maxAttempts !== 'number' || retrying.maxAttempts < 2) throw new Error('maxAttempts не задан: ' + JSON.stringify(retrying));

    const text = selectStatusText(Object.assign({}, state, {
        statusText: '', poolStatus: 'error', poolAttempt: 2, poolAutoRetryAt: Date.now() + 4200
    }));
    if (text.indexOf('повтор через') < 0) throw new Error('ожидал честный текст про авто-повтор, получил: ' + text);

    // Момент авто-повтора уже прошёл (таймер вот-вот сработает по-настоящему) — это уже не
    // "retrying", а обычный "error" (не должно вечно висеть в retrying, если реальный вызов почему-то
    // задержался).
    const overdue = selectSearchProgress(Object.assign({}, state, {
        poolStatus: 'error', poolAttempt: 2, poolAutoRetryAt: Date.now() - 10
    }));
    if (overdue.stage !== 'error') throw new Error('просроченный poolAutoRetryAt не должен давать stage=retrying: ' + JSON.stringify(overdue));
});
runner.test('selectPickerData: empty и error различаются, error несёт retrySeason', () => {
    const emptyState = Object.assign({}, state, { pool: [], poolStatus: 'ready', picker: { open: true, episode: 99 } });
    const empty = selectPickerData({ movie: tvMovie }, emptyState, null);
    if (empty.status !== 'empty') throw new Error('genuinely empty должен давать status=empty: ' + JSON.stringify(empty));

    const errorState = Object.assign({}, state, { pool: [], poolStatus: 'error', picker: { open: true, episode: 99 } });
    const error = selectPickerData({ movie: tvMovie }, errorState, null);
    if (error.status !== 'error' || !error.retrySeason) {
        throw new Error('провалившийся поиск должен давать status=error, retrySeason=true: ' + JSON.stringify(error));
    }
});
runner.test('selectPoolIndexers: pending по имени, ok/error, reportedAt проходит без фильтрации по времени', () => {
    // Домен/селектор больше не решают, когда прятать успешный чип — это презентационная политика
    // View (ui/results-screen.js's TRACKER_SUCCESS_HIDE_MS + собственное планирование), не факт из
    // стора. selectPoolIndexers всегда отдаёт все трекеры, включая давно ответившие — View сам
    // решает, что с ними делать дальше.
    const allIndexers = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }];
    const longAgo = Date.now() - 60000;
    const s = Object.assign({}, state, {
        poolAllIndexers: allIndexers,
        poolIndexers: [
            { id: 'a', name: 'A', ok: true, error: null, elapsedMs: 42, reportedAt: longAgo }, // давний успех
            { id: 'b', name: 'B', ok: false, error: 'Не ответил вовремя', elapsedMs: 30000, reportedAt: longAgo } // провал
            // 'c' ещё не ответил вообще
        ]
    });
    const progress = selectPoolIndexers(s);
    if (progress.total !== 3) throw new Error('ожидал total=3: ' + JSON.stringify(progress));
    if (progress.pending !== 1) throw new Error('ожидал pending=1 (только c): ' + JSON.stringify(progress));
    if (progress.trackers.length !== 3) {
        throw new Error('ожидал все 3 трекера видимыми — селектор больше не прячет давние успехи сам: ' + JSON.stringify(progress));
    }
    const a = progress.trackers.find((t) => t.id === 'a');
    const b = progress.trackers.find((t) => t.id === 'b');
    const c = progress.trackers.find((t) => t.id === 'c');
    if (a.status !== 'ok' || a.elapsedMs !== 42 || a.reportedAt !== longAgo) {
        throw new Error('a должен быть ok/42мс с исходным reportedAt (не отфильтрован по возрасту): ' + JSON.stringify(a));
    }
    if (b.status !== 'error' || b.error !== 'Не ответил вовремя') throw new Error('b должен быть error: ' + JSON.stringify(b));
    if (c.status !== 'pending' || c.reportedAt !== null) throw new Error('c ещё не ответил, должен быть pending с reportedAt=null: ' + JSON.stringify(c));
});
runner.test('isConfidentMatch — высокий availability даёт уверенный матч', () => {
    const best = { _score: { availabilityScore: 18, value: 30 }, seeders: 12 };
    if (!isConfidentMatch(best, null)) throw new Error('должен быть уверенный матч');
});

// ---------- results-selectors ----------
runner.test('selectFilterChipData — содержит seasonItems с активным сезоном', () => {
    const data = selectFilterChipData(state, tvMovie, true);
    if (!Array.isArray(data.seasonItems)) throw new Error('нет seasonItems');
    const s2 = data.seasonItems.find((i) => i.season === 2);
    if (!s2 || s2.selected !== true) throw new Error('сезон 2 не отмечен активным: ' + JSON.stringify(data.seasonItems[1]));
});
runner.test('selectFilterItems/selectEpisodeBadges/selectBusy не бросают', () => {
    if (!Array.isArray(selectFilterItems(state, tvMovie, true))) throw new Error('selectFilterItems');
    const badges = selectEpisodeBadges({ movie: tvMovie }, state);
    if (typeof badges[7].text !== 'string' || !badges[7].text.length) throw new Error('бейдж серии 7 пуст: ' + JSON.stringify(badges));
    if (selectBusy({ episodesStatus: 'loading' }) !== true) throw new Error('selectBusy');
    if (selectBusy({ episodesStatus: 'ready' }) !== false) throw new Error('selectBusy ready');
});
runner.test('buildEpisodeTarget/selectCandidatesForEpisode', () => {
    const t = buildEpisodeTarget({ movie: tvMovie }, state, 7);
    if (t.episode !== 7 || t.season !== 2) throw new Error(JSON.stringify(t));
    if (!selectCandidatesForEpisode({ movie: tvMovie }, state, 7).length) throw new Error('нет кандидатов');
});

// ---------- scoring ----------
runner.test('scoreCandidate: гейт пропускает правильный сезон/эпизод, отсекает чужой', () => {
    const ok = scoreCandidate(single, target);
    if (!ok.passes) throw new Error('правильная раздача не прошла гейт');
    const wrong = scoreCandidate(single, { movie: tvMovie, season: 3, episode: 7, seasonEpisodeCount: 22, avgRuntimeMinutes: 22 });
    if (wrong.passes) throw new Error('раздача S02E07 прошла гейт для S03E07');
});
runner.test('titleSimilarity (через гейт): отсеивает шум для однословной цели "The Boys", реальные совпадения проходят', () => {
    // Живой репорт пользователя: поиск "Пацаны"/"The Boys" был крайне шумным — старый scattered
    // bag-of-words гейт считал "the" полноценным сигналом совпадения (входит почти в любой
    // английский тайтл), а после его исключения оставалось только "boys" — слишком частое слово
    // само по себе (Pet Shop Boys, The Beach Boys, The Hardy Boys, Monster Boy, Lost Boys...),
    // чтобы что-либо различить. Живая проверка через реальный /api/torrent-search дала 11 из 12
    // руками отобранных заведомо левых тайтлов, проходящих старый гейт — см. CLAUDE.md.
    const boysMovie = {
        id: 76479, name: 'Пацаны', original_name: 'The Boys', title: 'Пацаны', original_title: 'The Boys',
        first_air_date: '2019-07-25', number_of_seasons: 5
    };
    const boysTarget = { movie: boysMovie, season: 1, episode: 0, seasonEpisodeCount: 8, avgRuntimeMinutes: 60, customQuery: null };
    function passesFor(title) {
        const release = parseSeriesRelease(title);
        const item = { title, tracker: 'x', size: 2_000_000_000, seeders: 5, peers: 2, publishedAt: 0, magnet: 'magnet:?x', link: '', release };
        return scoreCandidate(item, boysTarget).passes;
    }
    const noise = [
        'Ведьмак: Сирены глубин /  The Witcher- Sirens of the Deep - AniLiberty.TOP [WEB-DLRip 1080p][AVC][Фильм]',
        'Monster Boy and the Cursed Kingdom [MOEMOE]',
        'Парни в лодке / The Boys in the Boat (Джордж Клуни ) [2023, биография, драма, спорт, WEB-DL 1080p] [Jaskier]',
        'Братья Харди / The Hardy Boys, S1E1-13 of 13 (2020) WEBRip',
        'The Beach Boys - The Pet Sounds Sessions [Deluxe Edition] (2026) FLAC',
        'Pet Shop Boys - Smash (The Singles 1985-2020) (Box Set) - 2023, FLAC',
        'Пропащие ребята 3: Жажда / Lost Boys: The Thirst (2010) BDRip',
        'Всем парням: С любовью... / To All the Boys: Always and Forever (Майкл Фимоньяри) [2021, мелодрама, комедия, WEB-DL 1080p] [Netflix]',
        'Братья Ньютон / The Newton Boys (1998) BDRemux'
    ];
    const real = [
        'Пацаны / The Boys / S1E1-8 of 8 (Филип Сгриккиа, Дэниэл Эттиэс, Эрик Крипке) [2019, фантастика, боевик, комедия, криминал, WEB-DL 1080p] [LostFilm]',
        'Пацаны / The Boys [S01] (2019) BDRip-HEVC 1080p от RIPS CLUB | P, P2'
    ];
    noise.forEach((title) => { if (passesFor(title)) throw new Error('шум прошёл гейт: ' + title); });
    real.forEach((title) => { if (!passesFor(title)) throw new Error('реальное совпадение не прошло гейт: ' + title); });
});
runner.test('applyStateFilters: пустой фильтр оставляет пул, несуществующий не ломает', () => {
    const f = applyStateFilters(state.pool, { ...state, voiceType: 'Дубляж' });
    if (f.length !== 2) throw new Error('не должен сужать до пустоты: ' + f.length);
});

// ---------- metadata / season-picker ----------
runner.test('episodeCounts/getSeasonMeta/initialSeason', () => {
    const counts = episodeCounts(tvMovie);
    if (counts[2] !== 19) throw new Error(JSON.stringify(counts));
    if (getSeasonMeta(tvMovie).length !== 3) throw new Error('getSeasonMeta');
    if (initialSeason(tvMovie) !== 1) throw new Error('initialSeason без прогресса = 1');
});
runner.test('buildSeasonItems — подсветка текущего сезона', () => {
    const items = buildSeasonItems(tvMovie, 3);
    const s3 = items.find((i) => i.season === 3);
    if (!s3 || s3.selected !== true) throw new Error(JSON.stringify(items));
    const s2 = items.find((i) => i.season === 2);
    if (s2.selected !== false) throw new Error('сезон 2 не должен быть выбран');
});
runner.test('openTarget не бросает', () => {
    openTarget(tvMovie, 2, 'content');
});

runner.test('fetchEnglishTitle: TMDB en-US lookup, ok(\'\') (не error) при сетевом сбое', async () => {
    globalThis.__clearReguest();
    globalThis.__mockReguest((url) => url.includes('/tv/') && url.includes('language=en-US'), { name: 'Demon Slayer: Kimetsu no Yaiba' });
    const result = await fetchEnglishTitle({ id: 777 }, MODE_SERIES);
    if (!result.ok || result.value !== 'Demon Slayer: Kimetsu no Yaiba') {
        throw new Error('ожидал английское название сериала: ' + JSON.stringify(result));
    }

    // Best-effort фича — сбой сети не должен всплывать как error, только как пустая строка,
    // чтобы вызывающий код тихо продолжил работать с original_title (см. metadata/tmdb.js's
    // own comment on fetchEnglishTitle).
    globalThis.__clearReguest();
    const failed = await fetchEnglishTitle({ id: 778 }, MODE_MOVIE);
    if (!failed.ok || failed.value !== '') throw new Error('при сбое сети ожидал ok(\'\'), не error: ' + JSON.stringify(failed));
});
runner.test('buildFilterItems — содержит измерение Битрейт только с реальными бакетами пула', () => {
    const items = buildFilterItems(tvMovie, true, state);
    const bitrate = items.find((i) => i.kind === 'bitrate');
    if (!bitrate) throw new Error('нет пункта Битрейт');
    const keys = bitrate.items.map((i) => i.value);
    // single (S02E07, 2.5 ГБ) → ~15 Mbps → b12; pack (S1-5E1-62, 120 ГБ) → ~11.7 → b5-12
    if (keys.indexOf('b5-12') < 0 || keys.indexOf('b12') < 0) throw new Error('ожидал бакеты b5-12 и b12: ' + JSON.stringify(keys));
});

runner.test('activeFilterLabels включает выбранный битрейт', () => {
    const l = activeFilterLabels({ voiceType: 'any', resolution: 'any', bitrate: 'b5-12' });
    if (l.join(',') !== '5–12 Мбит/с') throw new Error(JSON.stringify(l));
});

runner.test('applyStateFilters фильтрует по битрейт-бакету', () => {
    const low = applyStateFilters(state.pool, { ...state, bitrate: 'b12' });
    if (low.length !== 1 || low[0] !== single) throw new Error('b12 должен оставить только single');
    const mid = applyStateFilters(state.pool, { ...state, bitrate: 'b5-12' });
    if (mid.length !== 1 || mid[0] !== seasonPack) throw new Error('b5-12 должен оставить только пак');
});

runner.test('candidateBadgeText показывает расчётный битрейт', () => {
    const withScore = Object.assign({}, single, { _score: { bitrateMbps: 15.2 } });
    const text = candidateBadgeText(withScore);
    if (text.indexOf('~15.2 Mbps') < 0) throw new Error('нет битрейта в бейдже: ' + text);
});

runner.test('формат: рискованная раздача (XviD AVI) получает штраф и маркер «Риск:»', () => {
    const riskyItem = {
        title: 'Фильм (2003) 720p XviD AVI', tracker: 'RuTracker', size: 1400000000,
        seeders: 10, peers: 5, magnet: 'magnet:?xt=urn:btih:ee', link: '',
        release: parseRelease('Фильм (2003) 720p XviD AVI')
    };
    const likelyItem = {
        title: 'Фильм (2024) 720p H.264 MP4', tracker: 'RuTracker', size: 1400000000,
        seeders: 10, peers: 5, magnet: 'magnet:?xt=urn:btih:ff', link: '',
        release: parseRelease('Фильм (2024) 720p H.264 MP4')
    };
    const target = { movie: movie, season: 0, episode: 0, seasonEpisodeCount: 0, avgRuntimeMinutes: 0 };
    const riskyScore = scoreCandidate(riskyItem, target);
    const likelyScore = scoreCandidate(likelyItem, target);
    if (!(riskyScore.value < likelyScore.value)) throw new Error('рискованный не штрафуется: ' + riskyScore.value + ' vs ' + likelyScore.value);
    if (candidateBadgeText(riskyItem).indexOf('Риск: XviD') < 0) throw new Error('нет маркера «Риск:»: ' + candidateBadgeText(riskyItem));
});

runner.test('выбор файла: фильм не использует episode/season scoring и выбирает основной файл', () => {
    const files = [
        { id: 1, path: 'sample.mkv', length: 50_000_000 },
        { id: 2, path: 'Dune.Part.Two.2024.mkv', length: 12_000_000_000 },
        { id: 3, path: 'bonus-trailer.mp4', length: 500_000_000 }
    ];
    const chosen = pickBestFile(files, { mode: 'movie', season: 0, episode: 0 }, () => ({
        explicitSeason: true, seasons: [99], explicitEpisode: true, episodeFrom: 1, episodeTo: 1
    }));
    if (!chosen || chosen.id !== 2) throw new Error('фильм выбрал не основной файл: ' + JSON.stringify(chosen));
});

runner.test('выбор файла: сериал сохраняет episode-aware выбор', () => {
    const files = [
        { id: 1, path: 'Show.S02E08.mkv', length: 10_000_000_000 },
        { id: 2, path: 'Show.S02E07.mkv', length: 1_000_000_000 }
    ];
    const chosen = pickBestFile(files, { mode: 'series', season: 2, episode: 7 }, (path) => ({
        explicitSeason: true, seasons: [2], explicitEpisode: true,
        episodeFrom: path.indexOf('E08') >= 0 ? 8 : 7, episodeTo: path.indexOf('E08') >= 0 ? 8 : 7
    }));
    if (!chosen || chosen.id !== 2) throw new Error('сериал потерял выбор по эпизоду: ' + JSON.stringify(chosen));
});

runner.test('createSeriesResultsViewModel/createMovieResultsViewModel forward domain.scope', () => {
    // Both files are 22-line pass-throughs to createResultsDomain (CLAUDE.md) that explicitly
    // re-list which fields to expose to the View rather than spreading the whole domain object —
    // results-domain.js added a `scope` field for the shared lifecycle work, and both wrappers'
    // own field lists were never updated to forward it. Every other test in this suite constructs
    // via createResultsDomain directly, bypassing these wrappers entirely, so nothing caught the
    // gap until it threw live in the browser: `TypeError: Cannot read properties of undefined
    // (reading 'subscribe')` inside ui/results-screen.js's `domain.scope.subscribe(...)` call,
    // silently swapped to Lampa's nocomponent empty-state screen by Component.create's own
    // try/catch (see CLAUDE.md) instead of showing any visible error.
    const seriesVm = createSeriesResultsViewModel({ object: { movie: tvMovie, season: 2 }, movie: tvMovie });
    if (!seriesVm.scope || typeof seriesVm.scope.subscribe !== 'function') {
        throw new Error('createSeriesResultsViewModel не прокинул рабочий scope: ' + JSON.stringify(seriesVm.scope));
    }
    seriesVm.destroy();

    const movieVm = createMovieResultsViewModel({ object: { movie: movie, season: 0 }, movie: movie });
    if (!movieVm.scope || typeof movieVm.scope.subscribe !== 'function') {
        throw new Error('createMovieResultsViewModel не прокинул рабочий scope: ' + JSON.stringify(movieVm.scope));
    }
    movieVm.destroy();
});

await runner.run();
