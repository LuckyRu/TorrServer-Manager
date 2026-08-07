    // ---------- season/episode picker (reused pattern from Smart TS) ----------
    import { canonicalTimeline, scanProgress, getSeasonMeta } from './tmdb.js';

    // Builds the season picker list shown inline in TorrentModComponent's toolbar (the slot
    // Online Mod uses for its balancer picker) — no separate pre-screen anymore, episode-level
    // choice happens naturally when the user opens a multi-file torrent's file list.
    export function buildSeasonItems(movie, currentSeason) {
        var continueAt = scanProgress(movie);
        return getSeasonMeta(movie).map(function (meta) {
            var season = parseInt(meta.season_number, 10);
            var watched = 0;
            var started = 0;
            var count = parseInt(meta.episode_count, 10) || 0;
            for (var episode = 1; episode <= count; episode++) {
                var view = canonicalTimeline(movie, season, episode);
                if (view && view.percent >= 90) watched++;
                else if (view && view.percent > 0) started++;
            }
            var bits = [count ? count + ' серий' : ''];
            if (watched) bits.push('просмотрено ' + watched);
            if (started) bits.push('начато ' + started);
            return {
                title: meta.name || ('Сезон ' + season),
                subtitle: bits.filter(Boolean).join(' · '),
                season: season,
                selected: currentSeason ? season === currentSeason : (!continueAt && season === 1) || (continueAt && season === continueAt.season)
            };
        });
    }

    export function initialSeason(movie) {
        if (!movie.number_of_seasons) return 0;
        var continueAt = scanProgress(movie);
        return continueAt ? continueAt.season : 1;
    }

    export function openTarget(movie, season, controller) {
        Lampa.Activity.push({
            url: '',
            title: 'Torrent Mod' + (season ? ' · Сезон ' + season : ''),
            component: 'torrent_mod',
            movie: movie,
            season: season || 0,
            back_controller: controller || 'content'
        });
    }
