// ---------- playback file-selection primitives shared by the mode-specific selectors ----------
var PLAYABLE_FORMATS = ['asf', 'wmv', 'divx', 'avi', 'mp4', 'm4v', 'mov', '3gp', '3g2', 'mkv', 'trp', 'tp', 'mts', 'mpg', 'mpeg', 'dat', 'vob', 'rm', 'rmvb', 'm2ts', 'ts'];
var STREAMABLE_FORMATS = ['mp4', 'mkv', 'm4v', 'mov', 'webm', 'ts', 'm2ts', 'mts'];
var LEGACY_FORMATS = ['avi', 'mpg', 'mpeg', 'vob', 'wmv', 'asf', 'flv', 'rm', 'rmvb', 'divx'];

export function isPlayableFile(file) {
    var exe = String((file && file.path) || '').split('.').pop().toLowerCase();
    return PLAYABLE_FORMATS.indexOf(exe) >= 0;
}

export function filePath(file) {
    return String((file && (file.path || file.title)) || '');
}

export function extensionScore(path) {
    var ext = path.toLowerCase().split('.').pop();
    if (STREAMABLE_FORMATS.indexOf(ext) >= 0) return 5;
    if (LEGACY_FORMATS.indexOf(ext) >= 0) return -5;
    return 0;
}
