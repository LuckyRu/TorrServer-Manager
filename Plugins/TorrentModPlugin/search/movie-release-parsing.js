// ---------- movie release parsing ----------
//
// Movie search must not expose series-only season/episode signals to the movie selector. The lexical
// parser remains shared, while this adapter defines the movie contract explicitly.
import { parseRelease } from './release-parsing.js';

export function parseMovieRelease(title) {
    var release = parseRelease(title);
    release.explicitSeason = false;
    release.seasons = [];
    release.explicitEpisode = false;
    release.episodeFrom = 0;
    release.episodeTo = 0;
    return release;
}
