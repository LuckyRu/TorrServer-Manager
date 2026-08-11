import './helpers/mock-lampa.mjs';
import { createRunner } from './helpers/test-runner.mjs';
import { flushMicrotasks } from './helpers/mock-lampa.mjs';
import { createResultsDomain } from '../domain/results-domain.js';
import { selectPickerData, selectPoolIndexers } from '../domain/results-selectors.js';
import { parseSeriesRelease } from '../search/series-release-parsing.js';
import { parseMovieRelease } from '../search/movie-release-parsing.js';
import { candidateIdentity } from '../domain/results-core.js';

const runner = createRunner();

const tvMovie = {
    id: 615, name: 'Футурама', original_name: 'Futurama', title: 'Футурама', original_title: 'Futurama',
    first_air_date: '1999-03-28', number_of_seasons: 10,
    seasons: [{ season_number: 1, episode_count: 13 }, { season_number: 2, episode_count: 19 }, { season_number: 3, episode_count: 22 }]
};
const movie = { id: 1, title: 'Дюна: Часть вторая', original_title: 'Dune: Part Two', release_date: '2024-02-01' };

function jackettRaw(title, seeders, peers, hash) {
    return {
        Title: title, Tracker: 'RuTracker', Size: 2500000000, Seeders: seeders, Peers: peers,
        MagnetUri: 'magnet:?xt=urn:btih:' + hash,
        PublishDate: '2026-08-01T00:00:00Z'
    };
}

function mappedCandidate(title, hash, mode) {
    return {
        title: title,
        tracker: 'fast',
        size: 2500000000,
        seeders: 12,
        peers: 6,
        publishedAt: Date.now(),
        magnet: 'magnet:?xt=urn:btih:' + hash,
        link: '',
        release: mode === 'movie' ? parseMovieRelease(title) : parseSeriesRelease(title)
    };
}

function pickerData(domain, object) {
    const state = domain.store.get();
    return selectPickerData(object, state, domain.selection.getSeasonDefault(state.season));
}

runner.test('сериал: start → пул → смена сезона → фильтр → клик серии → кандидаты', async () => {
    globalThis.__clearReguest();
    globalThis.__clearStorage();
    globalThis.__requestLog = [];
    globalThis.__mockReguest((url) => url.includes('/season/'), {
        episodes: [
            { episode_number: 1, name: 'Эпизод 1', runtime: 22 },
            { episode_number: 7, name: 'Эпизод 7', runtime: 22 }
        ]
    });
    globalThis.__mockReguest((url) => url.includes('/api/torrent-search'), {
        results: [
            jackettRaw('Футурама / Futurama S02E07 1080p WEB-DL', 12, 6, 'aaaa'),
            jackettRaw('Футурама / Futurama (2008-2013) BDRip (S1-5E1-62 of 62)', 30, 10, 'bbbb')
        ],
        indexers: []
    });

    const domain = createResultsDomain({ object: { movie: tvMovie, season: 2 }, movie: tvMovie, hasSeasons: true });
    domain.start();
    await flushMicrotasks();

    const state = domain.store.get();
    if (state.poolStatus !== 'ready') throw new Error('пул не загрузился: ' + state.poolStatus);
    if (!state.pool || state.pool.length !== 2) throw new Error('ожидал 2 раздачи в пуле, получил ' + (state.pool || []).length);
    if (!state.episodesCache || state.episodesCache.length !== 2) throw new Error('серии не загрузились');
    if (!state.poolAllIndexers || state.poolAllIndexers.length !== 1 || state.poolAllIndexers[0].id !== 'mock') {
        throw new Error('poolAllIndexers не заполнился из /start: ' + JSON.stringify(state.poolAllIndexers));
    }

    const poolBefore = state.pool;
    const searchCallsBefore = globalThis.__requestLog.filter((u) => u.includes('torrent-search')).length;
    domain.episodes.setSeason(3);
    const switchingSeason = domain.store.get();
    if (switchingSeason.seasonEpisodeCount !== 0 || switchingSeason.avgRuntimeMinutes !== 0 || !Array.isArray(switchingSeason.episodesCache) || switchingSeason.episodesCache.length !== 0) {
        throw new Error('при смене сезона остались метаданные предыдущего сезона: ' + JSON.stringify({
            count: switchingSeason.seasonEpisodeCount,
            runtime: switchingSeason.avgRuntimeMinutes,
            episodes: switchingSeason.episodesCache
        }));
    }
    await flushMicrotasks();
    const afterSeason = domain.store.get();
    if (afterSeason.season !== 3) throw new Error('сезон не сменился');
    if (afterSeason.pool !== poolBefore) throw new Error('пул перезагрузился при смене сезона — должен остаться');
    const searchCallsAfter = globalThis.__requestLog.filter((u) => u.includes('torrent-search')).length;
    if (searchCallsAfter !== searchCallsBefore) throw new Error('смена сезона сделала лишний torrent-search запрос');

    // фильтр
    domain.filters.setVoiceFilter('Дубляж');
    if (domain.store.get().filters.voiceType !== 'Дубляж') throw new Error('фильтр не применился');
    domain.filters.setTranslatorFilter('LostFilm');
    if (domain.store.get().filters.translator !== 'LostFilm') throw new Error('фильтр студии не применился');
    const savedTranslator = Lampa.Storage.get('torrent_mod_last_translator');
    if (!savedTranslator || savedTranslator[tvMovie.id] !== 'LostFilm') throw new Error('фильтр студии не сохранился: ' + JSON.stringify(savedTranslator));

    // клик по серии — СРАЗУ воспроизведение (без полноэкранного списка кандидатов)
    domain.episodes.setSeason(2);
    await flushMicrotasks();
    domain.selection.selectEpisode(7);
    await flushMicrotasks();
    const picked = domain.store.get();
    if (picked.stage === 'candidates') throw new Error('клик не должен показывать список кандидатов, stage=' + picked.stage);
    if (picked.lastEpisode !== 7) throw new Error('lastEpisode не обновился');
    // последняя серия запомнена для возврата фокуса при повторном входе
    const savedEp = Lampa.Storage.get('torrent_mod_last_episode');
    if (!savedEp || !savedEp[tvMovie.id] || savedEp[tvMovie.id].episode !== 7) throw new Error('последняя серия не сохранена: ' + JSON.stringify(savedEp));
    if (domain.selection.getSavedEpisode(tvMovie).episode !== 7) throw new Error('getSavedEpisode вернул не то');

});

