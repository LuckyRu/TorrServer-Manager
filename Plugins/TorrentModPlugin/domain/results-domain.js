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

        var scope = createLifecycle();
        function isDestroyed() { return !scope.isAlive(); }

        var store = createStore(createInitialResultsState(object));
        applyPersistedPreferences(store, movie); // one initial patch, before anyone subscribes

        var episodes = createEpisodesInteractor({ store: store, object: object, movie: movie, hasSeasons: hasSeasons, isDestroyed: isDestroyed, scope: scope });
        var selection = createSelectionInteractor({ store: store, object: object, hasSeasons: hasSeasons, isDestroyed: isDestroyed, requery: episodes.requery, ensureSeasonLoaded: episodes.ensureSeasonLoaded, scope: scope });
        var filters = createFiltersInteractor({ store: store, movie: movie });

        function start() {
            log('domain', 'start(), hasSeasons=' + hasSeasons + ', movie.id=' + movie.id);
            if (hasSeasons) episodes.start();
            else {
                store.patch({ stage: 'message', message: { text: 'Ищем раздачи по всем трекерам…', retry: null } });
                var runtime = parseInt(movie.runtime, 10) || 0;
                if (runtime) store.patch({ avgRuntimeMinutes: runtime });
                episodes.loadAllTorrents();
                selection.startMovie();
            }
        }

        function destroy() {
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
