// ---------- series torrent search ----------
import { searchTorrentMod } from './search-backend.js';
import { parseSeriesRelease } from './series-release-parsing.js';
import { buildSeriesQueries } from './series-query-building.js';

export function searchSeriesTorrents(target) {
    return searchTorrentMod(Object.assign({}, target, { mode: 'series' }), parseSeriesRelease, buildSeriesQueries);
}
