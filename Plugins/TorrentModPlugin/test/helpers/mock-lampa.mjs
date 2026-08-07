// ---------- browser-environment mocks for domain tests ----------
//
// The plugin sources are real browser ES modules (window/document/jQuery/Lampa globals). Node
// can't provide those, so this installs minimal stand-ins BEFORE any plugin module is imported.
// The point is NOT to emulate Lampa faithfully — it's to make the code actually runnable so that
// undefined-identifier bugs (like the buildSeasonItems ReferenceError that crashed the real
// screen) surface as test failures instead of at runtime on the TV.
export function setupMockLampa() {
    const storage = new Map();

    globalThis.window = globalThis;
    globalThis.document = { currentScript: { src: 'http://192.168.10.108:8095/plugins/torrent-mod.js' } };
    globalThis.Navigator = { move: () => {}, canmove: () => true };

    // Minimal jQuery: only what non-UI modules touch (smart-preload calls $('body') etc.).
    globalThis.$ = () => ({
        find: () => globalThis.$(),
        on: () => globalThis.$(),
        append: () => globalThis.$(),
        remove: () => globalThis.$(),
        text: () => globalThis.$(),
        css: () => globalThis.$(),
        addClass: () => globalThis.$(),
        toggleClass: () => globalThis.$(),
        empty: () => globalThis.$(),
        eq: () => globalThis.$(),
        trigger: () => globalThis.$(),
        html: () => globalThis.$(),
        length: 0,
        is: () => false
    });

    const reguestHandlers = [];
    globalThis.__requestLog = [];
    globalThis.__mockReguest = (match, data, delay) => reguestHandlers.push({ match, data, delay: delay || 0 });
    globalThis.__clearReguest = () => reguestHandlers.splice(0);
    // Lampa.Storage mock is shared across tests in one process — persisted prefs (e.g. last season)
    // would leak between tests via applyPersistedPreferences, so reset it per test.
    globalThis.__clearStorage = () => storage.clear();

    globalThis.Lampa = {
        Storage: {
            get: (key, fallback) => (storage.has(key) ? storage.get(key) : fallback),
            set: (key, value) => storage.set(key, value),
            // cache() only reads (and prunes) — our mock returns the stored object or `empty`
            cache: (key, max, empty) => (storage.has(key) ? storage.get(key) : empty),
            field: (name) => undefined // settings: no field set → code defaults apply
        },
        TMDB: { key: () => 'mock-key', api: (path) => 'https://api.tmdb.org/3/' + path },
        Timeline: { watchedEpisode: () => null, update: () => {} },
        Utils: {
            bytesToSize: (bytes) => Math.round(bytes / 1048576) + ' MB',
            secondsToTimeHuman: (sec) => '00:' + String(Math.floor(sec % 60)).padStart(2, '0')
        },
        Noty: { show: () => {} },
        Reguest: function () {
            this.timeout = () => this;
            this.native = (url, cb, err) => {
                globalThis.__requestLog.push(url);
                const handler = reguestHandlers.find((h) => h.match(url));
                const data = handler ? handler.data : null;
                const delay = handler ? handler.delay : 0;
                setTimeout(() => { if (data) cb(data); else if (err) err(); }, delay);
            };
        },
        Activity: { push: () => {}, backward: () => {}, back: () => {}, all: () => [], call: () => {} },
        Torrent: { start: () => {} },
        Controller: {
            add: () => {}, toggle: () => {}, collectionSet: () => {}, collectionFocus: () => {},
            enabled: () => ({ name: 'content' }), move: () => {}, back: () => {}
        },
        Component: { add: () => {} },
        Listener: { follow: () => {} },
        Template: { add: () => {} },
        SettingsApi: { addComponent: () => {}, addParam: () => {} }
    };

    return storage;
}

export async function flushMicrotasks() {
    await new Promise((resolve) => setTimeout(resolve, 10));
}

// Install the mocks as a module side effect: test files import this file FIRST, so the browser
// globals exist before any plugin module is imported (plugin modules read `document`/`Lampa`
// at top level, e.g. shared/state.js computing hubBase from document.currentScript.src).
setupMockLampa();
