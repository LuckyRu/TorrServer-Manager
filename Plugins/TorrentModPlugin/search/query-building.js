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
        //
        // Queries are built from ONE name (the localized title) only, not both localized+original:
        // every extra query is a separate /api/torrent-search round trip, and the original-title
        // duplicate used to add three of them on first screen open (e.g. «Футурама S02» + «Futurama
        // S02» + «Футурама 2 сезон»). Jackett already aggregates all indexers and dedups results
        // across queries, so the only thing the duplicate names bought was extra network load, not
        // extra recall — Russian trackers title releases with the localized name anyway. Max two
        // queries: localized name + Sxx, plus the «N сезон» variant when that setting is on.
        var name = (target.customQuery ? [target.customQuery] : baseTitles(target.movie))[0];
        if (!name) return [];
        var queries = [];

        if (target.episode) {
            queries.push(name + ' S' + pad(target.season) + 'E' + pad(target.episode));
        }
        if (target.season) {
            queries.push(name + ' S' + pad(target.season));
            if (!target.customQuery && enabled('torrent_mod_query_russian', true)) {
                queries.push(name + ' ' + target.season + ' сезон');
            }
        }
        if (!target.season) {
            queries.push(name);
        }

        return unique(queries, compact).slice(0, 4);
    }
