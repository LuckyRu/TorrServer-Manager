(function ($, Lampa) {
    'use strict';

    if (!window.Lampa || window.smart_ts_plugin_ready) return;
    window.smart_ts_plugin_ready = true;

    var VERSION = '1.4.1';
    var scriptUrl = document.currentScript && document.currentScript.src ? document.currentScript.src : '';
    var hubBase = scriptUrl.replace(/\/plugins\/[^/?]+\.js(?:\?.*)?$/i, '');
    var session = null;
    var fileList = null;
    var searchRequests = [];
    var originalStream = Lampa.Torserver && Lampa.Torserver.stream;
    var originalPlay = Lampa.Player && Lampa.Player.play;
    var originalPlaylist = Lampa.Player && Lampa.Player.playlist;
    var originalCallback = Lampa.Player && Lampa.Player.callback;
    var originalStat = Lampa.Player && Lampa.Player.stat;
    var pendingPlayer = null;

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

    function movieKey(movie) {
        return String((movie && movie.id) || '') + ':' + compact((movie && (movie.original_name || movie.original_title || movie.name || movie.title)) || '');
    }

    function sameMovie(left, right) {
        if (!left || !right) return false;
        if (left.id && right.id) return String(left.id) === String(right.id);
        return movieKey(left) === movieKey(right);
    }

    function notify(message) {
        if (Lampa.Noty && Lampa.Noty.show) Lampa.Noty.show(message);
        else console.log('Smart TS:', message);
    }

    function previousController() {
        try { return Lampa.Controller.enabled().name; } catch (e) { return 'content'; }
    }

    function restoreController(name) {
        try { Lampa.Controller.toggle(name || 'content'); } catch (e) {}
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

    function fetchSeason(movie, season) {
        var language = field('tmdb_lang', 'ru');
        var path = 'tv/' + movie.id + '/season/' + season + '?api_key=' + Lampa.TMDB.key() + '&language=' + encodeURIComponent(language);
        return request(Lampa.TMDB.api(path), 15000).then(function (data) {
            return data && Array.isArray(data.episodes) ? data.episodes : [];
        });
    }

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
            title: 'Торрент-серии · выберите сезон',
            items: items,
            onBack: function () { restoreController(controller); },
            onSelect: function (choice) {
                if (choice.resume) openEpisode(movie, choice.season, choice.episode, controller);
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
                onSelect: function (choice) { openEpisode(movie, season, choice.episode, controller); },
                onDraw: function (item, choice) {
                    if (choice.view && Lampa.Timeline && Lampa.Timeline.render) item.append(Lampa.Timeline.render(choice.view));
                }
            });
        });
    }

    function openEpisode(movie, season, episode, controller) {
        session = {
            movie: movie,
            season: parseInt(season, 10),
            episode: parseInt(episode, 10),
            created: Date.now(),
            controller: controller || 'content'
        };
        smartSearch(session);
    }

    function baseTitles(movie) {
        return unique([
            movie.title || movie.name,
            movie.original_title || movie.original_name
        ].filter(Boolean), function (title) { return compact(title); });
    }

    function buildQueries(target) {
        var exact = 'S' + pad(target.season) + 'E' + pad(target.episode);
        var pack = 'S' + pad(target.season);
        var titles = baseTitles(target.movie);
        var queries = [];
        titles.forEach(function (title) { queries.push({ text: title + ' ' + exact, exact: true }); });
        titles.forEach(function (title) { queries.push({ text: title + ' ' + pack, exact: false }); });
        if (titles[0]) queries.push({ text: titles[0] + ' ' + target.season + ' сезон', exact: false });
        return unique(queries, function (query) { return compact(query.text); }).slice(0, 5);
    }

    function torrServerUrl() {
        try {
            if (Lampa.Torserver && Lampa.Torserver.ip) return String(Lampa.Torserver.ip() || '').replace(/\/$/, '');
        } catch (e) {}
        var name = field('torrserver_use_link', 'one') === 'two' ? 'torrserver_url_two' : 'torrserver_url';
        return String(field(name, '') || '').replace(/\/$/, '');
    }

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

    function titleSimilarity(title, movie) {
        var haystack = ' ' + compact(title) + ' ';
        var best = 0;
        baseTitles(movie).forEach(function (name) {
            var tokens = compact(name).split(' ').filter(function (token) { return token.length > 2; });
            if (!tokens.length) return;
            var hits = tokens.filter(function (token) { return haystack.indexOf(' ' + token + ' ') >= 0; }).length;
            best = Math.max(best, hits / tokens.length);
        });
        return best;
    }

    function torrentScore(item, target) {
        var signals = parseSignals(item.Title || item.title);
        var score = Math.round(titleSimilarity(item.Title || item.title, target.movie) * 25);
        var seasonMatches = signals.seasons.indexOf(target.season) >= 0;
        var episodeMatches = signals.explicitEpisode && target.episode >= signals.episodeFrom && target.episode <= signals.episodeTo;

        if (signals.explicitSeason) score += seasonMatches ? 28 : -100;
        else score += target.season === 1 ? 5 : 0;

        if (signals.explicitEpisode) score += episodeMatches ? 65 : -90;
        else if (seasonMatches) score += 22;

        var seeds = parseInt(item.Seed || item.Seeders || item.seeders, 10) || 0;
        score += Math.min(18, Math.round(Math.log(seeds + 1) * 4));
        if (item._exactQuery) score += 5;

        return {
            value: score,
            season: seasonMatches,
            episode: episodeMatches,
            signals: signals
        };
    }

    function mapTorrent(raw, query) {
        var magnet = raw.MagnetUri || raw.Magnet || '';
        var link = raw.Link || raw.downloadUrl || '';
        if (!magnet && /^magnet:/i.test(link)) magnet = link;
        if (!magnet && !link) return null;
        return {
            Title: raw.Title || raw.title || 'Без названия',
            title: raw.Title || raw.title || 'Без названия',
            Tracker: raw.Tracker || raw.indexer || '',
            Size: raw.Size || raw.size || 0,
            Seeders: parseInt(raw.Seed || raw.Seeders || raw.seeders, 10) || 0,
            Peers: parseInt(raw.Peer || raw.Peers || raw.leechers, 10) || 0,
            MagnetUri: magnet,
            Link: link,
            _exactQuery: !!query.exact
        };
    }

    function searchEndpoint(base, path, query, timeout) {
        return request(base + path + '?query=' + encodeURIComponent(query.text), timeout || 20000).then(function (data) {
            var items = data && Array.isArray(data.Results) ? data.Results : data;
            if (!Array.isArray(items)) return [];
            return items.map(function (raw) { return mapTorrent(raw, query); }).filter(Boolean);
        });
    }

    function smartSearch(target) {
        var base = torrServerUrl();
        if (!base) {
            notify('Сначала задайте адрес TorrServer');
            return;
        }

        var controller = target.controller || previousController();
        var queries = buildQueries(target);
        var mode = field('torrserver_search_type', 'both');
        var calls = [];

        queries.forEach(function (query, index) {
            if (mode === 'rutor' || mode === 'both') calls.push(searchEndpoint(base, '/search/', query, 22000));
            if ((mode === 'torznab' || mode === 'both') && index < 3) {
                if (hubBase) calls.push(searchEndpoint(hubBase, '/api/smart-search', query, 35000));
                else calls.push(searchEndpoint(base, '/torznab/search/', query, 40000));
            }
        });

        Lampa.Loading.start(function () {
            cancelSearch();
            Lampa.Loading.stop();
            restoreController(controller);
        });
        Lampa.Loading.setText('Ищем S' + pad(target.season) + 'E' + pad(target.episode) + '…');

        Promise.all(calls).then(function (groups) {
            Lampa.Loading.stop();
            var results = unique([].concat.apply([], groups), function (item) {
                return compact(item.MagnetUri || item.Link || item.Title + '|' + item.Size);
            });
            results.forEach(function (item) { item._score = torrentScore(item, target); });
            results.sort(function (a, b) {
                return b._score.value - a._score.value || b.Seeders - a.Seeders;
            });

            if (!results.length) {
                notify('Точная раздача не найдена — открыт обычный поиск');
                return openNativeSearch(target);
            }

            var best = results[0];
            var next = results[1];
            var confident = best._score.value >= 58 &&
                (best._score.episode || (best._score.season && !best._score.signals.explicitEpisode)) &&
                (!next || best._score.value - next._score.value >= 6 || best.Seeders > next.Seeders * 2);

            if (confident) {
                notify('Smart TS: ' + (best.Tracker || 'раздача') + ' · ' + best.Seeders + ' сидов');
                startTorrent(best, target);
            } else {
                showTorrentChoices(results.slice(0, 12), target, controller);
            }
        });
    }

    function formatSize(value) {
        if (!value) return '';
        if (typeof value === 'string' && /[a-zа-я]/i.test(value)) return value;
        var bytes = parseFloat(value);
        return isNaN(bytes) ? '' : Lampa.Utils.bytesToSize(bytes);
    }

    function showTorrentChoices(results, target, controller) {
        var items = results.map(function (torrent, index) {
            var info = [];
            if (torrent.Tracker) info.push(torrent.Tracker);
            info.push(torrent.Seeders + ' сидов');
            var size = formatSize(torrent.Size);
            if (size) info.push(size);
            return {
                title: torrent.Title,
                subtitle: info.join(' · '),
                torrent: torrent,
                selected: index === 0
            };
        });
        items.push({ title: 'Открыть обычный поиск торрентов', subtitle: 'Ручной выбор раздачи', manual: true });

        Lampa.Select.show({
            title: 'Раздачи найдены, но выбор неоднозначен',
            items: items,
            onBack: function () { restoreController(controller); },
            onSelect: function (choice) {
                if (choice.manual) openNativeSearch(target);
                else startTorrent(choice.torrent, target);
            }
        });
    }

    function openNativeSearch(target) {
        session = target;
        var titles = baseTitles(target.movie);
        Lampa.Activity.push({
            url: '',
            title: 'Торренты · S' + pad(target.season) + 'E' + pad(target.episode),
            component: 'torrents',
            search: titles[0] || '',
            search_one: titles[0] || '',
            search_two: titles[1] || '',
            movie: target.movie,
            page: 1
        });
    }

    function startTorrent(torrent, target) {
        session = target;
        torrent.poster = target.movie.img || target.movie.poster_path || '';
        Lampa.Torrent.start(torrent, target.movie);
    }

    function fileScore(element, target) {
        var path = String(element.path || element.title || '');
        var signals = parseSignals(path);
        var score = 0;
        var season = parseInt(element.season, 10) || 0;
        var episode = parseInt(element.episode, 10) || 0;

        if (season) score += season === target.season ? 35 : -110;
        if (episode) score += episode === target.episode ? 100 : -95;

        if (signals.explicitSeason) score += signals.seasons.indexOf(target.season) >= 0 ? 35 : -100;
        if (signals.explicitEpisode) {
            score += target.episode >= signals.episodeFrom && target.episode <= signals.episodeTo ? 110 : -100;
        }

        var folder = path.split(/[\\/]/);
        var fileName = folder.pop() || '';
        var folderName = folder.join(' ');
        var folderSignals = parseSignals(folderName);
        if (folderSignals.explicitSeason && folderSignals.seasons.indexOf(target.season) >= 0) {
            score += 25;
            var bare = fileName.replace(/\.[^.]+$/, '').match(/(?:^|\D)(\d{1,3})(?:\D|$)/);
            if (bare && parseInt(bare[1], 10) === target.episode) score += 75;
        }

        return score;
    }

    function repairTimeline(event) {
        var element = event.element;
        var movie = event.params && event.params.movie;
        if (!movie || !element || !element.season || !element.episode || !element.timeline) return;
        var canonical = canonicalTimeline(movie, element.season, element.episode);
        if (!canonical || canonical.hash === element.timeline.hash) return;

        element.timeline.hash = canonical.hash;
        element.timeline.percent = canonical.percent;
        element.timeline.time = canonical.time;
        element.timeline.duration = canonical.duration;
        element.timeline.profile = canonical.profile;
        element.timeline.updated = canonical.updated;
        element.timeline.handler = canonical.handler;

        var line = event.item.find('.time-line');
        line.attr('data-hash', canonical.hash).toggleClass('hide', !canonical.percent);
        line.find('> div').css('width', canonical.percent + '%');
    }

    function finalizeFileList(state) {
        if (!fileList || fileList !== state || state.finished) return;
        state.finished = true;
        var rendered = state.rendered;
        if (!rendered.length || !enabled('smart_ts_enabled', true)) return;

        if (rendered.length === 1 && enabled('smart_ts_single_autoplay', true)) {
            notify('Smart TS: единственный видеофайл — запускаем');
            setTimeout(function () { rendered[0].item.trigger('hover:enter'); }, 80);
            return;
        }

        var target = state.target;
        if (!target || !enabled('smart_ts_episode_autoplay', true)) return;
        rendered.forEach(function (entry) { entry.score = fileScore(entry.element, target); });
        rendered.sort(function (a, b) { return b.score - a.score; });
        var best = rendered[0];
        var second = rendered[1];
        var confident = best.score >= 95 && (!second || best.score - second.score >= 25);

        if (confident) {
            var badge = $('<div class="smart-ts-match">S' + pad(target.season) + 'E' + pad(target.episode) + ' · найдено автоматически</div>');
            best.item.prepend(badge);
            notify('Smart TS: найден файл S' + pad(target.season) + 'E' + pad(target.episode));
            session = null;
            setTimeout(function () { best.item.trigger('hover:enter'); }, 100);
        } else {
            if (best && best.score > 0) {
                best.item.prepend('<div class="smart-ts-hint">Вероятно S' + pad(target.season) + 'E' + pad(target.episode) + ' — проверьте имя файла</div>');
                try { Lampa.Controller.collectionFocus(best.item, Lampa.Modal.scroll().render()); } catch (e) {}
            }
            notify('Не удалось надёжно распознать серию — выберите файл вручную');
        }
    }

    function onTorrentFile(event) {
        if (!event || !enabled('smart_ts_enabled', true)) return;
        if (event.type === 'list_open') {
            var target = session && Date.now() - session.created < 5 * 60 * 1000 && sameMovie(session.movie, event.params && event.params.movie) ? session : null;
            fileList = { items: event.items || [], params: event.params || {}, target: target, rendered: [], finished: false };
        } else if (event.type === 'render' && fileList) {
            repairTimeline(event);
            fileList.rendered.push({ element: event.element, item: event.item, score: 0 });
            if (fileList.rendered.length >= fileList.items.length) {
                var state = fileList;
                setTimeout(function () { finalizeFileList(state); }, 0);
            }
        } else if (event.type === 'onenter') {
            if (fileList && fileList.target) session = null;
        } else if (event.type === 'list_close') {
            fileList = null;
        }
    }

    function parseStreamUrl(url) {
        var match = String(url || '').match(/^(https?:\/\/[^/]+)(\/stream\/[^?]+)\?(.+)$/i);
        if (!match) return null;
        var args = {};
        match[3].split('&').forEach(function (part) {
            var pair = part.split('=');
            args[pair[0]] = pair.length > 1 ? pair.slice(1).join('=') : '';
        });
        delete args.play;
        delete args.preload;
        delete args.stat;
        var query = Object.keys(args).map(function (key) { return key + (args[key] !== '' ? '=' + args[key] : ''); }).join('&');
        return { base: match[1], stream: match[2], args: args, clear: match[1] + match[2] + '?' + query };
    }

    function clonePlayData(data) {
        var copy = {};
        Object.keys(data || {}).forEach(function (key) { copy[key] = data[key]; });
        var parsed = parseStreamUrl(copy.url);
        if (parsed) copy.url = parsed.clear + '&play';
        return copy;
    }

    function installPlayerHooks() {
        if (!originalStream || !originalPlay) return;

        Lampa.Torserver.stream = function () {
            var url = originalStream.apply(Lampa.Torserver, arguments);
            if (enabled('smart_ts_enabled', true) && enabled('smart_ts_preload_ui', true) && /\/stream\//i.test(url)) {
                return url.replace(/&preload\b/i, '&play');
            }
            return url;
        };

        Lampa.Player.play = function (data) {
            var parsed = parseStreamUrl(data && data.url);
            var shouldPreload = enabled('smart_ts_enabled', true) && enabled('smart_ts_preload_ui', true) &&
                enabled('torrserver_preload', false) && parsed && parsed.args.link;
            if (!shouldPreload || pendingPlayer) return originalPlay(data);

            pendingPlayer = {
                data: clonePlayData(data),
                playlist: null,
                callback: null,
                stat: null,
                parsed: parsed,
                started: Date.now()
            };
            showPreload(pendingPlayer);
        };

        Lampa.Player.playlist = function (playlist) {
            if (!pendingPlayer) return originalPlaylist(playlist);
            pendingPlayer.playlist = (playlist || []).map(clonePlayData);
        };
        Lampa.Player.callback = function (callback) {
            if (!pendingPlayer) return originalCallback(callback);
            pendingPlayer.callback = callback;
        };
        Lampa.Player.stat = function (url) {
            if (!pendingPlayer) return originalStat(url);
            pendingPlayer.stat = url;
        };
    }

    function showPreload(job) {
        var oldController = previousController();
        var preloadRequest = new Lampa.Reguest();
        var statRequest = new Lampa.Reguest();
        var pollTimer = 0;
        var clockTimer = 0;
        var closed = false;
        var timeout = parseInt(field('smart_ts_preload_timeout', '60'), 10) || 60;
        var html = $([
            '<div class="smart-ts-overlay">',
            ' <div class="smart-ts-preload">',
            '  <div class="smart-ts-preload__title">Подготовка торрента</div>',
            '  <div class="smart-ts-preload__file"></div>',
            '  <div class="smart-ts-preload__percent">0%</div>',
            '  <div class="smart-ts-preload__bar"><div></div></div>',
            '  <div class="smart-ts-preload__stats">Ожидаем подключение к раздаче…</div>',
            '  <div class="smart-ts-preload__buttons">',
            '   <div class="smart-ts-button selector">Отмена</div>',
            '   <div class="smart-ts-button selector">Запустить сейчас</div>',
            '  </div>',
            ' </div>',
            '</div>'
        ].join(''));
        var buttons = html.find('.smart-ts-button');
        html.find('.smart-ts-preload__file').text(job.data.title || 'Видео');
        $('body').append(html);

        function cleanup() {
            if (closed) return;
            closed = true;
            clearTimeout(pollTimer);
            clearInterval(clockTimer);
            try { preloadRequest.clear(); } catch (e) {}
            try { statRequest.clear(); } catch (e) {}
            html.remove();
        }

        function play() {
            if (!pendingPlayer || pendingPlayer !== job) return;
            cleanup();
            pendingPlayer = null;
            originalPlay(job.data);
            if (job.playlist) originalPlaylist(job.playlist);
            if (job.callback) originalCallback(job.callback);
            if (job.stat) originalStat(job.stat);
        }

        function cancel() {
            if (!pendingPlayer || pendingPlayer !== job) return;
            cleanup();
            pendingPlayer = null;
            restoreController(oldController);
            if (job.callback) job.callback();
        }

        buttons.eq(0).on('hover:enter click', cancel);
        buttons.eq(1).on('hover:enter click', play);

        Lampa.Controller.add('smart_ts_preload', {
            toggle: function () {
                Lampa.Controller.collectionSet(html);
                Lampa.Controller.collectionFocus(buttons.eq(1)[0], html);
            },
            left: function () { Navigator.move('left'); },
            right: function () { Navigator.move('right'); },
            up: function () { Navigator.move('up'); },
            down: function () { Navigator.move('down'); },
            back: cancel
        });
        Lampa.Controller.toggle('smart_ts_preload');

        function updateClock() {
            var elapsed = Math.floor((Date.now() - job.started) / 1000);
            if (elapsed >= timeout) {
                notify('Предзагрузка превысила ' + timeout + ' сек. Запускаем плеер.');
                play();
            }
        }
        clockTimer = setInterval(updateClock, 1000);

        function schedulePoll() {
            if (!closed) pollTimer = setTimeout(poll, 900);
        }

        function poll() {
            if (closed) return;
            statRequest.timeout(2500);
            statRequest.silent(job.parsed.base + '/cache', function (response) {
                var data = response && (response.Torrent || response);
                if (data) {
                    var loaded = parseFloat(data.preloaded_bytes) || 0;
                    var total = parseFloat(data.preload_size) || 0;
                    var percent = total ? Math.min(100, loaded * 100 / total) : 0;
                    var speed = Lampa.Utils.bytesToSize((parseFloat(data.download_speed) || 0) * 8, true);
                    var peers = parseInt(data.active_peers, 10) || 0;
                    var pending = parseInt(data.pending_peers, 10) || 0;
                    var seeds = parseInt(data.connected_seeders, 10) || 0;
                    html.find('.smart-ts-preload__percent').text(Math.round(percent) + '%');
                    html.find('.smart-ts-preload__bar > div').css('width', percent + '%');
                    html.find('.smart-ts-preload__stats').text(
                        Lampa.Utils.bytesToSize(loaded) + ' / ' + Lampa.Utils.bytesToSize(total) +
                        ' · ' + speed + ' · пиры ' + peers + (pending ? '+' + pending : '') + ' · сиды ' + seeds
                    );
                }
                schedulePoll();
            }, schedulePoll, JSON.stringify({ action: 'get', hash: job.parsed.args.link }));
        }

        preloadRequest.timeout((timeout + 5) * 1000);
        preloadRequest.silent(job.parsed.clear + '&preload', play, function () {
            if (!closed) play();
        });
        poll();
    }

    function addSeriesButton(event) {
        if (!event || event.type !== 'complite' || !enabled('smart_ts_enabled', true) || !enabled('smart_ts_series_button', true)) return;
        var movie = event.data && event.data.movie;
        if (!movie || !movie.number_of_seasons) return;
        var activity = event.object && event.object.activity && event.object.activity.render();
        if (!activity || activity.find('.view--smart-ts').length) return;

        var button = $('<div class="full-start__button selector view--smart-ts" data-subtitle="v' + VERSION + '">' +
            '<svg viewBox="0 0 64 64" width="34" height="34"><path fill="currentColor" d="M8 13h48v34H8zM4 9v42h56V9H4zm16 7h8v8h-8v-8zm0 12h8v8h-8v-8zm16-12h8v8h-8v-8zm0 12h8v8h-8v-8z"/></svg>' +
            '<span>Торрент-серии</span></div>');
        button.on('hover:enter', function () { showSeasons(movie); });
        var torrentButton = activity.find('.view--torrent');
        if (torrentButton.length) torrentButton.after(button);
        else activity.find('.full-start__buttons').append(button);
    }

    function addSettings() {
        if (!Lampa.SettingsApi || !Lampa.SettingsApi.addComponent) return;
        Lampa.SettingsApi.addComponent({
            component: 'smart_ts',
            icon: '<svg viewBox="0 0 64 64" width="36" height="36"><path fill="currentColor" d="M8 13h48v34H8zM4 9v42h56V9H4zm16 7h8v8h-8v-8zm0 12h8v8h-8v-8zm16-12h8v8h-8v-8zm0 12h8v8h-8v-8z"/></svg>',
            name: 'Smart TS'
        });
        [
            ['smart_ts_enabled', 'Smart TS', 'Умный поиск и выбор торрент-серий', true],
            ['smart_ts_series_button', 'Кнопка «Торрент-серии»', 'Навигация по сезонам и сериям в карточке сериала', true],
            ['smart_ts_single_autoplay', 'Не спрашивать про один файл', 'Сразу запускать единственный видеофайл в раздаче', true],
            ['smart_ts_episode_autoplay', 'Автовыбор серии', 'Запускать файл при надёжном распознавании сезона и серии', true],
            ['smart_ts_preload_ui', 'Подробная предзагрузка', 'Показывать буфер, скорость, пиры и сиды перед плеером', true]
        ].forEach(function (setting) {
            Lampa.SettingsApi.addParam({
                component: 'smart_ts',
                param: { name: setting[0], type: 'trigger', default: setting[3] },
                field: { name: setting[1], description: setting[2] }
            });
        });
        Lampa.SettingsApi.addParam({
            component: 'smart_ts',
            param: {
                name: 'smart_ts_preload_timeout',
                type: 'select',
                values: { '30': '30 секунд', '60': '60 секунд', '90': '90 секунд', '120': '2 минуты' },
                default: '60'
            },
            field: { name: 'Лимит предзагрузки', description: 'После этого времени видео запустится с текущим буфером' }
        });
    }

    function addStyles() {
        if (document.getElementById('smart-ts-styles')) return;
        var style = document.createElement('style');
        style.id = 'smart-ts-styles';
        style.textContent = [
            '.smart-ts-overlay{position:fixed;z-index:10000;inset:0;background:rgba(8,12,20,.92);display:flex;align-items:center;justify-content:center;padding:2em}',
            '.smart-ts-preload{width:min(46em,92vw);background:#182231;border-radius:1.2em;padding:2em;box-shadow:0 1em 5em #000}',
            '.smart-ts-preload__title{font-size:1.55em;font-weight:700;margin-bottom:.45em}',
            '.smart-ts-preload__file{opacity:.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
            '.smart-ts-preload__percent{font-size:2.5em;font-weight:700;margin:.55em 0 .15em}',
            '.smart-ts-preload__bar{height:.65em;background:#2c394b;border-radius:1em;overflow:hidden}',
            '.smart-ts-preload__bar>div{height:100%;width:0;background:#58d68d;transition:width .25s}',
            '.smart-ts-preload__stats{margin:1em 0 1.5em;min-height:1.4em;opacity:.85}',
            '.smart-ts-preload__buttons{display:flex;gap:.8em}',
            '.smart-ts-button{padding:.75em 1.2em;background:#2c394b;border-radius:.6em}',
            '.smart-ts-button.focus{background:#fff;color:#111}',
            '.smart-ts-match,.smart-ts-hint{padding:.45em .7em;margin-bottom:.45em;border-radius:.45em;font-size:.85em}',
            '.smart-ts-match{background:#135c3a;color:#c8ffe4}',
            '.smart-ts-hint{background:#72510b;color:#fff1ba}',
            '.view--smart-ts svg{margin-right:.7em}'
        ].join('');
        document.head.appendChild(style);
    }

    addStyles();
    addSettings();
    installPlayerHooks();
    Lampa.Listener.follow('full', addSeriesButton);
    Lampa.Listener.follow('torrent_file', onTorrentFile);
    console.log('Smart TS ' + VERSION + ': ready');
})(jQuery, Lampa);
