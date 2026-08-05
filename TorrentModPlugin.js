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

    // Builds the season picker list shown inline in TorrentModComponent's toolbar (the slot
    // Online Mod uses for its balancer picker) — no separate pre-screen anymore, episode-level
    // choice happens naturally when the user opens a multi-file torrent's file list.
    function buildSeasonItems(movie, currentSeason) {
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

    function initialSeason(movie) {
        if (!movie.number_of_seasons) return 0;
        var continueAt = scanProgress(movie);
        return continueAt ? continueAt.season : 1;
    }

    function openTarget(movie, season, controller) {
        Lampa.Activity.push({
            url: '',
            title: 'Torrent Mod' + (season ? ' · Сезон ' + season : ''),
            component: 'torrent_mod',
            movie: movie,
            season: season || 0,
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

        if (target.episode) {
            var exact = 'S' + pad(target.season) + 'E' + pad(target.episode);
            titles.forEach(function (title) { queries.push(title + ' ' + exact); });
        }
        if (target.season) {
            var pack = 'S' + pad(target.season);
            titles.forEach(function (title) { queries.push(title + ' ' + pack); });
            if (enabled('torrent_mod_query_russian', true) && titles[0]) {
                queries.push(titles[0] + ' ' + target.season + ' сезон');
            }
        }
        if (!target.season) {
            titles.forEach(function (title) { queries.push(title); });
        }

        return unique(queries, compact).slice(0, 4);
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

    // Adapted from SmartTsPlugin.js's torrentScore — decides whether a torrent is confidently
    // "this exact episode" (auto-play) or ambiguous (show a picker) once the user has already
    // chosen an episode from metadata; the torrent match itself stays a secondary, automatic step.
    function episodeMatchScore(item, target) {
        var signals = item.release;
        var score = Math.round(titleSimilarity(item.title, target.movie) * 25);
        var seasonMatches = signals.seasons.indexOf(target.season) >= 0;
        var episodeMatches = signals.explicitEpisode && target.episode >= signals.episodeFrom && target.episode <= signals.episodeTo;

        if (signals.explicitSeason) score += seasonMatches ? 28 : -100;
        else score += target.season === 1 ? 5 : 0;

        if (signals.explicitEpisode) score += episodeMatches ? 65 : -90;
        else if (seasonMatches) score += 22;

        score += Math.min(18, Math.round(Math.log(item.seeders + 1) * 4));
        return { value: score, season: seasonMatches, episode: episodeMatches };
    }

    function matchesTranslation(item, voiceType) {
        if (!voiceType || voiceType === 'any') return true;
        return item.release.voiceType === voiceType;
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

    // Primary content is EPISODE metadata (from TMDB), not raw torrent search results — matching
    // an episode to an actual torrent is a secondary, mostly-automatic step that happens only
    // once an episode is picked (auto-play on a confident match, a small picker otherwise), the
    // same division SmartTsPlugin.js already uses. Season/translation live in the toolbar (the
    // slot Online Mod uses for its balancer picker); anything else is a plain filter list.
    function TorrentModComponent(object) {
        var scroll = new Lampa.Scroll({ mask: true, over: true, step: 250 });
        var html = $('<div class="torrent-mod"></div>');
        var grid = $('<div class="torrent-mod__grid"></div>');
        var status = $('<div class="torrent-mod__status"></div>');
        var toolbar = $('<div class="torrent-mod__toolbar"></div>');
        var seasonControl = $('<div class="torrent-mod__control selector" data-name="season"></div>');
        var voiceControl = $('<div class="torrent-mod__control selector" data-name="voice">Перевод: любой</div>');
        var filtersControl = $('<div class="torrent-mod__control selector" data-name="filters">Фильтры</div>');
        var hasSeasons = !!(object.movie && object.movie.number_of_seasons);
        var state = {
            season: object.season || 0,
            voiceType: 'any',
            resolution: 'any'
        };

        if (hasSeasons) {
            toolbar.append(seasonControl);
            updateSeasonLabel();
        }
        toolbar.append(voiceControl).append(filtersControl);
        html.append(toolbar).append(status).append(grid);

        function updateSeasonLabel() {
            seasonControl.text('Сезон: ' + (state.season || 1));
        }

        function episodeCard(episode, view) {
            var number = parseInt(episode.episode_number, 10);
            var poster = episode.still_path
                ? 'https://image.tmdb.org/t/p/w300' + episode.still_path
                : (object.movie.img || object.movie.poster_path || '');
            var node = $(
                '<div class="torrent-mod-episode selector">' +
                '<div class="torrent-mod-episode__poster" style="background-image:url(\'' + poster + '\')"></div>' +
                '<div class="torrent-mod-episode__body">' +
                '<div class="torrent-mod-episode__title">' + number + '. ' + Lampa.Utils.escape(episode.name || ('Серия ' + number)) + '</div>' +
                '<div class="torrent-mod-episode__meta">' + Lampa.Utils.escape(episode.air_date || '') + '</div>' +
                '<div class="torrent-mod-episode__timeline"></div>' +
                '</div></div>'
            );
            if (view && Lampa.Timeline && Lampa.Timeline.render) node.find('.torrent-mod-episode__timeline').append(Lampa.Timeline.render(view));
            node.on('hover:enter', function () { selectEpisode(number); });
            return node;
        }

        function renderEpisodes(episodes) {
            grid.empty();
            episodes.forEach(function (episode) {
                var view = canonicalTimeline(object.movie, state.season, parseInt(episode.episode_number, 10));
                grid.append(episodeCard(episode, view));
            });
            try { Lampa.Controller.collectionSet(scroll.render(), grid); } catch (e) {}
        }

        function renderMovieCard() {
            grid.empty();
            var node = $(
                '<div class="torrent-mod-episode selector">' +
                '<div class="torrent-mod-episode__poster" style="background-image:url(\'' + (object.movie.img || object.movie.poster_path || '') + '\')"></div>' +
                '<div class="torrent-mod-episode__body"><div class="torrent-mod-episode__title">Найти раздачи</div></div>' +
                '</div>'
            );
            node.on('hover:enter', function () { selectEpisode(0); });
            grid.append(node);
            try { Lampa.Controller.collectionSet(scroll.render(), grid); } catch (e) {}
        }

        function showMessage(message, retry) {
            status.text(message);
            grid.empty();
            if (retry) {
                var retryNode = $('<div class="torrent-mod-episode selector"><div class="torrent-mod-episode__body"><div class="torrent-mod-episode__title">Повторить</div></div></div>');
                retryNode.on('hover:enter', retry);
                grid.append(retryNode);
            }
            try { Lampa.Controller.collectionSet(scroll.render(), grid); } catch (e) {}
        }

        function loadEpisodes() {
            status.text('Загрузка списка серий…');
            fetchSeason(object.movie, state.season).then(function (episodes) {
                if (!episodes.length) {
                    var fallbackCount = episodeCounts(object.movie)[state.season] || 0;
                    for (var i = 1; i <= fallbackCount; i++) episodes.push({ episode_number: i, name: 'Серия ' + i });
                }
                if (!episodes.length) { showMessage('Список серий недоступен', loadEpisodes); return; }
                status.text('');
                renderEpisodes(episodes);
            }).catch(function () { showMessage('Не удалось загрузить список серий', loadEpisodes); });
        }

        function selectEpisode(episode) {
            var target = { movie: object.movie, season: state.season, episode: episode };
            status.text('Ищем' + (episode ? ' S' + pad(state.season) + 'E' + pad(episode) : '') + '…');
            searchTorrentMod(target).then(function (response) {
                if (response.failed) { notify('Jackett недоступен или не ответил'); status.text(''); return; }
                var candidates = response.results.filter(function (item) { return matchesTranslation(item, state.voiceType); });
                if (!candidates.length) candidates = response.results;
                if (state.resolution !== 'any') {
                    var byQuality = candidates.filter(function (item) { return item.release.resolution === state.resolution; });
                    if (byQuality.length) candidates = byQuality;
                }
                if (!candidates.length) { notify('Ничего не найдено'); status.text(''); return; }

                candidates.forEach(function (item) { item._score = episodeMatchScore(item, target); });
                candidates.sort(function (a, b) { return b._score.value - a._score.value || b.seeders - a.seeders; });
                status.text('');

                var best = candidates[0];
                var next = candidates[1];
                var confident = episode
                    ? best._score.value >= 58 && (best._score.episode || (best._score.season && !best.release.explicitEpisode)) &&
                        (!next || best._score.value - next._score.value >= 6 || best.seeders > next.seeders * 2)
                    : best._score.value >= 25;

                if (confident) startDownload(best);
                else showCandidates(candidates.slice(0, 10));
            });
        }

        function showCandidates(candidates) {
            var items = candidates.map(function (item, index) {
                var info = [];
                if (item.tracker) info.push(item.tracker);
                info.push(item.seeders + ' сидов');
                var size = formatSize(item.size);
                if (size) info.push(size);
                if (item.release.voiceType) info.push(item.release.voiceType);
                return { title: item.title, subtitle: info.join(' · '), torrent: item, selected: index === 0 };
            });
            Lampa.Select.show({
                title: 'Выбор раздачи',
                items: items,
                onSelect: function (choice) { startDownload(choice.torrent); }
            });
        }

        function startDownload(item) {
            notify((item.tracker || 'Torrent Mod') + ' · ' + item.seeders + ' сидов');
            Lampa.Torrent.start({
                Title: item.title,
                title: item.title,
                MagnetUri: item.magnet,
                Link: item.link,
                poster: object.movie && (object.movie.img || object.movie.poster_path) || ''
            }, object.movie);
        }

        function start() {
            if (!hasSeasons) { status.text(''); renderMovieCard(); return; }
            loadEpisodes();
        }

        seasonControl.on('hover:enter', function () {
            Lampa.Select.show({
                title: 'Выберите сезон',
                items: buildSeasonItems(object.movie, state.season),
                onSelect: function (choice) {
                    if (choice.season === state.season) return;
                    state.season = choice.season;
                    updateSeasonLabel();
                    loadEpisodes();
                }
            });
        });

        voiceControl.on('hover:enter', function () {
            Lampa.Select.show({
                title: 'Перевод',
                items: [
                    { title: 'Любой', value: 'any' },
                    { title: 'Дубляж', value: 'Дубляж' },
                    { title: 'Многоголосый', value: 'Многоголосый' },
                    { title: 'Одноголосый', value: 'Одноголосый' },
                    { title: 'Оригинал', value: 'Оригинал' }
                ],
                onSelect: function (choice) {
                    state.voiceType = choice.value;
                    voiceControl.text('Перевод: ' + choice.title.toLowerCase());
                }
            });
        });

        filtersControl.on('hover:enter', function () {
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
                    filtersControl.text(choice.value === 'any' ? 'Фильтры' : 'Качество: ' + choice.title);
                }
            });
        });

        this.create = function () { return this.render(true); };
        this.render = function (js) { return js ? html : $('<div></div>').append(html); };
        this.start = function () { start(); };
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
            openTarget(movie, initialSeason(movie), previousController());
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
            param: { name: 'torrent_mod_query_russian', type: 'trigger', default: true },
            field: { name: 'Искать «N сезон»', description: 'Дополнительный локализованный вариант запроса' }
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
            '.torrent-mod__status{opacity:.7;margin-bottom:1em;min-height:1.2em}',
            '.torrent-mod__grid{display:flex;flex-wrap:wrap;gap:1em}',
            '.torrent-mod-episode{width:16em;border-radius:.8em;overflow:hidden;background:#182231}',
            '.torrent-mod-episode.focus{background:#fff;color:#111}',
            '.torrent-mod-episode__poster{width:100%;height:9em;background-size:cover;background-position:center;background-color:#0b1220}',
            '.torrent-mod-episode__body{padding:.8em}',
            '.torrent-mod-episode__title{font-weight:600;margin-bottom:.3em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
            '.torrent-mod-episode__meta{opacity:.7;font-size:.85em}',
            '.torrent-mod-episode__timeline{margin-top:.4em}',
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
