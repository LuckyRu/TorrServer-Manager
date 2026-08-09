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

    // `seasonDefault` (the persisted per-season default torrent, if any — read by the caller via
    // Lampa.Storage, since this module stays framework-agnostic) is threaded through to badgeText
    // so every episode's badge reflects what a click would actually start playing, not just the
    // top-ranked candidate.
    //
    // Before the whole-work pool has ever resolved (state.pool === null) every badge used to come
    // back as an empty string — visually indistinguishable from "haven't looked at this yet" and
    // from "searched and found nothing", on a screen whose FIRST cold search against every Jackett
    // indexer can legitimately take up to ~40s (see PluginHub's own 45s CancelAfter). Same problem,
    // narrower: a season the pool came back empty for (ensureSeasonLoaded's own lazy per-season
    // fetch) shows the identical blank state while that fetch is in flight. Both now show an
    // explicit "поиск…" placeholder instead — reported directly by the user ("понятная индикация
    // поиска... очень важна для первых холодных поисков"); once the real search resolves,
    // badgeText's own existing "раздачи не найдены" text (genuinely empty result, not a race) takes
    // back over exactly as before.
    export function selectEpisodeBadges(object, state, seasonDefault) {
        var poolLoading = !state.pool || state.poolStatus === 'loading';
        var seasonLoading = !!(state.seasonLoads && state.seasonLoads[state.season] === 'loading');
        // A genuinely FAILED search (Jackett 502/timeout on the aggregate query, or this season's
        // own lazy per-season retry failing too) used to be visually identical to "searched
        // cleanly, found nothing" — badgeText's own "раздачи не найдены" doesn't know the
        // difference, it just sees an empty candidates array either way. Reported directly by the
        // user testing this exact path live, alongside a real crash the same root cause enabled
        // (see ensureSeasonLoaded's own comment) — badges now say so explicitly instead of quietly
        // implying "confirmed empty".
        var poolFailed = state.poolStatus === 'error';
        var seasonFailed = !!(state.seasonLoads && state.seasonLoads[state.season] === 'error');
        var map = {};
        (state.episodesCache || []).forEach(function (episode) {
            var number = parseInt(episode.episode_number, 10);
            if (poolLoading || seasonLoading) map[number] = 'поиск…';
            else if (poolFailed || seasonFailed) map[number] = 'ошибка поиска';
            else map[number] = badgeText(selectCandidatesForEpisode(object, state, number), seasonDefault);
        });
        return map;
    }

    // Head status line, derived: state.statusText (set directly by the episode-list/manual-search
    // interactors — "Загрузка списка серий…", "Ищем <query>…") always wins when present; the
    // whole-work pool search has no interactor-managed message of its own (deliberately — it runs
    // silently in the background per season-pool design docs, and stomping the episode-list message
    // the instant loadAllTorrents() also starts would just replace one loading message with another
    // for no reason), so it only surfaces here, as a fallback shown once nothing more specific is
    // already saying something.
    export function selectStatusText(state) {
        if (state.statusText) return state.statusText;
        if (state.poolStatus === 'loading') return 'Ищем раздачи по всем трекерам…';
        if (state.poolStatus === 'error') return 'Не удалось получить раздачи — Jackett не ответил';
        return '';
    }

    // Side picker panel content — derived, not stored (see picker's own comment in
    // results-state.js). items/status/target/selectedId used to live in state.picker itself,
    // imperatively populated by an interactor call (fillPicker) threaded through a manual "call me
    // back once you know more" callback into ensureSeasonLoaded — the shared root cause of two
    // separate infinite-recursion crashes (see CLAUDE.md): a caller that assumes "callback fired"
    // always means "something changed" breaks the moment the callee ever fires it with nothing
    // having changed. Making this a pure selector over already-stored fields, exactly like
    // selectEpisodeBadges already does for the row badges, removes the "retry via callback" concept
    // entirely: ensureSeasonLoaded is now fire-and-forget (episodes-interactor.js), and the picker's
    // displayed content just re-derives itself automatically whenever the View's one
    // store.subscribe fires — there is no manual bookkeeping left that can go stale or loop.
    // `seasonDefault` is read by the caller via Lampa.Storage (this module stays framework-agnostic)
    // and passed in, same convention selectEpisodeBadges already uses.
    export function selectPickerData(object, state, seasonDefault) {
        var episode = state.picker.episode;
        var items = selectCandidatesForEpisode(object, state, episode);
        var selectedId = seasonDefault ? seasonDefault.id : null;
        if (items.length) {
            return { status: 'ready', items: items, target: buildEpisodeTarget(object, state, episode), selectedId: selectedId };
        }
        var poolLoading = !state.pool || state.poolStatus === 'loading';
        var seasonLoading = !!(state.seasonLoads && state.seasonLoads[state.season] === 'loading');
        if (poolLoading || seasonLoading) return { status: 'loading', items: [], target: null, selectedId: null };
        // Settled with zero candidates — covers both a genuinely empty result and a failed search;
        // the panel has only ever shown one "Раздач не найдено" message for both (unchanged from
        // before this selector existed — row badges distinguish 'ошибка поиска' from 'раздачи не
        // найдены' for a different reason, see selectEpisodeBadges, but the picker never did).
        return { status: 'error', items: [], target: null, selectedId: null };
    }
