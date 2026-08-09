// ---------- series torrent search ----------
import { searchTorrentMod, searchTorrentModProgressive } from './search-backend.js';
import { parseSeriesRelease } from './series-release-parsing.js';
import { buildSeriesQueries } from './series-query-building.js';
import { MODE_SERIES } from '../shared/state.js';

export function searchSeriesTorrents(target) {
    return searchTorrentMod(Object.assign({}, target, { mode: MODE_SERIES }), parseSeriesRelease, buildSeriesQueries);
}

// Progressive (per-indexer, as they answer) variant for the whole-work pool search — see
// search-backend.js's own searchTorrentModProgressive for the full contract.
export function searchSeriesTorrentsProgressive(target, onIndexerResult, onDone, scope, onIndexerList) {
    return searchTorrentModProgressive(Object.assign({}, target, { mode: MODE_SERIES }), parseSeriesRelease, buildSeriesQueries, onIndexerResult, onDone, scope, onIndexerList);
}
