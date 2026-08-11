import { selectEpisodeBadges, selectFilterChipData, selectPickerData, selectPoolIndexers } from './results-selectors.js';

function sameTuple(left, right) {
    if (left === right) return true;
    if (!left || !right || left.length !== right.length) return false;
    for (var i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
    return true;
}

function memoize(selectKey, selectValue) {
    var key = null;
    var value = null;
    return function (state) {
        var nextKey = selectKey(state);
        if (sameTuple(nextKey, key)) return value;
        key = nextKey;
        value = selectValue(state);
        return value;
    };
}

export function createResultsProjectionCache(object, movie, hasSeasons, seasonDefault) {
    function defaultId(state) {
        var saved = seasonDefault(state.season);
        return saved && saved.id;
    }

    return {
        episodeBadges: memoize(
            function (state) {
                return [state.pool, state.episodesCache, state.poolStatus, state.seasonLoads, state.season,
                    state.filters, state.stage, state.seasonEpisodeCount, state.avgRuntimeMinutes, defaultId(state)];
            },
            function (state) { return selectEpisodeBadges(object, state, seasonDefault(state.season)); }
        ),
        filterChipData: memoize(
            function (state) { return [state.season, state.pool, state.filters, state.seasonEpisodeCount, state.avgRuntimeMinutes]; },
            function (state) { return selectFilterChipData(state, movie, hasSeasons); }
        ),
        pickerData: memoize(
            function (state) {
                return [state.picker, state.pool, state.poolStatus, state.seasonLoads, state.season, state.filters,
                    state.seasonEpisodeCount, state.avgRuntimeMinutes, defaultId(state)];
            },
            function (state) { return selectPickerData(object, state, seasonDefault(state.season)); }
        ),
        poolIndexers: memoize(
            function (state) { return [state.poolIndexers, state.poolAllIndexers]; },
            function (state) { return selectPoolIndexers(state); }
        )
    };
}