runner.test('сериал: кандидат из частичного пула запускается, пока остальные трекеры ещё loading', async () => {
    globalThis.__clearReguest();
    globalThis.__clearStorage();
    globalThis.__resetPlaybackMock();
    globalThis.__mockReguest((url) => url.includes('/season/'), {
        episodes: [{ episode_number: 7, name: 'Эпизод 7', runtime: 22 }]
    });
    globalThis.__mockReguest((url) => url.includes('/api/torrent-search'), { results: [], indexers: [] }, 200);

    const domain = createResultsDomain({ object: { movie: tvMovie, season: 2 }, movie: tvMovie, hasSeasons: true });
    domain.start();
    await flushMicrotasks();
    domain.store.patch({
        pool: [mappedCandidate('Футурама / Futurama S02E07 1080p WEB-DL', 'partial-series', 'series')]
    });
    if (domain.store.get().poolStatus !== 'loading') throw new Error('тест должен оставлять медленные трекеры loading');

    domain.selection.selectEpisode(7);
    if (!globalThis.__isPreparationShellMounted()) throw new Error('частичный готовый пул не запустил серию сразу');

    globalThis.__invokeControllerBack();
    domain.destroy();
});

runner.test('сериал: клик до первого результата просыпается на росте пула, не на завершении поиска', async () => {
    globalThis.__clearReguest();
    globalThis.__clearStorage();
    globalThis.__resetPlaybackMock();
    globalThis.__mockReguest((url) => url.includes('/season/'), {
        episodes: [{ episode_number: 7, name: 'Эпизод 7', runtime: 22 }]
    });
    globalThis.__mockReguest((url) => url.includes('/api/torrent-search'), { results: [], indexers: [] }, 200);

    const domain = createResultsDomain({ object: { movie: tvMovie, season: 2 }, movie: tvMovie, hasSeasons: true });
    domain.start();
    await flushMicrotasks();
    domain.selection.selectEpisode(7);
    if (globalThis.__isPreparationShellMounted()) throw new Error('серия запустилась без кандидата');

    domain.store.patch({
        pool: [mappedCandidate('Футурама / Futurama S02E07 1080p WEB-DL', 'first-series', 'series')]
    });
    if (domain.store.get().poolStatus !== 'loading') throw new Error('поиск неожиданно завершился до проверки');
    if (!globalThis.__isPreparationShellMounted()) throw new Error('pending-клик не проснулся на первом кандидате');

    globalThis.__invokeControllerBack();
    domain.destroy();
});

runner.test('фильм: вход → список торрентов (без автоплея), выбор сохраняется как дефолт', async () => {
    globalThis.__clearReguest();
    globalThis.__clearStorage();
    globalThis.__requestLog = [];
    globalThis.__mockReguest((url) => url.includes('/api/torrent-search'), {
        results: [
            jackettRaw('Дюна: Часть вторая / Dune: Part Two (2024) 1080p WEB-DL', 12, 6, 'cccc'),
            jackettRaw('Дюна: Часть вторая / Dune: Part Two (2024) 2160p Remux', 0, 0, 'dddd')
        ],
        indexers: []
    });

    const domain = createResultsDomain({ object: { movie: movie, season: 0 }, movie: movie, hasSeasons: false });
    domain.start();
    await flushMicrotasks();

    let state = domain.store.get();
    if (state.poolStatus !== 'ready') throw new Error('пул фильма не загрузился');
    const movieQuery = globalThis.__requestLog.find((u) => u.includes('/api/torrent-search')) || '';
    if (/S\d+E\d+/i.test(decodeURIComponent(movieQuery))) throw new Error('поиск фильма получил series query: ' + movieQuery);
    // вход НЕ автоплеит без сохранённого выбора — показывает список торрентов (primary content)
    if (state.stage !== 'candidates') throw new Error('фильм должен показать список торрентов, stage=' + state.stage);
    if (!state.candidates || state.candidates.items.length !== 2) throw new Error('ожидал 2 кандидата для фильма');

    // выбор из списка → персистится как дефолт сезона 0
    const chosen = state.candidates.items[0];
    domain.selection.playCandidate(chosen, state.candidates.target);
    const saved = Lampa.Storage.get('torrent_mod_default_torrent');
    if (!saved || !saved[movie.id] || !saved[movie.id][0]) throw new Error('дефолт фильма не сохранён: ' + JSON.stringify(saved));
    if (saved[movie.id][0].title !== chosen.title) throw new Error('сохранён не тот торрент');

});

