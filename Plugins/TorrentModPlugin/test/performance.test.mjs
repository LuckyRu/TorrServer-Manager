// Регрессионный тест производительности. Считает ОПЕРАЦИИ, а не миллисекунды: wall-clock в Node
// зависит от машины и от фоновой нагрузки, а количество разборов заголовка, доставленных элементов
// и пересчётов проекции — нет. Почему выбраны именно эти счётчики и что каждый из них охраняет:
// docs/system-design/torrent-mod-render-performance.md, раздел «Вторая волна: intake, а не рендер».
//
// Пересчитать бюджеты после осознанной оптимизации: `npm run test:perf:baseline` печатает
// наблюдаемые значения — перенести их в BUDGETS, добавив запас.

import './helpers/mock-lampa.mjs';
import { createRunner } from './helpers/test-runner.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { searchTorrentModProgressive } from '../search/transport/search-backend.js';
import { parseSeriesRelease } from '../search/parse/series-release-parsing.js';
import { buildSeriesQueries } from '../search/plan/series-query-building.js';
import { createLifecycle } from '../shared/core/lifecycle.js';
import { createStore } from '../domain/store.js';
import { createResultsProjectionCache } from '../domain/results-projections.js';
import { createRenderScheduler } from '../ui/render-scheduler.js';
import { reconcileKeyedChildren } from '../ui/keyed-dom.js';
import { MODE_SERIES } from '../shared/state.js';
import { mergeReleases } from '../shared/release-identity.js';

const runner = createRunner();
const BASELINE = process.env.PERF_BASELINE === '1' || process.argv.includes('--baseline');
const observed = {};

// Потолки, а не равенства: тест ловит деградацию и не запрещает улучшения. Каждое число —
// зафиксированный факт текущей реализации плюс ~10 % запаса. Счётчики детерминированы, поэтому
// запас нужен только против мелких изменений сценария, а не против дрожания измерения.
const BUDGETS = {
    // --- intake: один поиск сезона, 9 трекеров, 2 запроса плана ---
    // Разбор заголовка стоит ~60 % всего intake и происходит ДО дедупликации: один и тот же
    // заголовок, пришедший на два запроса, разбирается дважды.
    parseCalls: 2400,
    // Самая длинная непрерывная порция разбора. Это и есть длина фриза интерфейса: отзывчивость
    // определяется не суммой работы, а размером её наибольшего неразрываемого куска.
    maxParseBurst: 135,
    // Пересчёты производных названий цели (baseTitles/titleNames/titleAnalysis). Растут, если
    // уже посчитанный анализ заголовка не переиспользуется или инвариант цели не вынесен из цикла.
    targetTitleReads: 3250,
    // console в горячем пути: на WebOS вызов с объектом ещё и удерживает граф от сборки мусора.
    consoleCalls: 25,
    // Каждый доставленный элемент домен прогоняет через mergeReleases по всему пулу.
    deliveredItemsVolume: 1450,

    // --- домен: 9 ревизий пула, 17 серий ---
    // Не более одного пересчёта проекции на ревизию.
    projectionRunsPerBurst: 9,
    // Нормированные величины: константа алгоритма, не зависящая от того, сколько раздач
    // пропустили гейты. Растёт при дублирующих вызовах в цикле «серия × раздача».
    selectionReadsPerItemEpisode: 7,
    movieSeasonsReadsPerItem: 1.5,

    // Проекция пикера пересчитывается на каждую ревизию пула. Сборка списков ради console
    // стоила бы дороже самой проекции, поэтому объектов в консоль здесь быть не должно.
    consoleObjectsPerPickerProjection: 0,

    // --- UI: планировщик кадра и keyed-реконсиляция ---
    flushesPerBurst: 1,
    mutationsOnUnchangedProjection: 0
};

if (BASELINE) {
    process.on('exit', () => {
        console.log('\nНаблюдаемые значения (перенести в BUDGETS, добавив запас):');
        Object.keys(observed).forEach((key) => console.log('    ' + key + ': ' + observed[key] + ','));
    });
}

// ---------- сценарий ----------
// «Теория большого взрыва» — 12 сезонов, 24 серии в сезоне, 9 трекеров, 2 запроса плана.
// Сознательно тяжелее живого baseline'а из документа (211 раздач): проверяется поведение на
// большой выдаче, а не типовой случай. Заголовки-шум взяты из реальной выдачи Jackett.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'live-multitracker.json'), 'utf8'));

const SEASON = 1;
const EPISODE_COUNT = 24;
const RAW_PER_QUERY = 120;
const SHARED_PER_QUERY = 80; // сколько записей повторяется между запросами одного трекера

