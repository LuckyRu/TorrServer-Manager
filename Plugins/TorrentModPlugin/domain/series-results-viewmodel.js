// ---------- series results ViewModel ----------
//
// Series keeps its episode/season interactor behind a dedicated ViewModel boundary. Playback remains
// in the shared session service; only the target and selection path differ by mode.
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
