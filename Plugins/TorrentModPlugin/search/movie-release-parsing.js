import { parseRelease } from './release-parsing.js';

export function parseMovieRelease(title, profile) {
    var release = parseRelease(title, profile);
    release.explicitSeason = false;
    release.seasons = [];
    release.explicitEpisode = false;
    release.finalSeason = false;
    release.episodeFrom = 0;
    release.episodeTo = 0;
    return release;
}