const seasons = [];
for (let s = 1; s <= 12; s++) seasons.push({ season_number: s, episode_count: 24, air_date: `${2006 + s}-09-01` });

const movie = {
    id: 1418,
    name: 'Теория большого взрыва',
    title: 'Теория большого взрыва',
    original_name: 'The Big Bang Theory',
    original_title: 'The Big Bang Theory',
    first_air_date: '2007-09-24',
    number_of_seasons: 12,
    seasons,
    episode_run_time: [22]
};

const episodes = [];
for (let e = 1; e <= EPISODE_COUNT; e++) {
    episodes.push({ episode_number: e, name: 'Серия ' + e, runtime: 22, air_date: '2007-09-24' });
}

const TRACKERS = Object.keys(fixture.trackers);
const noise = [];
Object.values(fixture.trackers).forEach((list) => list.forEach((title) => noise.push(title)));

const baseTarget = {
    movie, mode: MODE_SERIES, season: SEASON, episode: 0,
    englishTitle: 'The Big Bang Theory',
    aliases: ['TBBT', 'Big Bang Theory'],
    negativeAliases: [], ongoing: false
};

// Выдача трекера на конкретный запрос. Часть записей общая для всех запросов этого трекера —
// так же, как «X S01» и «X 1 сезон» на живом трекере возвращают в основном одно и то же. Пул
// схлопнет дубли по releaseIdentity, но разбор заголовка происходит до этого.
function trackerResults(trackerId, trackerIndex, queryIndex) {
    const out = [];
    for (let i = 0; i < RAW_PER_QUERY; i++) {
        const shared = i < SHARED_PER_QUERY;
        const salt = shared ? 'общая' : `q${queryIndex}`;
        const seed = shared ? i : i + queryIndex * 1000;
        if (i % 2 === 0) {
            const padded = String((i % 24) + 1).padStart(2, '0');
            out.push({
                Title: `Теория большого взрыва / The Big Bang Theory / S0${SEASON}E${padded} [2007, WEB-DL 1080p] ${trackerId} ${salt}`,
                Tracker: trackerId,
                Size: 2_000_000_000 + seed * 1000 + trackerIndex,
                Seeders: 3 + ((seed * 7) % 60),
                Peers: seed % 12,
                MagnetUri: `magnet:?xt=urn:btih:${trackerId}-${seed}`,
                PublishDate: '2024-03-01T00:00:00Z'
            });
        } else {
            out.push({
                Title: noise[(seed + trackerIndex * 13) % noise.length],
                Tracker: trackerId,
                Size: 900_000_000 + seed * 100 + trackerIndex,
                Seeders: seed % 20,
                Peers: 1,
                MagnetUri: `magnet:?xt=urn:btih:noise-${trackerId}-${seed}`,
                PublishDate: '2023-05-01T00:00:00Z'
            });
        }
    }
    return out;
}

// ---------- швы для подсчёта ----------
// Ни один счётчик не требует правок в рабочем коде: все они висят на уже существующих границах —
// внедряемом парсере, scope, объекте цели и полях, которые горячий путь и так читает.

// Производные названия цели читают target.aliases. Счётчик на геттере показывает, сколько раз эти
// данные пересчитаны заново вместо переиспользования.
function countingTarget(base, counters) {
    const aliases = base.aliases;
    const target = Object.assign({}, base);
    Object.defineProperty(target, 'aliases', {
        enumerable: true, configurable: true,
        get() { counters.targetTitleReads++; return aliases; }
    });
    return target;
}

// selectionMetadata() читает item.selection на каждой проверке покрытия — прокси объёма горячего
// цикла «серия × раздача»: удвоенный вызов гейта удваивает и это число.
function countingPool(pool, counters) {
    return pool.map((item) => {
        const selection = item.selection;
        const copy = Object.assign({}, item);
        Object.defineProperty(copy, 'selection', {
            enumerable: true, configurable: true,
            get() { counters.selectionReads++; return selection; }
        });
        return copy;
    });
}

// episodeCountsFor() читает movie.seasons на каждой оценке payload: счётчик ловит пересборку
// инварианта цели внутри поэлементного цикла.
function countingMovie(source, counters) {
    const list = source.seasons;
    const copy = Object.assign({}, source);
    Object.defineProperty(copy, 'seasons', {
        enumerable: true, configurable: true,
        get() { counters.movieSeasonsReads++; return list; }
    });
    return copy;
}

