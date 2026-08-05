(function ($, Lampa) {
    'use strict';

    if (!window.Lampa || window.torrent_mod_ready) return;
    window.torrent_mod_ready = true;

    var VERSION = '0.1.0';
    var scriptUrl = document.currentScript && document.currentScript.src ? document.currentScript.src : '';
    var hubBase = scriptUrl.replace(/\/plugins\/[^/?]+\.js(?:\?.*)?$/i, '');
    var searchRequests = [];

    // ---------- utils ----------

    function field(name, fallback) {
        var value;
        try { value = Lampa.Storage.field(name); } catch (e) { value = undefined; }
        return typeof value === 'undefined' || value === null || value === '' ? fallback : value;
    }

    function enabled(name, fallback) {
        var value = field(name, fallback);
        return value === true || value === 1 || value === 'true' || value === '1';
    }

    function pad(value) {
        value = parseInt(value, 10) || 0;
        return value < 10 ? '0' + value : String(value);
    }

    function compact(value) {
        return String(value || '')
            .toLowerCase()
            .replace(/ё/g, 'е')
            .replace(/[^a-zа-я0-9]+/gi, ' ')
            .replace(/^\s+|\s+$/g, '');
    }

    function unique(items, key) {
        var seen = {};
        return items.filter(function (item) {
            var id = key(item);
            if (!id || seen[id]) return false;
            seen[id] = true;
            return true;
        });
    }

    function notify(message) {
        if (Lampa.Noty && Lampa.Noty.show) Lampa.Noty.show(message);
        else console.log('Torrent Mod:', message);
    }

    function previousController() {
        try { return Lampa.Controller.enabled().name; } catch (e) { return 'content'; }
    }

    function restoreController(name) {
        try { Lampa.Controller.toggle(name || 'content'); } catch (e) {}
    }

    function formatSize(value) {
        if (!value) return '';
        if (typeof value === 'string' && /[a-zа-я]/i.test(value)) return value;
        var bytes = parseFloat(value);
        return isNaN(bytes) ? '' : Lampa.Utils.bytesToSize(bytes);
    }

    function request(url, timeout, postData) {
        return new Promise(function (resolve) {
            var network = new Lampa.Reguest();
            var settled = false;
            searchRequests.push(network);
            network.timeout(timeout || 15000);

            function done(value) {
                if (settled) return;
                settled = true;
                var index = searchRequests.indexOf(network);
                if (index >= 0) searchRequests.splice(index, 1);
                resolve(value);
            }

            network.native(url, function (data) { done(data); }, function () { done(null); }, postData);
        });
    }

    function cancelSearch() {
        searchRequests.splice(0).forEach(function (network) {
            try { network.clear(); } catch (e) {}
        });
    }

    function canonicalTimeline(movie, season, episode) {
        if (!movie || !season || !episode || !Lampa.Timeline || !Lampa.Timeline.watchedEpisode) return null;
        try { return Lampa.Timeline.watchedEpisode(movie, season, episode, true); } catch (e) { return null; }
    }

    function progressText(view) {
        if (!view || !view.percent) return 'не просмотрено';
        if (view.percent >= 90) return 'просмотрено';
        if (view.time && Lampa.Utils && Lampa.Utils.secondsToTimeHuman) {
            return Math.round(view.percent) + '% · ' + Lampa.Utils.secondsToTimeHuman(view.time);
        }
        return Math.round(view.percent) + '%';
    }

    function episodeCounts(movie) {
        var result = {};
        (movie.seasons || []).forEach(function (season) {
            var number = parseInt(season.season_number, 10);
            if (number > 0) result[number] = parseInt(season.episode_count, 10) || 0;
        });
        return result;
    }

    function scanProgress(movie) {
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

    function getSeasonMeta(movie) {
        var list = (movie.seasons || []).filter(function (season) {
            return parseInt(season.season_number, 10) > 0;
        });
        if (list.length) return list;

        var total = parseInt(movie.number_of_seasons, 10) || 1;
        for (var i = 1; i <= total; i++) list.push({ season_number: i, episode_count: 0, name: 'Сезон ' + i });
        return list;
    }

    function fetchSeason(movie, season) {
        var language = field('tmdb_lang', 'ru');
        var path = 'tv/' + movie.id + '/season/' + season + '?api_key=' + Lampa.TMDB.key() + '&language=' + encodeURIComponent(language);
        return request(Lampa.TMDB.api(path), 15000).then(function (data) {
            return data && Array.isArray(data.episodes) ? data.episodes : [];
        });
    }

    // ---------- season/episode picker (reused pattern from Smart TS) ----------

    function showSeasons(movie) {
        var controller = previousController();
        var continueAt = scanProgress(movie);
        var items = [];

        if (continueAt) {
            items.push({
                title: 'Продолжить: S' + pad(continueAt.season) + 'E' + pad(continueAt.episode),
                subtitle: progressText(continueAt.view),
                season: continueAt.season,
                episode: continueAt.episode,
                selected: true,
                resume: true
            });
        }

        getSeasonMeta(movie).forEach(function (meta) {
            var season = parseInt(meta.season_number, 10);
            var watched = 0;
            var started = 0;
            var count = parseInt(meta.episode_count, 10) || 0;
            for (var episode = 1; episode <= count; episode++) {
                var view = canonicalTimeline(movie, season, episode);
                if (view && view.percent >= 90) watched++;
                else if (view && view.percent > 0) started++;
            }
            var status = count ? count + ' серий' : 'открыть список';
            if (watched) status += ' · просмотрено ' + watched;
            if (started) status += ' · начато ' + started;
            items.push({
                title: meta.name || ('Сезон ' + season),
                subtitle: status,
                season: season,
                selected: !continueAt && season === 1
            });
        });

        Lampa.Select.show({
            title: 'Torrent Mod · выберите сезон',
            items: items,
            onBack: function () { restoreController(controller); },
            onSelect: function (choice) {
                if (choice.resume) openTarget(movie, choice.season, choice.episode, controller);
                else showEpisodes(movie, choice.season, controller);
            }
        });
    }

    function showEpisodes(movie, season, controller) {
        Lampa.Loading.start(function () {
            cancelSearch();
            Lampa.Loading.stop();
            restoreController(controller);
        });

        fetchSeason(movie, season).then(function (episodes) {
            Lampa.Loading.stop();
            if (!episodes.length) {
                var fallbackCount = episodeCounts(movie)[season] || 24;
                for (var i = 1; i <= fallbackCount; i++) episodes.push({ episode_number: i, name: 'Серия ' + i });
            }

            var items = episodes.map(function (episode) {
                var number = parseInt(episode.episode_number, 10);
                var view = canonicalTimeline(movie, season, number);
                var bits = [];
                if (episode.air_date) bits.push(episode.air_date);
                bits.push(progressText(view));
                return {
                    title: number + '. ' + (episode.name || ('Серия ' + number)),
                    subtitle: bits.join(' · '),
                    episode: number,
                    view: view,
                    selected: !!(view && view.percent > 0 && view.percent < 90)
                };
            });

            Lampa.Select.show({
                title: 'Сезон ' + season + ' · выберите серию',
                items: items,
                onBack: function () { setTimeout(function () { showSeasons(movie); }, 20); },
                onSelect: function (choice) { openTarget(movie, season, choice.episode, controller); },
                onDraw: function (item, choice) {
                    if (choice.view && Lampa.Timeline && Lampa.Timeline.render) item.append(Lampa.Timeline.render(choice.view));
                }
            });
        });
    }

    function openTarget(movie, season, episode, controller) {
        Lampa.Activity.push({
            url: '',
            title: 'Torrent Mod' + (season ? ' · S' + pad(season) + 'E' + pad(episode) : ''),
            component: 'torrent_mod',
            movie: movie,
            season: season || 0,
            episode: episode || 0,
            back_controller: controller || 'content'
        });
    }

    // ---------- query building ----------

    function baseTitles(movie) {
        return unique([
            movie.title || movie.name,
            movie.original_title || movie.original_name
        ].filter(Boolean), function (title) { return compact(title); });
    }

    function buildQueries(target) {
        var titles = baseTitles(target.movie);
        var queries = [];

        if (target.season) {
            var exact = 'S' + pad(target.season) + 'E' + pad(target.episode);
            var pack = 'S' + pad(target.season);
            titles.forEach(function (title) { queries.push(title + ' ' + exact); });
            if (enabled('torrent_mod_query_pack', true)) {
                titles.forEach(function (title) { queries.push(title + ' ' + pack); });
            }
            if (enabled('torrent_mod_query_russian', true) && titles[0]) {
                queries.push(titles[0] + ' ' + target.season + ' сезон');
            }
        } else {
            titles.forEach(function (title) { queries.push(title); });
        }

        return unique(queries, compact).slice(0, 3);
    }

    // ---------- release parsing ----------

    function parseSignals(title) {
        var source = String(title || '').replace(/_/g, ' ');
        var result = { seasons: [], episodeFrom: 0, episodeTo: 0, explicitEpisode: false, explicitSeason: false };
        var match;

        match = source.match(/\bS(\d{1,2})[ ._-]*E(\d{1,3})(?:\s*[-–]\s*(?:E)?(\d{1,3}))?/i);
        if (match) {
            result.seasons = [parseInt(match[1], 10)];
            result.episodeFrom = parseInt(match[2], 10);
            result.episodeTo = parseInt(match[3] || match[2], 10);
            result.explicitSeason = result.explicitEpisode = true;
            return result;
        }

        match = source.match(/\b(\d{1,2})x(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?/i);
        if (match) {
            result.seasons = [parseInt(match[1], 10)];
            result.episodeFrom = parseInt(match[2], 10);
            result.episodeTo = parseInt(match[3] || match[2], 10);
            result.explicitSeason = result.explicitEpisode = true;
            return result;
        }

        match = source.match(/(?:сезон|season)\s*[:№]?\s*(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?/i) ||
            source.match(/(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\s*(?:сезон|season)/i) ||
            source.match(/\bS(\d{1,2})(?:\s*[-–]\s*S?(\d{1,2}))?\b/i);
        if (match) {
            var fromSeason = parseInt(match[1], 10);
            var toSeason = parseInt(match[2] || match[1], 10);
            for (var season = fromSeason; season <= toSeason && season <= fromSeason + 50; season++) result.seasons.push(season);
            result.explicitSeason = true;
        }

        match = source.match(/(?:серии|серия|episodes?|эпизоды?)\s*[:№]?\s*(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?/i) ||
            source.match(/[\[(](\d{1,3})\s*[-–]\s*(\d{1,3})\s*(?:из|of)\s*\d{1,3}/i) ||
            source.match(/\bE(\d{1,3})(?:\s*[-–]\s*E?(\d{1,3}))?\b/i);
        if (match) {
            result.episodeFrom = parseInt(match[1], 10);
            result.episodeTo = parseInt(match[2] || match[1], 10);
            result.explicitEpisode = true;
        }
        return result;
    }

    // Quality/audio/subtitle tag extraction, tuned against real Torznab titles pulled from
    // this app's own Jackett instance (RuTracker/NoNaMe/BigFANGroup mixed results) —
    // needs-verification note: exact wording should be cross-checked against Lampa's own
    // native torrent/item.js badge set if it ever diverges visibly from what users expect.
    function matchOne(source, pairs) {
        for (var i = 0; i < pairs.length; i++) {
            if (pairs[i][0].test(source)) return pairs[i][1];
        }
        return '';
    }

    function parseRelease(title) {
        var source = String(title || '');
        var signals = parseSignals(source);
        return {
            seasons: signals.seasons,
            episodeFrom: signals.episodeFrom,
            episodeTo: signals.episodeTo,
            explicitSeason: signals.explicitSeason,
            explicitEpisode: signals.explicitEpisode,
            resolution: matchOne(source, [
                [/\b(2160p|4k|uhd)\b/i, '2160p'],
                [/\b1080p\b/i, '1080p'],
                [/\b720p\b/i, '720p'],
                [/\b480p\b/i, '480p']
            ]),
            hdr: /\bhdr10?\+?\b/i.test(source) ? 'HDR' : (/\bdolby ?vision\b|\bdv\b/i.test(source) ? 'DV' : ''),
            audioChannels: matchOne(source, [[/\b7\.1\b/, '7.1'], [/\b5\.1\b/, '5.1'], [/\b2\.0\b/, '2.0']]),
            voiceType: matchOne(source, [
                [/\bдубляж\b|\bdub\b/i, 'Дубляж'],
                [/\bmvo\b|многоголос/i, 'Многоголосый'],
                [/\bavo\b|одноголос/i, 'Одноголосый'],
                [/\borig(inal)?\b|ориг(инал)?/i, 'Оригинал']
            ]),
            subtitles: /\bsub\b|\bsubs\b|субтитр/i.test(source),
            is3d: /\b3d\b/i.test(source),
            year: (source.match(/\b(19|20)\d{2}\b/) || [])[0] || '',
            codec: matchOne(source, [[/\bh\.?265\b|\bhevc\b/i, 'H.265'], [/\bh\.?264\b|\bavc\b/i, 'H.264']])
        };
    }

    // ---------- search backend ----------

    function mapTorrent(raw) {
        var magnet = raw.MagnetUri || raw.Magnet || '';
        var link = raw.Link || raw.downloadUrl || '';
        if (!magnet && /^magnet:/i.test(link)) magnet = link;
        if (!magnet && !link) return null;
        var title = raw.Title || raw.title || 'Без названия';
        return {
            title: title,
            tracker: raw.Tracker || raw.indexer || '',
            size: raw.Size || raw.size || 0,
            seeders: parseInt(raw.Seeders || raw.Seed || raw.seeders, 10) || 0,
            peers: parseInt(raw.Peers || raw.Peer || raw.leechers, 10) || 0,
            magnet: magnet,
            link: link,
            release: parseRelease(title)
        };
    }

    function searchTorrentMod(target) {
        var queries = buildQueries(target);
        if (!queries.length) return Promise.resolve({ results: [], indexers: [], failed: true });

        var calls = queries.map(function (text) {
            return request(hubBase + '/api/torrent-search?query=' + encodeURIComponent(text), 45000)
                .then(function (data) { return data || null; });
        });

        return Promise.all(calls).then(function (responses) {
            var ok = responses.filter(Boolean);
            if (!ok.length) return { results: [], indexers: [], failed: true };

            var allResults = [];
            var indexerMap = {};
            ok.forEach(function (data) {
                (data.results || []).forEach(function (raw) { allResults.push(raw); });
                (data.indexers || []).forEach(function (entry) {
                    var id = entry.ID || entry.Name;
                    if (!id) return;
                    var existing = indexerMap[id];
                    if (!existing || (entry.Results || 0) > (existing.Results || 0)) indexerMap[id] = entry;
                });
            });

            var mapped = allResults.map(mapTorrent).filter(Boolean);
            var results = unique(mapped, function (item) {
                return compact(item.magnet || item.link || (item.title + '|' + item.size));
            });

            return { results: results, indexers: Object.keys(indexerMap).map(function (k) { return indexerMap[k]; }), failed: false };
        }).catch(function () {
            return { results: [], indexers: [], failed: true };
        });
    }

    // ---------- results screen (Lampa.Component) ----------
    //
    // needs-verification: exact Component lifecycle method names/order were not confirmed
    // against yumata/lampa-source at authoring time. Implemented against the common
    // Activity/Component contract (create/render/start/pause/stop/destroy/back) used across
    // this ecosystem; adjust here first if the results screen fails to mount.

    function TorrentModComponent(object) {
        var scroll = new Lampa.Scroll({ mask: true, over: true, step: 250 });
        var html = $('<div class="torrent-mod"></div>');
        var body = $('<div class="torrent-mod__list"></div>');
        var status = $('<div class="torrent-mod__status">Поиск…</div>');
        var toolbar = $('<div class="torrent-mod__toolbar"></div>');
        var sortSelect = $('<div class="torrent-mod__control selector" data-name="sort">Сортировка: сиды</div>');
        var minSeedersSelect = $('<div class="torrent-mod__control selector" data-name="filter">Фильтр: качество</div>');
        var state = { results: [], sort: field('torrent_mod_default_sort', 'seeders'), minSeeders: parseInt(field('torrent_mod_min_seeders', '0'), 10) || 0, resolution: 'any' };

        toolbar.append(sortSelect).append(minSeedersSelect);
        html.append(toolbar).append(status).append(body);

        function applyFilters(results) {
            return results.filter(function (item) {
                if (item.seeders < state.minSeeders) return false;
                if (state.resolution !== 'any' && item.release.resolution !== state.resolution) return false;
                return true;
            });
        }

        function applySort(results) {
            var sorted = results.slice();
            if (state.sort === 'size') sorted.sort(function (a, b) { return b.size - a.size; });
            else if (state.sort === 'title') sorted.sort(function (a, b) { return String(a.title).localeCompare(String(b.title)); });
            else sorted.sort(function (a, b) { return b.seeders - a.seeders; });
            return sorted;
        }

        function badge(text) {
            return text ? '<span class="torrent-mod-item__badge">' + Lampa.Utils.escape(text) + '</span>' : '';
        }

        function renderItem(item) {
            var release = item.release;
            var tags = [
                badge(release.resolution),
                badge(release.hdr),
                badge(release.codec),
                badge(release.audioChannels),
                badge(release.voiceType),
                release.subtitles ? badge('SUB') : '',
                release.is3d ? badge('3D') : ''
            ].join('');

            var info = [];
            if (item.tracker) info.push(Lampa.Utils.escape(item.tracker));
            info.push(item.seeders + ' сидов');
            info.push(item.peers + ' пиров');
            var size = formatSize(item.size);
            if (size) info.push(size);

            var node = $(
                '<div class="torrent-mod-item selector">' +
                '<div class="torrent-mod-item__title">' + Lampa.Utils.escape(item.title) + '</div>' +
                '<div class="torrent-mod-item__tags">' + tags + '</div>' +
                '<div class="torrent-mod-item__info">' + info.join(' · ') + '</div>' +
                '</div>'
            );
            node.on('hover:enter', function () { startDownload(item); });
            return node;
        }

        function render() {
            body.empty();
            var results = applySort(applyFilters(state.results));
            if (!results.length) {
                body.append('<div class="torrent-mod__empty">Ничего не найдено по текущим фильтрам</div>');
            } else {
                results.forEach(function (item) { body.append(renderItem(item)); });
            }
            try { Lampa.Controller.collectionSet(scroll.render(), body); } catch (e) {}
        }

        function showError(message) {
            status.text(message);
            body.empty();
            var retry = $('<div class="torrent-mod-item selector torrent-mod-item--retry">Повторить</div>');
            retry.on('hover:enter', runSearch);
            body.append(retry);
            try { Lampa.Controller.collectionSet(scroll.render(), body); } catch (e) {}
        }

        function runSearch() {
            status.text('Поиск…');
            body.empty();
            searchTorrentMod(object).then(function (response) {
                if (response.failed) {
                    showError('Не удалось выполнить поиск — Jackett недоступен или не ответил. Проверьте, что Jackett запущен.');
                    return;
                }
                state.results = response.results;
                if (!state.results.length) {
                    status.text('По вашему запросу ничего не найдено');
                    body.empty();
                    return;
                }
                var indexerNote = (response.indexers || []).filter(function (i) { return i.Error; });
                status.text(state.results.length + ' раздач' + (indexerNote.length ? ' · ' + indexerNote.length + ' источник(ов) недоступны' : ''));
                render();
            });
        }

        function startDownload(item) {
            Lampa.Torrent.start({
                Title: item.title,
                title: item.title,
                MagnetUri: item.magnet,
                Link: item.link,
                poster: object.movie && (object.movie.img || object.movie.poster_path) || ''
            }, object.movie);
        }

        sortSelect.on('hover:enter', function () {
            Lampa.Select.show({
                title: 'Сортировка',
                items: [
                    { title: 'Сиды', sort: 'seeders' },
                    { title: 'Размер', sort: 'size' },
                    { title: 'Название', sort: 'title' }
                ],
                onSelect: function (choice) {
                    state.sort = choice.sort;
                    sortSelect.text('Сортировка: ' + choice.title.toLowerCase());
                    render();
                }
            });
        });

        minSeedersSelect.on('hover:enter', function () {
            Lampa.Select.show({
                title: 'Качество',
                items: [
                    { title: 'Любое', value: 'any' },
                    { title: '4K', value: '2160p' },
                    { title: '1080p', value: '1080p' },
                    { title: '720p', value: '720p' }
                ],
                onSelect: function (choice) {
                    state.resolution = choice.value;
                    minSeedersSelect.text('Фильтр: ' + choice.title);
                    render();
                }
            });
        });

        this.create = function () { return this.render(true); };
        this.render = function (js) { return js ? html : $('<div></div>').append(html); };
        this.start = function () { runSearch(); };
        this.pause = function () {};
        this.stop = function () {};
        this.back = function () { Lampa.Activity.backward(); };
        this.destroy = function () {
            cancelSearch();
            try { scroll.destroy(); } catch (e) {}
            html.remove();
        };
    }

    // ---------- card button ----------

    function addCardButton(event) {
        if (!event || event.type !== 'complite' || !enabled('torrent_mod_enabled', true)) return;
        var movie = event.data && event.data.movie;
        if (!movie) return;
        var activity = event.object && event.object.activity && event.object.activity.render();
        if (!activity || activity.find('.view--torrent-mod').length) return;

        var button = $('<div class="full-start__button selector view--torrent-mod" data-subtitle="v' + VERSION + '">' +
            '<svg viewBox="0 0 64 64" width="34" height="34"><path fill="currentColor" d="M32 4a28 28 0 100 56 28 28 0 000-56zm0 8a20 20 0 110 40 20 20 0 010-40zm0 8a12 12 0 100 24 12 12 0 000-24z"/></svg>' +
            '<span>Torrent Mod</span></div>');
        button.on('hover:enter', function () {
            if (movie.number_of_seasons) showSeasons(movie);
            else openTarget(movie, 0, 0, previousController());
        });

        var reference = activity.find('.view--torrent, .view--smart-ts').last();
        if (reference.length) reference.after(button);
        else activity.find('.full-start__buttons').append(button);
    }

    // ---------- settings ----------

    function addSettings() {
        if (!Lampa.SettingsApi || !Lampa.SettingsApi.addComponent) return;
        Lampa.SettingsApi.addComponent({
            component: 'torrent_mod',
            icon: '<svg viewBox="0 0 64 64" width="36" height="36"><path fill="currentColor" d="M32 4a28 28 0 100 56 28 28 0 000-56zm0 8a20 20 0 110 40 20 20 0 010-40zm0 8a12 12 0 100 24 12 12 0 000-24z"/></svg>',
            name: 'Torrent Mod'
        });

        Lampa.SettingsApi.addParam({
            component: 'torrent_mod',
            param: { name: 'torrent_mod_enabled', type: 'trigger', default: true },
            field: { name: 'Torrent Mod', description: 'Отдельный поиск и просмотр торрентов сразу по всем источникам Jackett' }
        });

        Lampa.SettingsApi.addParam({
            component: 'torrent_mod',
            param: {
                name: 'torrent_mod_default_sort',
                type: 'select',
                values: { seeders: 'Сиды', size: 'Размер', title: 'Название' },
                default: 'seeders'
            },
            field: { name: 'Сортировка по умолчанию', description: '' }
        });

        Lampa.SettingsApi.addParam({
            component: 'torrent_mod',
            param: {
                name: 'torrent_mod_min_seeders',
                type: 'select',
                values: { '0': 'Без ограничения', '1': '1', '3': '3', '5': '5', '10': '10' },
                default: '0'
            },
            field: { name: 'Минимум сидов', description: 'Скрывать раздачи с сидами ниже этого значения' }
        });

        Lampa.SettingsApi.addParam({
            component: 'torrent_mod',
            param: {
                name: 'torrent_mod_preload_timeout',
                type: 'select',
                values: { '30': '30 секунд', '60': '60 секунд', '90': '90 секунд', '120': '2 минуты' },
                default: '60'
            },
            field: { name: 'Лимит предзагрузки', description: 'После этого времени видео запустится с текущим буфером' }
        });

        [
            ['torrent_mod_query_pack', 'Искать сезон целиком', 'Дополнительный запрос на весь сезон, не только серию', true],
            ['torrent_mod_query_russian', 'Искать «N сезон»', 'Дополнительный локализованный вариант запроса', true]
        ].forEach(function (setting) {
            Lampa.SettingsApi.addParam({
                component: 'torrent_mod',
                param: { name: setting[0], type: 'trigger', default: setting[3] },
                field: { name: setting[1], description: setting[2] }
            });
        });
    }

    // ---------- styles ----------

    function addStyles() {
        if (document.getElementById('torrent-mod-styles')) return;
        var style = document.createElement('style');
        style.id = 'torrent-mod-styles';
        style.textContent = [
            '.torrent-mod{padding:1.5em}',
            '.torrent-mod__toolbar{display:flex;gap:.8em;margin-bottom:1em}',
            '.torrent-mod__control{padding:.5em .9em;background:#2c394b;border-radius:.6em}',
            '.torrent-mod__control.focus{background:#fff;color:#111}',
            '.torrent-mod__status{opacity:.7;margin-bottom:1em}',
            '.torrent-mod__empty{opacity:.6;padding:2em 0;text-align:center}',
            '.torrent-mod-item{padding:1em;margin-bottom:.6em;background:#182231;border-radius:.8em}',
            '.torrent-mod-item.focus{background:#fff;color:#111}',
            '.torrent-mod-item__title{font-weight:600;margin-bottom:.4em}',
            '.torrent-mod-item__tags{margin-bottom:.4em}',
            '.torrent-mod-item__badge{display:inline-block;padding:.15em .5em;margin-right:.4em;background:#2c394b;border-radius:.4em;font-size:.8em}',
            '.torrent-mod-item.focus .torrent-mod-item__badge{background:#e6e6e6;color:#111}',
            '.torrent-mod-item__info{opacity:.75;font-size:.9em}',
            '.torrent-mod-item--retry{text-align:center}',
            '.view--torrent-mod svg{margin-right:.7em}'
        ].join('');
        document.head.appendChild(style);
    }

    addStyles();
    addSettings();
    Lampa.Template.add('torrent_mod', '<div></div>');
    Lampa.Component.add('torrent_mod', TorrentModComponent);
    Lampa.Listener.follow('full', addCardButton);
    console.log('Torrent Mod ' + VERSION + ': ready');
})(jQuery, Lampa);
