import { createResultsDomain } from './results-domain.js';
import { MODE_MOVIE } from '../shared/state.js';

export function createMovieResultsViewModel(options) {
    var domain = createResultsDomain({
        object: options.object,
        movie: options.movie,
        hasSeasons: false
    });
    return {
        mode: MODE_MOVIE,
        store: domain.store,
        filters: domain.filters,
        episodes: domain.episodes,
        selection: domain.selection,
        start: domain.start,
        destroy: domain.destroy,
        scope: domain.scope
    };
}
