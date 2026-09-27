import './helpers/mock-lampa.mjs';
import { createRunner } from './helpers/test-runner.mjs';
import { startRemoteLog, stopRemoteLog, recordRemote, flushRemoteLog } from '../shared/core/remote-log.js';
import { VERSION } from '../shared/state.js';

const runner = createRunner();

function capture() {
    const sent = [];
    return { sent, send: (url, body) => { sent.push({ url, body: JSON.parse(body), size: body.length }); return true; } };
}

function start(options) {
    stopRemoteLog();
    const transport = capture();
    startRemoteLog(Object.assign({ hubBase: 'http://hub:8095', version: VERSION, client: () => 'c-tv', send: transport.send }, options || {}));
    return transport;
}

runner.test('запись плагина уходит на хаб с клиентом и версией, метаданные устройства только в первом батче', () => {
    const transport = start();
    try {
        recordRemote('info', 'playback', 'switchAudioTrack: 0 → 5', { session: 3 });
        flushRemoteLog();
        recordRemote('warn', 'playback', 'второй');
        flushRemoteLog();

        if (transport.sent.length !== 2) throw new Error('ожидалось два батча, ушло ' + transport.sent.length);
        const [first, second] = transport.sent;
        if (first.url !== 'http://hub:8095/api/client-log') throw new Error('не тот адрес: ' + first.url);
        if (first.body.client !== 'c-tv' || first.body.version !== VERSION) throw new Error('нет клиента или версии: ' + JSON.stringify(first.body));
        const entry = first.body.entries[0];
        if (entry.l !== 'info' || entry.s !== 'playback' || entry.m !== 'switchAudioTrack: 0 → 5 {"session":3}') throw new Error('запись искажена: ' + JSON.stringify(entry));
        if (!('page' in first.body)) throw new Error('первый батч без сведений об устройстве');
        if ('page' in second.body) throw new Error('сведения об устройстве повторяются в каждом батче');
    } finally { stopRemoteLog(); }
});

runner.test('из журнала Lampa берутся только категории плеера и только записи после старта', () => {
    const store = { Player: [{ time: 1, message: ['Player', 'старое'] }], Other: [], Script: [] };
    Lampa.Console = { export: () => store };
    const transport = start();
    try {
        const t = Date.now() + 10;
        store.Player.push({ time: t + 1, message: ['Player', 'play url', 'http://tv/gst/h/master.m3u8?index=1&amp;audio=5'] });
        store.Player.push({ time: t, message: ['Player', 'start play'] });
        store.Other.push({ time: t, message: ['Torrent Mod [playback]: чужая категория'] });
        store.Script.push({ time: t, message: ['Script', 'не наше'] });
        flushRemoteLog();

        const entries = transport.sent[0].body.entries;
        const texts = entries.map((e) => e.s + ' ' + e.m);
        if (texts.join('|') !== 'lampa:Player start play|lampa:Player play url http://tv/gst/h/master.m3u8?index=1&audio=5')
            throw new Error('не те записи Lampa: ' + JSON.stringify(texts));

        store.Player.push({ time: t + 2, message: ['Player', 'video full loaded'] });
        flushRemoteLog();
        const again = transport.sent[1].body.entries.map((e) => e.m);
        if (again.join('|') !== 'video full loaded') throw new Error('записи Lampa ушли повторно: ' + JSON.stringify(again));
    } finally { stopRemoteLog(); delete Lampa.Console; }
});

// sendBeacon отказывает телам больше 64 КБ, а отказ — это потерянный батч без единой ошибки.
runner.test('большой журнал уходит частями, каждая меньше лимита beacon, без потерь и в порядке', () => {
    const transport = start();
    try {
        for (let i = 0; i < 300; i++) recordRemote('info', 'search', i + ' ' + 'x'.repeat(1300));
        for (let i = 0; i < 20 && (transport.sent.length === 0 || transport.sent[transport.sent.length - 1].body.entries.length); i++) flushRemoteLog();

        if (transport.sent.some((batch) => batch.size > 64 * 1024)) throw new Error('батч больше лимита beacon');
        const numbers = transport.sent.flatMap((batch) => batch.body.entries.map((e) => Number(e.m.split(' ')[0])));
        if (numbers.length !== 300) throw new Error('доставлено ' + numbers.length + ' из 300');
        if (numbers.some((n, i) => n !== i)) throw new Error('порядок записей нарушен');
    } finally { stopRemoteLog(); }
});

runner.test('длинная запись обрезается, а не раздувает батч', () => {
    const transport = start();
    try {
        recordRemote('warn', 'playback', 'y'.repeat(5000));
        flushRemoteLog();
        const text = transport.sent[0].body.entries[0].m;
        if (text.length > 1501 || !text.endsWith('…')) throw new Error('запись не обрезана: ' + text.length);
    } finally { stopRemoteLog(); }
});

runner.test('выключенный журнал и плагин не с хаба ничего не отправляют и не копят', () => {
    let transport = start({ isEnabled: () => false });
    try {
        recordRemote('info', 'playback', 'не отправлять');
        flushRemoteLog();
        if (transport.sent.length) throw new Error('выключенный журнал отправил батч');
    } finally { stopRemoteLog(); }

    transport = start({ hubBase: '' });
    try {
        recordRemote('info', 'playback', 'некуда');
        flushRemoteLog();
        if (transport.sent.length) throw new Error('без адреса хаба журнал отправил батч');
    } finally { stopRemoteLog(); }
});

await runner.run();
