    // ---------- query building ----------
    import { enabled, pad, compact, unique } from '../shared/utils.js';

    // `englishTitle` (optional — metadata/tmdb.js's fetchEnglishTitle, threaded through domain
    // state as state.englishTitle) is a TMDB en-US lookup, separate from `original_title` — for
    // Western content the two are the same string (harmless: unique() below dedupes them into one
    // query/one match candidate), but for Asian-origin content `original_title` is the SOURCE
    // LANGUAGE title (native script or its own romanization), which Russian-scene trackers almost
    // never use — they follow "Russian title / ENGLISH title", never the native-script one.
    // Requested directly by the user after confirming this live: "используя язык оригинала на
    // русских торрентах это пиздец. Надо использовать английский перевод из TMDB для поиска."
    export function baseTitles(movie, englishTitle) {
        return unique([
            movie.title || movie.name,
            movie.original_title || movie.original_name,
            englishTitle
        ].filter(Boolean), function (title) { return compact(title); });
    }

    // The default search name — built from Lampa's own "язык поиска" setting (parse_lang), the same
    // one the native torrent screen uses to build its query (vendor/lampa-source/src/components/full/start/torrents.js):
    // original_title/title + year combinations, default 'df' = original_title. Falls back to the
    // localized title if the chosen combo comes up empty (e.g. no original title on the card).
    // `englishTitle`, when available, is used in place of `original_title` for every 'df'-family
    // combo — see baseTitles' own comment for why a native-script original is actively harmful as
    // a SEARCH QUERY on Russian trackers, not just a weaker match target.
    export function defaultSearchName(movie, englishTitle) {
        try {
            var format = Lampa.Storage.field('parse_lang') || 'df';
            var title = movie.title || movie.name || '';
            var original = englishTitle || movie.original_title || movie.original_name || '';
            var year = String(movie.first_air_date || movie.release_date || '0000').slice(0, 4);
            var combos = {
                'df': original,
                'df_year': original + ' ' + year,
                'df_lg': original + ' ' + title,
                'df_lg_year': original + ' ' + title + ' ' + year,
                'lg': title,
                'lg_year': title + ' ' + year,
                'lg_df': title + ' ' + original,
                'lg_df_year': title + ' ' + original + ' ' + year
            };
            var value = String(combos[format] || '').trim();
            return value || title;
        } catch (e) {
            return movie.title || movie.name || '';
        }
    }

    export function buildQueries(target) {
        // A manual name override (customQuery) replaces the movie's own titles as the search name —
        // the plugin was launched from an already-found TMDB card, so this is a *disambiguation* of
        // the torrent search under the current season/episode context, not a new-movie search (see
        // selection-interactor.js). Season/episode suffixes still apply, exactly like the normal path.
        //
        // Queries are built from ONE name only, not both localized+original: every extra query is a
        // separate /api/torrent-search round trip, and the original-title duplicate used to add
        // three of them on first screen open (e.g. «Футурама S02» + «Futurama S02» + «Футурама
        // 2 сезон»). Jackett already aggregates all indexers and dedups results across queries, so
        // the only thing the duplicate names bought was extra network load, not extra recall.
        // Which one name: Lampa's own parse_lang setting (see defaultSearchName above).
        var name = target.customQuery || defaultSearchName(target.movie, target.englishTitle);
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
            // Whole-work pool (season=0): exactly ONE query — the title. A second variant with the
            // release year was tried and removed: Jackett returns the same releases for «Футурама»
            // and «Футурама 1999», so the extra round trip bought nothing but load.
            queries.push(name);
        }

        return unique(queries, compact).slice(0, 4);
    }
