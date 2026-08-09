    // ---------- domain: state shape ----------
    //
    // Plain data only — no Promises, no DOM, nothing that isn't renderable/comparable. The old
    // results-viewmodel.js kept a live `seasonPoolPromise` on its state object; that's dropped here
    // on purpose — storing a Promise inside an observable store is itself a smell (nothing a
    // subscriber does should ever branch on "is there a Promise present"). Status enums + generation
    // counters replace exactly what that field was doing (in-flight dedup + staleness), as plain,
    // renderable, comparable data instead.
    import { createInitialState } from './results-core.js';

    export function createInitialResultsState(object) {
        var base = createInitialState(object); // season, voiceType, resolution, bitrate — unchanged shape
        return Object.assign(base, {
            // Per-resource status — "local" waiting states. Three separate fields, not one combined
            // enum, because each drives a genuinely independent piece of UI (grid content vs. badge
            // column vs. head status text) that can be true/loading/etc. independently of the others.
            episodesStatus: 'idle',   // 'idle' | 'loading' | 'ready' | 'error' (TMDB season list)
            poolStatus: 'idle',       // the whole-work torrent pool (all seasons for a series)
            searchStatus: 'idle',     // explicit manual-query search (customQuery only)

            // Dependency/staleness identity. A monotonic counter closes a real gap plain value
            // comparison can't: switching season 2 -> 3 -> 2 again quickly, the *first* season-2
            // request's late response would pass a naive "season !== requestedSeason" check (season
            // really is 2 again!) even though a second, newer season-2 fetch is also in flight and
            // should win. Each interactor call that starts a fresh async op bumps the relevant
            // generation and captures it; the response is only trusted if the store's generation for
            // that key still matches when it resolves.
            seasonGeneration: 0,      // guards TMDB season-list fetches (season-scoped)
            poolGeneration: 0,        // guards whole-work pool fetches (pool/requery)
            searchGeneration: 0,      // guards explicit manual-query searches

            // Cosmetic-only timing/counter data for the search-progress widget (selectSearchProgress,
            // results-selectors.js) — none of these three have any gating role, generation counters
            // above already own staleness. poolStartedAt escalates the head status line's wording
            // past ~15s of a cold search; poolAttempt is a display-only "попытка N" counter bumped
            // by requery() whenever it's explicitly called as a retry (auto or manual) rather than a
            // fresh query context; poolAutoRetryAt is when episodes-interactor.js's own scheduled
            // auto-retry (POOL_RETRY_DELAYS_MS, shared/state.js) will next fire, or null when none is
            // pending — read by selectSearchProgress to show a live, honest "повтор через Nс" instead
            // of silently retrying in the background (required directly by the user after a real
            // repeated-search-failure report; see episodes-interactor.js's own comment).
            poolStartedAt: null,
            poolAttempt: 1,
            poolAutoRetryAt: null,

            // Data
            episodesCache: null,      // TMDB season episodes (scoped to state.season)
            // ALWAYS an array, never null — the pool search is now progressive (parallel-per-
            // indexer, search/parallel-search.js): results merge in as each tracker answers, so
            // "not settled yet" and "genuinely empty" are BOTH representable as `[]`, distinguished
            // by poolStatus alone. Used to start `null` specifically to mean "hasn't even started" —
            // a real, live-caught crash (`TypeError: Cannot read properties of null (reading
            // 'filter')`, see CLAUDE.md) came from code that forgot pool could be null and touched
            // it anyway; making it structurally always-an-array removes that whole class of bug
            // rather than relying on every caller remembering to check first.
            pool: [],
            // Per-tracker progress for the CURRENT pool search — `{id, name, ok, error, elapsedMs,
            // reportedAt}` per indexer, appended as each one answers (fastest first), reset to `[]`
            // at the start of every fresh search. Lets the widget show which specific tracker is
            // slow/broken instead of one opaque "Ищем…" for the whole aggregate — requested directly
            // by the user ("будет визуально видно какой трекер говнит"). `reportedAt` (a plain
            // Date.now() timestamp, set when the entry is appended) drives the widget's own
            // hide-successful-after-a-few-seconds declutter behaviour (selectPoolIndexers).
            poolIndexers: [],
            // The FULL configured-indexer list for the CURRENT pool search — `{id, name}[]`, set
            // once from /api/torrent-search/start's own response (search/parallel-search.js's
            // onIndexerList callback), before any individual indexer has necessarily answered.
            // selectPoolIndexers diffs this against poolIndexers to render every not-yet-reported
            // tracker as its own named, spinning "pending" chip — requested directly by the user
            // ("в панели показывать со спиннером кого ещё ждём"), not just an opaque count.
            poolAllIndexers: [],
            seasonEpisodeCount: 0,
            avgRuntimeMinutes: 0,

            // Per-season lazy-load coverage (whole-work pool may miss season-specific releases due
            // to Jackett's per-query result limit — no pagination). seasonLoads[season] is
            // 'idle' | 'loading' | 'ready' | 'error': a season is fetched on demand (only when the
            // local pool has zero candidates for it), merged into pool, and never re-fetched until
            // the query context changes (requery resets this map). Plain data, no Promises.
            seasonLoads: {},

            // What the grid area currently shows, and its payload — replaces the old code's implicit
            // "whichever render function was last called wins" with an explicit, renderable value.
            stage: 'episodes',        // 'episodes' | 'candidates' | 'message'
            candidates: null,         // { items, target, canReturnToEpisodeList } | null
            message: null,            // { text, retry: Function|null } | null — retry, when present, is
                                       // called directly by the View on the retry row's hover:enter
                                       // (not a boolean flag dispatched to a hardcoded function — a
                                       // plain function reference here is fine, this is the same kind
                                       // of value onLoaded/onComplete callbacks already carry through
                                       // this codebase; the "plain data only" rule above is about
                                       // never storing a live Promise, not about banning functions)

            statusText: '',           // head status line ("Ищем S03E03…", "Загрузка списка серий…")
            searchText: '',           // toolbar search box text
            lastEpisode: 0,
            // The episode currently under focus / most recently active — REACTIVE state, dispatched
            // by the view on row focus and read back on picker close to restore the cursor exactly
            // where the user was (no view-closure bookkeeping). Persisted via
            // torrent_mod_last_episode for reopen (selection-interactor).
            activeEpisode: 0,
            customQuery: null,

            // Side picker panel (right-arrow on an episode row): candidates for one episode, shown
            // in a slide-in panel instead of the full-screen candidates stage. ONLY the UI intent
            // lives here — is it open, for which episode. items/status/target/selectedId used to be
            // stored here too, imperatively populated by an interactor call (fillPicker) threaded
            // through a manual "call me back once you know more" callback into ensureSeasonLoaded —
            // the shared root cause of two separate infinite-recursion crashes (see CLAUDE.md).
            // They're now selectPickerData's job (results-selectors.js): a pure derivation over
            // state.pool/seasonLoads/customQuery/poolStatus + picker.episode, recomputed on every
            // render exactly like selectEpisodeBadges already does for the row badges — there is
            // nothing here that can go stale or need a retry-callback to refresh, because it isn't
            // stored at all.
            picker: {
                open: false,
                episode: 0
            }
        });
    }
