    // ---------- domain: composition root ----------
    //
    // Wires the Store + Episodes/Selection/Filters interactors together. A single shared `destroyed`
    // flag lives here (not one per interactor) — both async interactors read the same `isDestroyed`
    // function, so there's exactly one place a future third interactor would need to plug into, not
    // one flag per file to keep in sync.
    //
    // playback/smart-preload.js is deliberately NOT wired in here as another interactor sharing this
    // store — its overlay is appended directly to `$('body')` and its own `Lampa.Controller.add`
    // entry, entirely outside the Lampa.Explorer/Scroll/Filter/`content`-controller tree the results
    // View owns, and its lifetime is deliberately *decoupled* from this screen's (startDownload
    // registers the torrent with TorrServer directly and starts playback via Lampa.Player.play,
    // keeping its own timers polling after the results Activity is gone, by design — see
    // playback/smart-preload.js's own header comment). Folding it in would
    // mean either the Store carrying state nothing in this domain's own render loop ever reads, or
    // special-casing domain.destroy() to *not* cancel it. It stays a plain function call across a
    // module boundary (selection-interactor.js's playCandidate/finishSelection call startDownload
    // directly), same shape as every other data-layer module this domain already calls into.
    import { createStore } from './store.js';
    import { createInitialResultsState } from './results-state.js';
    import { applyPersistedPreferences } from './filters-interactor.js';
    import { createEpisodesInteractor } from './episodes-interactor.js';
    import { createSelectionInteractor } from './selection-interactor.js';
    import { createFiltersInteractor } from './filters-interactor.js';

    export function createResultsDomain(options) {
        var object = options.object;
        var movie = options.movie;
        var hasSeasons = options.hasSeasons;

        var destroyed = false;
        function isDestroyed() { return destroyed; }

        var store = createStore(createInitialResultsState(object));
        applyPersistedPreferences(store, movie); // one initial patch, before anyone subscribes

        var episodes = createEpisodesInteractor({ store: store, object: object, movie: movie, hasSeasons: hasSeasons, isDestroyed: isDestroyed });
        var selection = createSelectionInteractor({ store: store, object: object, hasSeasons: hasSeasons, isDestroyed: isDestroyed, requery: episodes.requery, ensureSeasonLoaded: episodes.ensureSeasonLoaded });
        var filters = createFiltersInteractor({ store: store, movie: movie });

        // Film vs series — two genuinely different flows (see docs/system-design/torrent-mod-unified-pool.md,
        // Этап 2): a series shows the TMDB episode list + whole-work pool behind it; a movie has no
        // episode list, the candidate list IS the primary content, so we load the pool first and
        // then run the local pick (auto-play on a confident match, picker otherwise).
        function start() {
            if (hasSeasons) episodes.start();
            else {
                // A movie has no per-episode runtime from TMDB season data — use its own runtime so
                // the estimated bitrate (and the Битрейт filter buckets) is not off by the 42-min
                // fallback (found in review).
                var runtime = parseInt(movie.runtime, 10) || 0;
                if (runtime) store.patch({ avgRuntimeMinutes: runtime });
                episodes.loadAllTorrents(function () { selection.selectEpisode(0); });
            }
        }

        function destroy() {
            destroyed = true;
        }

        return {
            store: store,
            episodes: episodes,
            selection: selection,
            filters: filters,
            start: start,
            destroy: destroy
        };
    }
