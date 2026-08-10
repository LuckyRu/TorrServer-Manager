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
