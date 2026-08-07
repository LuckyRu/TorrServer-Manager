// ---------- domain flow smoke test (npm run test:plugin) ----------
//
// Drives the real composition root (createResultsDomain) with mocked browser globals and mocked
// network (TMDB season fetch + /api/torrent-search): start → pool load → season switch → filters →
// episode click → manual query. Catches the same class of runtime ReferenceErrors as domain.test.mjs,
// but through the async interactor chains instead of isolated pure calls.
import './helpers/mock-lampa.mjs';
import { createRunner } from './helpers/test-runner.mjs';
import { flushMicrotasks } from './helpers/mock-lampa.mjs';
import { createResultsDomain } from '../domain/results-domain.js';

const runner = createRunner();

const tvMovie = {
    id: 615, name: 'Футурама', original_name: 'Futurama', title: 'Футурама', original_title: 'Futurama',
    first_air_date: '1999-03-28', number_of_seasons: 10,
    seasons: [{ season_number: 1, episode_count: 13 }, { season_number: 2, episode_count: 19 }, { season_number: 3, episode_count: 22 }]
};
const movie = { id: 1, title: 'Дюна', original_title: 'Dune', release_date: '2024-02-01' };

function jackettRaw(title, seeders, peers, hash) {
    return {
        Title: title, Tracker: 'RuTracker', Size: 2500000000, Seeders: seeders, Peers: peers,
        MagnetUri: 'magnet:?xt=urn:btih:' + hash,
        PublishDate: '2026-08-01T00:00:00Z'
    };
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

    // смена сезона — локально, пул не перезагружается (тот же объект) и НЕ отправляется новый
    // torrent-search запрос (только TMDB season)
    const poolBefore = state.pool;
    const searchCallsBefore = globalThis.__requestLog.filter((u) => u.includes('torrent-search')).length;
    domain.episodes.setSeason(3);
    await flushMicrotasks();
    const afterSeason = domain.store.get();
    if (afterSeason.season !== 3) throw new Error('сезон не сменился');
    if (afterSeason.pool !== poolBefore) throw new Error('пул перезагрузился при смене сезона — должен остаться');
    const searchCallsAfter = globalThis.__requestLog.filter((u) => u.includes('torrent-search')).length;
    if (searchCallsAfter !== searchCallsBefore) throw new Error('смена сезона сделала лишний torrent-search запрос');

    // фильтр
    domain.filters.setVoiceFilter('Дубляж');
    if (domain.store.get().voiceType !== 'Дубляж') throw new Error('фильтр не применился');

    // клик по серии — локальная фильтрация (pickerOnly, чтобы не автоплей)
    domain.episodes.setSeason(2);
    await flushMicrotasks();
    domain.selection.selectEpisode(7, true);
    await flushMicrotasks();
    const picked = domain.store.get();
    if (picked.stage !== 'candidates') throw new Error('ожидал экран кандидатов, stage=' + picked.stage);
    if (!picked.candidates || picked.candidates.items.length !== 2) {
        throw new Error('ожидал 2 кандидата (сингл S02E07 + пак S1-5E1-62), получил ' + (picked.candidates && picked.candidates.items.length));
    }

    // ручной запрос — единственный сетевой поиск; сериал остаётся на сериях
    domain.selection.searchWithQuery('Futurama');
    await flushMicrotasks();
    const requeried = domain.store.get();
    if (requeried.customQuery !== 'Futurama') throw new Error('customQuery не сохранился');
    if (requeried.poolStatus !== 'ready') throw new Error('requery не выполнился: ' + requeried.poolStatus);
    if (requeried.stage !== 'episodes') throw new Error('сериал должен остаться на сериях, stage=' + requeried.stage);
});

runner.test('фильм: start → пул → локальный пикер (без автоплея на пустом рое)', async () => {
    globalThis.__clearReguest();
    globalThis.__clearStorage();
    globalThis.__requestLog = [];
    globalThis.__mockReguest((url) => url.includes('/api/torrent-search'), {
        results: [
            jackettRaw('Дюна: Часть вторая / Dune: Part Two (2024) 1080p WEB-DL', 0, 0, 'cccc'),
            jackettRaw('Дюна: Часть вторая / Dune: Part Two (2024) 2160p Remux', 0, 0, 'dddd')
        ],
        indexers: []
    });

    const domain = createResultsDomain({ object: { movie: movie, season: 0 }, movie: movie, hasSeasons: false });
    domain.start();
    await flushMicrotasks();

    const state = domain.store.get();
    if (state.poolStatus !== 'ready') throw new Error('пул фильма не загрузился');
    if (state.stage !== 'candidates') throw new Error('фильм должен сразу показать кандидатов, stage=' + state.stage);
    if (!state.candidates || state.candidates.items.length !== 2) throw new Error('ожидал 2 кандидата для фильма');

    // смена названия фильма — пикер без автоплея
    domain.selection.searchWithQuery('Dune');
    await flushMicrotasks();
    const requeried = domain.store.get();
    if (requeried.stage !== 'candidates') throw new Error('после смены названия фильм должен показать кандидатов');
});

