import { buildQueries, buildAnimeQueries, isAnimeTarget } from './query-building.js';
import { unique } from '../shared/utils.js';
import { indexersInGroup } from './tracker-profiles.js';

// Список аниме-трекеров больше не хардкод: он выводится из группы в реестре профилей,
// поэтому добавить третий аниме-трекер — это правка данных, а не кода.
export function animeIndexerIds() { return indexersInGroup('anime'); }
export const ANIME_INDEXER_IDS = animeIndexerIds();

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
        return { query: query, indexerIds: animeIndexerIds() };
    });

    standardQueries.forEach(function (query) {
        plans.push({ query: query, excludeIndexerIds: animeIndexerIds() });
    });

    return unique(plans, planKey);
}
