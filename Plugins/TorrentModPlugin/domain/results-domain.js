    // ---------- domain: composition root ----------
    //
    // Wires the Store + Episodes/Selection/Filters interactors together. A single shared lifecycle
    // `scope` lives here (not one destroy() per interactor) — both async interactors, and the View
    // once it's constructed with this domain, register their timers/subscriptions into it directly
    // (shared/core/lifecycle.js's `track`/`setTimeout`/`setInterval`/`subscribe`), so there's exactly
    // one place anything with a cleanup step plugs into, and exactly one dispose() call
    // (`destroy()`, below) that tears all of it down — not N separately-remembered destroy() methods
    // a future timer is one missed edit away from outliving its screen.
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

        // `scope` is the one lifecycle every async resource this screen owns registers into
        // (timers, the store subscriptions below AND the View's own, once it's constructed with
        // this domain as an option) — see lifecycle.js's own header for why this replaced two
        // separate ad hoc destroy() methods the interactors used to carry.
        var scope = createLifecycle();
        function isDestroyed() { return !scope.isAlive(); }

        var store = createStore(createInitialResultsState(object));
        applyPersistedPreferences(store, movie); // one initial patch, before anyone subscribes

        var episodes = createEpisodesInteractor({ store: store, object: object, movie: movie, hasSeasons: hasSeasons, isDestroyed: isDestroyed, scope: scope });
        var selection = createSelectionInteractor({ store: store, object: object, hasSeasons: hasSeasons, isDestroyed: isDestroyed, requery: episodes.requery, ensureSeasonLoaded: episodes.ensureSeasonLoaded, scope: scope });
        var filters = createFiltersInteractor({ store: store, movie: movie });

        // Film vs series — two genuinely different flows (see docs/system-design/torrent-mod-unified-pool.md,
        // Этап 2): a series shows the TMDB episode list + whole-work pool behind it; a movie has no
        // episode list, the candidate list IS the primary content, so we load the pool first and
        // then run the local pick (auto-play on a confident match, picker otherwise).
        function start() {
            log('domain', 'start(), hasSeasons=' + hasSeasons + ', movie.id=' + movie.id);
            if (hasSeasons) episodes.start();
            else {
                // Movie: start the whole-work pool and the movie presentation together. A movie has
                // no episode list to show meanwhile, and the pool is progressive: the first useful
                // indexer response must open the candidate list immediately while slower trackers
                // keep enriching it in the background. Waiting for loadAllTorrents's final callback
                // here used to discard that progressive property and kept the grid empty until the
                // slowest tracker completed. Before the first result there is still an explicit
                // message, so nothing leaves the user guessing whether a search against every
                // Jackett indexer is even running (it can legitimately take
                // ~40s on a genuinely cold search — reported directly by the user: "понятная
                // индикация поиска... очень важна для первых холодных поисков"). Set an explicit,
                // non-retryable loading message before kicking the search off; startMovie() keeps a
                // reactive presentation intent and replaces it as soon as `pool` gains a candidate.
                store.patch({ stage: 'message', message: { text: 'Ищем раздачи по всем трекерам…', retry: null } });
                var runtime = parseInt(movie.runtime, 10) || 0;
                if (runtime) store.patch({ avgRuntimeMinutes: runtime });
                episodes.loadAllTorrents();
                selection.startMovie();
            }
        }

        function destroy() {
            // Idempotent via scope.dispose() — a second destroy() call is a no-op instead of
            // re-running teardown. Every timer/subscription the interactors AND the View registered
            // into `scope` gets cleaned up here, in one call — neither interactor needs its own
            // destroy() method to remember to keep in sync with whatever timers it happens to have
            // added since (see scope's own header comment for the history behind this).
            var disposed = scope.dispose();
            log('domain', disposed ? 'destroy()' : 'destroy() — уже уничтожен, повторный вызов проигнорирован');
        }

        return {
            store: store,
            episodes: episodes,
            selection: selection,
            filters: filters,
            start: start,
            destroy: destroy,
            scope: scope
        };
    }
