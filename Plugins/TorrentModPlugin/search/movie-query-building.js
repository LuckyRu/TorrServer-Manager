import { defaultSearchName } from './query-building.js';
import { compact, unique } from '../shared/utils.js';

export function buildMovieQueries(target) {
    var name = defaultSearchName(target.movie, target.englishTitle);
    return name ? unique([name], compact).slice(0, 1) : [];
}
