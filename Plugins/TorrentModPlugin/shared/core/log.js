    var PREFIX = 'Torrent Mod';

    export function debugEnabled() {
        if (typeof window === 'undefined') return false;
        if (!window.TorrentModDiagnostics) window.TorrentModDiagnostics = { verbose: false };
        return window.TorrentModDiagnostics.verbose === true;
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
        log(scope, message, data);
    }
