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

    // ручной запрос — единственный сетевой поиск; сериал остаётся на сериях
    domain.selection.searchWithQuery('Futurama');
    await flushMicrotasks();
    const requeried = domain.store.get();
    if (requeried.customQuery !== 'Futurama') throw new Error('customQuery не сохранился');
    if (requeried.poolStatus !== 'ready') throw new Error('requery не выполнился: ' + requeried.poolStatus);
    if (requeried.stage !== 'episodes') throw new Error('сериал должен остаться на сериях, stage=' + requeried.stage);
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

    // смена названия фильма — ручной поиск без автоплея
    domain.selection.searchWithQuery('Dune');
    await flushMicrotasks();
    const requeried = domain.store.get();
    if (requeried.stage !== 'candidates') throw new Error('после смены названия фильм должен показать кандидатов');
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
    Lampa.Storage.set('torrent_mod_default_torrent', { [movie.id]: { 0: { id: 'magnet xt urn btih eeee', title: 'x', size: 1 } } });

    const domain = createResultsDomain({ object: { movie: movie, season: 0 }, movie: movie, hasSeasons: false });
    domain.start();
    await flushMicrotasks();

    const state = domain.store.get();
    if (state.stage === 'candidates') throw new Error('с сохранённым дефолтом фильм должен автозапуститься, а не показывать список');
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
    // дозагрузка сезона 2 — запросы «Имя S02» и «Имя 2 сезон»; ответ содержит и новую раздачу,
    // и дубль уже имеющейся (S07E01) — мерж не должен задвоить
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

    // первый пул готов, клик по серии 7 сезона 2 запускает дозагрузку (пустую)…
    // сделаем дозагрузку медленной, чтобы успеть сменить сезон до ответа
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

    const domain = createResultsDomain({ object: { movie: tvMovie, season: 2 }, movie: tvMovie, hasSeasons: true });
    domain.start();
    await flushMicrotasks();

    domain.selection.setActiveEpisode(7);
    domain.selection.openPicker();
    await flushMicrotasks();
    let state = domain.store.get();
    if (!state.picker.open) throw new Error('панель не открылась');
    if (state.picker.items.length !== 2) throw new Error('ожидал 2 кандидата в панели, получил ' + state.picker.items.length);

    const chosen = state.picker.items[1]; // второй — выберем его вручную
    domain.selection.playPickerCandidate(chosen, state.picker.target);
    state = domain.store.get();
    if (state.picker.open) throw new Error('панель не закрылась после выбора');

    const saved = Lampa.Storage.get('torrent_mod_default_torrent');
    const seasonDefault = saved && saved[tvMovie.id] && saved[tvMovie.id][2];
    if (!seasonDefault) throw new Error('дефолт сезона не сохранён: ' + JSON.stringify(saved));
    if (seasonDefault.title !== chosen.title) throw new Error('сохранён не тот кандидат');

    // повторное открытие панели для той же серии — в state.picker.selectedId должен быть дефолт
    domain.selection.setActiveEpisode(7);
    domain.selection.openPicker();
    await flushMicrotasks();
    state = domain.store.get();
    if (!state.picker.open) throw new Error('панель не открылась повторно');
    if (state.picker.selectedId !== seasonDefault.id) {
        throw new Error('selectedId в панели не совпадает с дефолтом: ' + state.picker.selectedId + ' vs ' + seasonDefault.id);
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
    // Нарочно НЕ регистрируем хендлер для /season/ — mock Reguest.native вызывает fail-колбэк на
    // непойманном URL, что даёт ровно тот же путь, что и реальный сетевой сбой (request() резолвит
    // null; fetchSeason теперь возвращает err('network', ...)).
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

runner.test('freshSearch: Jackett недоступен при активном customQuery — retryable, повтор восстанавливает', async () => {
    globalThis.__clearReguest();
    globalThis.__clearStorage();
    globalThis.__requestLog = [];
    globalThis.__mockReguest((url) => url.includes('/season/'), {
        episodes: [{ episode_number: 7, name: 'Эпизод 7', runtime: 22 }]
    });
    globalThis.__mockReguest((url) => url.includes('/api/torrent-search'), {
        results: [jackettRaw('Футурама / Futurama S02E07 1080p WEB-DL', 12, 6, 'aaaa')],
        indexers: []
    });

    const domain = createResultsDomain({ object: { movie: tvMovie, season: 2 }, movie: tvMovie, hasSeasons: true });
    domain.start();
    await flushMicrotasks();

    // ручной поиск по имени — успешный requery, сериал остаётся на списке серий
    domain.selection.searchWithQuery('Futurama');
    await flushMicrotasks();
    if (domain.store.get().customQuery !== 'Futurama') throw new Error('customQuery не сохранился');

    // убираем torrent-search хендлер — клик по серии уходит в freshSearch (customQuery активен) и
    // не находит ответа, mock Reguest.native вызывает fail-колбэк на непойманном URL — тот же путь,
    // что и реальная недоступность Jackett
    globalThis.__clearReguest();
    globalThis.__mockReguest((url) => url.includes('/season/'), {
        episodes: [{ episode_number: 7, name: 'Эпизод 7', runtime: 22 }]
    });
    domain.selection.selectEpisode(7);
    await flushMicrotasks();

    let state = domain.store.get();
    if (state.searchStatus !== 'error') throw new Error('ожидал searchStatus=error, получил ' + state.searchStatus);
    if (state.stage !== 'message') throw new Error('ожидал stage=message, получил ' + state.stage);
    if (typeof state.message.retry !== 'function') throw new Error('retry должен быть функцией: ' + JSON.stringify(state.message));

    // регистрируем хендлер снова и вызываем сохранённый retry — переиздаёт идентичный поиск и
    // восстанавливается
    globalThis.__mockReguest((url) => url.includes('/api/torrent-search'), {
        results: [jackettRaw('Футурама / Futurama S02E07 1080p WEB-DL', 12, 6, 'aaaa')],
        indexers: []
    });
    state.message.retry();
    await flushMicrotasks();

    state = domain.store.get();
    if (state.searchStatus !== 'ready') throw new Error('повтор не восстановил поиск: ' + state.searchStatus);
});

runner.test('destroy() мид-флайт: поздний ответ после domain.destroy() не трогает стор', async () => {
    globalThis.__clearReguest();
    globalThis.__clearStorage();
    globalThis.__requestLog = [];
    // Задерживаем оба сетевых ответа (сезон + пул), чтобы успеть вызвать destroy() до того, как
    // хоть один из них резолвится — это единственный путь, которым сейчас проверяется isDestroyed()
    // (найдено при плане: ни domain.destroy()/isDestroyed(), ни playback/smart-preload.js вообще не
    // покрыты тестами до этого прохода).
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
    if (stateAfter.episodesCache !== null) throw new Error('episodesCache не должен был заполниться после destroy()');
    if (stateAfter.pool !== null) throw new Error('pool не должен был заполниться после destroy()');
});

await runner.run();
