// ---------- movie file selection ----------
import { filePath, extensionScore } from './file-selection-common.js';

var MOVIE_ARTIFACT = /(?:^|[._\- ])(?:sample|trailer|preview|teaser|proof|menu|extras?|featurette)(?:$|[._\- ])/i;

export function scoreMovieFile(file) {
    var path = filePath(file);
    if (MOVIE_ARTIFACT.test(path)) return -1000000000;
    var length = Number(file && (file.length || file.size || file.bytes)) || 0;
    return Math.log(length + 1) * 100 + extensionScore(path);
}

export function pickMovieFile(files) {
    return (files || []).slice().sort(function (a, b) {
        return scoreMovieFile(b) - scoreMovieFile(a);
    })[0] || null;
}
