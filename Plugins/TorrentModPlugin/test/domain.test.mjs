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
    selectPickerData
} from '../domain/results-selectors.js';
import { episodeCounts, getSeasonMeta } from '../metadata/tmdb.js';
import { initialSeason, buildSeasonItems, openTarget } from '../metadata/season-picker.js';
import { pickBestFile } from '../playback/file-selection.js';

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
    const loadingByNullPool = selectEpisodeBadges({ movie: tvMovie }, Object.assign({}, state, { pool: null }));
    if (loadingByNullPool[7].text !== 'поиск…' || !loadingByNullPool[7].loading) {
        throw new Error('pool=null должен давать "поиск…" (loading:true): ' + JSON.stringify(loadingByNullPool));
    }

    const loadingByStatus = selectEpisodeBadges({ movie: tvMovie }, Object.assign({}, state, { poolStatus: 'loading' }));
    if (loadingByStatus[7].text !== 'поиск…' || !loadingByStatus[7].loading) {
        throw new Error('poolStatus=loading должен давать "поиск…" (loading:true): ' + JSON.stringify(loadingByStatus));
    }

    const loadingBySeason = selectEpisodeBadges({ movie: tvMovie }, Object.assign({}, state, { seasonLoads: { 2: 'loading' } }));
    if (loadingBySeason[7].text !== 'поиск…' || !loadingBySeason[7].loading) {
        throw new Error('seasonLoads[season]=loading должен давать "поиск…" (loading:true): ' + JSON.stringify(loadingBySeason));
    }

    // Пул реально готов и пуст (а не всё ещё грузится) — должно остаться настоящее
    // "раздачи не найдены" от badgeText, не "поиск…", и loading:false.
    const genuinelyEmpty = selectEpisodeBadges({ movie: tvMovie }, Object.assign({}, state, { pool: [] }));
    if (genuinelyEmpty[7].text !== 'раздачи не найдены' || genuinelyEmpty[7].loading) {
        throw new Error('пустой готовый пул должен давать "раздачи не найдены" (loading:false): ' + JSON.stringify(genuinelyEmpty));
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

await runner.run();
