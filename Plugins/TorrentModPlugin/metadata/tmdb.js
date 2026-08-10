    // ---------- TMDB season/episode data ----------
    import { field, request } from '../shared/utils.js';
    import { ok, err } from '../shared/core/result.js';
    import { MODE_MOVIE } from '../shared/state.js';

    export function canonicalTimeline(movie, season, episode) {
        if (!movie || !season || !episode || !Lampa.Timeline || !Lampa.Timeline.watchedEpisode) return null;
        try { return Lampa.Timeline.watchedEpisode(movie, season, episode, true); } catch (e) { return null; }
    }

    export function progressText(view) {
        if (!view || !view.percent) return 'не просмотрено';
        if (view.percent >= 90) return 'просмотрено';
        if (view.time && Lampa.Utils && Lampa.Utils.secondsToTimeHuman) {
            return Math.round(view.percent) + '% · ' + Lampa.Utils.secondsToTimeHuman(view.time);
        }
        return Math.round(view.percent) + '%';
    }

    export function episodeCounts(movie) {
        var result = {};
        (movie.seasons || []).forEach(function (season) {
            var number = parseInt(season.season_number, 10);
            if (number > 0) result[number] = parseInt(season.episode_count, 10) || 0;
        });
        return result;
    }

    export function scanProgress(movie) {
        var counts = episodeCounts(movie);
        var seasons = Object.keys(counts).map(Number).sort(function (a, b) { return a - b; });
        var all = [];

        seasons.forEach(function (season) {
            for (var episode = 1; episode <= counts[season]; episode++) {
                all.push({ season: season, episode: episode, view: canonicalTimeline(movie, season, episode) });
            }
        });

        var inProgress = all.filter(function (entry) {
            return entry.view && entry.view.percent > 0 && entry.view.percent < 90;
        }).sort(function (a, b) {
            return (b.view.updated || 0) - (a.view.updated || 0);
        })[0];
        if (inProgress) return inProgress;

        var completed = all.filter(function (entry) {
            return entry.view && entry.view.percent >= 90;
        }).sort(function (a, b) {
            return (b.view.updated || 0) - (a.view.updated || 0);
        })[0];

        if (completed) {
            var index = all.indexOf(completed);
            if (index >= 0 && index + 1 < all.length) return all[index + 1];
        }
        return null;
    }

    export function getSeasonMeta(movie) {
        var list = (movie.seasons || []).filter(function (season) {
            return parseInt(season.season_number, 10) > 0;
        });
        if (list.length) return list;

        var total = parseInt(movie.number_of_seasons, 10) || 1;
        for (var i = 1; i <= total; i++) list.push({ season_number: i, episode_count: 0, name: 'Сезон ' + i });
        return list;
    }

    // Returns a Result (shared/core/result.js), not a bare array — request() (shared/utils.js) is
    // built on a Promise that never rejects (a network failure resolves to `null`, same shape as "no
    // data"), so without this, a TMDB network error and a legitimately empty season were structurally
    // indistinguishable to the caller. `data === null` is specifically the network-failure case;
    // `data` present but with no `episodes` array (or an empty one) is a real, successful "this
    // season has no episodes" answer, not an error — ok([]) is returned for that, not err(...).
    export function fetchSeason(movie, season) {
        var language = field('tmdb_lang', 'ru');
        var path = 'tv/' + movie.id + '/season/' + season + '?api_key=' + Lampa.TMDB.key() + '&language=' + encodeURIComponent(language);
        return request(Lampa.TMDB.api(path), 15000).then(function (data) {
            if (data === null) return err('network', 'Список серий недоступен', { retryable: true });
            return ok(Array.isArray(data.episodes) ? data.episodes : []);
        });
    }

    // A one-off TMDB lookup for the show/movie's own ENGLISH title — deliberately NOT the same
    // thing as `movie.original_title`/`original_name` (the card's own field, already known without
    // a network call): `original_title` is the SOURCE-LANGUAGE title as TMDB has it registered
    // (native script or its own romanization for Asian-origin content), while Russian-scene
    // trackers overwhelmingly follow a "Russian title / ENGLISH title" naming convention and
    // essentially never use the native-script original. Searching/matching against the native
    // original for e.g. a Korean or Japanese show is close to useless on these trackers — requested
    // directly by the user after confirming this live ("используя язык оригинала на русских
    // торрентах это пиздец. Надо использовать английский перевод из TMDB для поиска"). For Western
    // content this just resolves to the same string as original_title — harmless, `baseTitles`/
    // `unique()` (query-building.js) already collapse an identical duplicate into one entry, no
    // extra query round trip. Best-effort only: on failure this returns ok('') rather than a
    // retryable error — the whole feature is additive (search/matching already work, just less
    // precisely, without it), not worth a user-facing retry prompt for what's essentially free
    // recall on top of an already-working baseline.
    export function fetchEnglishTitle(movie, mode) {
        var kind = mode === MODE_MOVIE ? 'movie' : 'tv';
        var path = kind + '/' + movie.id + '?api_key=' + Lampa.TMDB.key() + '&language=en-US';
        return request(Lampa.TMDB.api(path), 15000).then(function (data) {
            if (!data) return ok('');
            return ok(String(data.name || data.title || ''));
        });
    }