runner.test('гонка: freshSearch при active customQuery отбрасывается сменой сезона до ответа', async () => {
    globalThis.__clearReguest();
    globalThis.__clearStorage();
    globalThis.__requestLog = [];
    globalThis.__mockReguest((url) => url.includes('/season/'), { episodes: [{ episode_number: 7, runtime: 22 }] });
    // медленный торрент-поиск: успеет стартовать, но не ответить до смены сезона
    globalThis.__mockReguest((url) => url.includes('/api/torrent-search'), {
        results: [jackettRaw('Футурама / Futurama S02E07 1080p WEB-DL', 12, 6, 'cccc')],
        indexers: []
    }, 80);

    const domain = createResultsDomain({ object: { movie: tvMovie, season: 2 }, movie: tvMovie, hasSeasons: true });
    domain.start();
    await new Promise((r) => setTimeout(r, 160)); // серии + пул полностью пришли

    domain.selection.searchWithQuery('Futurama'); // customQuery → requery (медленный)
    await new Promise((r) => setTimeout(r, 10));
    domain.selection.selectEpisode(7);             // клик серии при активном customQuery → freshSearch (медленный, season 2)
    await new Promise((r) => setTimeout(r, 10));
    domain.episodes.setSeason(3);                  // смена сезона должна инвалидировать in-flight freshSearch
    await new Promise((r) => setTimeout(r, 200));  // все ответы пришли

    const state = domain.store.get();
    if (state.season !== 3) throw new Error('сезон не сменился');
    if (state.stage === 'candidates') throw new Error('устаревший freshSearch показал кандидатов на новом сезоне');
    if (state.searchStatus !== 'idle') throw new Error('searchStatus не сброшен: ' + state.searchStatus);
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
    // дозагрузка сезона 2 — запросы «Имя S02» и «Имя 2 сезон»
    globalThis.__mockReguest((url) => url.includes('torrent-search') && /(S02|сезон)/i.test(decodeURIComponent(url)), {
        results: [jackettRaw('Футурама / Futurama S02E07 1080p WEB-DL', 12, 6, 'bbbb')],
        indexers: []
    });

    const domain = createResultsDomain({ object: { movie: tvMovie, season: 2 }, movie: tvMovie, hasSeasons: true });
    domain.start();
    await flushMicrotasks();

    let state = domain.store.get();
    if (state.pool.length !== 1) throw new Error('ожидал 1 раздачу в пуле по имени, получил ' + state.pool.length);

    // клик серии 7 сезона 2: локально пусто → дозагрузка сезона → мерж → кандидаты
    domain.selection.selectEpisode(7, true);
    await flushMicrotasks();
    state = domain.store.get();
    if (state.stage !== 'candidates') {
        throw new Error('дозагрузка не привела к кандидатам, stage=' + state.stage +
            ' loads=' + JSON.stringify(state.seasonLoads) +
            ' log=' + JSON.stringify(globalThis.__requestLog.filter((u) => u.includes('torrent-search'))));
    }
    if (state.pool.length !== 2) throw new Error('ожидал мерж: 2 раздачи в пуле, получил ' + state.pool.length);
    if (state.seasonLoads[2] !== 'ready') throw new Error('сезон 2 не помечен ready');

    // повторный клик по той же серии/другой серии сезона — БЕЗ нового запроса
    const callsBefore = globalThis.__requestLog.filter((u) => u.includes('torrent-search')).length;
    domain.selection.selectEpisode(8, true);
    await flushMicrotasks();
    const callsAfter = globalThis.__requestLog.filter((u) => u.includes('torrent-search')).length;
    if (callsAfter !== callsBefore) throw new Error('повторный клик сделал лишний запрос: ' + callsBefore + ' → ' + callsAfter);
});

await runner.run();
