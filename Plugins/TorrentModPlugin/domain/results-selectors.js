    // ---------- domain: selectors (derived data, computed fresh, never stored) ----------
    //
    // Global "is anything busy" and the filter-panel/badge data are both *derivations* over stored
    // fields, not fields of their own — a separately-maintained flag that has to be kept in sync by
    // hand in multiple places is a second source of truth that can drift (miss one clear-path on an
    // error branch and it's stuck wrong forever, the same class of bug the old code's ad hoc
    // staleness checks were prone to). A pure function over already-stored state can't drift by
    // construction and costs nothing worth avoiding to recompute on each render.
    import { buildFilterItems, activeFilterLabels, currentSeasonLabel, candidatesForEpisode, badgeText } from './results-core.js';

    export function selectBusy(state) {
        return state.episodesStatus === 'loading' || state.seasonPoolStatus === 'loading' || state.searchStatus === 'loading';
    }

    export function selectFilterChipData(state, movie, hasSeasons) {
        return {
            seasonLabel: currentSeasonLabel(movie, hasSeasons, state),
            activeLabels: activeFilterLabels(state),
            filterItems: buildFilterItems(movie, hasSeasons, state)
        };
    }

    export function selectFilterItems(state, movie, hasSeasons) {
        return buildFilterItems(movie, hasSeasons, state);
    }

    // Same target shape every interactor that needs one builds — kept in one place so the shape
    // itself only has to agree with candidatesForEpisode's own expectations in a single spot.
    export function buildEpisodeTarget(object, state, number) {
        return {
            movie: object.movie,
            season: state.season,
            episode: number,
            seasonEpisodeCount: state.seasonEpisodeCount,
            avgRuntimeMinutes: state.avgRuntimeMinutes
        };
    }

    export function selectCandidatesForEpisode(object, state, number) {
        var target = buildEpisodeTarget(object, state, number);
        return candidatesForEpisode(state.seasonPool, target, state);
    }

    export function selectEpisodeBadges(object, state) {
        if (!state.seasonPool) return {};
        var map = {};
        (state.episodesCache || []).forEach(function (episode) {
            var number = parseInt(episode.episode_number, 10);
            map[number] = badgeText(selectCandidatesForEpisode(object, state, number));
        });
        return map;
    }
