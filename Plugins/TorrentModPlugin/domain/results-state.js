    import { createInitialState } from './results-core.js';

    export function createInitialResultsState(object) {
        var base = createInitialState(object); // season, voiceType, resolution, bitrate — unchanged shape
        return Object.assign(base, {
            episodesStatus: 'idle',   // 'idle' | 'loading' | 'ready' | 'error' (TMDB season list)
            poolStatus: 'idle',       // the whole-work torrent pool (all seasons for a series)
            searchStatus: 'idle',     // explicit manual-query search (customQuery only)

            seasonGeneration: 0,      // guards TMDB season-list fetches (season-scoped)
            poolGeneration: 0,        // guards whole-work pool fetches (pool/requery)
            searchGeneration: 0,      // guards explicit manual-query searches

            poolStartedAt: null,
            poolAttempt: 1,
            poolAutoRetryAt: null,

            // Data
            episodesCache: null,      // TMDB season episodes (scoped to state.season)
            pool: [],
            poolIndexers: [],
            poolAllIndexers: [],
            seasonEpisodeCount: 0,
            avgRuntimeMinutes: 0,

            seasonLoads: {},

            stage: 'episodes',        // 'episodes' | 'candidates' | 'message'
            candidates: null,         // { items, target, canReturnToEpisodeList } | null
            message: null,            // { text, retry: Function|null } | null — retry, when present, is

            statusText: '',           // head status line ("Ищем S03E03…", "Загрузка списка серий…")
            searchText: '',           // toolbar search box text
            lastEpisode: 0,
            activeEpisode: 0,
            customQuery: null,
            englishTitle: null,

            picker: {
                open: false,
                episode: 0
            }
        });
    }