runner.test('anime-профиль запускает alias-запросы, а обычный сериал остаётся одноимённым', async () => {
    globalThis.__clearReguest();
    globalThis.__clearStorage();
    globalThis.__requestLog = [];
    const animeMovie = {
        id: 999, name: 'Клинок, рассекающий демонов', original_name: '鬼滅の刃',
        title: 'Клинок, рассекающий демонов', original_title: '鬼滅の刃',
        original_language: 'ja', genre_ids: [16], origin_country: ['JP'],
        seasons: [{ season_number: 1, episode_count: 12 }]
    };
    globalThis.__mockReguest((url) => url.includes('/season/'), {
        episodes: [{ episode_number: 1, name: 'Эпизод 1', runtime: 24 }]
    });
    globalThis.__mockReguest((url) => url.includes('/tv/') && !url.includes('/season/'), {
        name: 'Demon Slayer'
    });
    globalThis.__mockReguest((url) => url.includes('/api/torrent-search'), {
        results: [{
            Title: '鬼滅の刃 / E01-E12 Demon Slayer S01 1080p WEB-DL',
            Tracker: 'AniDUB', Size: 2500000000, Seeders: 12, Peers: 3,
            MagnetUri: 'magnet:?xt=urn:btih:anime-alias'
        }],
        indexers: []
    });

    const domain = createResultsDomain({ object: { movie: animeMovie, season: 1 }, movie: animeMovie, hasSeasons: true });
    domain.start();
    await flushMicrotasks();
    const starts = globalThis.__requestLog
        .filter((url) => url.includes('/api/torrent-search/start'))
        .map((url) => decodeURIComponent(url.split('query=')[1] || ''));
    if (starts.length !== 4) throw new Error('anime profile должен запустить три targeted alias-запроса и один общий: ' + JSON.stringify(starts));
    if (!starts.some((query) => query.indexOf('鬼滅の刃') >= 0) || !starts.some((query) => query.indexOf('Demon Slayer') >= 0)) {
        throw new Error('anime alias-запросы не попали в Jackett: ' + JSON.stringify(starts));
    }
    const startUrls = globalThis.__requestLog.filter((url) => url.includes('/api/torrent-search/start'));
    if (!startUrls.some((url) => url.includes('indexers=anidub%2Canilibria'))) {
        throw new Error('anime alias-запросы не маршрутизированы в AniDUB/Anilibria: ' + JSON.stringify(startUrls));
    }
    if (!startUrls.some((url) => url.includes('exclude=anidub%2Canilibria'))) {
        throw new Error('общий anime-запрос не исключает специализированные индексаторы: ' + JSON.stringify(startUrls));
    }
    if (domain.store.get().pool.length !== 1) throw new Error('anime alias-кандидат не попал в общий пул');
    domain.destroy();
});

runner.test('фильм: список появляется и растёт до завершения всех трекеров', async () => {
    globalThis.__clearReguest();
    globalThis.__clearStorage();
    globalThis.__resetPlaybackMock();
    globalThis.__mockReguest((url) => url.includes('/api/torrent-search'), { results: [], indexers: [] }, 200);

    const domain = createResultsDomain({ object: { movie: movie, season: 0 }, movie: movie, hasSeasons: false });
    domain.start();
    if (domain.store.get().stage !== 'message') throw new Error('до первого кандидата нужен loading message');

    const first = mappedCandidate('Дюна: Часть вторая / Dune: Part Two (2024) 1080p WEB-DL', 'partial-movie-1', 'movie');
    const second = mappedCandidate('Дюна: Часть вторая / Dune: Part Two (2024) 2160p Remux', 'partial-movie-2', 'movie');
    domain.store.patch({ pool: [first] });
    let state = domain.store.get();
    if (state.poolStatus !== 'loading') throw new Error('тест должен оставлять медленные трекеры loading');
    if (state.stage !== 'candidates' || !state.candidates || state.candidates.items.length !== 1) {
        throw new Error('первый фильм не появился из частичного пула: ' + JSON.stringify(state.candidates));
    }

    domain.store.patch({ pool: [first, second] });
    state = domain.store.get();
    if (state.stage !== 'candidates' || state.candidates.items.length !== 2) {
        throw new Error('список фильма не вырос со вторым tracker result');
    }
    domain.filters.setResolutionFilter('2160p');
    state = domain.store.get();
    if (state.candidates.items.length !== 1 || !/2160p/i.test(state.candidates.items[0].title)) {
        throw new Error('progressive movie projection не обновилась после фильтра');
    }
    domain.destroy();
});

runner.test('фильм: вход с сохранённым дефолтом — автозапуск выбранного торрента', async () => {
    globalThis.__clearReguest();
    globalThis.__clearStorage();
    globalThis.__requestLog = [];
    globalThis.__mockReguest((url) => url.includes('/api/torrent-search'), {
        results: [
            jackettRaw('Дюна: Часть вторая / Dune: Part Two (2024) 1080p WEB-DL', 12, 6, 'eeee'),
            jackettRaw('Дюна: Часть вторая / Dune: Part Two (2024) 2160p Remux', 0, 0, 'ffff')
        ],
        indexers: []
    });
    // заранее сохраняем дефолт фильма (сезон 0)
    Lampa.Storage.set('torrent_mod_default_torrent', { [movie.id]: { 0: {
        id: candidateIdentity({ title: 'Дюна: Часть вторая / Dune: Part Two (2024) 1080p WEB-DL', tracker: 'RuTracker', size: 2500000000 }),
        title: 'x', size: 1
    } } });

    const domain = createResultsDomain({ object: { movie: movie, season: 0 }, movie: movie, hasSeasons: false });
    domain.start();
    await flushMicrotasks();

    const state = domain.store.get();
    if (state.stage === 'candidates') throw new Error('с сохранённым дефолтом фильм должен автозапуститься, а не показывать список');
});

