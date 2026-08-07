    // ---------- query building ----------
    import { enabled, pad, compact, unique } from '../shared/utils.js';

    export function baseTitles(movie) {
        return unique([
            movie.title || movie.name,
            movie.original_title || movie.original_name
        ].filter(Boolean), function (title) { return compact(title); });
    }

    export function buildQueries(target) {
        // A manual name override (customQuery) replaces the movie's own titles as the search name —
        // the plugin was launched from an already-found TMDB card, so this is a *disambiguation* of
        // the torrent search under the current season/episode context, not a new-movie search (see
        // selection-interactor.js). Season/episode suffixes still apply, exactly like the normal path.
        var names = target.customQuery ? [target.customQuery] : baseTitles(target.movie);
        var queries = [];

        if (target.episode) {
            var exact = 'S' + pad(target.season) + 'E' + pad(target.episode);
            names.forEach(function (title) { queries.push(title + ' ' + exact); });
        }
        if (target.season) {
            var pack = 'S' + pad(target.season);
            names.forEach(function (title) { queries.push(title + ' ' + pack); });
            if (!target.customQuery && enabled('torrent_mod_query_russian', true) && names[0]) {
                queries.push(names[0] + ' ' + target.season + ' сезон');
            }
        }
        if (!target.season) {
            names.forEach(function (title) { queries.push(title); });
        }

        return unique(queries, compact).slice(0, 4);
    }
