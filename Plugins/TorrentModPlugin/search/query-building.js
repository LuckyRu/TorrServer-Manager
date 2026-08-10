    // ---------- query building ----------
    import { enabled, pad, compact, unique } from '../shared/utils.js';

    export function baseTitles(movie, englishTitle) {
        return unique([
            movie.title || movie.name,
            movie.original_title || movie.original_name,
            englishTitle
        ].filter(Boolean), function (title) { return compact(title); });
    }

    export function defaultSearchName(movie, englishTitle, includeYear) {
        try {
            var format = Lampa.Storage.field('parse_lang') || 'df';
            if (includeYear === false) format = format.replace(/_year$/, '');
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
        var name = defaultSearchName(target.movie, target.englishTitle, target.includeYear);
        if (!name) return [];
        var queries = [];

        if (target.episode) {
            queries.push(name + ' S' + pad(target.season) + 'E' + pad(target.episode));
        }
        if (target.season) {
            queries.push(name + ' S' + pad(target.season));
            if (enabled('torrent_mod_query_russian', true)) {
                queries.push(name + ' ' + target.season + ' сезон');
            }
        }
        if (!target.season) {
            queries.push(name);
        }

        return unique(queries, compact).slice(0, 4);
    }