runner.test('ленивая дозагрузка сезона: пустой сезон → мерж → кандидаты, без повторных запросов', async () => {
    globalThis.__clearReguest();
    globalThis.__clearStorage();
    globalThis.__requestLog = [];
    globalThis.__mockReguest((url) => url.includes('/season/'), {
        episodes: [{ episode_number: 7, runtime: 22 }, { episode_number: 8, runtime: 22 }]
    });
    // общий пул по имени — только раздача ДРУГОГО сезона (сезон 2 остаётся пустым)
    globalThis.__mockReguest((url) => url.includes('torrent-search') && !/(S02|сезон)/i.test(decodeURIComponent(url)), {
        results: [jackettRaw('Футурама / Futurama S07E01 1080p WEB-DL', 5, 2, 'aaaa')],
        indexers: []
    });
    globalThis.__mockReguest((url) => url.includes('torrent-search') && /(S02|сезон)/i.test(decodeURIComponent(url)), {
        results: [
            jackettRaw('Футурама / Futurama S02E07 1080p WEB-DL', 12, 6, 'bbbb'),
            jackettRaw('Футурама / Futurama S07E01 1080p WEB-DL', 5, 2, 'aaaa')
        ],
        indexers: []
    });

    const domain = createResultsDomain({ object: { movie: tvMovie, season: 2 }, movie: tvMovie, hasSeasons: true });
    domain.start();
    await flushMicrotasks();

    let state = domain.store.get();
    if (state.pool.length !== 1) throw new Error('ожидал 1 раздачу в пуле по имени, получил ' + state.pool.length);

    // клик серии 7 сезона 2: локально пусто → дозагрузка сезона → мерж → сразу воспроизведение
    domain.selection.selectEpisode(7);
    await flushMicrotasks();
    state = domain.store.get();
    if (state.stage === 'candidates') {
        throw new Error('дозагрузка не должна приводить к списку кандидатов, stage=' + state.stage +
            ' loads=' + JSON.stringify(state.seasonLoads) +
            ' log=' + JSON.stringify(globalThis.__requestLog.filter((u) => u.includes('torrent-search'))));
    }
    if (state.pool.length !== 2) throw new Error('ожидал мерж: 2 раздачи в пуле, получил ' + state.pool.length);
    if (state.seasonLoads[2] !== 'ready') throw new Error('сезон 2 не помечен ready');

    // повторный клик по другой серии сезона — БЕЗ нового запроса
    const callsBefore = globalThis.__requestLog.filter((u) => u.includes('torrent-search')).length;
    domain.selection.selectEpisode(8);
    await flushMicrotasks();
    const callsAfter = globalThis.__requestLog.filter((u) => u.includes('torrent-search')).length;
    if (callsAfter !== callsBefore) throw new Error('повторный клик сделал лишний запрос: ' + callsBefore + ' → ' + callsAfter);
});

runner.test('дозагрузка: последний клик во время loading выигрывает, смена сезона отменяет повтор', async () => {
    globalThis.__clearReguest();
    globalThis.__clearStorage();
    globalThis.__requestLog = [];
    globalThis.__mockReguest((url) => url.includes('/season/'), {
        episodes: [{ episode_number: 7, runtime: 22 }, { episode_number: 8, runtime: 22 }]
    });
    // общий пул: только раздача сезона 7 (сезон 2 локально пуст)
    globalThis.__mockReguest((url) => url.includes('torrent-search') && !/(S02|сезон)/i.test(decodeURIComponent(url)), {
        results: [jackettRaw('Футурама / Futurama S07E01 1080p WEB-DL', 5, 2, 'aaaa')],
        indexers: []
    });
    // дозагрузка сезона 2 — медленная, с раздачами для серий 7 и 8
    globalThis.__mockReguest((url) => url.includes('torrent-search') && /(S02|сезон)/i.test(decodeURIComponent(url)), {
        results: [
            jackettRaw('Футурама / Futurama S02E07 1080p WEB-DL', 12, 6, 'bbbb'),
            jackettRaw('Футурама / Futurama S02E08 1080p WEB-DL', 12, 6, 'cccc')
        ],
        indexers: []
    }, 80);

    const domain = createResultsDomain({ object: { movie: tvMovie, season: 2 }, movie: tvMovie, hasSeasons: true });
    domain.start();
    await new Promise((r) => setTimeout(r, 160));

    // два клика пока дозагрузка in-flight: выиграть должен ПОСЛЕДНИЙ (серия 8)
    domain.selection.selectEpisode(7);
    domain.selection.selectEpisode(8);
    await new Promise((r) => setTimeout(r, 200));
    let state = domain.store.get();
    if (state.stage === 'candidates') throw new Error('после дозагрузки не должно быть списка кандидатов, stage=' + state.stage);
    if (state.lastEpisode !== 8) throw new Error('повторён не последний выбор: lastEpisode=' + state.lastEpisode);
});

