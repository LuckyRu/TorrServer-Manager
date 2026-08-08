// ---------- movie results View ----------
//
// Movie UI has one primary collection: torrent candidates. Keep its entry point separate from the
// series View even though Explorer/Scroll/Filter primitives are shared underneath.
import { createResultsView } from './results-screen.js';

export function createMovieResultsView(options) {
    return createResultsView(Object.assign({}, options, { hasSeasons: false }));
}
