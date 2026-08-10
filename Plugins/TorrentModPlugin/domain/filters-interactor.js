    import { SEASON_CACHE_KEY } from '../shared/state.js';

    var VOICE_DEFAULT_KEY = 'torrent_mod_voice';
    var VOICE_CACHE_KEY = 'torrent_mod_last_voice';
    var QUALITY_DEFAULT_KEY = 'torrent_mod_quality';
    var QUALITY_CACHE_KEY = 'torrent_mod_last_quality';
    var BITRATE_DEFAULT_KEY = 'torrent_mod_bitrate';
    var BITRATE_CACHE_KEY = 'torrent_mod_last_bitrate';
    var PER_MOVIE_CACHE_MAX = 200;

    function rememberVoice(movie, value) {
        try {
            Lampa.Storage.set(VOICE_DEFAULT_KEY, value);
            var last = Lampa.Storage.cache(VOICE_CACHE_KEY, PER_MOVIE_CACHE_MAX, {});
            last[movie.id] = value;
            Lampa.Storage.set(VOICE_CACHE_KEY, last);
        } catch (e) {}
    }

    function rememberQuality(movie, value) {
        try {
            Lampa.Storage.set(QUALITY_DEFAULT_KEY, value);
            var last = Lampa.Storage.cache(QUALITY_CACHE_KEY, PER_MOVIE_CACHE_MAX, {});
            last[movie.id] = value;
            Lampa.Storage.set(QUALITY_CACHE_KEY, last);
        } catch (e) {}
    }

    function rememberBitrate(movie, value) {
        try {
            Lampa.Storage.set(BITRATE_DEFAULT_KEY, value);
            var last = Lampa.Storage.cache(BITRATE_CACHE_KEY, PER_MOVIE_CACHE_MAX, {});
            last[movie.id] = value;
            Lampa.Storage.set(BITRATE_CACHE_KEY, last);
        } catch (e) {}
    }

    export function createFiltersInteractor(options) {
        var store = options.store;
        var movie = options.movie;

        function resetFilters() {
            rememberVoice(movie, 'any');
            rememberQuality(movie, 'any');
            rememberBitrate(movie, 'any');
            store.patch({ voiceType: 'any', resolution: 'any', bitrate: 'any' });
        }

        function setVoiceFilter(value) {
            rememberVoice(movie, value);
            store.patch({ voiceType: value });
        }

        function setResolutionFilter(value) {
            rememberQuality(movie, value);
            store.patch({ resolution: value });
        }

        function setBitrateFilter(value) {
            rememberBitrate(movie, value);
            store.patch({ bitrate: value });
        }

        return {
            resetFilters: resetFilters,
            setVoiceFilter: setVoiceFilter,
            setResolutionFilter: setResolutionFilter,
            setBitrateFilter: setBitrateFilter
        };
    }

    export function applyPersistedPreferences(store, movie) {
        try {
            var state = store.get();
            var lastSeason = Lampa.Storage.cache(SEASON_CACHE_KEY, PER_MOVIE_CACHE_MAX, {});
            var season = lastSeason[movie.id] ? lastSeason[movie.id] : state.season;

            var voiceType = Lampa.Storage.get(VOICE_DEFAULT_KEY, 'any');
            var lastVoice = Lampa.Storage.cache(VOICE_CACHE_KEY, PER_MOVIE_CACHE_MAX, {});
            if (lastVoice[movie.id]) voiceType = lastVoice[movie.id];

            var resolution = Lampa.Storage.get(QUALITY_DEFAULT_KEY, 'any');
            var lastQuality = Lampa.Storage.cache(QUALITY_CACHE_KEY, PER_MOVIE_CACHE_MAX, {});
            if (lastQuality[movie.id]) resolution = lastQuality[movie.id];

            var bitrate = Lampa.Storage.get(BITRATE_DEFAULT_KEY, 'any');
            var lastBitrate = Lampa.Storage.cache(BITRATE_CACHE_KEY, PER_MOVIE_CACHE_MAX, {});
            if (lastBitrate[movie.id]) bitrate = lastBitrate[movie.id];

            store.patch({ season: season, voiceType: voiceType, resolution: resolution, bitrate: bitrate });
        } catch (e) {}
    }
