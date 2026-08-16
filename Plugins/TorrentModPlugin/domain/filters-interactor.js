    import { SEASON_CACHE_KEY } from '../shared/state.js';

    var VOICE_DEFAULT_KEY = 'torrent_mod_voice';
    var VOICE_CACHE_KEY = 'torrent_mod_last_voice';
    var QUALITY_DEFAULT_KEY = 'torrent_mod_quality';
    var QUALITY_CACHE_KEY = 'torrent_mod_last_quality';
    var BITRATE_DEFAULT_KEY = 'torrent_mod_bitrate';
    var BITRATE_CACHE_KEY = 'torrent_mod_last_bitrate';
    var TRANSLATOR_DEFAULT_KEY = 'torrent_mod_translator';
    var TRANSLATOR_CACHE_KEY = 'torrent_mod_last_translator';
    var GROUP_DEFAULT_KEY = 'torrent_mod_release_group';
    var GROUP_CACHE_KEY = 'torrent_mod_last_release_group';
    var PER_MOVIE_CACHE_MAX = 200;

    // Выбор запоминается дважды: как общее умолчание и как выбор для этого произведения.
    function remember(keys, movie, value) {
        try {
            Lampa.Storage.set(keys.def, value);
            var last = Lampa.Storage.cache(keys.cache, PER_MOVIE_CACHE_MAX, {});
            last[movie.id] = value;
            Lampa.Storage.set(keys.cache, last);
        } catch (e) {}
    }

    function restore(keys, movie) {
        var value = Lampa.Storage.get(keys.def, 'any');
        var last = Lampa.Storage.cache(keys.cache, PER_MOVIE_CACHE_MAX, {});
        return last[movie.id] ? last[movie.id] : value;
    }

    var VOICE = { def: VOICE_DEFAULT_KEY, cache: VOICE_CACHE_KEY };
    var QUALITY = { def: QUALITY_DEFAULT_KEY, cache: QUALITY_CACHE_KEY };
    var BITRATE = { def: BITRATE_DEFAULT_KEY, cache: BITRATE_CACHE_KEY };
    var TRANSLATOR = { def: TRANSLATOR_DEFAULT_KEY, cache: TRANSLATOR_CACHE_KEY };
    var GROUP = { def: GROUP_DEFAULT_KEY, cache: GROUP_CACHE_KEY };

    export function createFiltersInteractor(options) {
        var store = options.store;
        var movie = options.movie;

        function patchFilters(partial) {
            var current = store.get().filters;
            var changed = Object.keys(partial).some(function (key) { return current[key] !== partial[key]; });
            if (changed) store.patch({ filters: Object.assign({}, current, partial) });
        }

        function resetFilters() {
            [VOICE, TRANSLATOR, GROUP, QUALITY, BITRATE].forEach(function (keys) { remember(keys, movie, 'any'); });
            patchFilters({ voiceType: 'any', translator: 'any', releaseGroup: 'any', resolution: 'any', bitrate: 'any' });
        }

        function setVoiceFilter(value) {
            remember(VOICE, movie, value);
            patchFilters({ voiceType: value });
        }

        function setResolutionFilter(value) {
            remember(QUALITY, movie, value);
            patchFilters({ resolution: value });
        }

        function setTranslatorFilter(value) {
            remember(TRANSLATOR, movie, value);
            patchFilters({ translator: value });
        }

        function setReleaseGroupFilter(value) {
            remember(GROUP, movie, value);
            patchFilters({ releaseGroup: value });
        }

        function setBitrateFilter(value) {
            remember(BITRATE, movie, value);
            patchFilters({ bitrate: value });
        }

        return {
            resetFilters: resetFilters,
            setVoiceFilter: setVoiceFilter,
            setTranslatorFilter: setTranslatorFilter,
            setReleaseGroupFilter: setReleaseGroupFilter,
            setResolutionFilter: setResolutionFilter,
            setBitrateFilter: setBitrateFilter
        };
    }

    export function applyPersistedPreferences(store, movie) {
        try {
            var state = store.get();
            var lastSeason = Lampa.Storage.cache(SEASON_CACHE_KEY, PER_MOVIE_CACHE_MAX, {});
            var season = lastSeason[movie.id] ? lastSeason[movie.id] : state.season;

            store.patch({
                season: season,
                filters: {
                    voiceType: restore(VOICE, movie),
                    translator: restore(TRANSLATOR, movie),
                    releaseGroup: restore(GROUP, movie),
                    resolution: restore(QUALITY, movie),
                    bitrate: restore(BITRATE, movie)
                }
            });
        } catch (e) {}
    }
