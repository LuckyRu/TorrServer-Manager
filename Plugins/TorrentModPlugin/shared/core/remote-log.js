// Plugin and Lampa player logs, sent to the Plugin Hub: on a TV there is no devtools to read them
// (docs/how-to/diagnose-a-tv-client.md). No imports on purpose: log.js depends on this module, and
// the core must load without a DOM, so the hub address and version come in through startRemoteLog.

var MAX_BUFFER = 400;
var MAX_TEXT = 1500;
// sendBeacon refuses bodies over 64 KB, and a refused beacon is a silently lost batch.
var MAX_BODY = 48 * 1024;
var FLUSH_MS = 5000;
var URGENT_FLUSH_MS = 1000;
var LAMPA_CATEGORIES = ['Player', 'WebOS', 'Errors', 'Warnings', 'Ad'];

var state = null;

function now() { return Date.now(); }

function truncate(text) {
    text = String(text);
    return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '…' : text;
}

function describe(value) {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.name + ': ' + value.message;
    try { return JSON.stringify(value); } catch (e) { return String(value); }
}

// Lampa's console store keeps its messages HTML-escaped.
function unescapeHtml(text) {
    return String(text).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function push(entry) {
    state.buffer.push(entry);
    var overflow = state.buffer.length - MAX_BUFFER;
    if (overflow > 0) state.buffer.splice(0, overflow);
}

function collectLampaConsole() {
    var exported;
    try { exported = window.Lampa && Lampa.Console && Lampa.Console.export ? Lampa.Console.export() : null; } catch (e) { return; }
    if (!exported || typeof exported !== 'object') return;
    LAMPA_CATEGORIES.forEach(function (category) {
        var entries = exported[category];
        if (!Array.isArray(entries)) return;
        var since = state.cursor[category] || state.startedAt;
        var newest = since;
        var fresh = entries.filter(function (entry) { return entry && Number(entry.time) > since; });
        fresh.sort(function (a, b) { return a.time - b.time; });
        fresh.forEach(function (entry) {
            var parts = Array.isArray(entry.message) ? entry.message.slice() : [entry.message];
            if (parts.length > 1 && parts[0] === category) parts.shift();
            newest = Math.max(newest, Number(entry.time));
            push({
                t: Number(entry.time),
                l: category === 'Errors' ? 'error' : category === 'Warnings' ? 'warn' : 'info',
                s: 'lampa:' + category,
                m: truncate(unescapeHtml(parts.map(describe).join(' ')))
            });
        });
        state.cursor[category] = newest;
    });
}

function header() {
    var result = { client: '', version: state.version, platform: '' };
    try { result.client = state.client ? String(state.client() || '') : ''; } catch (e) {}
    try {
        var platform = window.Lampa && Lampa.Platform;
        if (platform && platform.get) result.platform = String(platform.get() || '');
    } catch (e) {}
    if (!state.sentMeta) {
        try { result.ua = String(navigator.userAgent || ''); } catch (e) {}
        try { result.page = String(window.location && window.location.href || '').split('?')[0]; } catch (e) {}
        try { if (window.Lampa && Lampa.Manifest) result.lampa = String(Lampa.Manifest.app_version || ''); } catch (e) {}
    }
    return result;
}

function defaultSend(url, body) {
    try {
        if (typeof navigator !== 'undefined' && navigator.sendBeacon && navigator.sendBeacon(url, body)) return true;
    } catch (e) {}
    try {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', url, true);
        xhr.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
        xhr.send(body);
        return true;
    } catch (e) { return false; }
}

// One batch per call, under MAX_BODY; whatever does not fit waits for the next flush.
export function flushRemoteLog() {
    if (!state) return;
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    if (!state.hubBase || !state.isEnabled()) { state.buffer.length = 0; return; }
    collectLampaConsole();
    if (!state.buffer.length) return;

    var payload = header();
    payload.entries = [];
    var size = JSON.stringify(payload).length;
    while (state.buffer.length) {
        var entrySize = JSON.stringify(state.buffer[0]).length + 1;
        if (payload.entries.length && size + entrySize > MAX_BODY) break;
        payload.entries.push(state.buffer.shift());
        size += entrySize;
    }
    if (state.send(state.hubBase + '/api/client-log', JSON.stringify(payload))) state.sentMeta = true;
    if (state.buffer.length) schedule(FLUSH_MS);
}

function schedule(delay) {
    if (!state || state.timer) return;
    state.timer = setTimeout(flushRemoteLog, delay);
}

export function recordRemote(level, scope, message, data) {
    if (!state) return;
    var text = describe(message);
    if (data !== undefined) text += ' ' + describe(data);
    push({ t: now(), l: level, s: String(scope || ''), m: truncate(text) });
    schedule(level === 'warn' || level === 'error' ? URGENT_FLUSH_MS : FLUSH_MS);
}

// options: hubBase, version, client(), isEnabled(); send(url, body) only for tests.
export function startRemoteLog(options) {
    options = options || {};
    if (state) return;
    state = {
        hubBase: String(options.hubBase || ''),
        version: String(options.version || ''),
        client: options.client || null,
        isEnabled: options.isEnabled || function () { return true; },
        send: options.send || defaultSend,
        buffer: [],
        cursor: {},
        startedAt: now(),
        sentMeta: false,
        timer: null,
        interval: null
    };
    // Lampa's own player log arrives without us being told, so it has to be polled.
    state.interval = setInterval(function () { collectLampaConsole(); if (state.buffer.length) schedule(0); }, FLUSH_MS);
    try {
        window.addEventListener('pagehide', flushRemoteLog);
        document.addEventListener('visibilitychange', onVisibilityChange);
    } catch (e) {}
}

function onVisibilityChange() {
    if (document.visibilityState === 'hidden') flushRemoteLog();
}

export function stopRemoteLog() {
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    if (state.interval) clearInterval(state.interval);
    try {
        window.removeEventListener('pagehide', flushRemoteLog);
        document.removeEventListener('visibilitychange', onVisibilityChange);
    } catch (e) {}
    state = null;
}