runner.test('дозагрузка: смена сезона до ответа не выбирает эпизод в чужом сезоне', async () => {
    globalThis.__clearReguest();
    globalThis.__clearStorage();
    globalThis.__requestLog = [];
    globalThis.__mockReguest((url) => url.includes('/season/'), {
        episodes: [{ episode_number: 7, runtime: 22 }, { episode_number: 8, runtime: 22 }]
    });
    // общий пул пуст — любой клик триггерит дозагрузку
    globalThis.__mockReguest((url) => url.includes('torrent-search'), {
        results: [], indexers: []
    });

    const domain = createResultsDomain({ object: { movie: tvMovie, season: 2 }, movie: tvMovie, hasSeasons: true });
    domain.start();
    await new Promise((r) => setTimeout(r, 100)); // пул готов (пустой)

    globalThis.__clearReguest();
    globalThis.__mockReguest((url) => url.includes('/season/'), {
        episodes: [{ episode_number: 7, runtime: 22 }, { episode_number: 8, runtime: 22 }]
    });
    globalThis.__mockReguest((url) => url.includes('torrent-search'), { results: [], indexers: [] }, 80);

    domain.selection.selectEpisode(7, true);
    await new Promise((r) => setTimeout(r, 10)); // дозагрузка сезона 2 in-flight
    domain.episodes.setSeason(3);
    await new Promise((r) => setTimeout(r, 200)); // ответ пришёл ПОСЛЕ смены сезона

    const state = domain.store.get();
    if (state.stage === 'candidates') throw new Error('устаревшая дозагрузка показала кандидатов в чужом сезоне');
    if (state.season !== 3) throw new Error('сезон не сменился');
});

runner.test('панель: openPicker строит кандидатов, playPickerCandidate сохраняет дефолт сезона', async () => {
    globalThis.__clearReguest();
    globalThis.__clearStorage();
    globalThis.__requestLog = [];
    globalThis.__mockReguest((url) => url.includes('/season/'), {
        episodes: [{ episode_number: 7, runtime: 22 }, { episode_number: 8, runtime: 22 }]
    });
    globalThis.__mockReguest((url) => url.includes('/api/torrent-search'), {
        results: [
            jackettRaw('Футурама / Futurama S02E07 1080p WEB-DL', 12, 6, 'aaaa'),
            jackettRaw('Футурама / Futurama S02E07 720p WEBRip', 3, 1, 'bbbb')
        ],
        indexers: []
    });

    const object = { movie: tvMovie, season: 2 };
    const domain = createResultsDomain({ object: object, movie: tvMovie, hasSeasons: true });
    domain.start();
    await flushMicrotasks();

    domain.selection.setActiveEpisode(7);
    domain.selection.openPicker();
    await flushMicrotasks();
    let state = domain.store.get();
    let picker = pickerData(domain, object);
    if (!state.picker.open) throw new Error('панель не открылась');
    if (picker.items.length !== 2) throw new Error('ожидал 2 кандидата в панели, получил ' + picker.items.length);

    const chosen = picker.items[1]; // второй — выберем его вручную
    domain.selection.playPickerCandidate(chosen, picker.target);
    state = domain.store.get();
    if (state.picker.open) throw new Error('панель не закрылась после выбора');

    const saved = Lampa.Storage.get('torrent_mod_default_torrent');
    const seasonDefault = saved && saved[tvMovie.id] && saved[tvMovie.id][2];
    if (!seasonDefault) throw new Error('дефолт сезона не сохранён: ' + JSON.stringify(saved));
    if (seasonDefault.title !== chosen.title) throw new Error('сохранён не тот кандидат');

    // повторное открытие панели для той же серии — selectPickerData должен вернуть дефолт как selectedId
    domain.selection.setActiveEpisode(7);
    domain.selection.openPicker();
    await flushMicrotasks();
    state = domain.store.get();
    picker = pickerData(domain, object);
    if (!state.picker.open) throw new Error('панель не открылась повторно');
    if (picker.selectedId !== seasonDefault.id) {
        throw new Error('selectedId в панели не совпадает с дефолтом: ' + picker.selectedId + ' vs ' + seasonDefault.id);
    }

    // следующий клик по серии этого сезона использует сохранённый дефолт (его id — из пула)
    domain.selection.selectEpisode(8);
    await flushMicrotasks();
    state = domain.store.get();
    if (state.stage === 'candidates') throw new Error('клик не должен показывать список');
});

runner.test('TMDB сезон недоступен: ошибка retryable, повтор восстанавливает', async () => {
    globalThis.__clearReguest();
    globalThis.__clearStorage();
    globalThis.__requestLog = [];
    globalThis.__mockReguest((url) => url.includes('/api/torrent-search'), {
        results: [jackettRaw('Футурама / Futurama S02E07 1080p WEB-DL', 12, 6, 'aaaa')],
        indexers: []
    });

    const domain = createResultsDomain({ object: { movie: tvMovie, season: 2 }, movie: tvMovie, hasSeasons: true });
    domain.start();
    await flushMicrotasks();

    let state = domain.store.get();
    if (state.episodesStatus !== 'error') throw new Error('ожидал episodesStatus=error, получил ' + state.episodesStatus);
    if (state.stage !== 'message') throw new Error('ожидал stage=message, получил ' + state.stage);
    if (typeof state.message.retry !== 'function') throw new Error('retry должен быть функцией: ' + JSON.stringify(state.message));

    // Регистрируем хендлер и вызываем сохранённый retry — должен повторно запросить и восстановиться
    globalThis.__mockReguest((url) => url.includes('/season/'), {
        episodes: [{ episode_number: 7, name: 'Эпизод 7', runtime: 22 }]
    });
    state.message.retry();
    await flushMicrotasks();

    state = domain.store.get();
    if (state.episodesStatus !== 'ready') throw new Error('повтор не восстановил список серий: ' + state.episodesStatus);
    if (state.stage !== 'episodes') throw new Error('после повтора ожидал stage=episodes, получил ' + state.stage);
});

