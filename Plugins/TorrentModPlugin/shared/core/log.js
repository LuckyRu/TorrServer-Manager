    // Unified lifecycle-log helper (see docs/system-design/torrent-mod-domain-architecture.md);
    // scope is a short module label ('domain', 'playback', ...) shown in every line for console filtering.
    var PREFIX = 'Torrent Mod';

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
