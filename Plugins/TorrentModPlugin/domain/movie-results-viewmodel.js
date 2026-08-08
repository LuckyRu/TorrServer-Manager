// ---------- movie results ViewModel ----------
//
// The ViewModel is the movie-specific composition boundary. It exposes the common store/interactors
// to the View but does not expose series episode semantics as the movie's public entry point.
import { createResultsDomain } from './results-domain.js';

export function createMovieResultsViewModel(options) {
    var domain = createResultsDomain({
        object: options.object,
        movie: options.movie,
        hasSeasons: false
    });
    return {
        mode: 'movie',
        store: domain.store,
        filters: domain.filters,
        episodes: domain.episodes,
        selection: domain.selection,
        start: domain.start,
        destroy: domain.destroy
    };
}
