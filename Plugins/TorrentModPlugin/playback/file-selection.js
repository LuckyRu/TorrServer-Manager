import { isPlayableFile, fileExtension } from './file-selection-common.js';
import { pickMovieFile } from './movie-file-selection.js';
import { pickSeriesFile, parseSeriesFileLayout } from './series-file-selection.js';
import { MODE_MOVIE } from '../shared/state.js';

export { isPlayableFile };
export { fileExtension };
export { parseSeriesFileLayout };

export function pickBestFile(files, target, parseSignals) {
    var playable = (files || []).filter(isPlayableFile);
    if (!playable.length) return null;
    return target && target.mode === MODE_MOVIE
        ? pickMovieFile(playable)
        : pickSeriesFile(playable, target || {}, parseSignals);
}
