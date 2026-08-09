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
    import { createLifecycle } from '../shared/core/lifecycle.js';
    import { log } from '../shared/core/log.js';

    export function createResultsDomain(options) {
        var object = options.object;
        var movie = options.movie;
        var hasSeasons = options.hasSeasons;

        var lifecycle = createLifecycle();
        function isDestroyed() { return !lifecycle.isAlive(); }

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
            log('domain', 'start(), hasSeasons=' + hasSeasons + ', movie.id=' + movie.id);
            if (hasSeasons) episodes.start();
            else {
                // Movie: load the whole-work pool, then run the movie flow (auto-play a persisted
                // pick if any, otherwise show the torrent list). A movie has no episode list to
                // show meanwhile — until loadAllTorrents resolves, `stage` never leaves its initial
                // default and the grid stays completely empty, with nothing at all telling the user
                // a search against every Jackett indexer is even running (can legitimately take
                // ~40s on a genuinely cold search — reported directly by the user: "понятная
                // индикация поиска... очень важна для первых холодных поисков"). Set an explicit,
                // non-retryable loading message before kicking the search off; startMovie() (called
                // once loadAllTorrents resolves) always replaces it with the real candidate list or
                // its own "Раздач не нашлось" message, so this is only ever visible for the
                // duration of the search itself.
                store.patch({ stage: 'message', message: { text: 'Ищем раздачи по всем трекерам…', retry: null } });
                var runtime = parseInt(movie.runtime, 10) || 0;
                if (runtime) store.patch({ avgRuntimeMinutes: runtime });
                episodes.loadAllTorrents(function () { selection.startMovie(); });
            }
        }

        function destroy() {
            // Idempotent via lifecycle.dispose() — a second destroy() call is a no-op instead of
            // re-running teardown.
            var disposed = lifecycle.dispose(function () {
                // Cancel interactor timers (pending-retry) that would otherwise outlive the screen.
                if (selection.destroy) selection.destroy();
            });
            log('domain', disposed ? 'destroy()' : 'destroy() — уже уничтожен, повторный вызов проигнорирован');
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
