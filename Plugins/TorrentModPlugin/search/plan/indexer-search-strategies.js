import { buildQueries, buildAnimeQueries, isAnimeTarget, queryNames, searchNames, normalizedTitleKey } from './query-building.js';
import { unique } from '../../shared/utils.js';
import { indexersInGroup } from '../rules/tracker-profiles.js';

// Список аниме-трекеров больше не хардкод: он выводится из группы в реестре профилей,
// поэтому добавить третий аниме-трекер — это правка данных, а не кода.
export function animeIndexerIds() { return indexersInGroup('anime'); }
export const ANIME_INDEXER_IDS = animeIndexerIds();

function planKey(plan) {
    var include = (plan.indexerIds || []).join(',');
    var exclude = (plan.excludeIndexerIds || []).join(',');
    return plan.query + '|' + include + '|' + exclude;
}

// Названия, не попавшие в первую волну. Уходят только при пустом результате: угадать нужное имя
// с первого раза нельзя — parse_lang у пользователя может дать оригинал, которого нет в индексе
// русских трекеров, а то же аниме лежит там под русским названием. Постоянный второй запрос
// стоил бы отдельного job на каждый трекер со своими ретраями, поэтому он отложенный.
function escalationPlans(target, usedQueries, excludeIndexerIds, candidates) {
    var used = {};
    (usedQueries || []).forEach(function (query) { used[normalizedTitleKey(query)] = true; });
    return (candidates || queryNames(target))
        .filter(function (name) {
            // Запасной запрос уходит на общие трекеры: письмо, которого нет в их индексе,
            // там бесполезно — оно вернёт случайную свежую выдачу, а не пустой ответ.
            return name && !used[normalizedTitleKey(name)] && /[a-zа-яё]/i.test(name);
        })
        .slice(0, 1)
        .map(function (name) {
            var plan = { query: name, when: 'if-empty' };
            if (excludeIndexerIds) plan.excludeIndexerIds = excludeIndexerIds;
            return plan;
        });
}

export function buildSearchPlan(target, queries) {
    queries = Array.isArray(queries) ? queries : [];

    if (!isAnimeTarget(target)) {
        // Общий маршрут не должен повторно спрашивать профильные аниме-индексаторы: для anime и
        // donghua они получают отдельные адресные планы, а для остальных семейств там нет контента.
        var animeIds = animeIndexerIds();
        var general = queries.map(function (query) { return { query: query, excludeIndexerIds: animeIds }; });
        return unique(general.concat(escalationPlans(target, queries, animeIds)), planKey);
    }

    var animeQueries = buildAnimeQueries(target).slice(0, 3);
    var standardQueries = buildQueries(target).slice(0, 1);
    var plans = animeQueries.map(function (query) {
        return { query: query, indexerIds: animeIndexerIds() };
    });

    standardQueries.forEach(function (query) {
        plans.push({ query: query, excludeIndexerIds: animeIndexerIds() });
    });

    // У аниме запасное имя берётся из alias-набора: на общих трекерах то же произведение
    // лежит под русским названием, которое в первую волну не попало.
    return unique(plans.concat(escalationPlans(target, standardQueries, animeIndexerIds(), searchNames(target))), planKey);
}
