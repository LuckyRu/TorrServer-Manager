import { buildQueries, buildAnimeQueries, isAnimeTarget } from './query-building.js';
import { unique } from '../shared/utils.js';

export const ANIME_INDEXER_IDS = ['anidub', 'anilibria'];

function planKey(plan) {
    var include = (plan.indexerIds || []).join(',');
    var exclude = (plan.excludeIndexerIds || []).join(',');
    return plan.query + '|' + include + '|' + exclude;
}

export function buildSearchPlan(target, queries) {
    queries = Array.isArray(queries) ? queries : [];
    if (!isAnimeTarget(target)) return queries.map(function (query) { return { query: query }; });

    var animeQueries = buildAnimeQueries(target).slice(0, 3);
    var standardQueries = buildQueries(target).slice(0, 1);
    var plans = animeQueries.map(function (query) {
        return { query: query, indexerIds: ANIME_INDEXER_IDS.slice() };
    });

    standardQueries.forEach(function (query) {
        plans.push({ query: query, excludeIndexerIds: ANIME_INDEXER_IDS.slice() });
    });

    return unique(plans, planKey);
}