runner.test('destroy() мид-флайт: поздний ответ после domain.destroy() не трогает стор', async () => {
    globalThis.__clearReguest();
    globalThis.__clearStorage();
    globalThis.__requestLog = [];
    globalThis.__mockReguest((url) => url.includes('/season/'), {
        episodes: [{ episode_number: 7, name: 'Эпизод 7', runtime: 22 }]
    }, 50);
    globalThis.__mockReguest((url) => url.includes('/api/torrent-search'), {
        results: [jackettRaw('Футурама / Futurama S02E07 1080p WEB-DL', 12, 6, 'aaaa')],
        indexers: []
    }, 50);

    const domain = createResultsDomain({ object: { movie: tvMovie, season: 2 }, movie: tvMovie, hasSeasons: true });
    domain.start();
    const stateBeforeDestroy = domain.store.get();
    if (stateBeforeDestroy.episodesStatus !== 'loading') throw new Error('ожидал episodesStatus=loading до ответа, получил ' + stateBeforeDestroy.episodesStatus);
    if (stateBeforeDestroy.poolStatus !== 'loading') throw new Error('ожидал poolStatus=loading до ответа, получил ' + stateBeforeDestroy.poolStatus);

    domain.destroy();
    await new Promise((r) => setTimeout(r, 100)); // оба задержанных ответа успевают прийти

    const stateAfter = domain.store.get();
    if (stateAfter.episodesStatus !== 'loading') throw new Error('поздний TMDB-ответ изменил стор после destroy(): episodesStatus=' + stateAfter.episodesStatus);
    if (stateAfter.poolStatus !== 'loading') throw new Error('поздний torrent-search-ответ изменил стор после destroy(): poolStatus=' + stateAfter.poolStatus);
    if (!Array.isArray(stateAfter.episodesCache) || stateAfter.episodesCache.length !== 0) throw new Error('episodesCache не должен был заполниться после destroy()');
    if (stateAfter.pool.length !== 0) throw new Error('pool не должен был заполниться после destroy()');
});

runner.test('провал сезонной дозагрузки не запускает устаревший авто-повтор', async () => {
    globalThis.__clearReguest();
    globalThis.__clearStorage();
    globalThis.__requestLog = [];
    globalThis.__mockReguest((url) => url.includes('/season/'), {
        episodes: [{ episode_number: 1, name: 'Эпизод 1', runtime: 22 }, { episode_number: 2, name: 'Эпизод 2', runtime: 22 }]
    });

    const object = { movie: tvMovie, season: 2 };
    const domain = createResultsDomain({ object: object, movie: tvMovie, hasSeasons: true });
    domain.start();
    await flushMicrotasks();

    const afterPoolFail = domain.store.get();
    if (afterPoolFail.poolStatus !== 'error') throw new Error('ожидал poolStatus=error, получил ' + afterPoolFail.poolStatus);

    // right-arrow на серии 1 — тот самый пользовательский сценарий, приводивший к краху
    domain.selection.setActiveEpisode(1);
    domain.selection.openPicker();
    const seasonCalls = globalThis.__requestLog.filter((u) => u.includes('/api/torrent-search')).length;
    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 2800));

    const state = domain.store.get();
    if (!state.seasonLoads || state.seasonLoads[2] !== 'error') {
        throw new Error('ожидал seasonLoads[2]=error (без этого — риск рекурсии), получил ' + JSON.stringify(state.seasonLoads));
    }
    const seasonCallsAfter = globalThis.__requestLog.filter((u) => u.includes('/api/torrent-search')).length;
    if (seasonCallsAfter !== seasonCalls) throw new Error('пустой сезон запустил повторный запрос: ' + seasonCalls + ' → ' + seasonCallsAfter);
    const picker = pickerData(domain, object);
    if (picker.status !== 'error') throw new Error('ожидал picker.status=error, получил ' + picker.status);
    domain.destroy(); // отменяет любые ещё не сработавшие таймеры пула/сезона перед следующим тестом
});

runner.test('дедлок при переоткрытии панели для другой серии, пока идёт дозагрузка сезона', async () => {
    globalThis.__clearReguest();
    globalThis.__clearStorage();
    globalThis.__requestLog = [];
    globalThis.__mockReguest((url) => url.includes('/season/'), {
        episodes: [{ episode_number: 1, name: 'Эпизод 1', runtime: 22 }, { episode_number: 6, name: 'Эпизод 6', runtime: 22 }]
    });
    let torrentSearchCalls = 0;
    globalThis.__mockReguest((url) => {
        if (!url.includes('/api/torrent-search')) return false;
        torrentSearchCalls++;
        return torrentSearchCalls === 1;
    }, { results: [], indexers: [] }, 0);
    globalThis.__mockReguest((url) => url.includes('/api/torrent-search'), {
        results: [jackettRaw('Футурама / Futurama S02E06 1080p WEB-DL', 10, 5, 'cccc')],
        indexers: []
    }, 60);

    const object = { movie: tvMovie, season: 2 };
    const domain = createResultsDomain({ object: object, movie: tvMovie, hasSeasons: true });
    domain.start();
    await flushMicrotasks();

    const afterPool = domain.store.get();
    if (afterPool.poolStatus !== 'ready') throw new Error('ожидал poolStatus=ready, получил ' + afterPool.poolStatus);

    domain.selection.setActiveEpisode(1);
    domain.selection.openPicker();
    if (domain.store.get().seasonLoads[2] !== 'loading') {
        throw new Error('ожидал seasonLoads[2]=loading сразу после openPicker, получил ' + domain.store.get().seasonLoads[2]);
    }

    domain.selection.closePicker();
    domain.selection.setActiveEpisode(6);
    let threw = null;
    try {
        domain.selection.openPicker();
    } catch (e) {
        threw = e;
    }
    if (threw) throw new Error('openPicker(6) во время дозагрузки сезона выбросил исключение: ' + threw.message);

    await new Promise((r) => setTimeout(r, 100));

    const state = domain.store.get();
    if (state.seasonLoads[2] !== 'ready') throw new Error('ожидал seasonLoads[2]=ready, получил ' + state.seasonLoads[2]);
    if (!state.picker.open) throw new Error('ожидал открытую панель');
    if (state.picker.episode !== 6) throw new Error('ожидал панель для серии 6, получил ' + state.picker.episode);
    const picker = pickerData(domain, object);
    if (picker.status !== 'ready' || !picker.items.length) {
        throw new Error('ожидал готовые кандидаты для серии 6, получил status=' + picker.status + ' items=' + picker.items.length);
    }
});

