import { selectEpisodeBadges, selectFilterChipData, selectPickerData, selectPoolIndexers } from './results-selectors.js';

function sameTuple(left, right) {
    if (left === right) return true;
    if (!left || !right || left.length !== right.length) return false;
    for (var i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
    return true;
}

function revisionOrReference(state, revisionField, valueField) {
    return state[revisionField] === undefined ? state[valueField] : state[revisionField];
}

function memoize(name, selectKey, selectValue, stats) {
    var key = null;
    var value = null;
    return function (state) {
        var nextKey = selectKey(state);
        if (sameTuple(nextKey, key)) return value;
        key = nextKey;
        stats[name] = (stats[name] || 0) + 1;
        value = selectValue(state);
        return value;
    };
}

export function createResultsProjectionCache(object, movie, hasSeasons, seasonDefault) {
    var stats = {};

    return {
        episodeBadges: memoize('episodeBadges',
            function (state) {
                return [revisionOrReference(state, 'poolRevision', 'pool'),
                    revisionOrReference(state, 'episodesRevision', 'episodesCache'), state.poolStatus,
                    state.seasonLoads, state.season, revisionOrReference(state, 'filtersRevision', 'filters'),
                    state.seasonEpisodeCount, state.avgRuntimeMinutes, state.defaultsRevision];
            },
            function (state) { return selectEpisodeBadges(object, state, seasonDefault(state.season)); }, stats
        ),
        filterChipData: memoize('filterChipData',
            function (state) { return [state.season, revisionOrReference(state, 'poolRevision', 'pool'),
                revisionOrReference(state, 'filtersRevision', 'filters'), state.seasonEpisodeCount, state.avgRuntimeMinutes]; },
            function (state) { return selectFilterChipData(state, movie, hasSeasons); }, stats
        ),
        pickerData: memoize('pickerData',
            function (state) {
                return [state.picker, revisionOrReference(state, 'poolRevision', 'pool'), state.poolStatus,
                    state.seasonLoads, state.season, revisionOrReference(state, 'filtersRevision', 'filters'),
                    state.seasonEpisodeCount, state.avgRuntimeMinutes, state.defaultsRevision];
            },
            function (state) { return selectPickerData(object, state, seasonDefault(state.season)); }, stats
        ),
        poolIndexers: memoize('poolIndexers',
            function (state) { return [state.poolIndexers, state.poolAllIndexers]; },
            function (state) { return selectPoolIndexers(state); }, stats
        ),
        stats: function () { return Object.assign({}, stats); }
    };
}
