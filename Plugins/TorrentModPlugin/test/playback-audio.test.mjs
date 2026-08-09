import './helpers/mock-lampa.mjs';
import { createRunner } from './helpers/test-runner.mjs';
import { flushMicrotasks } from './helpers/mock-lampa.mjs';
import { startDownload } from '../playback/smart-preload.js';

const runner = createRunner();

function candidate() {
    return { title: 'Сериал S02E01', tracker: 'test', seeders: 10, size: 1000, magnet: 'magnet:?xt=urn:btih:test' };
}

function target() {
    return { mode: 'series', season: 2, episode: 1, movie: { id: 42, name: 'Тестовый сериал' } };
}

async function waitForPlay(count) {
    for (let attempt = 0; attempt < 10; attempt++) {
        await flushMicrotasks();
        if (globalThis.__playerPlays.length >= count) return;
    }
    throw new Error('Player.play не был вызван ' + count + ' раз');
}

runner.test('оболочка Player появляется сразу, а media source ждёт обязательный probe', async () => {
    globalThis.__clearStorage();
    globalThis.__resetPlaybackMock();
    globalThis.__setProbeBehavior(80, false);

    startDownload(candidate(), target());
    if (!globalThis.__isPreparationShellMounted()) throw new Error('оболочка Player не смонтирована синхронно');
    if (!globalThis.__isPreparationOverlayMounted()) throw new Error('видимый индикатор подготовки не смонтирован синхронно');
    if (globalThis.__preparationStatus() !== 'Подключение к раздаче…') throw new Error('не показана начальная фаза подготовки');
    if (globalThis.__playerPlays.length) throw new Error('Player.play вызван до завершения probe');

    await new Promise((resolve) => setTimeout(resolve, 100));
    await waitForPlay(1);
    if (globalThis.__isPreparationShellMounted()) throw new Error('состояние подготовки осталось после Player.play');
    if (globalThis.__isPreparationOverlayMounted()) throw new Error('индикатор подготовки остался после Player.ready');
    if (!globalThis.__isPlayerShellMounted()) throw new Error('нативный Player не остался открыт после handoff');
    if (globalThis.__playerShellDetachCount()) throw new Error('handoff отсоединил Player DOM и создал чёрный визуальный разрыв');
});

runner.test('Back во время probe отменяет запуск и поздний ответ не открывает media', async () => {
    globalThis.__clearStorage();
    globalThis.__resetPlaybackMock();
    globalThis.__setProbeBehavior(80, false);

    startDownload(candidate(), target());
    await flushMicrotasks();
    globalThis.__invokeControllerBack();
    if (globalThis.__isPreparationShellMounted()) throw new Error('оболочка подготовки не закрылась по Back');

    await new Promise((resolve) => setTimeout(resolve, 100));
    if (globalThis.__playerPlays.length) throw new Error('поздний probe запустил Player после отмены');
});

runner.test('временный сбой probe повторяется внутри открытой оболочки Player', async () => {
    globalThis.__clearStorage();
    globalThis.__resetPlaybackMock();
    globalThis.__setProbeBehavior(0, 1);

    startDownload(candidate(), target());
    await new Promise((resolve) => setTimeout(resolve, 1300));
    await waitForPlay(1);
    if (globalThis.__isPreparationShellMounted()) throw new Error('оболочка не передана Player после успешного retry');
});

runner.test('GST preflight строит единственный GST URL и передаёт все voiceovers', async () => {
    globalThis.__clearStorage();
    globalThis.__resetPlaybackMock();
    const nativeStream = Lampa.Torserver.stream;
    // A global Lampa `torrserver_gts` setting makes this method return a GST master URL. The
    // plugin must not call it for cache preload, otherwise it creates an audio=0 GST task before
    // the probe chooses the actual track.
    Lampa.Torserver.stream = () => { throw new Error('cache preload must not call Torserver.stream'); };
    try {
        startDownload(candidate(), target());
        await waitForPlay(1);
    } finally {
        Lampa.Torserver.stream = nativeStream;
    }

    const data = globalThis.__playerPlays[0];
    if (!data.url.includes('/gst/mock-torrent-hash/master.m3u8?index=1&audio=3')) throw new Error('неверный GST URL: ' + data.url);
    if (data.url_reserve) throw new Error('GST-only путь не должен передавать url_reserve');
    if (!data.voiceovers || data.voiceovers.length !== 2) throw new Error('ожидал две audio-дорожки: ' + JSON.stringify(data.voiceovers));
    if (!data.voiceovers[0].selected || data.voiceovers[1].selected) throw new Error('первая дорожка должна быть выбрана без preference');
});

runner.test('ручная смена дорожки рестартует GST с позицией и сохраняет preference только после canplay', async () => {
    globalThis.__clearStorage();
    globalThis.__resetPlaybackMock();
    startDownload(candidate(), target());
    await waitForPlay(1);

    globalThis.__setMockPlayerTime(123.8);
    globalThis.__playerPlays[0].voiceovers[1].onSelect();
    await waitForPlay(2);
    const restarted = globalThis.__playerPlays[1];
    if (!restarted.url.includes('&audio=5&seconds=123')) throw new Error('переключение не сохранило audio/position: ' + restarted.url);
    if (Lampa.Storage.get('torrent_mod_audio_preference')) throw new Error('preference сохранён до canplay');

    globalThis.__emitPlayerVideo('canplay');
    const stored = Lampa.Storage.get('torrent_mod_audio_preference');
    if (!stored || !stored['42:2'] || stored['42:2'].titleNormalized !== 'original') throw new Error('preference не сохранён после canplay: ' + JSON.stringify(stored));
});

await runner.run();
