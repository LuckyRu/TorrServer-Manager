// ---------- Torrent Mod component composition root ----------
//
// The Lampa registration stays one component, while movie and series get separate ViewModel and
// View factories. This keeps the public Component contract stable and makes a movie playback bug
// impossible to hide inside the series screen's lifecycle.
import { isSeriesWithSeasons } from '../domain/results-core.js';
import { createMovieResultsViewModel } from '../domain/movie-results-viewmodel.js';
import { createSeriesResultsViewModel } from '../domain/series-results-viewmodel.js';
import { createMovieResultsView } from './movie-results-view.js';
import { createSeriesResultsView } from './series-results-view.js';
import { cancelSearch } from '../shared/utils.js';

export function TorrentModComponent(object) {
    var movie = object.movie || {};
    var series = isSeriesWithSeasons(movie);
    var viewModel = series
        ? createSeriesResultsViewModel({ object: object, movie: movie })
        : createMovieResultsViewModel({ object: object, movie: movie });
    var view = series
        ? createSeriesResultsView({ object: object, movie: movie, domain: viewModel })
        : createMovieResultsView({ object: object, movie: movie, domain: viewModel });

    this.create = function () { return view.create(); };
    this.render = function (js) { return view.render(js); };
    this.start = function () { view.start(); viewModel.start(); };
    this.pause = function () {};
    this.stop = function () {};
    this.destroy = function () {
        cancelSearch();
        viewModel.destroy();
        view.destroy();
    };
}
