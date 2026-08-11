export function setupMockLampa() {
    const storage = new Map();
    const playerListeners = new Map();
    const videoListeners = new Map();
    const controllers = new Map();
    let playerCurrentTime = 0;
    let currentController = 'content';
    let preparationShellMounted = false;
    let preparationOverlayMounted = false;
    let preparationStatus = '';
    let playerShellDetachCount = 0;
    let playerShellMounted = false;
    let probeDelay = 0;
    let probeFailuresRemaining = 0;

    function listenerApi(listeners) {
        return {
            follow: (event, callback) => {
                const callbacks = listeners.get(event) || [];
                callbacks.push(callback);
                listeners.set(event, callbacks);
            },
            remove: (event, callback) => {
                const callbacks = listeners.get(event) || [];
                listeners.set(event, callbacks.filter((item) => item !== callback));
            }
        };
    }
    function emit(listeners, event, payload) {
        (listeners.get(event) || []).slice().forEach((callback) => callback(payload));
    }

    globalThis.__playerPlays = [];
    globalThis.__resetPlaybackMock = () => {
        globalThis.__playerPlays.length = 0;
        playerListeners.clear();
        videoListeners.clear();
        playerCurrentTime = 0;
        currentController = 'content';
        preparationShellMounted = false;
        preparationOverlayMounted = false;
        preparationStatus = '';
        playerShellDetachCount = 0;
        playerShellMounted = false;
        probeDelay = 0;
        probeFailuresRemaining = 0;
    };
    globalThis.__setMockPlayerTime = (seconds) => { playerCurrentTime = seconds; };
    globalThis.__emitPlayerVideo = (event, payload) => emit(videoListeners, event, payload);
    globalThis.__isPreparationShellMounted = () => preparationShellMounted;
    globalThis.__isPreparationOverlayMounted = () => preparationOverlayMounted;
    globalThis.__preparationStatus = () => preparationStatus;
    globalThis.__playerShellDetachCount = () => playerShellDetachCount;
    globalThis.__isPlayerShellMounted = () => playerShellMounted;
    globalThis.__setProbeBehavior = (delay, failures) => {
        probeDelay = delay || 0;
        probeFailuresRemaining = failures === true ? Number.MAX_SAFE_INTEGER : (Number(failures) || 0);
    };
    globalThis.__invokeControllerBack = () => {
        const controller = controllers.get(currentController);
        if (controller && controller.back) controller.back();
    };

    globalThis.window = globalThis;
    globalThis.document = { currentScript: { src: 'http://192.168.10.108:8095/plugins/torrent-mod.js' } };
    globalThis.Navigator = { move: () => {}, canmove: () => true };

    // Minimal jQuery: only what non-UI modules touch (smart-preload calls $('body') etc.).
    function jqueryNode() { return {
        find: () => globalThis.$(),
        after: () => globalThis.$(),
        attr: () => globalThis.$(),
        on: () => globalThis.$(),
        append: () => globalThis.$(),
        remove: () => globalThis.$(),
        removeClass: () => globalThis.$(),
        detach: () => globalThis.$(),
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
    }; }
    const preparationTitle = jqueryNode();
    preparationTitle.text = (value) => { if (value !== undefined) preparationStatus = String(value); return preparationTitle; };
    const preparationOverlay = jqueryNode();
    preparationOverlay.remove = () => { preparationOverlayMounted = false; return preparationOverlay; };
    preparationOverlay.find = (selector) => selector === '.torrent-mod-player-preparing__title' ? preparationTitle : jqueryNode();
    const playerShell = jqueryNode();
    playerShell.addClass = (names) => {
        if (String(names).includes('torrent-mod-player-preparing')) preparationShellMounted = true;
        return playerShell;
    };
    playerShell.removeClass = (names) => {
        if (String(names).includes('torrent-mod-player-preparing')) preparationShellMounted = false;
        return playerShell;
    };
    playerShell.detach = () => {
        playerShellDetachCount++;
        preparationShellMounted = false;
        preparationOverlayMounted = false;
        playerShellMounted = false;
        return playerShell;
    };
    playerShell.append = (node) => {
        if (node === preparationOverlay) preparationOverlayMounted = true;
        return playerShell;
    };
    playerShell.find = (selector) => selector === '.torrent-mod-player-preparing__title' ? preparationTitle : jqueryNode();
    const bodyNode = jqueryNode();
    bodyNode.append = (node) => {
        if (node === playerShell) playerShellMounted = true;
        return bodyNode;
    };
    globalThis.$ = (selector) => {
        if (selector === 'body') return bodyNode;
        if (typeof selector === 'string' && selector.includes('torrent-mod-player-preparing__overlay')) return preparationOverlay;
        return jqueryNode();
    };
    globalThis.$.ajax = (opts) => {
        const req = {
            done(fn) { this._done = fn; return this; },
            fail(fn) { this._fail = fn; return this; },
            always(fn) { this._always = fn; return this; },
            abort() { this._aborted = true; if (this._always) this._always(); }
        };
        const isProbe = opts.url && opts.url.includes('/gst/') && opts.url.includes('/probe');
        setTimeout(() => {
            if (req._aborted) return;
            if (isProbe && probeFailuresRemaining > 0) {
                probeFailuresRemaining--;
                if (req._fail) req._fail({ responseText: 'probe failed' }, 'error', 'mock probe failure');
                if (req._always) req._always();
                return;
            }
            if (!req._done) { if (req._always) req._always(); return; }
            let body = {};
            try { body = typeof opts.data === 'string' ? JSON.parse(opts.data) : (opts.data || {}); } catch {}
            if (opts.url && opts.url.includes('/gst/echo')) req._done('ok');
            else if (opts.url && opts.url.includes('/gst/') && opts.url.includes('/probe')) req._done({
                Tracks: [
                    { Type: 'video', Index: 0, Codec: 'video/x-h264' },
                    { Type: 'audio', Index: 3, Language: 'ru', Title: 'Студия А', Codec: 'audio/mpeg', Channels: 2 },
                    { Type: 'audio', Index: 5, Language: 'en', Title: 'Original', Codec: 'audio/ac3', Channels: 6 }
                ]
            });
            else if (opts.url && opts.url.includes('/gst/') && opts.url.includes('master.m3u8')) req._done('#EXTM3U\n');
            else if (body.action === 'add' || body.action === 'get') req._done({ hash: 'mock-torrent-hash', file_stats: [] });
            else if (body.action === 'list') req._done([]);
            else req._done({});
            if (req._always) req._always();
        }, isProbe ? probeDelay : 0);
        return req;
    };

    const reguestHandlers = [];
    globalThis.__requestLog = [];
    globalThis.__mockReguest = (match, data, delay) => reguestHandlers.push({ match, data, delay: delay || 0 });
    globalThis.__clearReguest = () => reguestHandlers.splice(0);

    var jobCounter = 0;
    var jobs = new Map();
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
        Timeline: {
            watchedEpisode: () => null,
            view: () => ({ hash: 'mock', percent: 0, time: 0, duration: 0, handler: () => {} }),
            update: () => {}
        },
        Torserver: {
            ip: () => 'http://127.0.0.1:8090',
            hash: (object, cb, fail) => cb({ hash: 'mock-torrent-hash' }),
            files: (hash, cb, fail) => cb({ file_stats: [{ id: 1, path: 'video.mp4', length: 1000000, path_human: 'video.mp4' }] }),
            stream: (path, hash, id) => 'http://127.0.0.1:8090/stream/x?link=' + hash + '&index=' + id,
            parse: (data) => ({ hash: 'mock-timeline-hash' }),
            clearFileName: (files) => files
        },
        Favorite: { add: () => {} },
        Player: {
            play: (data) => {
                playerShellMounted = true;
                globalThis.__playerPlays.push(data);
                emit(playerListeners, 'ready', data);
            },
            close: () => { playerShellMounted = false; emit(playerListeners, 'destroy'); },
            render: () => playerShell,
            playlist: () => {}, callback: () => {}, listener: listenerApi(playerListeners)
        },
        PlayerVideo: { video: () => ({ currentTime: playerCurrentTime }), listener: listenerApi(videoListeners) },
        Utils: {
            bytesToSize: (bytes) => Math.round(bytes / 1048576) + ' MB',
            secondsToTimeHuman: (sec) => '00:' + String(Math.floor(sec % 60)).padStart(2, '0')
        },
        Noty: { show: () => {} },
        Reguest: function () {
            this.timeout = () => this;
            this.native = (url, cb, err) => {
                globalThis.__requestLog.push(url);
                const respond = (fn, delay) => { if (delay) setTimeout(fn, delay); else Promise.resolve().then(fn); };
                if (url.includes('/api/torrent-search/start')) {
                    const handler = reguestHandlers.find((h) => h.match(url));
                    respond(() => {
                        if (!handler || handler.data === null) { if (err) err(); return; }
                        const jobId = 'job' + (++jobCounter);
                        jobs.set(jobId, handler);
                        const configuredIndexers = (handler.data.indexers && handler.data.indexers.length)
                            ? handler.data.indexers.map((ix) => ({ id: ix.id, name: ix.name }))
                            : [{ id: 'mock', name: 'mock' }];
                        cb({ jobId: jobId, totalIndexers: configuredIndexers.length, indexers: configuredIndexers });
                    }, 0);
                    return;
                }
                if (url.includes('/api/torrent-search/poll')) {
                    const jobId = (url.split('jobId=')[1] || '').split('&')[0];
                    const handler = jobs.get(jobId);
                    jobs.delete(jobId); // one-shot: this mock always answers "done" on the first poll
                    respond(() => {
                        if (!handler) { cb(null); return; }
                        const rawResults = handler.data.results || [];
                        const indexers = (handler.data.indexers && handler.data.indexers.length)
                            ? handler.data.indexers.map((ix) => Object.assign({ results: rawResults }, ix))
                            : [{ id: 'mock', name: 'mock', ok: true, error: null, elapsedMs: handler.delay || 0, results: rawResults }];
                        cb({ done: true, indexers: indexers });
                    }, handler ? handler.delay : 0);
                    return;
                }
                if (url.includes('/api/torrent-search/cancel')) {
                    respond(() => cb({ ok: true }), 0);
                    return;
                }
                const handler = reguestHandlers.find((h) => h.match(url));
                const data = handler ? handler.data : null;
                const delay = handler ? handler.delay : 0;
                respond(() => { if (data) cb(data); else if (err) err(); }, delay);
            };
        },
        Activity: { push: () => {}, backward: () => {}, back: () => {}, all: () => [], call: () => {} },
        Torrent: { start: () => {} },
        Controller: {
            add: (name, controller) => controllers.set(name, controller),
            toggle: (name) => { currentController = name; }, collectionSet: () => {}, collectionFocus: () => {},
            enabled: () => ({ name: currentController }), move: () => {}, back: () => {}
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

setupMockLampa();
