import './helpers/mock-lampa.mjs';
import { createRunner } from './helpers/test-runner.mjs';
import { describeEnvironment } from '../shared/device-environment.js';
import { startRemoteLog, stopRemoteLog, recordRemote, flushRemoteLog } from '../shared/core/remote-log.js';

const runner = createRunner();

// An LG TV as Lampa sees it: webOS platform, Chromium 87, native HLS, HEVC through MSE only.
function withTv(run) {
    const saved = {
        platform: Lampa.Platform, field: Lampa.Storage.field, createElement: document.createElement,
        palm: globalThis.PalmSystem, mse: globalThis.MediaSource, hls: globalThis.Hls
    };
    const settings = {
        player_torrent: 'inner', player_hls_method: 'native', torrserver_gts: true,
        torrent_mod_remote_log: true, torrserver_password: 'secret', account_email: 'me@example.com'
    };
    Lampa.Platform = {
        get: () => 'webos', chromeVersion: () => 87, tv: () => true, widgetVersion: () => '1.2.0',
        version: (name) => (name === 'app' ? '3.3.4' : '')
    };
    Lampa.Storage.field = (name) => settings[name];
    globalThis.PalmSystem = { deviceInfo: JSON.stringify({ modelName: 'OLED55C1', platformVersion: '6.3.1', serialNumber: 'SN123' }) };
    document.createElement = () => ({
        canPlayType: (type) => (type === 'application/vnd.apple.mpegurl' || type.includes('avc1') ? 'maybe' : '')
    });
    globalThis.MediaSource = { isTypeSupported: (type) => type.includes('avc1') || type.includes('hvc1.2.4.L120') || type.includes('mp4a') };
    globalThis.Hls = { version: '1.4.7', isSupported: () => true };
    try { return run(); } finally {
        Lampa.Platform = saved.platform;
        Lampa.Storage.field = saved.field;
        document.createElement = saved.createElement;
        globalThis.PalmSystem = saved.palm;
        globalThis.MediaSource = saved.mse;
        globalThis.Hls = saved.hls;
    }
}

runner.test('окружение телевизора: платформа, модель, Chromium, способы HLS и кодеки', () => withTv(() => {
    const env = describeEnvironment();
    const expect = {
        platform: 'webos', chrome: '87', tv: 'true', widget: '1.2.0', lampa: '3.3.4',
        'webos.modelName': 'OLED55C1', 'webos.platformVersion': '6.3.1',
        hlsNative: 'maybe', hlsjs: '1.4.7',
        'set.player_torrent': 'inner', 'set.player_hls_method': 'native', 'set.torrserver_gts': 'true'
    };
    for (const [key, value] of Object.entries(expect)) {
        if (env[key] !== value) throw new Error(key + ' = ' + JSON.stringify(env[key]) + ', ожидалось ' + value);
    }
    if (!env.codecs.startsWith('h264:mn hevc10:m hevc10-4k:- ')) throw new Error('строка кодеков: ' + env.codecs);
    if (!env.codecs.includes('aac:m')) throw new Error('AAC через MSE не отмечен: ' + env.codecs);
}));

// В хранилище Lampa лежат учётные записи и пароли TorrServer: в журнал попадает только перечисленное.
runner.test('в окружение не попадает ничего вне белых списков', () => withTv(() => {
    const text = JSON.stringify(describeEnvironment());
    for (const secret of ['secret', 'me@example.com', 'SN123', 'serialNumber', 'password', 'account'])
        if (text.includes(secret)) throw new Error('в окружение утекло: ' + secret);
}));

runner.test('окружение уходит в первой пачке и снова только когда изменилось', () => {
    let current = { platform: 'webos', 'set.player_hls_method': 'native' };
    const sent = [];
    stopRemoteLog();
    startRemoteLog({ hubBase: 'http://hub:8095', version: 'x', environment: () => current, send: (url, body) => { sent.push(JSON.parse(body)); return true; } });
    try {
        recordRemote('info', 'boot', 'первая');
        flushRemoteLog();
        recordRemote('info', 'boot', 'вторая');
        flushRemoteLog();
        current = { platform: 'webos', 'set.player_hls_method': 'hlsjs' };
        recordRemote('info', 'boot', 'третья');
        flushRemoteLog();

        if (!sent[0].env || sent[0].env['set.player_hls_method'] !== 'native') throw new Error('окружение не ушло в первой пачке');
        if ('env' in sent[1]) throw new Error('неизменное окружение повторено');
        if (!sent[2].env || sent[2].env['set.player_hls_method'] !== 'hlsjs') throw new Error('изменённое окружение не отправлено');
        if (!sent.every((batch) => batch.sentAt > 0)) throw new Error('пачке не хватает времени отправки для расчёта сдвига часов');
    } finally { stopRemoteLog(); }
});

await runner.run();
