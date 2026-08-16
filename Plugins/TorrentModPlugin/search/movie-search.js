// ---------- movie torrent search ----------
import { searchTorrentMod, searchTorrentModProgressive } from './transport/search-backend.js';
import { parseMovieRelease } from './parse/movie-release-parsing.js';
import { buildMovieQueries } from './plan/movie-query-building.js';
import { MODE_MOVIE } from '../shared/state.js';

export function searchMovieTorrents(target) {
    return searchTorrentMod(Object.assign({}, target, { mode: MODE_MOVIE }), parseMovieRelease, buildMovieQueries);
}

export function searchMovieTorrentsProgressive(target, onIndexerResult, onDone, scope, onIndexerList) {
    return searchTorrentModProgressive(Object.assign({}, target, { mode: MODE_MOVIE }), parseMovieRelease, buildMovieQueries, onIndexerResult, onDone, scope, onIndexerList);
}
