import './helpers/mock-lampa.mjs';
import { createRunner } from './helpers/test-runner.mjs';
import { traceMenuItem, traceNativeAudioTracks } from '../playback/audio-track-trace.js';
import { startRemoteLog, stopRemoteLog, flushRemoteLog } from '../shared/core/remote-log.js';

const runner = createRunner();

function captureLog() {
    const messages = [];
    stopRemoteLog();
    startRemoteLog({ hubBase: 'http://hub:8095', version: 't', send: (url, body) => { JSON.parse(body).entries.forEach((e) => messages.push(e)); return true; } });
    return messages;
}

runner.test('пункт нашего списка сообщает, что Lampa собрала из него меню и отметила его выбранным', () => {
    const messages = captureLog();
    try {
        const items = [0, 5].map((index) => traceMenuItem({ index, label: 'дорожка ' + index, onSelect: () => {} }));
        items.forEach((item, p) => { item.title = (p + 1) + ' / ru / ' + item.label; });
        items.forEach((item) => { item.enabled = false; });
        items[1].enabled = true;
        flushRemoteLog();

        const texts = messages.map((e) => e.m);
        if (texts.filter((m) => m.startsWith('меню дорожек Lampa собрано')).length !== 1) throw new Error('сборка меню не записана ровно один раз: ' + JSON.stringify(texts));
        if (!texts.includes('меню дорожек: Lampa отметила наш пункт 5 (дорожка 5)')) throw new Error('выбор не записан: ' + JSON.stringify(texts));
        if (items[1].title !== '2 / ru / дорожка 5' || items[1].enabled !== true) throw new Error('свойства пункта перестали работать');
        if (!JSON.stringify(items[1]).includes('"title":"2 / ru / дорожка 5"')) throw new Error('пункт не сериализуется как раньше');
    } finally { stopRemoteLog(); }
});

// Родную дорожку видео выключают присваиванием enabled; обёртка пишет, кто это сделал, и не мешает.
runner.test('присваивание enabled родной дорожке видео пишется со стеком и доходит до видео', () => {
    const saved = globalThis.AudioTrack;
    class FakeAudioTrack { constructor() { this.id = '1'; this.label = 'Дублированный'; this._on = true; } }
    Object.defineProperty(FakeAudioTrack.prototype, 'enabled', {
        configurable: true, enumerable: true,
        get() { return this._on; },
        set(value) { this._on = value; }
    });
    globalThis.AudioTrack = FakeAudioTrack;
    const messages = captureLog();
    try {
        traceNativeAudioTracks();
        const track = new FakeAudioTrack();
        (function lampaOnSelect() { track.enabled = false; })();
        flushRemoteLog();

        if (track.enabled !== false) throw new Error('значение не дошло до родного сеттера');
        const entry = messages.find((e) => e.m.startsWith('родная дорожка видео id=1 label=Дублированный: enabled = false'));
        if (!entry || entry.l !== 'warn') throw new Error('присваивание не записано: ' + JSON.stringify(messages));
        if (!entry.m.includes('lampaOnSelect')) throw new Error('в записи нет вызвавшей функции: ' + entry.m);
    } finally { stopRemoteLog(); globalThis.AudioTrack = saved; }
});

await runner.run();
