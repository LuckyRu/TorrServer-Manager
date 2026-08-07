    // ---------- domain: state shape ----------
    //
    // Plain data only — no Promises, no DOM, nothing that isn't renderable/comparable. The old
    // results-viewmodel.js kept a live `seasonPoolPromise` on its state object; that's dropped here
    // on purpose — storing a Promise inside an observable store is itself a smell (nothing a
    // subscriber does should ever branch on "is there a Promise present"). seasonPoolStatus (a
    // string enum) + seasonGeneration (a counter) replace exactly what that field was doing
    // (in-flight dedup + staleness), as plain, renderable, comparable data instead.
    import { createInitialState } from './results-core.js';

    export function createInitialResultsState(object) {
        var base = createInitialState(object); // season, voiceType, resolution — unchanged shape
        return Object.assign(base, {
            // Per-resource status — "local" waiting states. Three separate fields, not one combined
            // enum, because each drives a genuinely independent piece of UI (grid content vs. badge
            // column vs. head status text) that can be true/loading/etc. independently of the others.
            episodesStatus: 'idle',   // 'idle' | 'loading' | 'ready' | 'error'
            seasonPoolStatus: 'idle',
            searchStatus: 'idle',

            // Dependency/staleness identity. A monotonic counter closes a real gap plain value
            // comparison can't: switching season 2 -> 3 -> 2 again quickly, the *first* season-2
            // request's late response would pass a naive "season !== requestedSeason" check (season
            // really is 2 again!) even though a second, newer season-2 fetch is also in flight and
            // should win. Each interactor call that starts a fresh async op bumps the relevant
            // generation and captures it; the response is only trusted if the store's generation for
            // that key still matches when it resolves.
            seasonGeneration: 0,
            searchGeneration: 0,

            // Data
            episodesCache: null,
            seasonPool: null,
            seasonEpisodeCount: 0,
            avgRuntimeMinutes: 0,

            // What the grid area currently shows, and its payload — replaces the old code's implicit
            // "whichever render function was last called wins" with an explicit, renderable value.
            stage: 'episodes',        // 'episodes' | 'candidates' | 'message'
            candidates: null,         // { items, target, canReturnToEpisodeList } | null
            message: null,            // { text, retry: boolean } | null

            statusText: '',           // head status line ("Ищем S03E03…", "Загрузка списка серий…")
            searchText: '',           // toolbar search box text
            lastEpisode: 0,
            customQuery: null
        });
    }
