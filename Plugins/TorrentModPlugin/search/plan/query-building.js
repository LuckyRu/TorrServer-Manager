    // ---------- query building ----------
    import { enabled, pad, unique } from '../../shared/utils.js';
    import { MODE_MOVIE } from '../../shared/state.js';
    import { workFamily, prefersLocalTitle } from '../profile/work-profile.js';

    // Разбор одного заголовка вызывает нормализацию около полусотни раз, и аргументы повторяются:
    // названия и алиасы цели одни и те же для всей выдачи трекера. NFKC плюс Unicode-regex дороги,
    // поэтому результат кэшируется. Кэш ограничен и сбрасывается целиком: приложение живёт на
    // телевизоре неделями, а вытеснение по одному здесь не окупает своей сложности.
    var NORMALIZED_CACHE_MAX = 2000;
    var normalizedCache = Object.create(null);
    var normalizedCacheSize = 0;

    export function normalizedTitleKey(value) {
        var source = String(value || '');
        var cached = normalizedCache[source];
        if (cached !== undefined) return cached;
        var normalized = normalizeTitleValue(source);
        if (normalizedCacheSize >= NORMALIZED_CACHE_MAX) {
            normalizedCache = Object.create(null);
            normalizedCacheSize = 0;
        }
        normalizedCache[source] = normalized;
        normalizedCacheSize++;
        return normalized;
    }

    function normalizeTitleValue(source) {
        try { source = source.normalize('NFKC'); } catch (e) {}
        return source.toLowerCase().replace(/[^a-z0-9а-яё\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]+/gi, ' ').trim();
    }

    // Lampa дописывает в карточку оба поля, и у сериала title — это заглушка («Фильм не найден»),
    // а настоящее название лежит в name. Идиома «title || name» брала заглушку и отправляла её
    // в поисковый запрос; для сериала правильный порядок обратный.
    export function localTitle(movie, mode) {
        movie = movie || {};
        return mode === MODE_MOVIE
            ? (movie.title || movie.name || '')
            : (movie.name || movie.title || '');
    }

    // aliases — варианты названия из TMDB alternative_titles. У онгоингов устоявшегося русского
    // названия ещё нет, и трекер вполне может назвать раздачу переводом, которого нет в карточке;
    // без вариантов такая раздача не совпадёт ни с одним известным нам названием.
    export function baseTitles(movie, englishTitle, aliases) {
        return unique([
            movie.name,
            movie.title,
            movie.original_title || movie.original_name,
            englishTitle
        ].concat(Array.isArray(aliases) ? aliases : []).filter(Boolean), normalizedTitleKey);
    }

    export { isAnimeTarget } from '../profile/work-profile.js';

    export function searchNames(target) {
        target = target || {};
        var movie = target.movie || {};
        // Варианты названия идут последними: у аниме-онгоингов русское название у каждой студии
        // своё, но общий лимит запросов важнее полноты — сюда попадёт только то, что влезло.
        return unique([
            localTitle(movie, target.mode),
            movie.original_title || movie.original_name,
            target.englishTitle
        ].concat(Array.isArray(target.aliases) ? target.aliases : []).filter(Boolean), normalizedTitleKey).slice(0, 4);
    }

    export function defaultSearchName(movie, englishTitle, includeYear, mode) {
        try {
            var format = Lampa.Storage.field('parse_lang') || 'df';
            if (includeYear === false) format = format.replace(/_year$/, '');
            var title = localTitle(movie, mode);
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
            return localTitle(movie, mode);
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
        var local = localTitle(movie, target && target.mode);
        var english = (target && target.englishTitle) || '';
        var preferred = defaultSearchName(movie, english, target && target.includeYear, target && target.mode);
        var ordered;

        if (prefersLocalTitle(workFamily(target))) {
            ordered = [local, english, preferred];
        } else if (!hasSearchableLetters(preferred)) {
            ordered = [preferred, local, english];
        } else if (target && target.ongoing) {
            // Пока произведение выходит, русское название ещё не устоялось: студии переводят
            // его по-своему, и запрос по названию из карточки может не найти ничего. Оригинал
            // при этом стабилен, поэтому у онгоингов он идёт вторым запросом.
            ordered = [preferred, english, local];
        } else {
            ordered = [preferred];
        }
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
