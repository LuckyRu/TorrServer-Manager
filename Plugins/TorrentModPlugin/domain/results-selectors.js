    // ---------- domain: selectors (derived data, computed fresh, never stored) ----------
    //
    // Global "is anything busy" and the filter-panel/badge data are both *derivations* over stored
    // fields, not fields of their own — a separately-maintained flag that has to be kept in sync by
    // hand in multiple places is a second source of truth that can drift (miss one clear-path on an
    // error branch and it's stuck wrong forever, the same class of bug the old code's ad hoc
    // staleness checks were prone to). A pure function over already-stored state can't drift by
    // construction and costs nothing worth avoiding to recompute on each render.
    import { buildFilterItems, activeFilterLabels, currentSeasonLabel, candidatesForEpisode, badgeText } from './results-core.js';
    import { buildSeasonItems } from '../metadata/season-picker.js';
    import { MODE_SERIES } from '../shared/state.js';

    export function selectBusy(state) {
        return state.episodesStatus === 'loading' || state.poolStatus === 'loading' || state.searchStatus === 'loading';
    }

    export function selectFilterChipData(state, movie, hasSeasons) {
        return {
            seasonLabel: currentSeasonLabel(movie, hasSeasons, state),
            // Season picker items, refreshed on every season change: Lampa.Filter renders the
            // "selected" marker straight off these objects (it mutates them in place via
            // Filter.prototype.selected), so the array handed to filter.set('sort', ...) must be
            // rebuilt with the new season's selected flag — otherwise the chip keeps showing the
            // previously picked season as active on every reopen.
            seasonItems: buildSeasonItems(movie, state.season),
            activeLabels: activeFilterLabels(state),
            filterItems: buildFilterItems(movie, hasSeasons, state)
        };
    }

    export function selectFilterItems(state, movie, hasSeasons) {
        return buildFilterItems(movie, hasSeasons, state);
    }

    // Same target shape every interactor that needs one builds — kept in one place so the shape
    // itself only has to agree with candidatesForEpisode's own expectations in a single spot.
    // customQuery must travel with the target: passesMatchGate (search/scoring.js) skips the
    // title-similarity gate when it's set, since a manual name override means the original TMDB
    // title is known to mismatch real torrent titles. Omitting it here re-gated episode badges and
    // the side picker against the stale title even after the user searched under a better name,
    // while a plain click on the same episode (selectEpisode, which always included it) found
    // matches fine — the UI visibly contradicted itself (found in review).
    export function buildEpisodeTarget(object, state, number, mode) {
        return {
            movie: object.movie,
            mode: mode || MODE_SERIES,
            season: state.season,
            episode: number,
            seasonEpisodeCount: state.seasonEpisodeCount,
            avgRuntimeMinutes: state.avgRuntimeMinutes,
            customQuery: state.customQuery
        };
    }

    export function selectCandidatesForEpisode(object, state, number, mode) {
        var target = buildEpisodeTarget(object, state, number, mode);
        return candidatesForEpisode(state.pool, target, state);
    }

    export function selectEpisodeBadges(object, state) {
        if (!state.pool) return {};
        var map = {};
        (state.episodesCache || []).forEach(function (episode) {
            var number = parseInt(episode.episode_number, 10);
            map[number] = badgeText(selectCandidatesForEpisode(object, state, number));
        });
        return map;
    }
