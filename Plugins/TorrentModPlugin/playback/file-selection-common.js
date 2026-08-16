// ---------- playback file-selection primitives shared by the mode-specific selectors ----------
var PLAYABLE_FORMATS = ['asf', 'wmv', 'divx', 'avi', 'mp4', 'm4v', 'mov', '3gp', '3g2', 'mkv', 'trp', 'tp', 'mts', 'mpg', 'mpeg', 'dat', 'vob', 'rm', 'rmvb', 'm2ts', 'ts'];
var STREAMABLE_FORMATS = ['mp4', 'mkv', 'm4v', 'mov', 'webm', 'ts', 'm2ts', 'mts'];
var LEGACY_FORMATS = ['avi', 'mpg', 'mpeg', 'vob', 'wmv', 'asf', 'flv', 'rm', 'rmvb', 'divx'];

export function isPlayableFile(file) {
    var exe = fileExtension(file);
    return PLAYABLE_FORMATS.indexOf(exe) >= 0;
}

export function filePath(file) {
    // TorrServer versions differ: file_stats may expose the machine path as `path`,
    // while some Jackett/Anilibria layouts only fill `path_human`. Keep the human
    // path as a fallback so a valid video is not silently discarded before scoring.
    return String((file && (file.path || file.path_human || file.title)) || '');
}

export function fileExtension(file) {
    var path = filePath(file).split(/[?#]/)[0];
    var match = path.match(/\.([a-z0-9]{2,6})$/i);
    return match ? match[1].toLowerCase() : '';
}

export function extensionScore(path) {
    var ext = path.toLowerCase().split('.').pop();
    if (STREAMABLE_FORMATS.indexOf(ext) >= 0) return 5;
    if (LEGACY_FORMATS.indexOf(ext) >= 0) return -5;
    return 0;
}