runner.test('панель, закрытая во время дозагрузки сезона, не открывается заново сама по себе', async () => {
    globalThis.__clearReguest();
    globalThis.__clearStorage();
    globalThis.__requestLog = [];
    globalThis.__mockReguest((url) => url.includes('/season/'), {
        episodes: [{ episode_number: 1, name: 'Эпизод 1', runtime: 22 }]
    });
    let torrentSearchCalls = 0;
    globalThis.__mockReguest((url) => {
        if (!url.includes('/api/torrent-search')) return false;
        torrentSearchCalls++;
        return torrentSearchCalls === 1;
    }, { results: [], indexers: [] }, 0);
    globalThis.__mockReguest((url) => url.includes('/api/torrent-search'), {
        results: [jackettRaw('Футурама / Futurama S02E01 1080p WEB-DL', 10, 5, 'dddd')],
        indexers: []
    }, 60);

    const domain = createResultsDomain({ object: { movie: tvMovie, season: 2 }, movie: tvMovie, hasSeasons: true });
    domain.start();
    await flushMicrotasks();

    domain.selection.setActiveEpisode(1);
    domain.selection.openPicker();
    domain.selection.closePicker();

    await new Promise((r) => setTimeout(r, 100));

    const state = domain.store.get();
    if (state.picker.open) throw new Error('панель не должна была открыться заново сама по себе после закрытия');
});

runner.test('retrySeasonLoad: ручной повтор после провала дозагрузки сезона восстанавливает панель', async () => {
    globalThis.__clearReguest();
    globalThis.__clearStorage();
    globalThis.__requestLog = [];
    globalThis.__mockReguest((url) => url.includes('/season/'), {
        episodes: [{ episode_number: 1, name: 'Эпизод 1', runtime: 22 }]
    });
    let torrentSearchCalls = 0;
    globalThis.__mockReguest((url) => {
        if (!url.includes('/api/torrent-search')) return false;
        torrentSearchCalls++;
        return torrentSearchCalls === 1;
    }, { results: [], indexers: [] }, 0);
    globalThis.__mockReguest((url) => {
        if (!url.includes('/api/torrent-search')) return false;
        return torrentSearchCalls === 2;
    }, null); // unmatched-shaped: passing null data makes mock-Reguest call the fail callback

    const object = { movie: tvMovie, season: 2 };
    const domain = createResultsDomain({ object: object, movie: tvMovie, hasSeasons: true });
    domain.start();
    await flushMicrotasks();

    domain.selection.setActiveEpisode(1);
    domain.selection.openPicker();
    await new Promise((r) => setTimeout(r, 10));

    let picker = pickerData(domain, object);
    if (picker.status !== 'error') {
        throw new Error('ожидал status=error после единственного сезонного запроса, получил ' + JSON.stringify(picker));
    }
    if (!picker.retrySeason) {
        throw new Error('ожидал ручной retry после ошибки сезонного запроса, получил ' + JSON.stringify(picker));
    }

    // Свежий успешный мок для РУЧНОЙ повторной попытки.
    globalThis.__mockReguest((url) => url.includes('/api/torrent-search'), {
        results: [jackettRaw('Футурама / Futurama S02E01 1080p WEB-DL', 8, 4, 'eeee')],
        indexers: []
    });

    domain.episodes.retrySeasonLoad(2);
    await new Promise((r) => setTimeout(r, 10));

    picker = pickerData(domain, object);
    if (picker.status !== 'ready' || !picker.items.length) {
        throw new Error('ожидал восстановление после retrySeasonLoad, получил ' + JSON.stringify(picker));
    }
    domain.destroy();
});

runner.test('панель, открытая ДО того как пул хоть раз ответил, не падает на пустой pool', async () => {
    globalThis.__clearReguest();
    globalThis.__clearStorage();
    globalThis.__requestLog = [];
    globalThis.__mockReguest((url) => url.includes('/season/'), {
        episodes: [{ episode_number: 1, name: 'Эпизод 1', runtime: 22 }]
    });
    globalThis.__mockReguest((url) => url.includes('/api/torrent-search'), { results: [], indexers: [] }, 200);

    const object = { movie: tvMovie, season: 2 };
    const domain = createResultsDomain({ object: object, movie: tvMovie, hasSeasons: true });
    domain.start();
    await new Promise((r) => setTimeout(r, 30));
    if (domain.store.get().pool.length !== 0) throw new Error('тест сломан: pool уже не пуст, сценарий не воспроизведён');

    domain.selection.setActiveEpisode(1);
    let threw = null;
    try {
        domain.selection.openPicker();
        pickerData(domain, object); // именно это (через View) раньше падало
    } catch (e) {
        threw = e;
    }
    if (threw) throw new Error('открытие панели до ответа пула выбросило исключение: ' + threw.message);

    const picker = pickerData(domain, object);
    if (picker.status !== 'loading') throw new Error('ожидал status=loading пока pool ещё null, получил ' + JSON.stringify(picker));
    domain.destroy();
    await new Promise((r) => setTimeout(r, 200));
});

