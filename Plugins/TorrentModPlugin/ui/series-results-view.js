import { createResultsView } from './results-screen.js';

export function createSeriesResultsView(options) {
    return createResultsView(Object.assign({}, options, { hasSeasons: true }));
}
