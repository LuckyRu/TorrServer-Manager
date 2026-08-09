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
    import { MODE_SERIES, POOL_MAX_ATTEMPTS } from '../shared/state.js';

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
    // fetch) shows the identical blank state while that fetch is in flight.
    //
    // Each entry is `{text, loading}`, not a plain string: `loading` drives a shimmer/skeleton
    // element in the View instead of the "поиск…" text itself (part of the search-progress-widget
    // work — a UX/product/error-domain design consilium documented in CLAUDE.md decided static text
    // wasn't dynamic enough). `text` is still always populated (loading rows carry a plain-language
    // fallback too) so nothing downstream that reads `.text` directly needs a loading-aware branch.
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
            if (poolLoading || seasonLoading) map[number] = { text: 'поиск…', loading: true };
            else if (poolFailed || seasonFailed) map[number] = { text: 'ошибка поиска', loading: false };
            else map[number] = { text: badgeText(selectCandidatesForEpisode(object, state, number), seasonDefault), loading: false };
        });
        return map;
    }

    // Escalates the wording for a genuinely slow cold search (up to ~40s server-side) instead of
    // one static sentence the whole time — product decision (see CLAUDE.md consilium): a raw
    // countdown reads as "is this frozen?" on a slow connection, so this steps the WORDING at a
    // fixed threshold instead of showing elapsed time directly. `elapsedMs` is null unless the pool
    // is actually loading (nothing to escalate otherwise).
    var SLOW_SEARCH_THRESHOLD_MS = 15000;

    // Unified "is torrent search still working, and what happened" signal — collapses the
    // whole-work pool search, this season's lazy background retry, and an active manual-query
    // search into ONE stage (product decision: the user's real question is "is THIS season ready",
    // not which of three independent async ops is currently running — see CLAUDE.md). Loading wins
    // over error wins over idle: if the pool failed but a lazy per-season retry is now running for
    // the season on screen, the combined stage is still 'loading', not 'error'.
    //
    // 'retrying': a network/Jackett failure now auto-retries with a live, honest countdown instead
    // of silently retrying in the background or requiring a manual "Повторить" every time —
    // required directly by the user after a real repeated-search-failure report ("сбой поиска был 2
    // раза, два раза переходил назад и запускал плагин заново"). `poolAutoRetryAt` is written by
    // episodes-interactor.js's own scheduled retry; this only ever reads it, never schedules
    // anything itself (selectors stay pure).
    export function selectSearchProgress(state) {
        var seasonStatus = state.seasonLoads && state.seasonLoads[state.season];
        var loading = state.poolStatus === 'loading' || seasonStatus === 'loading' || state.searchStatus === 'loading';
        if (loading) {
            var elapsedMs = (state.poolStatus === 'loading' && state.poolStartedAt) ? Date.now() - state.poolStartedAt : null;
            return { stage: 'loading', elapsedMs: elapsedMs, slow: elapsedMs !== null && elapsedMs >= SLOW_SEARCH_THRESHOLD_MS };
        }
        if (state.poolAutoRetryAt && state.poolAutoRetryAt > Date.now()) {
            return {
                stage: 'retrying', elapsedMs: null, slow: false,
                retryInMs: state.poolAutoRetryAt - Date.now(),
                attempt: state.poolAttempt || 1, maxAttempts: POOL_MAX_ATTEMPTS
            };
        }
        var failed = state.poolStatus === 'error' || seasonStatus === 'error' || state.searchStatus === 'error';
        if (failed) return { stage: 'error', elapsedMs: null, slow: false, attempt: state.poolAttempt || 1 };
        return { stage: 'idle', elapsedMs: null, slow: false };
    }

    // Head status line, derived: state.statusText (set directly by the episode-list/manual-search
    // interactors — "Загрузка списка серий…", "Ищем <query>…") always wins when present; the
    // whole-work pool search has no interactor-managed message of its own (deliberately — it runs
    // silently in the background per season-pool design docs, and stomping the episode-list message
    // the instant loadAllTorrents() also starts would just replace one loading message with another
    // for no reason), so it only surfaces here, as a fallback shown once nothing more specific is
    // already saying something. Delegates stage detection to selectSearchProgress so there's one
    // source of truth for "is search loading/failed" shared with the spinner and the shimmer badges.
    export function selectStatusText(state) {
        if (state.statusText) return state.statusText;
        var progress = selectSearchProgress(state);
        if (progress.stage === 'loading') {
            return progress.slow
                ? 'Опрашиваем трекеры — некоторые отвечают медленно, обычно до 40 секунд'
                : 'Ищем раздачи по всем трекерам…';
        }
        if (progress.stage === 'retrying') {
            // A real, deterministic setTimeout backs this countdown (not network-speed-dependent
            // like the "slow search" wording above), so a live ticking number here is accurate, not
            // misleading — unlike a raw search-duration timer, this one can't under/overshoot.
            var seconds = Math.max(1, Math.ceil(progress.retryInMs / 1000));
            return 'Не удалось получить раздачи — повтор через ' + seconds + ' с (попытка ' + (progress.attempt + 1) + ' из ' + progress.maxAttempts + ')';
        }
        if (progress.stage === 'error') {
            return 'Не удалось получить раздачи — Jackett не ответил' + (progress.attempt > 1 ? ' (попытка ' + progress.attempt + ' из ' + POOL_MAX_ATTEMPTS + ')' : '');
        }
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
        // MUST check poolLoading (which includes `!state.pool`) BEFORE ever touching the pool —
        // state.pool is `null` by design until the whole-work search resolves at least once
        // (results-state.js), and applyStateFilters (search/scoring.js, reached via
        // selectCandidatesForEpisode → candidatesForEpisode) calls `pool.filter(...)` with no
        // null-guard of its own. TMDB's episode list (which is what makes an episode row focusable
        // at all) typically resolves far faster than the Jackett aggregate search (up to ~40s) —
        // real crash, confirmed live: right-arrow on an episode row before the pool has EVER
        // resolved threw `TypeError: Cannot read properties of null (reading 'filter')`. Every
        // other caller of selectCandidatesForEpisode (selectEpisodeBadges, the reactive watcher,
        // selectEpisode/startMovie/showMoviePool) already checks poolStatus/pool first — this one
        // didn't, a regression from the reactive-architecture rewrite that dropped openPicker's own
        // pre-check without replacing it here.
        var poolLoading = !state.pool || state.poolStatus === 'loading';
        var seasonLoading = !!(state.seasonLoads && state.seasonLoads[state.season] === 'loading');
        if (poolLoading || seasonLoading) return { status: 'loading', items: [], target: null, selectedId: null };
        var items = selectCandidatesForEpisode(object, state, episode);
        var selectedId = seasonDefault ? seasonDefault.id : null;
        if (items.length) {
            return { status: 'ready', items: items, target: buildEpisodeTarget(object, state, episode), selectedId: selectedId };
        }
        // Settled with zero candidates — now split the same way row badges already do
        // (selectEpisodeBadges: 'ошибка поиска' vs 'раздачи не найдены'), instead of one identical
        // "Раздач не найдено" for both (product decision, CLAUDE.md consilium: empty and failed are
        // semantically opposite — nothing exists vs. the app couldn't check — and only a failure is
        // worth a retry affordance). 'error' additionally carries `retrySeason`: true so the View
        // knows this specific season can be manually retried (episodes.retrySeasonLoad).
        var poolFailed = state.poolStatus === 'error';
        var seasonFailed = !!(state.seasonLoads && state.seasonLoads[state.season] === 'error');
        if (poolFailed || seasonFailed) return { status: 'error', items: [], target: null, selectedId: null, retrySeason: true };
        return { status: 'empty', items: [], target: null, selectedId: null };
    }
