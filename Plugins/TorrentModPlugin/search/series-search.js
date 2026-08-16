// ---------- series torrent search ----------
import { searchTorrentMod, searchTorrentModProgressive } from './transport/search-backend.js';
import { parseSeriesRelease } from './parse/series-release-parsing.js';
import { buildSeriesQueries } from './plan/series-query-building.js';
import { MODE_SERIES } from '../shared/state.js';

export function searchSeriesTorrents(target) {
    return searchTorrentMod(Object.assign({}, target, { mode: MODE_SERIES }), parseSeriesRelease, buildSeriesQueries);
}

export function searchSeriesTorrentsProgressive(target, onIndexerResult, onDone, scope, onIndexerList) {
    return searchTorrentModProgressive(Object.assign({}, target, { mode: MODE_SERIES }), parseSeriesRelease, buildSeriesQueries, onIndexerResult, onDone, scope, onIndexerList);
}
