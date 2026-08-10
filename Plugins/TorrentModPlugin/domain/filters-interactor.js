    import { SEASON_CACHE_KEY } from '../shared/state.js';

    var VOICE_DEFAULT_KEY = 'torrent_mod_voice';
    var VOICE_CACHE_KEY = 'torrent_mod_last_voice';
    var QUALITY_DEFAULT_KEY = 'torrent_mod_quality';
    var QUALITY_CACHE_KEY = 'torrent_mod_last_quality';
    var BITRATE_DEFAULT_KEY = 'torrent_mod_bitrate';
    var BITRATE_CACHE_KEY = 'torrent_mod_last_bitrate';
    var TRANSLATOR_DEFAULT_KEY = 'torrent_mod_translator';
    var TRANSLATOR_CACHE_KEY = 'torrent_mod_last_translator';
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

    function rememberTranslator(movie, value) {
        try {
            Lampa.Storage.set(TRANSLATOR_DEFAULT_KEY, value);
            var last = Lampa.Storage.cache(TRANSLATOR_CACHE_KEY, PER_MOVIE_CACHE_MAX, {});
            last[movie.id] = value;
            Lampa.Storage.set(TRANSLATOR_CACHE_KEY, last);
        } catch (e) {}
    }

    export function createFiltersInteractor(options) {
        var store = options.store;
        var movie = options.movie;

        function patchFilters(partial) {
            store.patch({ filters: Object.assign({}, store.get().filters, partial) });
        }

        function resetFilters() {
            rememberVoice(movie, 'any');
            rememberTranslator(movie, 'any');
            rememberQuality(movie, 'any');
            rememberBitrate(movie, 'any');
            patchFilters({ voiceType: 'any', translator: 'any', resolution: 'any', bitrate: 'any' });
        }

        function setVoiceFilter(value) {
            rememberVoice(movie, value);
            patchFilters({ voiceType: value });
        }

        function setResolutionFilter(value) {
            rememberQuality(movie, value);
            patchFilters({ resolution: value });
        }

        function setTranslatorFilter(value) {
            rememberTranslator(movie, value);
            patchFilters({ translator: value });
        }

        function setBitrateFilter(value) {
            rememberBitrate(movie, value);
            patchFilters({ bitrate: value });
        }

        return {
            resetFilters: resetFilters,
            setVoiceFilter: setVoiceFilter,
            setTranslatorFilter: setTranslatorFilter,
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

            var translator = Lampa.Storage.get(TRANSLATOR_DEFAULT_KEY, 'any');
            var lastTranslator = Lampa.Storage.cache(TRANSLATOR_CACHE_KEY, PER_MOVIE_CACHE_MAX, {});
            if (lastTranslator[movie.id]) translator = lastTranslator[movie.id];

            var resolution = Lampa.Storage.get(QUALITY_DEFAULT_KEY, 'any');
            var lastQuality = Lampa.Storage.cache(QUALITY_CACHE_KEY, PER_MOVIE_CACHE_MAX, {});
            if (lastQuality[movie.id]) resolution = lastQuality[movie.id];

            var bitrate = Lampa.Storage.get(BITRATE_DEFAULT_KEY, 'any');
            var lastBitrate = Lampa.Storage.cache(BITRATE_CACHE_KEY, PER_MOVIE_CACHE_MAX, {});
            if (lastBitrate[movie.id]) bitrate = lastBitrate[movie.id];

            store.patch({ season: season, filters: { voiceType: voiceType, translator: translator, resolution: resolution, bitrate: bitrate } });
        } catch (e) {}
    }