runner.test('loadAllTorrents: сетевой сбой авто-повторяется и восстанавливается без ручного действия', async () => {
    globalThis.__clearReguest();
    globalThis.__clearStorage();
    globalThis.__requestLog = [];
    globalThis.__mockReguest((url) => url.includes('/season/'), {
        episodes: [{ episode_number: 1, name: 'Эпизод 1', runtime: 22 }]
    });
    let torrentSearchCalls = 0;
    globalThis.__mockReguest((url) => {
        if (!url.includes('/api/torrent-search')) return false;
        torrentSearchCalls++;
        return torrentSearchCalls === 1;
    }, null); // первая попытка — сбой сети/Jackett
    globalThis.__mockReguest((url) => {
        if (!url.includes('/api/torrent-search')) return false;
        return torrentSearchCalls === 2;
    }, { results: [jackettRaw('Футурама / Futurama S02E01 1080p WEB-DL', 20, 8, 'ffff')], indexers: [] });

    const domain = createResultsDomain({ object: { movie: tvMovie, season: 2 }, movie: tvMovie, hasSeasons: true });
    domain.start();
    await new Promise((r) => setTimeout(r, 30));

    let state = domain.store.get();
    if (state.poolStatus !== 'error') throw new Error('ожидал первый сбой poolStatus=error, получил ' + state.poolStatus);
    if (!state.poolAutoRetryAt || state.poolAutoRetryAt <= Date.now()) {
        throw new Error('ожидал запланированный авто-повтор в будущем, получил poolAutoRetryAt=' + state.poolAutoRetryAt);
    }

    // Реально ждём срабатывания первого запланированного авто-повтора (POOL_RETRY_DELAYS_MS[0]=5с).
    await new Promise((r) => setTimeout(r, 5300));

    state = domain.store.get();
    if (state.poolStatus !== 'ready') throw new Error('ожидал восстановление после авто-повтора, получил poolStatus=' + state.poolStatus);
    if (!state.pool || state.pool.length !== 1) throw new Error('ожидал 1 раздачу после авто-повтора, получил ' + JSON.stringify(state.pool));
    if (state.poolAttempt !== 2) throw new Error('ожидал poolAttempt=2 после одного авто-повтора, получил ' + state.poolAttempt);
    if (state.poolAutoRetryAt !== null) throw new Error('poolAutoRetryAt должен сброситься после успеха, получил ' + state.poolAutoRetryAt);
    domain.destroy();
});

runner.test('domain.destroy() отменяет запланированный авто-повтор пула', async () => {
    globalThis.__clearReguest();
    globalThis.__clearStorage();
    globalThis.__requestLog = [];
    globalThis.__mockReguest((url) => url.includes('/season/'), {
        episodes: [{ episode_number: 1, name: 'Эпизод 1', runtime: 22 }]
    });
    globalThis.__mockReguest((url) => url.includes('/api/torrent-search'), null); // всегда проваливается

    const domain = createResultsDomain({ object: { movie: tvMovie, season: 2 }, movie: tvMovie, hasSeasons: true });
    domain.start();
    await new Promise((r) => setTimeout(r, 30));

    if (domain.store.get().poolStatus !== 'error') throw new Error('ожидал первый сбой перед destroy()');
    const requestsBeforeDestroy = globalThis.__requestLog.filter((u) => u.includes('/api/torrent-search')).length;

    domain.destroy();
    await new Promise((r) => setTimeout(r, 3300)); // пережидаем время первого запланированного авто-повтора

    const requestsAfterDestroy = globalThis.__requestLog.filter((u) => u.includes('/api/torrent-search')).length;
    if (requestsAfterDestroy !== requestsBeforeDestroy) {
        throw new Error('destroy() не отменил авто-повтор — новый запрос всё равно улетел (' + requestsBeforeDestroy + ' → ' + requestsAfterDestroy + ')');
    }
});

runner.test('виджет трекеров: домен не планирует никакого скрытия — это презентационная политика View', async () => {
    globalThis.__clearReguest();
    globalThis.__clearStorage();
    globalThis.__requestLog = [];
    globalThis.__mockReguest((url) => url.includes('/season/'), {
        episodes: [{ episode_number: 1, name: 'Эпизод 1', runtime: 22 }]
    });
    globalThis.__mockReguest((url) => url.includes('/api/torrent-search'), { results: [], indexers: [] });

    const domain = createResultsDomain({ object: { movie: tvMovie, season: 2 }, movie: tvMovie, hasSeasons: true });
    domain.start();
    await flushMicrotasks();

    const afterSearch = domain.store.get();
    if (afterSearch.poolStatus !== 'ready') throw new Error('пул не загрузился: ' + afterSearch.poolStatus);
    const progressNow = selectPoolIndexers(afterSearch);
    if (progressNow.trackers.length !== 1 || progressNow.trackers[0].status !== 'ok') {
        throw new Error('ожидал один успешный трекер сразу после ответа: ' + JSON.stringify(progressNow));
    }
    const poolIndexersRef = afterSearch.poolIndexers;

    await new Promise((resolve) => setTimeout(resolve, 4300));

    const afterWait = domain.store.get();
    if (afterWait.poolIndexers !== poolIndexersRef) {
        throw new Error('poolIndexers сменил ссылку сам по себе — в домене осталось что-то планирующее скрытие, это презентационная логика, ей место во View');
    }
    if (selectPoolIndexers(afterWait).trackers.length !== 1) {
        throw new Error('селектор не должен сам прятать давно ответившие трекеры — это решение View, не его');
    }
    domain.destroy();
});

await runner.run();
