    // ---------- query building ----------
    import { enabled, pad, compact, unique } from '../shared/utils.js';

    export function baseTitles(movie) {
        return unique([
            movie.title || movie.name,
            movie.original_title || movie.original_name
        ].filter(Boolean), function (title) { return compact(title); });
    }

    export function buildQueries(target) {
        if (target.customQuery) return [target.customQuery];

        var titles = baseTitles(target.movie);
        var queries = [];

        if (target.episode) {
            var exact = 'S' + pad(target.season) + 'E' + pad(target.episode);
            titles.forEach(function (title) { queries.push(title + ' ' + exact); });
        }
        if (target.season) {
            var pack = 'S' + pad(target.season);
            titles.forEach(function (title) { queries.push(title + ' ' + pack); });
            if (enabled('torrent_mod_query_russian', true) && titles[0]) {
                queries.push(titles[0] + ' ' + target.season + ' сезон');
            }
        }
        if (!target.season) {
            titles.forEach(function (title) { queries.push(title); });
        }

        return unique(queries, compact).slice(0, 4);
    }