// Размер браузерной задачи: счётчик сбрасывается на входе в каждый колбэк scope.setTimeout и
// растёт до следующего, то есть покрывает колбэк вместе с его микрозадачами — ровно то, что в
// браузере выполняется одним неразрываемым блоком и откладывает кадр.
//
// Считать через setImmediate нельзя: Node выполняет все истёкшие таймеры одной фазой и склеил бы
// в один «оборот» независимые задачи разных трекеров, которых браузер не склеивает.
//
// Метрика опирается на то, что рабочий код уходит в event loop именно через scope.setTimeout.
// Выход мимо scope не сбросит счётчик, и тест упадёт — это правильно: такой выход заодно ломает
// отмену работы при закрытии экрана.
function turnAwareCounter(counters) {
    let inTurn = 0;
    return {
        beginTurn() { inTurn = 0; },
        countParse() {
            inTurn++;
            counters.parseCalls++;
            counters.maxParseBurst = Math.max(counters.maxParseBurst, inTurn);
        }
    };
}

function instrumentedScope(turn) {
    const scope = createLifecycle();
    const real = scope.setTimeout;
    scope.setTimeout = (fn, ms) => real(() => { turn.beginTurn(); fn(); }, ms);
    return scope;
}

function spyConsole(counters) {
    const original = { log: console.log, warn: console.warn, info: console.info };
    const wrap = () => () => { counters.consoleCalls++; };
    console.log = wrap();
    console.warn = wrap();
    console.info = wrap();
    return () => Object.assign(console, original);
}

// ---------- прогон поиска ----------

function runSearch() {
    const counters = {
        parseCalls: 0, maxParseBurst: 0, targetTitleReads: 0, consoleCalls: 0,
        deliveredItemsVolume: 0, indexerCallbacks: 0
    };

    const queries = buildSeriesQueries(baseTarget);
    globalThis.__clearReguest();
    queries.forEach((query, queryIndex) => {
        const encoded = 'query=' + encodeURIComponent(query);
        globalThis.__mockReguest(
            (url) => url.includes(encoded + '&') || url.endsWith(encoded),
            {
                indexers: TRACKERS.map((id, index) => ({
                    id, name: id, ok: true, error: null, elapsedMs: 10 + index,
                    results: trackerResults(id, index, queryIndex)
                })),
                results: []
            },
            0
        );
    });

    const target = countingTarget(baseTarget, counters);
    const turn = turnAwareCounter(counters);
    const scope = instrumentedScope(turn);
    const countingParse = (title, profile) => { turn.countParse(); return parseSeriesRelease(title, profile); };
    let pool = [];

    const restoreConsole = spyConsole(counters);
    return new Promise((resolve) => {
        searchTorrentModProgressive(
            target, countingParse, buildSeriesQueries,
            (entry) => {
                counters.indexerCallbacks++;
                counters.deliveredItemsVolume += entry.items.length;
                // Пул собирается ровно так же, как его собирает домен, — слиянием каждой доставки.
                pool = mergeReleases(pool, entry.items);
            },
            () => {
                restoreConsole();
                scope.dispose();
                resolve({ counters, pool, queries });
            },
            scope,
            () => {}
        );
    });
}

// ---------- фейковый DOM и кадр ----------
// jsdom в проекте нет и не нужен: reconcileKeyedChildren работает с тремя методами контейнера,
// а планировщику достаточно управляемого requestAnimationFrame.

function fakeNode(key) { return { key }; }

function fakeContainer() {
    const children = [];
    return {
        children,
        insertBefore(node, before) {
            const existing = children.indexOf(node);
            if (existing >= 0) children.splice(existing, 1);
            const at = before ? children.indexOf(before) : children.length;
            children.splice(at < 0 ? children.length : at, 0, node);
        },
        removeChild(node) {
            const at = children.indexOf(node);
            if (at >= 0) children.splice(at, 1);
        }
    };
}

function fakeFrames() {
    const queue = [];
    const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
    const previous = globalThis.window;
    globalThis.window = {
        requestAnimationFrame: (fn) => queue.push(fn),
        cancelAnimationFrame: () => {}
    };
    return {
        run() { queue.splice(0).forEach((fn) => fn()); },
        restore() { if (had) globalThis.window = previous; else delete globalThis.window; }
    };
}

// ---------- тесты ----------

const search = await runSearch();
observed.poolSize = search.pool.length;
observed.queries = search.queries.length;

