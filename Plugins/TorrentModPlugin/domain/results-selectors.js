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
    //
    // CANDIDATES ARE CHECKED FIRST, before loading/error — the pool search is now progressive
    // (parallel-per-indexer, search/parallel-search.js): `state.pool` fills in as each tracker
    // answers, so an episode can genuinely have real candidates already while OTHER, slower trackers
    // are still being waited on. Showing "поиск…" for an episode that already has a real match would
    // hide data that's already there, exactly the "мучительно больно ждать" complaint this whole
    // redesign was for — requested directly by the user: "начать показывать торренты от самого
    // быстрого трекера". Only falls through to loading/error/empty once there's truly nothing yet.
    export function selectEpisodeBadges(object, state, seasonDefault) {
        var poolSettling = state.poolStatus === 'loading' || state.poolStatus === 'idle';
        var seasonLoading = !!(state.seasonLoads && state.seasonLoads[state.season] === 'loading');
        // A genuinely FAILED search (every tracker errored/timed out, or this season's own lazy
        // per-season retry failing too) used to be visually identical to "searched cleanly, found
        // nothing" — badgeText's own "раздачи не найдены" doesn't know the difference, it just sees
        // an empty candidates array either way. Reported directly by the user testing this exact
        // path live — badges now say so explicitly instead of quietly implying "confirmed empty".
        var poolFailed = state.poolStatus === 'error';
        var seasonFailed = !!(state.seasonLoads && state.seasonLoads[state.season] === 'error');
        var map = {};
        (state.episodesCache || []).forEach(function (episode) {
            var number = parseInt(episode.episode_number, 10);
            var candidates = selectCandidatesForEpisode(object, state, number);
            if (candidates.length) {
                map[number] = { text: badgeText(candidates, seasonDefault), loading: false };
            } else if (poolSettling || seasonLoading) {
                map[number] = { text: 'поиск…', loading: true };
            } else if (poolFailed || seasonFailed) {
                map[number] = { text: 'ошибка поиска', loading: false };
            } else {
                map[number] = { text: badgeText(candidates, seasonDefault), loading: false }; // 'раздачи не найдены'
            }
        });
        return map;
    }

    // Per-tracker progress for the CURRENT pool search — one entry per CONFIGURED indexer (not just
    // the ones that have answered so far), each `{id, name, status, error, elapsedMs, reportedAt}`
    // where status is `'pending'` (not in state.poolIndexers yet — the widget renders this with a
    // spinner, requested directly by the user: "показывать со спиннером кого ещё ждём"), `'ok'`, or
    // `'error'`. Diffs `state.poolAllIndexers` (the full configured list, known from the job's own
    // /start response — see results-state.js) against `state.poolIndexers` (who's actually reported
    // so far) to derive this — nothing here is itself stored.
    //
    // Deliberately reports EVERY indexer forever, with no time-based hiding of its own — how long
    // a successfully-answered chip stays visible before it fades is a presentation decision, not a
    // domain fact, and belongs entirely to the View (ui/results-screen.js's own
    // TRACKER_SUCCESS_HIDE_MS + per-chip scheduling). An earlier version filtered stale 'ok'
    // entries out right here and had episodes-interactor.js schedule the actual hide as a
    // store.patch — corrected directly by the user ("таймер фейда — это UI логика, а не домена...
    // Процесс поиска спокойно наполняет стор, а во вьюмодели создаются мягкий плавный вид"): this
    // selector's only job is reshaping already-stored facts, and `reportedAt` is passed through
    // unfiltered so the View can compute its own remaining-time-until-hide from it.
    // `pending`/`total` stay as plain counts too, for callers that just want the aggregate (there
    // are none today, kept for symmetry/debuggability).
    export function selectPoolIndexers(state) {
        var reported = {};
        (state.poolIndexers || []).forEach(function (indexer) { reported[indexer.id] = indexer; });
        var trackers = [];
        var pending = 0;
        (state.poolAllIndexers || []).forEach(function (configured) {
            var indexer = reported[configured.id];
            if (!indexer) {
                pending++;
                trackers.push({ id: configured.id, name: configured.name, status: 'pending', error: null, elapsedMs: null, reportedAt: null });
                return;
            }
            trackers.push({
                id: indexer.id, name: indexer.name, status: indexer.ok ? 'ok' : 'error',
                error: indexer.error, elapsedMs: indexer.elapsedMs, reportedAt: indexer.reportedAt
            });
        });
        return { trackers: trackers, pending: pending, total: (state.poolAllIndexers || []).length };
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
        // state.pool is now ALWAYS an array (results-state.js), never null — calling
        // selectCandidatesForEpisode unconditionally is safe by construction, not just because
        // something upstream happens to gate it (a real, live-caught crash — `TypeError: Cannot
        // read properties of null (reading 'filter')` — came from exactly that assumption breaking
        // once, see CLAUDE.md; making `pool` structurally non-null removes the whole bug class
        // instead of relying on every caller remembering to check first).
        //
        // CANDIDATES ARE CHECKED FIRST, before loading/error, for the same reason
        // selectEpisodeBadges now does: the pool search is progressive, so this episode may already
        // have real candidates while other, slower trackers are still being waited on — showing
        // "Ищем раздачи…" over data that's already there would hide it (requested directly by the
        // user: "начать показывать торренты от самого быстрого трекера").
        var items = selectCandidatesForEpisode(object, state, episode);
        var selectedId = seasonDefault ? seasonDefault.id : null;
        if (items.length) {
            return { status: 'ready', items: items, target: buildEpisodeTarget(object, state, episode), selectedId: selectedId };
        }
        var poolSettling = state.poolStatus === 'loading' || state.poolStatus === 'idle';
        var seasonLoading = !!(state.seasonLoads && state.seasonLoads[state.season] === 'loading');
        if (poolSettling || seasonLoading) return { status: 'loading', items: [], target: null, selectedId: null };
        // Settled with zero candidates — split the same way row badges already do
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
