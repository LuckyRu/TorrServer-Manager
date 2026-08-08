// ---------- playback file-selection dispatcher ----------
//
// The dispatcher is intentionally tiny: movie and series selection rules live in separate modules.
// This is the only common entry point used by the TorrServer session.
import { isPlayableFile } from './file-selection-common.js';
import { pickMovieFile } from './movie-file-selection.js';
import { pickSeriesFile } from './series-file-selection.js';

export { isPlayableFile };

export function pickBestFile(files, target, parseSignals) {
    var playable = (files || []).filter(isPlayableFile);
    if (!playable.length) return null;
    return target && target.mode === 'movie'
        ? pickMovieFile(playable)
        : pickSeriesFile(playable, target || {}, parseSignals);
}
