import { createResultsView } from './results-screen.js';

export function createMovieResultsView(options) {
    return createResultsView(Object.assign({}, options, { hasSeasons: false }));
}
