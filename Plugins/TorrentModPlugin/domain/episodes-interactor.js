    import { fetchSeason, fetchWorkTitles, episodeCounts } from '../metadata/tmdb.js';
    import { searchMovieTorrents, searchMovieTorrentsProgressive } from '../search/movie-search.js';
    import { searchSeriesTorrents, searchSeriesTorrentsProgressive } from '../search/series-search.js';
    import { notify } from '../shared/utils.js';
    import { ensureSearchRules } from '../search/rules-source.js';
    import { mergeReleases } from '../shared/release-identity.js';
    import { SEASON_CACHE_KEY, MODE_MOVIE, MODE_SERIES, POOL_RETRY_DELAYS_MS } from '../shared/state.js';
    import { isCurrentGeneration } from '../shared/core/generation-guard.js';
    import { log, warn } from '../shared/core/log.js';

    var PER_MOVIE_CACHE_MAX = 200;
    var SLOW_INDEXER_MS = 15000;

    // Воронка поиска: сколько раздач вернули трекеры, сколько из них видео, сколько относится к
    // этому произведению и сколько дошло до пула. Без неё «ничего не найдено» и «всё отсеяли
    // фильтры» выглядят одинаково.
    function sumFunnel(indexers, pool) {
        var funnel = { raw: 0, video: 0, title: 0, pool: (pool || []).length };
        (indexers || []).forEach(function (indexer) {
            if (!indexer.stats) return;
            funnel.raw += indexer.stats.raw || 0;
            funnel.video += indexer.stats.video || 0;
            funnel.title += indexer.stats.title || 0;
        });
        return funnel;
    }

    function rememberSeason(movie, season) {
        try {
            var last = Lampa.Storage.cache(SEASON_CACHE_KEY, PER_MOVIE_CACHE_MAX, {});
            last[movie.id] = season;
            Lampa.Storage.set(SEASON_CACHE_KEY, last);
        } catch (e) {}
    }

    export function createEpisodesInteractor(options) {
        var store = options.store;
        var object = options.object;
        var movie = options.movie;
        var hasSeasons = options.hasSeasons;
        var isDestroyed = options.isDestroyed;
        // Shared lifecycle scope — see docs/system-design/torrent-mod-parallel-search.md.
        var scope = options.scope;

        var poolRetryTimerId = null;
        var poolSearchHandle = null; // {cancel} from the currently in-flight progressive search, if any

        scope.track(function () { if (poolSearchHandle) poolSearchHandle.cancel(); });

        var englishTitleFetch = null;
        function ensureEnglishTitle() {
            var state = store.get();
            if (state.englishTitle !== null) return Promise.resolve(state.englishTitle);
            if (englishTitleFetch) return englishTitleFetch;
            englishTitleFetch = fetchWorkTitles(object.movie, hasSeasons ? MODE_SERIES : MODE_MOVIE).then(function (result) {
                englishTitleFetch = null;
                var titles = result.ok ? result.value : { english: '', aliases: [], negativeAliases: [], ongoing: false };
                log('episodes', 'ensureEnglishTitle: "' + titles.english + '"' +
                    (titles.aliases.length ? ', вариантов названия ' + titles.aliases.length : '') +
                    (titles.ongoing ? ', онгоинг' : ''));
                if (!isDestroyed()) {
                    store.patch({
                        englishTitle: titles.english, titleAliases: titles.aliases,
                        negativeAliases: titles.negativeAliases || [], ongoing: titles.ongoing
                    });
                }
                return titles.english;
            });
            return englishTitleFetch;
        }

        function loadEpisodes() {
            var state = store.get();
            var requestedSeason = state.season;
            var generation = state.seasonGeneration;
            log('episodes', 'loadEpisodes старт, сезон=' + requestedSeason + ', generation=' + generation);
            store.patch({ episodesStatus: 'loading', statusText: 'Загрузка списка серий…' });

            fetchSeason(movie, requestedSeason).then(function (result) {
                if (!isCurrentGeneration(store, 'seasonGeneration', generation, isDestroyed)) {
                    log('episodes', 'loadEpisodes отброшен как устаревший, сезон=' + requestedSeason + ', generation=' + generation);
                    return;
                }

                if (!result.ok) {
                    warn('episodes', 'loadEpisodes ошибка (' + result.error.kind + '): ' + result.error.message, { retryable: result.error.retryable });
                    store.patch({ episodesStatus: 'error', stage: 'message', message: { text: result.error.message, retry: result.error.retryable ? loadEpisodes : null } });
                    return;
                }
                var episodes = result.value;
                var runtimes = episodes.map(function (e) { return parseInt(e.runtime, 10) || 0; }).filter(Boolean);
                var seasonEpisodeCount = episodes.length || (episodeCounts(movie)[requestedSeason] || 0);
                var avgRuntimeMinutes = runtimes.length ? runtimes.reduce(function (a, b) { return a + b; }, 0) / runtimes.length : 0;

                if (!episodes.length) {
                    var fallbackCount = episodeCounts(movie)[requestedSeason] || 0;
                    for (var i = 1; i <= fallbackCount; i++) episodes.push({ episode_number: i, name: 'Серия ' + i });
                }
                if (!episodes.length) {
                    warn('episodes', 'loadEpisodes: TMDB не вернул ни одной серии для сезона ' + requestedSeason);
                    store.patch({ episodesStatus: 'error', stage: 'message', message: { text: 'Список серий недоступен', retry: loadEpisodes } });
                    return;
                }
                log('episodes', 'loadEpisodes успех, сезон=' + requestedSeason + ', серий=' + episodes.length);
                store.patch({
                    episodesCache: episodes,
                    seasonEpisodeCount: seasonEpisodeCount,
                    avgRuntimeMinutes: avgRuntimeMinutes,
                    stage: 'episodes',
                    statusText: '',
                    episodesStatus: 'ready'
                });
            });
        }

        var pendingOnLoaded = null;
        function loadAllTorrents(onLoaded) {
            var state = store.get();
            if (state.poolStatus === 'loading') {
                // Already in flight: queue the caller's callback rather than dropping it.
                log('episodes', 'loadAllTorrents уже в процессе, callback добавлен в очередь');
                if (typeof onLoaded === 'function') pendingOnLoaded = onLoaded;
                return;
            }
            var generation = state.poolGeneration;
            log('episodes', 'loadAllTorrents старт, generation=' + generation);
            store.patch({ poolStatus: 'loading', poolStartedAt: Date.now(), pool: [], poolIndexers: [], poolAllIndexers: [] });
            // Правила студий должны быть на месте до первого разбора заголовка — парсер
            // синхронный. Ждём их здесь же, где уже ждём англоязычное название.
            Promise.all([ensureEnglishTitle(), ensureSearchRules()]).then(function (results) {
                var englishTitle = results[0];
                // Re-check staleness after the async englishTitle wait before firing the real search.
                if (!isCurrentGeneration(store, 'poolGeneration', generation, isDestroyed)) return;
                var titles = store.get();
                var target = {
                    movie: object.movie,
                    mode: hasSeasons ? MODE_SERIES : MODE_MOVIE,
                    season: 0,
                    episode: 0,
                    englishTitle: englishTitle,
                    aliases: titles.titleAliases,
                    negativeAliases: titles.negativeAliases,
                    ongoing: titles.ongoing
                };
                var search = hasSeasons ? searchSeriesTorrentsProgressive : searchMovieTorrentsProgressive;
                poolSearchHandle = search(target, function (entry) {
                if (!isCurrentGeneration(store, 'poolGeneration', generation, isDestroyed)) return;
                var current = store.get();
                log('episodes', 'loadAllTorrents: трекер "' + entry.name + '" ' +
                    (entry.ok ? ('ответил за ' + entry.elapsedMs + 'мс, +' + entry.items.length) : ('провалился (' + entry.error + ') за ' + entry.elapsedMs + 'мс')));
                // Один медленный индексатор держит poolStatus в «загружается» и после того, как
                // показывать уже есть что. Прогрессивная выдача это скрывает, поэтому отмечаем
                // явно: иначе разбирать «почему поиск шёл минуту» не по чему.
                if (entry.elapsedMs > SLOW_INDEXER_MS) {
                    warn('episodes', 'трекер "' + entry.name + '" отвечал ' +
                        Math.round(entry.elapsedMs / 1000) + ' с — он и задерживает завершение поиска');
                }
                var merged = mergePools(current.pool, entry.items);
                var indexers = current.poolIndexers.filter(function (indexer) { return indexer.id !== entry.id; });
                indexers.push({
                    id: entry.id, name: entry.name, ok: entry.ok, error: entry.error,
                    elapsedMs: entry.elapsedMs, reportedAt: Date.now(), stats: entry.stats || null
                });
                store.patch({ pool: merged, poolIndexers: indexers, funnel: sumFunnel(indexers, merged) });
            }, function (startFailed) {
                poolSearchHandle = null;
                if (!isCurrentGeneration(store, 'poolGeneration', generation, isDestroyed)) return;
                var current = store.get();
                var anyOk = current.poolIndexers.some(function (indexer) { return indexer.ok; });
                if (startFailed || !anyOk) {
                    var attempt = current.poolAttempt || 1;
                    var retryIndex = attempt - 1;
                    if (retryIndex < POOL_RETRY_DELAYS_MS.length) {
                        var delayMs = POOL_RETRY_DELAYS_MS[retryIndex];
                        warn('episodes', 'loadAllTorrents: ни один трекер не ответил, авто-повтор через ' + delayMs + 'мс (попытка ' + (attempt + 1) + ')');
                        store.patch({ poolStatus: 'error', poolAutoRetryAt: Date.now() + delayMs });
                        if (poolRetryTimerId !== null) clearTimeout(poolRetryTimerId);
                        poolRetryTimerId = scope.setTimeout(function () {
                            poolRetryTimerId = null;
                            requery(onLoaded, true);
                        }, delayMs);
                        return;
                    }
                    warn('episodes', 'loadAllTorrents: авто-повторы исчерпаны, ни один трекер не ответил');
                    notify('Не удалось получить раздачи — проверьте Jackett или повторите позже');
                    store.patch({ poolStatus: 'error', poolAutoRetryAt: null });
                } else {
                    log('episodes', 'loadAllTorrents успех, раздач в пуле=' + current.pool.length);
                    store.patch({ poolStatus: 'ready', poolAutoRetryAt: null });
                }
                if (typeof onLoaded === 'function') onLoaded();
                var pending = pendingOnLoaded;
                pendingOnLoaded = null;
                if (pending && pending !== onLoaded) pending();
            }, scope, function (indexerList) {
                if (!isCurrentGeneration(store, 'poolGeneration', generation, isDestroyed)) return;
                store.patch({ poolAllIndexers: indexerList });
            });
            });
        }

        function setSeason(season) {
            var state = store.get();
            if (season === state.season) return false;
            log('episodes', 'setSeason: ' + state.season + ' → ' + season);
            rememberSeason(movie, season);
            store.patch({
                season: season,
                seasonGeneration: state.seasonGeneration + 1,
                episodesCache: [],
                seasonEpisodeCount: 0,
                avgRuntimeMinutes: 0,
                episodesStatus: 'idle'
            });
            loadEpisodes();
            return true;
        }

        function ensureSeasonLoaded(season) {
            var state = store.get();
            if (!hasSeasons) return;
            if (state.poolStatus !== 'ready' && state.poolStatus !== 'error') return;
            if (state.seasonLoads && state.seasonLoads[season]) return; // already loading/ready/error

            var generation = state.poolGeneration;
            var loads = Object.assign({}, state.seasonLoads || {});
            loads[season] = 'loading';
            store.patch({ seasonLoads: loads });
            log('episodes', 'ensureSeasonLoaded: дозагрузка сезона ' + season + ' (в общем пуле для него пусто)');
            runSeasonSearch(season, generation);
        }

        function runSeasonSearch(season, generation) {
            // Дозагрузка обязана искать по тому же набору имён, что и основной поиск, иначе
            // расходятся и запрос, и гейт по названию. Ждать приходится только если название
            // ещё не получено — обычно основной поиск его уже разрешил.
            var known = store.get().englishTitle;
            if (known !== null) {
                runSeasonSearchWith(season, generation, known);
                return;
            }
            ensureEnglishTitle().then(function (englishTitle) {
                if (!isCurrentGeneration(store, 'poolGeneration', generation, isDestroyed)) return;
                runSeasonSearchWith(season, generation, englishTitle);
            });
        }

        function runSeasonSearchWith(season, generation, englishTitle) {
            var titles = store.get();
            var target = {
                movie: object.movie, mode: MODE_SERIES, season: season, episode: 0,
                englishTitle: englishTitle, aliases: titles.titleAliases,
                negativeAliases: titles.negativeAliases, ongoing: titles.ongoing
            };
            searchSeriesTorrents(target).then(function (response) {
                if (!isCurrentGeneration(store, 'poolGeneration', generation, isDestroyed)) {
                    log('episodes', 'ensureSeasonLoaded(' + season + ') отброшен как устаревший');
                    return;
                }
                if (response.failed) {
                    warn('episodes', 'ensureSeasonLoaded(' + season + ') не удался, повтор только вручную');
                    var current = store.get();
                    var loadsFailed = Object.assign({}, current.seasonLoads || {});
                    loadsFailed[season] = 'error';
                    store.patch({ seasonLoads: loadsFailed });
                    return;
                }
                var current = store.get();
                var merged = mergePools(current.pool, response.results);
                var loadsReady = Object.assign({}, current.seasonLoads || {});
                loadsReady[season] = 'ready';
                log('episodes', 'ensureSeasonLoaded(' + season + ') успех, пул после мержа=' + merged.length);
                store.patch({ pool: merged, seasonLoads: loadsReady });
            });
        }

        function retrySeasonLoad(season) {
            var state = store.get();
            var loads = Object.assign({}, state.seasonLoads || {});
            delete loads[season];
            log('episodes', 'retrySeasonLoad: сброс статуса сезона ' + season + ', повторная попытка');
            store.patch({ seasonLoads: loads });
            ensureSeasonLoaded(season);
        }

        function mergePools(existing, incoming) {
            return mergeReleases(existing, incoming);
        }

        // The "К списку серий" back action — reuses the already-loaded episodesCache, no refetch.
        function showEpisodeList() {
            store.patch({ stage: 'episodes', statusText: '' });
        }

        function requery(onLoaded, isRetry) {
            var state = store.get();
            log('episodes', 'requery: сброс пула под новым запросом' + (isRetry ? ', попытка ' + ((state.poolAttempt || 1) + 1) : ''));
            if (poolRetryTimerId !== null) { clearTimeout(poolRetryTimerId); poolRetryTimerId = null; }
            if (poolSearchHandle) { poolSearchHandle.cancel(); poolSearchHandle = null; }
            // New query context: old pool and per-season coverage are both invalid.
            store.patch({
                pool: [], poolStatus: 'idle', poolGeneration: state.poolGeneration + 1, seasonLoads: {}, poolIndexers: [], poolAllIndexers: [],
                poolAttempt: isRetry ? (state.poolAttempt || 1) + 1 : 1, poolAutoRetryAt: null
            });
            loadAllTorrents(onLoaded);
        }

        function start() {
            if (!hasSeasons) return;
            loadEpisodes();
            loadAllTorrents();
        }

        return {
            start: start,
            loadEpisodes: loadEpisodes,
            loadAllTorrents: loadAllTorrents,
            ensureSeasonLoaded: ensureSeasonLoaded,
            retrySeasonLoad: retrySeasonLoad,
            setSeason: setSeason,
            showEpisodeList: showEpisodeList,
            requery: requery
        };
    }
