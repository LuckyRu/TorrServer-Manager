// What the device is and how Lampa is set up on it, for the log sent to the PC. On the TV the same
// code takes other branches (native HLS below Chromium 121, webOS track module), so without this a
// log line cannot be read (docs/how-to/diagnose-a-tv-client.md). Setting names are whitelisted:
// Lampa storage also holds accounts and passwords.

var LAMPA_SETTINGS = [
    'player', 'player_torrent', 'player_hls_method', 'player_normalization', 'player_scale_method',
    'player_timecode', 'torrserver_gts', 'torrserver_preload', 'torrserver_use_link',
    'torrserver_tracktimecode', 'video_quality_default', 'subtitles_start', 'language'
];
var PLUGIN_SETTINGS = [
    'torrent_mod_enabled', 'torrent_mod_preload_next', 'torrent_mod_remote_log', 'torrent_mod_debug',
    'torrent_mod_perf_diagnostics', 'torrent_mod_query_russian'
];
var WEBOS_FIELDS = [
    'modelName', 'platformVersion', 'sdkVersion', 'version', 'screenWidth', 'screenHeight',
    'uhd', 'uhd8K', 'oled', 'hdr10', 'dolbyVision', 'dolbyAtmos'
];
var CODECS = [
    ['h264', 'video/mp4; codecs="avc1.640028"'],
    ['hevc10', 'video/mp4; codecs="hvc1.2.4.L120.90"'],
    ['hevc10-4k', 'video/mp4; codecs="hvc1.2.4.L153.90"'],
    ['dv', 'video/mp4; codecs="dvh1.08.06"'],
    ['av1', 'video/mp4; codecs="av01.0.08M.10"'],
    ['vp9', 'video/mp4; codecs="vp09.02.10.10"'],
    ['aac', 'audio/mp4; codecs="mp4a.40.2"'],
    ['ac3', 'audio/mp4; codecs="ac-3"'],
    ['eac3', 'audio/mp4; codecs="ec-3"']
];

function attempt(read) {
    try {
        var value = read();
        return value === undefined || value === null ? '' : String(value);
    } catch (e) { return 'ERR'; }
}

function platform(result) {
    var P = window.Lampa && Lampa.Platform;
    if (!P) return;
    result.platform = attempt(function () { return P.get(); });
    result.chrome = attempt(function () { return P.chromeVersion(); });
    result.tv = attempt(function () { return P.tv(); });
    result.widget = attempt(function () { return P.widgetVersion(); });
    result.lampa = attempt(function () { return P.version('app'); });
}

function webos(result) {
    var raw = attempt(function () { return window.PalmSystem && PalmSystem.deviceInfo; });
    if (!raw || raw === 'ERR') return;
    var info;
    try { info = JSON.parse(raw); } catch (e) { return; }
    WEBOS_FIELDS.forEach(function (key) {
        if (info[key] !== undefined) result['webos.' + key] = String(info[key]);
    });
}

function settings(result, names) {
    names.forEach(function (name) {
        result['set.' + name] = attempt(function () { return Lampa.Storage.field(name); });
    });
}

// "m" — Media Source (hls.js), "n" — the element itself (native HLS); "-" — neither.
function codecs(result) {
    var video = null;
    try { video = document.createElement('video'); } catch (e) {}
    var mse = typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported ? MediaSource : null;
    result.codecs = CODECS.map(function (codec) {
        var viaMse = attempt(function () { return mse && mse.isTypeSupported(codec[1]); }) === 'true';
        var native = attempt(function () { return video && video.canPlayType(codec[1]); });
        var flags = (viaMse ? 'm' : '') + (native && native !== 'ERR' ? 'n' : '');
        return codec[0] + ':' + (flags || '-');
    }).join(' ');
    result.hlsNative = attempt(function () { return video && video.canPlayType('application/vnd.apple.mpegurl'); });
    result.hlsjs = attempt(function () { return window.Hls ? Hls.version + (Hls.isSupported() ? '' : ' (unsupported)') : 'none'; });
    result.audioTracksApi = attempt(function () { return typeof HTMLMediaElement !== 'undefined' && 'audioTracks' in HTMLMediaElement.prototype; });
}

function device(result) {
    result.screen = attempt(function () { return screen.width + 'x' + screen.height + '@' + (window.devicePixelRatio || 1); });
    result.viewport = attempt(function () { return window.innerWidth + 'x' + window.innerHeight; });
    result.locale = attempt(function () { return navigator.language; });
    result.timezone = attempt(function () { return Intl.DateTimeFormat().resolvedOptions().timeZone; });
    result.cpus = attempt(function () { return navigator.hardwareConcurrency; });
    result.memoryGb = attempt(function () { return navigator.deviceMemory; });
}

export function describeEnvironment() {
    var result = {};
    platform(result);
    webos(result);
    device(result);
    codecs(result);
    result.torrserver = attempt(function () { return Lampa.Torserver.ip(); });
    settings(result, LAMPA_SETTINGS);
    settings(result, PLUGIN_SETTINGS);
    return result;
}
