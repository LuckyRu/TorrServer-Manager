import './helpers/mock-lampa.mjs';
import { createRunner } from './helpers/test-runner.mjs';
import { parseRelease, parseSignals } from '../search/release-parsing.js';
import { baseTitles, defaultSearchName, buildQueries, isAnimeTarget, buildAnimeQueries } from '../search/query-building.js';
import { buildMovieQueries } from '../search/movie-query-building.js';
import { buildSeriesQueries } from '../search/series-query-building.js';
import { buildSearchPlan, ANIME_INDEXER_IDS } from '../search/indexer-search-strategies.js';
import { parseMovieRelease } from '../search/movie-release-parsing.js';
import { parseSeriesRelease } from '../search/series-release-parsing.js';
import { evaluateMediaTypeGate, evaluateSearchTitleGate, extractSearchTitleSegments } from '../search/search-gates.js';
import { scoreCandidate, createCandidateScoreBase, scoreCandidateFromBase, applyStateFilters, evaluateCandidatePool, passesSearchTitleGate, estimatePayload } from '../search/scoring.js';
import {
    createInitialState, isSeriesWithSeasons, poolValues, poolTranslators, currentSeasonLabel,
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
import { mergeReleases } from '../shared/release-identity.js';
import { initialSeason, buildSeasonItems, openTarget } from '../metadata/season-picker.js';
import { pickBestFile } from '../playback/file-selection.js';
import { createSeriesResultsViewModel } from '../domain/series-results-viewmodel.js';
import { createMovieResultsViewModel } from '../domain/movie-results-viewmodel.js';
import { createResultsProjectionCache } from '../domain/results-projections.js';
import { pickerNavigationWindow, adjacentPickerId, replacementPickerId } from '../ui/picker-navigation.js';

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

const target = { movie: tvMovie, season: 2, episode: 7, seasonEpisodeCount: 19, avgRuntimeMinutes: 22 };

const state = {
    season: 2,
    filters: { voiceType: 'any', translator: 'any', resolution: 'any', bitrate: 'any' },
    pool: [single, seasonPack],
    episodesCache: [{ episode_number: 1 }, { episode_number: 7 }, { episode_number: 8 }],
    seasonEpisodeCount: 19, avgRuntimeMinutes: 22,
    poolStatus: 'ready', episodesStatus: 'ready',
    stage: 'episodes', statusText: '', lastEpisode: 0
};

// ---------- query building ----------
runner.test('defaultSearchName использует parse_lang (df → оригинальное название)', () => {
    if (defaultSearchName(tvMovie) !== 'Futurama') throw new Error('expected "Futurama", got "' + defaultSearchName(tvMovie) + '"');
    if (defaultSearchName(tvMovie, 'Futurama', false) !== 'Futurama') throw new Error('поиск сериалов не должен добавлять год');
});
runner.test('buildQueries для пула — один запрос по названию', () => {
    const q = buildQueries({ movie: tvMovie, season: 0, episode: 0 });
    if (q.length !== 1 || q[0] !== 'Futurama') throw new Error(JSON.stringify(q));
});
runner.test('buildQueries использует название TMDB и сигналы сезона/эпизода', () => {
    const q = buildQueries({ movie: tvMovie, season: 2, episode: 7 });
    if (q.indexOf('Futurama S02E07') < 0 || q.indexOf('Futurama S02') < 0) throw new Error(JSON.stringify(q));
});
runner.test('режимы поиска: фильм не получает season/episode suffix, сериал получает', () => {
    const movieQueries = buildMovieQueries({ movie, season: 4, episode: 2 });
    if (movieQueries.length !== 1 || /S\d+E\d+/i.test(movieQueries[0])) throw new Error(JSON.stringify(movieQueries));
    const seriesQueries = buildSeriesQueries({ movie: tvMovie, season: 2, episode: 7 });
    if (seriesQueries.indexOf('Futurama S02E07') < 0) throw new Error(JSON.stringify(seriesQueries));
});
runner.test('series query не использует год, movie query сохраняет настройку имени', () => {
    const seriesQueries = buildSeriesQueries({ movie: tvMovie, season: 0, episode: 0, englishTitle: 'Futurama' });
    if (seriesQueries.length !== 1 || seriesQueries[0].includes('1999')) throw new Error(JSON.stringify(seriesQueries));
    const movieQueries = buildMovieQueries({ movie: { ...movie, release_date: '2024-02-01' }, englishTitle: 'Dune' });
    if (movieQueries.length !== 1 || movieQueries[0] !== 'Dune') throw new Error(JSON.stringify(movieQueries));
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
runner.test('anime profile сохраняет CJK alias и не меняет обычные сериалы', () => {
    const asianMovie = {
        id: 999, name: 'Клинок, рассекающий демонов', original_name: '鬼滅の刃',
        title: 'Клинок, рассекающий демонов', original_title: '鬼滅の刃',
        original_language: 'ja', genre_ids: [16], origin_country: ['JP']
    };
    const withEnglish = baseTitles(asianMovie, 'Demon Slayer');
    if (withEnglish.indexOf('Demon Slayer') < 0) throw new Error('englishTitle отсутствует в baseTitles: ' + JSON.stringify(withEnglish));
    if (withEnglish.indexOf('鬼滅の刃') < 0) throw new Error('CJK original_title не должен теряться: ' + JSON.stringify(withEnglish));
    if (!isAnimeTarget({ movie: asianMovie, mode: 'series' })) throw new Error('anime profile не определился');

    const name = defaultSearchName(asianMovie, 'Demon Slayer');
    if (name !== 'Demon Slayer') throw new Error('defaultSearchName должен предпочесть englishTitle: ' + name);

    const queries = buildAnimeQueries({ movie: asianMovie, englishTitle: 'Demon Slayer', mode: 'series', season: 2, episode: 3 });
    if (queries.indexOf('鬼滅の刃') < 0 || !queries.some((query) => /TV-2/.test(query)) || !queries.some((query) => /S02E03/.test(query))) {
        throw new Error('anime query plan не содержит aliases и сезонные маркеры: ' + JSON.stringify(queries));
    }

    const plan = buildSearchPlan({ movie: asianMovie, englishTitle: 'Demon Slayer', mode: 'series', season: 2 }, queries);
    const animeRoutes = plan.filter((entry) => entry.indexerIds);
    const generalRoute = plan.find((entry) => entry.excludeIndexerIds);
    if (animeRoutes.length !== 3 || animeRoutes.some((entry) => entry.indexerIds.join(',') !== ANIME_INDEXER_IDS.join(','))) {
        throw new Error('anime-план должен отправить три alias-запроса в AniDUB/Anilibria: ' + JSON.stringify(plan));
    }
    if (!generalRoute || generalRoute.excludeIndexerIds.join(',') !== ANIME_INDEXER_IDS.join(',')) {
        throw new Error('общий anime-запрос должен исключать специализированные индексаторы: ' + JSON.stringify(plan));
    }

    const western = Object.assign({}, tvMovie, { original_language: 'en', genre_ids: [16], origin_country: ['US'] });
    if (isAnimeTarget({ movie: western, mode: 'series' })) throw new Error('американская анимация ошибочно попала в anime profile');

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
    if (s.season !== 3 || !s.filters || s.filters.voiceType !== 'any' || s.filters.translator !== 'any' || s.filters.resolution !== 'any') throw new Error(JSON.stringify(s));
});
runner.test('poolValues — только реально присутствующие значения', () => {
    const v = poolValues(state, (i) => i.release.resolution);
    if (v.length !== 1 || v[0] !== '1080p') throw new Error(JSON.stringify(v));
});
runner.test('poolTranslators — собирает уникальные студии в порядке появления', () => {
    const pool = [
        { release: { translators: ['LostFilm', 'Кубик в Кубе'] } },
        { release: { translators: ['Кубик в Кубе', 'Jetvis Studio'] } },
        { release: { translators: [] } }
    ];
    const values = poolTranslators(pool);
    if (JSON.stringify(values) !== JSON.stringify(['LostFilm', 'Кубик в Кубе', 'Jetvis Studio'])) throw new Error(JSON.stringify(values));
});
runner.test('buildFilterItems — структура и не бросает', () => {
    const withStudio = Object.assign({}, single, { release: Object.assign({}, single.release, { translators: ['Jetvis Studio'] }) });
    const items = buildFilterItems(tvMovie, true, Object.assign({}, state, { pool: [withStudio, seasonPack] }));
    if (items.length < 4) throw new Error('мало пунктов: ' + items.length);
    const voice = items.find((i) => i.kind === 'voice');
    if (!voice || !voice.items || voice.items.length === 0) throw new Error('нет пункта Перевод');
    const translator = items.find((i) => i.kind === 'translator');
    if (!translator || translator.items.map((i) => i.value).indexOf('Jetvis Studio') < 0) throw new Error('нет пункта Студия: ' + JSON.stringify(translator));
});
runner.test('activeFilterLabels', () => {
    const l = activeFilterLabels({ filters: { voiceType: 'Дубляж', translator: 'Jetvis Studio', resolution: '1080p' } });
    if (l.join(',') !== 'Дубляж,Jetvis Studio,1080p') throw new Error(JSON.stringify(l));
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
runner.test('candidateIdentity: одинаковый релиз стабилен при разных Jackett-ссылках', () => {
    const first = { title: single.title, tracker: single.tracker, size: single.size, magnet: '', link: 'http://jackett/dl?path=AAA111' };
    const second = { title: single.title, tracker: single.tracker, size: single.size, magnet: '', link: 'http://jackett/dl?path=ZZZ999' };
    if (candidateIdentity(first) !== candidateIdentity(second)) {
        throw new Error('identity разъехалась между поисками из-за разного link: ' + candidateIdentity(first) + ' vs ' + candidateIdentity(second));
    }
    const withMagnet = { title: single.title, tracker: single.tracker, size: single.size, magnet: 'magnet:?xt=urn:btih:abc', link: 'http://jackett/dl?path=AAA111' };
    if (candidateIdentity(withMagnet) !== candidateIdentity(first)) {
        throw new Error('magnet не должен менять identity уже известного релиза');
    }
});
runner.test('mergeReleases: дубль с новым path схлопывается и сохраняет лучшую доступность', () => {
    const first = { title: single.title, tracker: 'RuTracker', size: single.size, seeders: 13, link: 'path=A' };
    const second = { title: single.title, tracker: 'RuTracker', size: single.size, seeders: 70, link: 'path=B' };
    const merged = mergeReleases([first], [second]);
    if (merged.length !== 1) throw new Error('дубликат релиза не схлопнулся: ' + merged.length);
    if (merged[0].seeders !== 70) throw new Error('не сохранена запись с лучшей доступностью');
});

runner.test('mergeReleases сохраняет ссылку пула при бессодержательном ответе', () => {
    const pool = [single, seasonPack];
    if (mergeReleases(pool, []) !== pool) throw new Error('пустой merge создал новый массив');
    if (mergeReleases(pool, [single]) !== pool) throw new Error('неизменившийся дубль создал новый массив');
});
runner.test('badgeText предпочитает сохранённый дефолт top-ranked кандидату', () => {
    const c = candidatesForEpisode(state.pool, target, state);
    if (badgeText(c).indexOf(String(c[0].seeders)) < 0) throw new Error('без saved ожидал top-ranked: ' + badgeText(c));
    const saved = { id: candidateIdentity(single), title: single.title, size: single.size };
    const withSaved = badgeText(c, saved);
    if (withSaved.indexOf(String(single.seeders)) < 0) throw new Error('с saved ожидал данные single: ' + withSaved);
});
runner.test('selectEpisodeBadges прокидывает seasonDefault в каждую серию', () => {
    const saved = { id: candidateIdentity(single), title: single.title, size: single.size };
    const badges = selectEpisodeBadges({ movie: tvMovie }, state, saved);
    if (badges[7].text.indexOf(String(single.seeders)) < 0) throw new Error('серия 7 должна показывать saved-дефолт: ' + JSON.stringify(badges));
});
runner.test('selectEpisodeBadges показывает affordance выбора только при нескольких раздачах', () => {
    const badges = selectEpisodeBadges({ movie: tvMovie }, state);
    if (!badges[7].canPick) throw new Error('для серии с двумя кандидатами нужен шеврон выбора');
    if (badges[1].canPick) throw new Error('для серии с одной раздачей шеврон не нужен');
});
runner.test('оптимизированные episode badges совпадают с полным candidate pipeline', () => {
    const badges = selectEpisodeBadges({ movie: tvMovie }, state);
    state.episodesCache.forEach((episode) => {
        const number = episode.episode_number;
        const candidates = selectCandidatesForEpisode({ movie: tvMovie }, state, number);
        const expected = badgeText(candidates, null);
        if (badges[number].text !== expected) {
            throw new Error('episode ' + number + ': ' + badges[number].text + ' != ' + expected);
        }
        if (badges[number].canPick !== (candidates.length > 1)) throw new Error('canPick расходится для episode ' + number);
    });
});
runner.test('selectEpisodeBadges: "поиск…" вместо пустой строки, пока пул/сезон грузятся', () => {
    const loadingByStatus = selectEpisodeBadges({ movie: tvMovie }, Object.assign({}, state, { poolStatus: 'loading', pool: [] }));
    if (loadingByStatus[7].text !== 'поиск…' || !loadingByStatus[7].loading) {
        throw new Error('poolStatus=loading должен давать "поиск…" (loading:true): ' + JSON.stringify(loadingByStatus));
    }

    const loadingBySeason = selectEpisodeBadges({ movie: tvMovie }, Object.assign({}, state, { seasonLoads: { 2: 'loading' }, pool: [] }));
    if (loadingBySeason[7].text !== 'поиск…' || !loadingBySeason[7].loading) {
        throw new Error('seasonLoads[season]=loading должен давать "поиск…" (loading:true): ' + JSON.stringify(loadingBySeason));
    }

    const genuinelyEmpty = selectEpisodeBadges({ movie: tvMovie }, Object.assign({}, state, { pool: [] }));
    if (genuinelyEmpty[7].text !== 'раздачи не найдены' || genuinelyEmpty[7].loading) {
        throw new Error('пустой готовый пул должен давать "раздачи не найдены" (loading:false): ' + JSON.stringify(genuinelyEmpty));
    }

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

    const overdue = selectSearchProgress(Object.assign({}, state, {
        poolStatus: 'error', poolAttempt: 2, poolAutoRetryAt: Date.now() - 10
    }));
    if (overdue.stage !== 'error') throw new Error('просроченный poolAutoRetryAt не должен давать stage=retrying: ' + JSON.stringify(overdue));
});
runner.test('selectPickerData: empty и error различаются, error несёт retrySeason', () => {
    const ready = selectPickerData({ movie: tvMovie }, Object.assign({}, state, { picker: { open: true, episode: 7 } }), null);
    if (ready.status !== 'ready' || ready.rows.length !== ready.items.length || !ready.rows[0].id || !ready.rows[0].badge) {
        throw new Error('ready picker не подготовил row projection: ' + JSON.stringify(ready));
    }
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
    const best = { _score: { availabilityScore: 18, matchScore: 100, value: 30 }, seeders: 12 };
    if (!isConfidentMatch(best, null)) throw new Error('должен быть уверенный матч');
});
runner.test('isConfidentMatch — личеры без сидов не считаются доступной раздачей', () => {
    const score = scoreCandidate(Object.assign({}, single, { seeders: 0, peers: 100, leechers: 100 }), target);
    const best = { _score: score, seeders: 0 };
    if (score.availabilityScore !== 0) throw new Error('личеры дали availability без сидов: ' + JSON.stringify(score));
    if (isConfidentMatch(best, null)) throw new Error('раздача без сидов не должна быть уверенной');
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
runner.test('scoreCandidateFromBase совпадает с полной оценкой для разных эпизодов', () => {
    const baseTarget = Object.assign({}, target, { episode: 0 });
    const base = createCandidateScoreBase(single, baseTarget);
    [1, 7, 8].forEach((episode) => {
        const episodeTarget = Object.assign({}, target, { episode });
        const full = scoreCandidate(single, episodeTarget);
        const reused = scoreCandidateFromBase(single, episodeTarget, base);
        if (JSON.stringify(full) !== JSON.stringify(reused)) {
            throw new Error('episode ' + episode + ': ' + JSON.stringify({ full, reused }));
        }
    });
});
runner.test('scoreCandidate: высокий payload HEVC/HDR не получает симметричный штраф', () => {
    const boysMovie = {
        title: 'Ферма Кларксона', original_title: "Clarkson's Farm",
        name: 'Ферма Кларксона', original_name: "Clarkson's Farm"
    };
    const boysTarget = { movie: boysMovie, englishTitle: "Clarkson's Farm", season: 2, episode: 1, seasonEpisodeCount: 8, avgRuntimeMinutes: 50 };
    const first = {
        title: "Ферма Кларксона / Clarkson's Farm / S2E1-8 2160p WEB-DL",
        size: 40450000000, seeders: 13, peers: 8,
        release: parseSeriesRelease("Ферма Кларксона / Clarkson's Farm / S2E1-8 2160p WEB-DL")
    };
    const hevcHdr = {
        title: "Ферма Кларксона / Clarkson's Farm / Сезоны: 1-2 / Эпизоды: 1-16 2160p WEB-DL HDR H.265",
        size: 82860000000, seeders: 70, peers: 46,
        release: parseSeriesRelease("Ферма Кларксона / Clarkson's Farm / Сезоны: 1-2 / Эпизоды: 1-16 2160p WEB-DL HDR H.265")
    };
    const popular1080 = {
        title: "Ферма Кларксона / Clarkson's Farm / S2E1-8 1080p WEBRip",
        size: 26760707777, seeders: 106, peers: 9,
        release: parseSeriesRelease("Ферма Кларксона / Clarkson's Farm / S2E1-8 1080p WEBRip")
    };
    const firstScore = scoreCandidate(first, boysTarget);
    const hevcScore = scoreCandidate(hevcHdr, boysTarget);
    const popular1080Score = scoreCandidate(popular1080, boysTarget);
    if (!firstScore.passes || !hevcScore.passes) throw new Error('тестовые релизы не прошли title/season gate');
    if (hevcScore.qualityScore < firstScore.qualityScore) {
        throw new Error('HEVC/HDR всё ещё штрафуется сильнее близкого H.264: ' + JSON.stringify({ first: firstScore, hevc: hevcScore }));
    }
    if (hevcScore.value <= firstScore.value) {
        throw new Error('HEVC/HDR с 70 сидами не обошёл релиз с 13 сидами: ' + JSON.stringify({ first: firstScore, hevc: hevcScore }));
    }
    if (popular1080Score.value <= firstScore.value) {
        throw new Error('1080p со 106 сидами должен быть надёжнее 4K с 13 сидами: ' + JSON.stringify({ first: firstScore, popular1080: popular1080Score }));
    }
    if (Math.abs(firstScore.payloadMbps - 13.48) > 0.05 || Math.abs(hevcScore.payloadMbps - 13.81) > 0.05) {
        throw new Error('payload рассчитан неверно: ' + JSON.stringify({ first: firstScore, hevc: hevcScore }));
    }
});
runner.test('estimatePayload: многосезонный пак без E-диапазона использует сумму episode_count', () => {
    const release = parseSeriesRelease('Футурама / Futurama S1-3 1080p WEB-DL');
    const item = { title: 'Футурама / Futurama S1-3 1080p WEB-DL', size: 120_000_000_000, release };
    const payload = estimatePayload(item, { movie: tvMovie, mode: MODE_SERIES, season: 2, seasonEpisodeCount: 19, avgRuntimeMinutes: 22 });
    if (payload.coverageEpisodes !== 54 || payload.confidence !== 'medium') throw new Error(JSON.stringify(payload));
    const expected = 120_000_000_000 * 8 / (54 * 22 * 60 * 1_000_000);
    if (Math.abs(payload.mbps - expected) > 0.01) throw new Error(JSON.stringify(payload));
});
runner.test('estimatePayload: фильм без runtime возвращает неизвестную оценку вместо fallback 42 минуты', () => {
    const item = { title: 'Дюна / Dune 2024 2160p WEB-DL', size: 20_000_000_000, release: parseMovieRelease('Дюна / Dune 2024 2160p WEB-DL') };
    const payload = estimatePayload(item, { movie, mode: MODE_MOVIE, season: 0, episode: 0, avgRuntimeMinutes: 0 });
    if (payload.mbps !== null || payload.confidence !== 'none') throw new Error(JSON.stringify(payload));
});
runner.test('scoreCandidate: высокий H.264 payload не уменьшает visual quality', () => {
    const target = { movie: Object.assign({}, movie, { runtime: 120 }), mode: MODE_MOVIE, season: 0, episode: 0, avgRuntimeMinutes: 120 };
    const title = 'Дюна / Dune 2024 1080p WEB-DL H.264';
    const base = { title, seeders: 10, peers: 2, release: parseMovieRelease(title) };
    const normal = scoreCandidate(Object.assign({}, base, { size: 7_000_000_000 }), target);
    const large = scoreCandidate(Object.assign({}, base, { size: 30_000_000_000 }), target);
    if (large.qualityScore < normal.qualityScore) throw new Error(JSON.stringify({ normal, large }));
});
runner.test('titleSimilarity (через гейт): отсеивает шум для однословной цели "The Boys", реальные совпадения проходят', () => {
    const boysMovie = {
        id: 76479, name: 'Пацаны', original_name: 'The Boys', title: 'Пацаны', original_title: 'The Boys',
        first_air_date: '2019-07-25', number_of_seasons: 5
    };
    const boysTarget = { movie: boysMovie, season: 1, episode: 0, seasonEpisodeCount: 8, avgRuntimeMinutes: 60 };
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
runner.test('anime title gate принимает alias после E-префикса и CJK-оригинал', () => {
    const hellMode = {
        movie: { title: 'Адский режим', original_name: 'Hell Mode' },
        englishTitle: 'Hell Mode', mode: MODE_SERIES
    };
    const alternative = 'Адский уровень / E01-E06 Hell Mode: Yarikomi Suki no Gamer wa Hai Settei no Isekai de Musou suru [WEBRip 1080p]';
    const segments = extractSearchTitleSegments(alternative);
    if (!segments.some((segment) => segment.indexOf('Hell Mode') >= 0)) throw new Error(JSON.stringify(segments));
    if (!evaluateSearchTitleGate({ title: alternative }, hellMode).passes) throw new Error('альтернативный anime alias был отброшен');

    const chinese = { movie: { title: 'Воин судьбы', original_name: '择天记' }, mode: MODE_SERIES };
    if (!evaluateSearchTitleGate({ title: '择天记 S01E01 1080p WEB-DL' }, chinese).passes) throw new Error('CJK alias не прошёл title gate');
});
runner.test('passesSearchTitleGate отсекает явный шум до доменного пула', () => {
    const item = {
        title: 'The Beach Boys - The Pet Sounds Sessions [Deluxe Edition]',
        release: parseSeriesRelease('The Beach Boys - The Pet Sounds Sessions [Deluxe Edition]')
    };
    const boys = { movie: { title: 'Пацаны', original_title: 'The Boys' }, englishTitle: '' };
    if (passesSearchTitleGate(item, boys)) throw new Error('явный шум прошёл ранний title-gate');
});
runner.test('search gates: корпус Игры престолов отсекает книги, аудио, игры и чужой заголовок', () => {
    const gotMovie = { title: 'Игра престолов', original_title: 'Game of Thrones' };
    const gotTarget = { movie: gotMovie, englishTitle: 'Game of Thrones', mode: MODE_SERIES };
    const cases = [
        ['Игра престолов / Game of Thrones [S1-8] (2011-2019) BDRip 1080p-LostFilm', true, ''],
        ['Игра престолов / Game of Thrones S01', true, ''],
        ['Игра престолов / Game of Thrones (2012) PC | RePack от R.G. Механики', false, 'game-distribution'],
        ['Джордж Мартин - Песнь Льда и Пламени [01. Игра престолов] (2012) MP3', false, 'audio-only'],
        ['Брайан Когман / HBO: Игра престолов (2015) PDF', false, 'ebook-or-document'],
        ['Ramin Djawadi / Игра Престолов 7 (Game Of Thrones 7) (2017) FLAC, lossless', false, 'audio-only'],
        ['Настоящая война / игра престолов (4 S1-6 серий из 6, DVB)', false, 'conflicting-title'],
        ['Игра Дарвина / E01-E11 Darwin\'s Game [WEBRip 1080p]', false, 'title-mismatch']
    ];

    cases.forEach(([title, expectedPass, expectedReason]) => {
        const item = { title, release: parseSeriesRelease(title) };
        const media = evaluateMediaTypeGate(item, gotTarget);
        const titleDecision = media.passes ? evaluateSearchTitleGate(item, gotTarget) : media;
        if (titleDecision.passes !== expectedPass || titleDecision.reason !== expectedReason) {
            throw new Error(title + ': ' + JSON.stringify({ media, titleDecision }));
        }
    });
});
runner.test('anime TV-N: ТВ-1/ТВ-2 мапятся на сезоны и не пересекаются', () => {
    const tv2Title = 'Адский режим (ТВ-2) | Hell Mode [TV] [1-5 из 13] 1080p WEB-DL';
    const tv1Title = 'Адский режим (ТВ-1) | Hell Mode [TV] [1-12 из 12] 1080p WEB-DL';
    const tv2 = parseSeriesRelease(tv2Title);
    const tv1 = parseSeriesRelease(tv1Title);
    if (JSON.stringify(tv2.seasons) !== JSON.stringify([2]) || !tv2.explicitSeason) throw new Error(JSON.stringify(tv2));
    if (JSON.stringify(tv1.seasons) !== JSON.stringify([1]) || !tv1.explicitSeason) throw new Error(JSON.stringify(tv1));

    const target = { movie: { title: 'Адский режим', original_title: 'Hell Mode' }, mode: MODE_SERIES, season: 2, episode: 3, seasonEpisodeCount: 13, avgRuntimeMinutes: 24, englishTitle: 'Hell Mode' };
    const item = { title: tv2Title, seeders: 8, peers: 0, size: 1000, publishedAt: 0, release: tv2 };
    const wrong = { title: tv1Title, seeders: 8, peers: 0, size: 1000, publishedAt: 0, release: tv1 };
    if (!scoreCandidate(item, target).passes) throw new Error('TV-2 должен пройти для сезона 2: ' + JSON.stringify(scoreCandidate(item, target)));
    if (scoreCandidate(wrong, target).passes) throw new Error('TV-1 не должен пройти для сезона 2');
});
runner.test('media-type gate не считает FLAC аудиодорожку аудио-only при сильных видеосигналах', () => {
    const title = 'Игра престолов / Game of Thrones S01 1080p WEB-DL H.265 FLAC';
    const item = { title, release: parseSeriesRelease(title) };
    const decision = evaluateMediaTypeGate(item, {
        movie: { title: 'Игра престолов', original_title: 'Game of Thrones' },
        englishTitle: 'Game of Thrones', mode: MODE_SERIES
    });
    if (!decision.passes) throw new Error(JSON.stringify(decision));
});
runner.test('media-type gate для фильма не требует season/video metadata без явного мусорного формата', () => {
    const title = 'Дюна / Dune (2024)';
    const decision = evaluateMediaTypeGate({ title, release: parseMovieRelease(title) }, {
        movie, englishTitle: 'Dune', mode: MODE_MOVIE
    });
    if (!decision.passes) throw new Error(JSON.stringify(decision));
});
runner.test('applyStateFilters: пустой фильтр оставляет пул, несуществующий не ломает', () => {
    const f = applyStateFilters(state.pool, Object.assign({}, state, { filters: Object.assign({}, state.filters, { voiceType: 'Дубляж' }) }));
    if (f.length !== 2) throw new Error('не должен сужать до пустоты: ' + f.length);
});
runner.test('applyStateFilters фильтрует по студии, включая раздачи с несколькими студиями', () => {
    const lostFilm = Object.assign({}, single, { release: Object.assign({}, single.release, { translators: ['LostFilm'] }) });
    const multi = Object.assign({}, seasonPack, { release: Object.assign({}, seasonPack.release, { translators: ['Jetvis Studio', 'LostFilm'] }) });
    const filtered = applyStateFilters([lostFilm, multi], Object.assign({}, state, { filters: Object.assign({}, state.filters, { translator: 'Jetvis Studio' }) }));
    if (filtered.length !== 1 || filtered[0] !== multi) throw new Error('фильтр студии оставил неверный пул: ' + JSON.stringify(filtered));
    const fallback = applyStateFilters([lostFilm], Object.assign({}, state, { filters: Object.assign({}, state.filters, { translator: 'Jetvis Studio' }) }));
    if (fallback.length !== 1 || fallback[0] !== lostFilm) throw new Error('пустой результат должен возвращать исходный пул');
});
runner.test('evaluateCandidatePool возвращает счётчики и заголовки отсеянных по этапам', () => {
    const wrongSeason = {
        ...single,
        title: 'Футурама / Futurama S03E07 1080p WEB-DL',
        release: parseSeriesRelease('Футурама / Futurama S03E07 1080p WEB-DL')
    };
    const evaluation = evaluateCandidatePool([single, wrongSeason], target, state);
    if (evaluation.inputCount !== 2 || evaluation.afterStateFilters !== 2) throw new Error(JSON.stringify(evaluation));
    if (evaluation.gateFilteredCount !== 1 || evaluation.filteredCount !== 1) throw new Error(JSON.stringify(evaluation));
    if (evaluation.gateFilteredTitles[0] !== wrongSeason.title || evaluation.rejectedTitles[0] !== wrongSeason.title) {
        throw new Error('неверные заголовки отсеянных: ' + JSON.stringify(evaluation));
    }

    const voiceFiltered = evaluateCandidatePool([
        Object.assign({}, single, { release: Object.assign({}, single.release, { voiceType: 'Дубляж' }) }),
        Object.assign({}, seasonPack, { release: Object.assign({}, seasonPack.release, { voiceType: 'Оригинал' }) })
    ], target, Object.assign({}, state, { filters: Object.assign({}, state.filters, { voiceType: 'Дубляж' }) }));
    if (voiceFiltered.stateFilteredCount !== 1 || voiceFiltered.afterStateFilters !== 1) throw new Error(JSON.stringify(voiceFiltered));
    if (voiceFiltered.stateFilteredTitles[0] !== seasonPack.title) throw new Error(JSON.stringify(voiceFiltered));
});

runner.test('evaluateCandidatePool не записывает score в объекты исходного пула', () => {
    const input = Object.assign({}, single);
    const evaluation = evaluateCandidatePool([input], target, state);
    if (Object.prototype.hasOwnProperty.call(input, '_score')) throw new Error('исходный item мутирован');
    if (!evaluation.items[0] || !evaluation.items[0]._score) throw new Error('scored view не содержит score');
    if (evaluation.items[0] === input) throw new Error('scored view совпал с объектом пула');
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

    globalThis.__clearReguest();
    const failed = await fetchEnglishTitle({ id: 778 }, MODE_MOVIE);
    if (!failed.ok || failed.value !== '') throw new Error('при сбое сети ожидал ok(\'\'), не error: ' + JSON.stringify(failed));
});
runner.test('buildFilterItems — содержит измерение Битрейт только с реальными бакетами пула', () => {
    const items = buildFilterItems(tvMovie, true, state);
    const bitrate = items.find((i) => i.kind === 'bitrate');
    if (!bitrate) throw new Error('нет пункта Поток (оценка)');
    const keys = bitrate.items.map((i) => i.value);
    // single (S02E07, 2.5 ГБ) → ~15 Mbps → b12; pack (S1-5E1-62, 120 ГБ) → ~11.7 → b5-12
    if (keys.indexOf('b5-12') < 0 || keys.indexOf('b12') < 0) throw new Error('ожидал бакеты b5-12 и b12: ' + JSON.stringify(keys));
});

runner.test('activeFilterLabels включает выбранный payload-бакет', () => {
    const l = activeFilterLabels({ filters: { voiceType: 'any', resolution: 'any', bitrate: 'b5-12' } });
    if (l.join(',') !== '5–12 Мбит/с') throw new Error(JSON.stringify(l));
});

runner.test('applyStateFilters фильтрует по payload-бакету', () => {
    const low = applyStateFilters(state.pool, Object.assign({}, state, { filters: Object.assign({}, state.filters, { bitrate: 'b12' }) }));
    if (low.length !== 1 || low[0] !== single) throw new Error('b12 должен оставить только single');
    const mid = applyStateFilters(state.pool, Object.assign({}, state, { filters: Object.assign({}, state.filters, { bitrate: 'b5-12' }) }));
    if (mid.length !== 1 || mid[0] !== seasonPack) throw new Error('b5-12 должен оставить только пак');
});

runner.test('candidateBadgeText показывает оценку payload-потока', () => {
    const withScore = Object.assign({}, single, { _score: { payloadMbps: 15.2, payloadConfidence: 'high' } });
    const text = candidateBadgeText(withScore);
    if (text.indexOf('~15.2 Mbps') < 0) throw new Error('нет оценки потока в бейдже: ' + text);
});

runner.test('формат: рискованная раздача (XviD AVI) получает GST-штраф и маркер', () => {
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
    if (candidateBadgeText(riskyItem).indexOf('GST-риск: XviD') < 0) throw new Error('нет маркера GST-риска: ' + candidateBadgeText(riskyItem));
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

runner.test('выбор файла: сезонный каталог и порядковый номер задают серию', () => {
    const files = [
        { id: 1, path: 'The Big Bang Theory/Season_07/01. Недостаток Хофстедтера.mkv', length: 1_000_000_000 },
        { id: 6, path: 'The Big Bang Theory/Season_07/06. Недостаточность близости.mkv', length: 1_000_000_000 },
        { id: 106, path: 'The Big Bang Theory/Season_06/06. Отрывок Купера.mkv', length: 1_000_000_000 }
    ];
    const chosen = pickBestFile(files, { mode: 'series', season: 7, episode: 6 }, parseSignals);
    if (!chosen || chosen.id !== 6) throw new Error('не распознан layout Season_07/06: ' + JSON.stringify(chosen));
});

runner.test('выбор файла: абсолютная нумерация не перебивает целевой сезон', () => {
    const files = [
        { id: 145, path: 'Show/Season_07/145. Episode.mkv', length: 1_000_000_000 },
        { id: 806, path: 'Show/Season_08/06. Episode.mkv', length: 1_000_000_000 }
    ];
    const chosen = pickBestFile(files, { mode: 'series', season: 7, episode: 6 }, parseSignals);
    if (!chosen || chosen.id !== 145) throw new Error('номер серии из чужого сезона перебил сезон: ' + JSON.stringify(chosen));
});

runner.test('createSeriesResultsViewModel/createMovieResultsViewModel forward domain.scope', () => {
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

runner.test('results projections кэшируются по ссылкам состояния', () => {
    const cache = createResultsProjectionCache(tvMovie, tvMovie, true, () => null);
    const first = cache.episodeBadges(state);
    const unrelated = Object.assign({}, state, { statusText: 'обновился статус' });
    const second = cache.episodeBadges(unrelated);
    if (first !== second) throw new Error('изменение нерелевантного поля сбросило кэш бейджей');
    const changed = Object.assign({}, state, { filters: Object.assign({}, state.filters, { resolution: '1080p' }) });
    if (cache.episodeBadges(changed) === second) throw new Error('изменение фильтра не сбросило кэш бейджей');
});

runner.test('render benchmark: 250 раздач × 24 серии считают base один раз на revision', () => {
    const episodes = Array.from({ length: 24 }, (_, index) => ({ episode_number: index + 1, runtime: 22 }));
    const release = parseSeriesRelease('Футурама / Futurama S02E01-E24 1080p WEB-DL');
    const pool = Array.from({ length: 250 }, (_, index) => ({
        title: 'Футурама / Futurama S02E01-E24 1080p WEB-DL [' + index + ']',
        tracker: 'stress-' + index,
        size: 20_000_000_000 + index,
        seeders: 20 + (index % 50),
        peers: index % 10,
        magnet: 'magnet:?xt=urn:btih:' + String(index).padStart(40, '0'),
        link: '',
        release
    }));
    const stressState = Object.assign({}, state, {
        pool,
        episodesCache: episodes,
        season: 2,
        seasonEpisodeCount: 24,
        avgRuntimeMinutes: 22,
        poolRevision: 0,
        episodesRevision: 0,
        filtersRevision: 0,
        defaultsRevision: 0
    });
    const metrics = {};
    selectEpisodeBadges({ movie: tvMovie }, stressState, null, metrics);
    if (metrics.baseScores !== 250 || metrics.episodeScores !== 6000) throw new Error(JSON.stringify(metrics));

    const cache = createResultsProjectionCache({ movie: tvMovie }, tvMovie, true, () => null);
    for (let revision = 0; revision < 9; revision++) {
        const versioned = Object.assign({}, stressState, { poolRevision: revision, statusText: 'tick-' + revision });
        cache.episodeBadges(versioned);
        cache.episodeBadges(Object.assign({}, versioned, { statusText: 'unrelated-' + revision }));
    }
    if (cache.stats().episodeBadges !== 9) throw new Error(JSON.stringify(cache.stats()));
});

runner.test('picker navigation ограничивает коллекцию Lampa и проходит границы окна', () => {
    const ids = Array.from({ length: 100 }, (_, index) => 'item-' + index);
    const windowIds = pickerNavigationWindow(ids, 'item-50', 36);
    if (windowIds.length !== 73 || windowIds[0] !== 'item-14' || windowIds.at(-1) !== 'item-86') {
        throw new Error(JSON.stringify(windowIds));
    }
    if (adjacentPickerId(ids, 'item-50', 'up') !== 'item-49') throw new Error('up перескочил строку');
    if (adjacentPickerId(ids, 'item-50', 'down') !== 'item-51') throw new Error('down перескочил строку');
    if (adjacentPickerId(ids, 'item-0', 'up') !== null) throw new Error('up вышел за начало');
    if (adjacentPickerId(ids, 'item-99', 'down') !== null) throw new Error('down вышел за конец');
    const withoutFocused = ids.filter((id) => id !== 'item-50');
    if (replacementPickerId(ids, withoutFocused, 'item-50') !== 'item-51') throw new Error('не выбран ближайший сосед удалённого фокуса');
    const reordered = ids.slice().reverse();
    if (replacementPickerId(ids, reordered, 'item-50') !== 'item-50') throw new Error('reorder потерял focused identity');
});

await runner.run();
