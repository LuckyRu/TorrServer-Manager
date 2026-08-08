// ---------- movie torrent search ----------
import { searchTorrentMod } from './search-backend.js';
import { parseMovieRelease } from './movie-release-parsing.js';
import { buildMovieQueries } from './movie-query-building.js';

export function searchMovieTorrents(target) {
    return searchTorrentMod(Object.assign({}, target, { mode: 'movie' }), parseMovieRelease, buildMovieQueries);
}
