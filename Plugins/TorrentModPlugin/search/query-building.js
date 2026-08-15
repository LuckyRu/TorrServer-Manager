    // ---------- query building ----------
    import { enabled, pad, unique } from '../shared/utils.js';
    import { workFamily, prefersLocalTitle } from './work-profile.js';

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

    export { isAnimeTarget } from './work-profile.js';

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

    // Настройка Lampa parse_lang по умолчанию даёт оригинальное название. Для корейского,
    // японского и китайского это письмо, которого нет в индексе русских трекеров, — такой
    // запрос возвращает случайную свежую выдачу, а не «ничего не найдено».
    function hasSearchableLetters(value) {
        return /[a-zа-яё]/i.test(String(value || ''));
    }

    export function queryNames(target) {
        var movie = (target && target.movie) || {};
        var local = movie.title || movie.name || '';
        var preferred = defaultSearchName(movie, target && target.englishTitle, target && target.includeYear);
        var ordered = prefersLocalTitle(workFamily(target))
            ? [local, target && target.englishTitle, preferred]
            : [preferred, hasSearchableLetters(preferred) ? '' : local, hasSearchableLetters(preferred) ? '' : (target && target.englishTitle)];
        return unique(ordered.filter(Boolean), normalizedTitleKey);
    }

    export function buildQueries(target) {
        var names = queryNames(target);
        if (!names.length) return [];
        var queries = [];

        // Второе название добавляется только там, где первое заведомо не ищется, — цена запроса
        // это отдельный job на каждый трекер с собственными ретраями.
        names.slice(0, 2).forEach(function (name) {
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
        });

        return unique(queries, normalizedTitleKey).slice(0, 4);
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
