import { createResultsDomain } from './results-domain.js';
import { MODE_SERIES } from '../shared/state.js';

export function createSeriesResultsViewModel(options) {
    var domain = createResultsDomain({
        object: options.object,
        movie: options.movie,
        hasSeasons: true
    });
    return {
        mode: MODE_SERIES,
        store: domain.store,
        filters: domain.filters,
        episodes: domain.episodes,
        selection: domain.selection,
        start: domain.start,
        destroy: domain.destroy,
        scope: domain.scope
    };
}
