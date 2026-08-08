// ---------- series results View ----------
//
// Series UI owns the episode-list-first flow and its season/episode picker. The shared View only
// supplies the native Lampa chrome and navigation primitives.
import { createResultsView } from './results-screen.js';

export function createSeriesResultsView(options) {
    return createResultsView(Object.assign({}, options, { hasSeasons: true }));
}