runner.test('сценарий воспроизводится: пул непустой, все трекеры доложились', () => {
    // Нижняя граница обязательна: если гейты вдруг начнут отсеивать почти всё, счётчики упадут
    // сами собой и тест «позеленеет», ничего не проверив.
    assert.ok(search.pool.length > 400, 'пул выродился, сценарий сломан: ' + search.pool.length);
    assert.ok(search.counters.indexerCallbacks >= TRACKERS.length, 'не все трекеры доложились');
    assert.ok(search.queries.length >= 2, 'план поиска выродился в один запрос');
});

runner.test('intake: объём разбора заголовков не растёт', () => {
    observed.parseCalls = search.counters.parseCalls;
    assert.ok(search.counters.parseCalls <= BUDGETS.parseCalls,
        `разборов заголовка ${search.counters.parseCalls}, бюджет ${BUDGETS.parseCalls}`);
});

runner.test('intake: синхронная порция разбора ограничена', () => {
    observed.maxParseBurst = search.counters.maxParseBurst;
    assert.ok(search.counters.maxParseBurst <= BUDGETS.maxParseBurst,
        `в одной задаче разобрано ${search.counters.maxParseBurst} заголовков, бюджет ${BUDGETS.maxParseBurst}; ` +
        'это длина фриза интерфейса, а не сумма работы');
});

runner.test('intake: производные названия цели не пересчитываются на каждую раздачу', () => {
    observed.targetTitleReads = search.counters.targetTitleReads;
    assert.ok(search.counters.targetTitleReads <= BUDGETS.targetTitleReads,
        `пересчётов названий цели ${search.counters.targetTitleReads}, бюджет ${BUDGETS.targetTitleReads}`);
});

runner.test('intake: консоль не участвует в горячем пути', () => {
    observed.consoleCalls = search.counters.consoleCalls;
    assert.ok(search.counters.consoleCalls <= BUDGETS.consoleCalls,
        `вызовов console за поиск ${search.counters.consoleCalls}, бюджет ${BUDGETS.consoleCalls}`);
});

runner.test('intake: трекер не переотправляет накопленное целиком', () => {
    observed.deliveredItemsVolume = search.counters.deliveredItemsVolume;
    assert.ok(search.counters.deliveredItemsVolume <= BUDGETS.deliveredItemsVolume,
        `доставлено элементов ${search.counters.deliveredItemsVolume}, бюджет ${BUDGETS.deliveredItemsVolume}`);
});

runner.test('проекции: один poolRevision — не более одного пересчёта каждой проекции', () => {
    const counters = { selectionReads: 0, movieSeasonsReads: 0 };
    const instrumentedMovie = countingMovie(movie, counters);
    const object = { movie: instrumentedMovie, season: SEASON };
    const pool = countingPool(search.pool, counters);

    const store = createStore(baseState(instrumentedMovie), {
        revisions: { pool: 'poolRevision', episodesCache: 'episodesRevision', filters: 'filtersRevision' }
    });
    const projections = createResultsProjectionCache(object, instrumentedMovie, true, () => null);

    const step = Math.ceil(pool.length / 9);
    for (let revision = 1; revision <= 9; revision++) {
        store.patch({ pool: pool.slice(0, Math.min(pool.length, step * revision)) });
        projections.episodeBadges(store.get());
        projections.filterChipData(store.get());
        projections.poolIndexers(store.get());
        // Повторный вызов на том же состоянии обязан попасть в кэш.
        projections.episodeBadges(store.get());
        projections.filterChipData(store.get());
    }

    const stats = projections.stats();
    observed.projectionRunsPerBurst = Math.max(stats.episodeBadges || 0, stats.filterChipData || 0);
    assert.ok(stats.episodeBadges <= BUDGETS.projectionRunsPerBurst,
        `episodeBadges пересчитан ${stats.episodeBadges} раз на 9 ревизий`);
    assert.ok(stats.filterChipData <= BUDGETS.projectionRunsPerBurst,
        `filterChipData пересчитан ${stats.filterChipData} раз на 9 ревизий`);
    assert.equal(stats.pickerData, undefined, 'проекция пикера построена при закрытом пикере');
});

