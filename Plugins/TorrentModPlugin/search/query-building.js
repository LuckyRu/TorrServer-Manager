    // ---------- query building ----------
    import { enabled, pad, compact, unique } from '../shared/utils.js';

    export function normalizedTitleKey(value) {
        var source = String(value || '');
        try { source = source.normalize('NFKC'); } catch (e) {}
        return source.toLowerCase().replace(/[^a-z0-9а-яё\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]+/gi, ' ').trim();
    }

    export function baseTitles(movie, englishTitle) {
        return unique([
            movie.title || movie.name,
            movie.original_title || movie.original_name,
            englishTitle
        ].filter(Boolean), normalizedTitleKey);
    }

    export function isAnimeTarget(target) {
        target = target || {};
        if (target.mode && target.mode !== 'series') return false;
        var movie = target.movie || {};
        var language = String(movie.original_language || '').toLowerCase();
        var countries = Array.isArray(movie.origin_country)
            ? movie.origin_country.map(function (country) { return String(country || '').toUpperCase(); })
            : [];
        var genres = (Array.isArray(movie.genre_ids) ? movie.genre_ids : [])
            .map(function (genre) { return String(genre); });
        var genreNames = (Array.isArray(movie.genres) ? movie.genres : [])
            .map(function (genre) { return String(genre && (genre.name || genre) || '').toLowerCase(); });
        var animation = genres.indexOf('16') >= 0 || genreNames.some(function (name) {
            return /animation|анимац|мультфильм|мультсериал|动画|アニメ|애니/.test(name);
        });
        var asian = ['ja', 'zh', 'ko'].indexOf(language) >= 0 || countries.some(function (country) {
            return ['JP', 'CN', 'KR'].indexOf(country) >= 0;
        });
        return animation && asian;
    }

    export function searchNames(target) {
        target = target || {};
        var movie = target.movie || {};
        return unique([
            movie.title || movie.name,
            movie.original_title || movie.original_name,
            target.englishTitle
        ].filter(Boolean), normalizedTitleKey).slice(0, 4);
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

    export function buildAnimeQueries(target) {
        target = target || {};
        var names = searchNames(target);
        if (!names.length) return [];
        var queries = [];

        // Anime indexers usually expose season packs by alias alone; keep these first for fast initial results.
        names.forEach(function (name) { queries.push(name); });

        if (target.episode) {
            var episode = pad(target.episode);
            names.slice(0, 2).forEach(function (name) {
                queries.push(name + ' S' + pad(target.season) + 'E' + episode);
                queries.push(name + ' E' + episode);
            });
        }
        if (target.season) {
            var season = parseInt(target.season, 10) || 0;
            var padded = pad(season);
            names.slice(0, 3).forEach(function (name) {
                queries.push(name + ' S' + padded);
                queries.push(name + ' TV-' + season);
                queries.push(name + ' ' + season + ' сезон');
                queries.push(name + ' ' + season + ' Season');
            });
        }
        return unique(queries, normalizedTitleKey).slice(0, 12);
    }
