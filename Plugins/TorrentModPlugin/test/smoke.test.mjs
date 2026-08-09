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
import { selectPickerData } from '../domain/results-selectors.js';

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

// The side picker's own items/status/target/selectedId are no longer stored (state.picker only
// carries open/episode) — selectPickerData derives them fresh, same as the real View does.
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

runner.test('крах после провала поиска: открытие панели после ошибки пула не уходит в бесконечную рекурсию', async () => {
    // Реальный краш, пойманный пользователем вживую: RangeError "Maximum call stack size exceeded"
    // при открытии боковой панели (right-arrow на серии) сразу после того, как основной поиск по
    // всем трекерам провалился (Jackett 502/таймаут). Причина: ensureSeasonLoaded безусловно
    // выходило через onComplete() при poolStatus !== 'ready' — включая 'error' — НИКОГДА не
    // трогая seasonLoads[season], так что fillPicker → ensureSeasonLoaded → onComplete (=fillPicker
    // снова) зацикливались синхронно без базового случая. Не мокаем /api/torrent-search вообще —
    // необработанный URL в mock-Reguest вызывает fail-колбэк, тот же путь, что и реальная
    // недоступность Jackett.
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
    await flushMicrotasks();
    // /api/torrent-search всё ещё не замокан — ленивая дозагрузка сезона (ensureSeasonLoaded,
    // теперь запускаемая реактивным watcher'ом внутри selection-interactor, а не самим openPicker)
    // тоже проваливается, но КОРРЕКТНО (без рекурсии), помечая сезон как 'error'
    await new Promise((r) => setTimeout(r, 10));

    const state = domain.store.get();
    if (!state.seasonLoads || state.seasonLoads[2] !== 'error') {
        throw new Error('ожидал seasonLoads[2]=error (без этого — риск рекурсии), получил ' + JSON.stringify(state.seasonLoads));
    }
    const picker = pickerData(domain, object);
    if (picker.status !== 'error') throw new Error('ожидал picker.status=error, получил ' + picker.status);
});

runner.test('дедлок при переоткрытии панели для другой серии, пока идёт дозагрузка сезона', async () => {
    // Второй реальный краш пользователя, тот же RangeError, тот же fillPicker↔ensureSeasonLoaded
    // цикл, но другой триггер: не провал поиска, а закрытие и повторное открытие боковой панели
    // ДЛЯ ДРУГОЙ СЕРИИ, пока ленивая дозагрузка сезона (запущенная первым открытием) ещё не
    // завершилась. ensureSeasonLoaded раньше безусловно вызывало onComplete() синхронно, когда
    // seasonLoads[season] уже 'loading' — тот же класс бага, что и в тесте выше, но в ветке
    // 'loading', не 'error'. Первый вызов /api/torrent-search (общий пул) резолвится сразу и
    // пусто; второй (ленивая дозагрузка сезона) — с задержкой 60мс, чтобы успеть закрыть и
    // переоткрыть панель до его завершения.
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
    // Переоткрытие ДЛЯ ДРУГОЙ серии, пока сезон ещё грузится — раньше здесь падал
    // RangeError: Maximum call stack size exceeded.
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
    // Побочный эффект того же фикса (очередь колбэков в ensureSeasonLoaded вместо синхронного
    // отскока): колбэк fillPicker теперь может сработать заметно позже, уже после того как
    // пользователь закрыл панель — без явной проверки picker.open это воскресило бы закрытую
    // панель прямо во время просмотра списка серий.
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
    // Часть виджета прогресса поиска (консилиум дизайнер/продакт/инженер, см. CLAUDE.md): панель
    // теперь различает status='empty' (реально пусто) и status='error' (поиск не удался), и для
    // error появляется ручная кнопка «Повторить» — episodes.retrySeasonLoad(season) сбрасывает
    // settled-статус сезона и заново запускает ensureSeasonLoaded. Только по нажатию, без авто-ретрая.
    globalThis.__clearReguest();
    globalThis.__clearStorage();
    globalThis.__requestLog = [];
    globalThis.__mockReguest((url) => url.includes('/season/'), {
        episodes: [{ episode_number: 1, name: 'Эпизод 1', runtime: 22 }]
    });
    // Общий пул сразу пуст и успешен; первый вызов ленивой дозагрузки сезона (запущенный watcher'ом
    // при открытии панели) проваливается; второй — уже после ручного retrySeasonLoad — успешен.
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
    if (picker.status !== 'error' || !picker.retrySeason) {
        throw new Error('ожидал status=error после провала дозагрузки, получил ' + JSON.stringify(picker));
    }

    // Третий мок (свежий успешный ответ) для повторной попытки после ручного retry.
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
});

runner.test('панель, открытая ДО того как пул хоть раз ответил, не падает на null pool', async () => {
    // Реальный краш, найденный при ревью (не пойман руками): TMDB (список серий) обычно резолвится
    // намного быстрее агрегатного поиска Jackett (до ~40с) — значит строка серии становится
    // фокусируемой и доступной для right-arrow ЗАДОЛГО до того, как state.pool перестаёт быть null
    // (его стартовое значение, results-state.js). selectPickerData звало
    // selectCandidatesForEpisode (→ applyStateFilters → pool.filter(...)) РАНЬШЕ проверки
    // poolLoading — TypeError: Cannot read properties of null (reading 'filter'). Не мокаем
    // /api/torrent-search вообще (искусственно "вечно висящий" ответ), чтобы pool гарантированно
    // остался null на момент открытия панели.
    globalThis.__clearReguest();
    globalThis.__clearStorage();
    globalThis.__requestLog = [];
    globalThis.__mockReguest((url) => url.includes('/season/'), {
        episodes: [{ episode_number: 1, name: 'Эпизод 1', runtime: 22 }]
    });
    // Задержка намного больше окна проверки ниже (30мс), но не настолько огромная, чтобы
    // болтающийся таймер держал процесс теста надолго после его завершения (мок не отменяется
    // domain.destroy() — это таймер уровня mock-Reguest, не связанный с generation-guard'ами).
    globalThis.__mockReguest((url) => url.includes('/api/torrent-search'), { results: [], indexers: [] }, 200);

    const object = { movie: tvMovie, season: 2 };
    const domain = createResultsDomain({ object: object, movie: tvMovie, hasSeasons: true });
    domain.start();
    // Достаточно для TMDB (быстрый), недостаточно для /api/torrent-search (200мс) —
    // state.pool гарантированно всё ещё null здесь.
    await new Promise((r) => setTimeout(r, 30));
    if (domain.store.get().pool !== null) throw new Error('тест сломан: pool уже не null, сценарий не воспроизведён');

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
});

await runner.run();
