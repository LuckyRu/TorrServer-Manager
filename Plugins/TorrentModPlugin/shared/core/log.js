    var PREFIX = 'Torrent Mod';

    export function diagnosticsState() {
        if (typeof window === 'undefined') return null;
        var diagnostics = window.TorrentModDiagnostics;
        if (!diagnostics || typeof diagnostics !== 'object') diagnostics = {};
        if (!Array.isArray(diagnostics.entries)) diagnostics.entries = [];
        if (typeof diagnostics.verbose !== 'boolean') diagnostics.verbose = false;
        if (typeof diagnostics.consoleOutput !== 'boolean') diagnostics.consoleOutput = false;
        if (!isFinite(diagnostics.maxEntries) || diagnostics.maxEntries < 1) diagnostics.maxEntries = 500;
        // Замыкания ставятся один раз: debugEnabled() зовётся на каждую сырую раздачу, и
        // пересоздание их здесь означало две аллокации на запись выдачи.
        if (typeof diagnostics.clear !== 'function') {
            diagnostics.clear = function () { diagnostics.entries.length = 0; };
        }
        if (typeof diagnostics.snapshot !== 'function') {
            diagnostics.snapshot = function () { return diagnostics.entries.slice(); };
        }
        window.TorrentModDiagnostics = diagnostics;
        return diagnostics;
    }

    function recordDebug(scope, message, data) {
        var diagnostics = diagnosticsState();
        if (!diagnostics) return;
        diagnostics.entries.push({ at: Date.now(), scope: scope, message: message, data: data });
        var overflow = diagnostics.entries.length - diagnostics.maxEntries;
        if (overflow > 0) diagnostics.entries.splice(0, overflow);
    }

    // Настройка «Отладка поиска» не была подключена ни к чему: единственным способом включить
    // подробный лог оставался devtools, недоступный на телевизоре — то есть там, где продукт и
    // живёт. Читаем настройку при старте, дальше флагом можно управлять и из консоли.
    export function applyDebugSetting(value) {
        var diagnostics = diagnosticsState();
        if (diagnostics) diagnostics.verbose = value === true;
    }

    export function debugEnabled() {
        var diagnostics = diagnosticsState();
        return !!diagnostics && diagnostics.verbose === true;
    }

    export function log(scope, message, data) {
        var line = PREFIX + ' [' + scope + ']: ' + message;
        if (data !== undefined) console.log(line, data);
        else console.log(line);
    }

    export function warn(scope, message, data) {
        var line = PREFIX + ' [' + scope + ']: ' + message;
        if (data !== undefined) console.warn(line, data);
        else console.warn(line);
    }

    export function debug(scope, message, data) {
        if (!debugEnabled()) return;
        recordDebug(scope, message, data);
        if (window.TorrentModDiagnostics.consoleOutput === true) log(scope, message, data);
    }

    export function diagnosticsSnapshot() {
        var diagnostics = diagnosticsState();
        return diagnostics ? diagnostics.snapshot() : [];
    }
