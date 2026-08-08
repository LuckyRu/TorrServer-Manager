// ---------- series query building ----------
import { buildQueries } from './query-building.js';

export function buildSeriesQueries(target) {
    return buildQueries(Object.assign({}, target, { mode: 'series' }));
}
