// ---------- series query building ----------
import { buildQueries } from './query-building.js';
import { MODE_SERIES } from '../shared/state.js';

export function buildSeriesQueries(target) {
    return buildQueries(Object.assign({}, target, { mode: MODE_SERIES, includeYear: false }));
}
