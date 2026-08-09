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