runner.test('проекция бейджей: константа цикла «серия × раздача» не растёт', () => {
    const counters = { selectionReads: 0, movieSeasonsReads: 0 };
    const instrumentedMovie = countingMovie(movie, counters);
    const pool = countingPool(search.pool, counters);
    const projections = createResultsProjectionCache(
        { movie: instrumentedMovie, season: SEASON }, instrumentedMovie, true, () => null
    );

    projections.episodeBadges(Object.assign(baseState(instrumentedMovie), {
        pool, poolStatus: 'ready', poolRevision: 1
    }));

    const perItemEpisode = counters.selectionReads / (pool.length * EPISODE_COUNT);
    const perItem = counters.movieSeasonsReads / pool.length;
    observed.selectionReadsPerItemEpisode = Math.ceil(perItemEpisode * 100) / 100;
    observed.movieSeasonsReadsPerItem = Math.ceil(perItem * 100) / 100;

    assert.ok(perItemEpisode <= BUDGETS.selectionReadsPerItemEpisode,
        `чтений selection на пару «серия × раздача» ${perItemEpisode.toFixed(2)}, ` +
        `бюджет ${BUDGETS.selectionReadsPerItemEpisode}`);
    assert.ok(perItem <= BUDGETS.movieSeasonsReadsPerItem,
        `пересборок карты сезонов на раздачу ${perItem.toFixed(2)}, бюджет ${BUDGETS.movieSeasonsReadsPerItem}`);
});

runner.test('проекция пикера: в консоль не уходят построенные списки', () => {
    const counters = { selectionReads: 0, movieSeasonsReads: 0 };
    const instrumentedMovie = countingMovie(movie, counters);
    const pool = countingPool(search.pool, counters);
    const projections = createResultsProjectionCache(
        { movie: instrumentedMovie, season: SEASON }, instrumentedMovie, true, () => null
    );
    const state = Object.assign(baseState(instrumentedMovie), {
        pool, poolStatus: 'ready', poolRevision: 1, picker: { open: true, episode: 3 }
    });

    // Считаем не вызовы, а переданные объекты: хлебная крошка строкой стоит копейки, а сборка
    // списка кандидатов ради console повторяет работу проекции.
    let objectArguments = 0;
    const original = { log: console.log, warn: console.warn };
    console.log = (...args) => { objectArguments += args.filter((a) => a && typeof a === 'object').length; };
    console.warn = console.log;
    try {
        projections.pickerData(state);
    } finally {
        Object.assign(console, original);
    }

    observed.consoleObjectsPerPickerProjection = objectArguments;
    assert.ok(objectArguments <= BUDGETS.consoleObjectsPerPickerProjection,
        `в консоль ушло ${objectArguments} объектов, бюджет ${BUDGETS.consoleObjectsPerPickerProjection}`);
});

runner.test('планировщик: девять патчей за кадр дают один визуальный коммит', () => {
    const frames = fakeFrames();
    try {
        const scope = createLifecycle();
        let flushes = 0;
        const scheduler = createRenderScheduler(scope, () => { flushes++; });
        for (let i = 0; i < 9; i++) {
            scheduler.invalidate('badges');
            scheduler.invalidate('trackers');
        }
        frames.run();
        observed.flushesPerBurst = flushes;
        assert.ok(flushes <= BUDGETS.flushesPerBurst, `коммитов ${flushes}, бюджет ${BUDGETS.flushesPerBurst}`);
        scope.dispose();
    } finally {
        frames.restore();
    }
});

runner.test('keyed-реконсиляция: неизменившийся список не трогает DOM', () => {
    const container = fakeContainer();
    const nodes = Array.from({ length: 200 }, (_, index) => fakeNode('n' + index));
    reconcileKeyedChildren(container, nodes);

    const again = reconcileKeyedChildren(container, nodes);
    observed.mutationsOnUnchangedProjection = again;
    assert.ok(again <= BUDGETS.mutationsOnUnchangedProjection,
        `мутаций на неизменившейся проекции ${again}, бюджет ${BUDGETS.mutationsOnUnchangedProjection}`);

    // Добавление одной раздачи в конец не пересоздаёт остальные строки.
    const grown = nodes.concat([fakeNode('n200')]);
    assert.ok(reconcileKeyedChildren(container, grown) <= 1, 'добавление одной строки перестроило список');

    // Удаление из середины трогает только хвост, а не весь список.
    const shrunk = grown.slice(0, 100).concat(grown.slice(101));
    assert.ok(reconcileKeyedChildren(container, shrunk) <= grown.length - 100,
        'удаление из середины перестроило голову списка');
});

function baseState(currentMovie) {
    return {
        season: SEASON, pool: [], episodesCache: episodes, poolStatus: 'loading',
        seasonLoads: {}, seasonEpisodeCount: 24, avgRuntimeMinutes: 22,
        filters: { voiceType: 'any', translator: 'any', releaseGroup: 'any', resolution: 'any', bitrate: 'any' },
        picker: { open: false, episode: 0 }, poolIndexers: [], poolAllIndexers: [],
        englishTitle: 'The Big Bang Theory', titleAliases: [], negativeAliases: [], ongoing: false,
        movie: currentMovie, funnel: null, defaultsRevision: 0, statusText: ''
    };
}

await runner.run();
