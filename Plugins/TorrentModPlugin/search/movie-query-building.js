// ---------- movie query building ----------
//
// A movie is searched as one whole work. It never gets season/episode suffixes, even when an
// accidental `season` field is present on the Lampa object.
import { defaultSearchName } from './query-building.js';
import { compact, unique } from '../shared/utils.js';

export function buildMovieQueries(target) {
    var name = target.customQuery || defaultSearchName(target.movie, target.englishTitle);
    return name ? unique([name], compact).slice(0, 1) : [];
}
