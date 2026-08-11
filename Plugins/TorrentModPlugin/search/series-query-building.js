// ---------- series query building ----------
import { buildQueries, buildAnimeQueries, isAnimeTarget } from './query-building.js';
import { MODE_SERIES } from '../shared/state.js';

export function buildSeriesQueries(target) {
    var normalized = Object.assign({}, target, { mode: MODE_SERIES, includeYear: false });
    return isAnimeTarget(normalized) ? buildAnimeQueries(normalized) : buildQueries(normalized);
}
