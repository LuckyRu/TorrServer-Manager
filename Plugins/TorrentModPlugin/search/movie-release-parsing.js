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
