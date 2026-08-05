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

    // Lampa.Utils has no HTML-escaping helper (confirmed live against a real Lampa instance —
    // Lampa.Utils.escape does not exist there), so this is our own.
    function escapeHtml(text) {
        return String(text == null ? '' : text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function notify(message) {
        if (Lampa.Noty && Lampa.Noty.show) Lampa.Noty.show(message);
        else console.log('Torrent Mod:', message);
    }

    // Behind the `torrent_mod_debug` setting (off by default). Prints a table of every scored
    // candidate for a search — raw title, everything parseRelease() extracted from it, and the
    // three score components — so parsing/scoring quality on real raздачи (especially season
    // packs with inconsistent naming) can be checked directly in devtools without guessing.
    function debugLogCandidates(candidates, target) {
        try {
            var rows = candidates.map(function (item) {
                var r = item.release;
                var s = item._score || {};
                return {
                    passes: s.passes ? '✓' : '✗',
                    title: item.title,
                    tracker: item.tracker,
                    published: item.publishedAt ? new Date(item.publishedAt).toISOString().slice(0, 10) : '',
                    season: r.seasons.join(','),
                    episodes: r.explicitEpisode ? (r.episodeFrom + '-' + r.episodeTo) : '',
                    resolution: r.resolution,
                    hdr: r.hdr,
                    codec: r.codec,
                    voice: r.voiceType,
                    subs: r.subtitles,
                    sizeMB: Math.round(item.size / 1048576),
                    bitrateMbps: s.bitrateMbps ? s.bitrateMbps.toFixed(2) : '',
                    seeders: item.seeders,
                    peers: item.peers,
                    match: s.matchScore,
                    quality: s.qualityScore ? s.qualityScore.toFixed(1) : '',
                    availability: s.availabilityScore ? s.availabilityScore.toFixed(1) : '',
                    total: s.value ? s.value.toFixed(1) : ''
                };
            });
            console.log('Torrent Mod debug: search target', target);
            if (console.table) console.table(rows); else console.log(rows);
        } catch (e) { console.warn('Torrent Mod debug logging failed', e); }
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
        if (target.customQuery) return [target.customQuery];

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
        var published = Date.parse(raw.PublishDate || raw.publishDate || raw.pubDate || '');
        return {
            title: title,
            tracker: raw.Tracker || raw.indexer || '',
            size: raw.Size || raw.size || 0,
            seeders: parseInt(raw.Seeders || raw.Seed || raw.seeders, 10) || 0,
            peers: parseInt(raw.Peers || raw.Peer || raw.leechers, 10) || 0,
            publishedAt: isNaN(published) ? 0 : published,
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

    function estimateBitrateMbps(item, target) {
        var release = item.release;
        var covered = (release.explicitEpisode && release.episodeTo >= release.episodeFrom)
            ? (release.episodeTo - release.episodeFrom + 1)
            : Math.max(1, target.seasonEpisodeCount || 1);
        var perEpisodeBytes = item.size / covered;
        var runtimeSeconds = (target.avgRuntimeMinutes || 42) * 60;
        return runtimeSeconds > 0 ? (perEpisodeBytes * 8) / (runtimeSeconds * 1000000) : 0;
    }

    // A believable "good enough for this resolution" bitrate per tier (H.264-ish; real releases
    // vary, this only needs to be roughly right since qualityScore below is a peak, not a cliff).
    // HEVC/H.265 gets scaled down — same perceived quality at a lower bitrate, so judging it
    // against the H.264 reference would unfairly punish well-encoded HEVC releases.
    var REFERENCE_BITRATE_MBPS = { '2160p': 18, '1080p': 6, '720p': 3, '480p': 1.5 };

    function referenceBitrateMbps(release) {
        var base = REFERENCE_BITRATE_MBPS[release.resolution] || REFERENCE_BITRATE_MBPS['1080p'];
        return release.codec === 'H.265' ? base * 0.6 : base;
    }

    // matchScore is a hard gate, not a scored component: title has to plausibly be this movie/show,
    // and if the release states a season/episode at all, it has to be the right one. Candidates that
    // fail this don't get ranked lower, they don't participate — a "Заражённая земля 2019" torrent
    // should never be an option when the target is "Игра престолов" S1E1, no matter how many seeds
    // it has. Releases that *don't* state season/episode explicitly (ambiguous naming, common on
    // some trackers) are let through for qualityScore/availabilityScore to sort out.
    function passesMatchGate(item, target) {
        var release = item.release;
        if (titleSimilarity(item.title, target.movie) < 0.34) return false;
        if (release.explicitSeason && release.seasons.indexOf(target.season) < 0) return false;
        if (target.episode && release.explicitEpisode &&
            !(target.episode >= release.episodeFrom && target.episode <= release.episodeTo)) return false;
        return true;
    }

    // Once a candidate clears the matchScore gate, ranking is qualityScore + availabilityScore only
    // (matchScore already did its job as a filter, it doesn't also weigh in here). qualityScore peaks
    // near a sane bitrate for the release's own resolution instead of rewarding "bigger is better" —
    // a 1080p release at 80 Mbps is a bloated remux, not a better watch, and would always win a
    // monotonic score. availabilityScore folds seeders and peers into one log-scaled figure with
    // peers weighted higher — peers are the live swarm that actually drives download *speed*, seeders
    // alone can be idle. Auto-play additionally requires availabilityScore above a floor (see
    // MIN_AVAILABILITY_FOR_AUTOPLAY below) — a perfect title/season/episode match with an empty swarm
    // must never auto-play, that's a hang, not "feels like an online service".
    function scoreCandidate(item, target) {
        var release = item.release;
        var passes = passesMatchGate(item, target);
        var matchScore = Math.round(titleSimilarity(item.title, target.movie) * 40) +
            (release.explicitSeason && release.seasons.indexOf(target.season) >= 0 ? 20 : 0) +
            (target.episode && release.explicitEpisode &&
                target.episode >= release.episodeFrom && target.episode <= release.episodeTo ? 40 : 0);

        var bitrateMbps = estimateBitrateMbps(item, target);
        item.bitrateMbps = bitrateMbps;
        var reference = referenceBitrateMbps(release);
        // Triangular peak at `reference`: full marks right on target, falling off in both
        // directions (over-encoded remux and under-encoded transcode both lose points).
        var deviation = Math.abs(bitrateMbps - reference) / reference;
        var qualityScore = Math.max(0, 20 * (1 - deviation));
        var preferred = field('torrent_mod_preferred_quality', 'any');
        if (preferred !== 'any' && release.resolution === preferred) qualityScore += 10;

        var availabilityScore = Math.min(24, Math.log(item.seeders + item.peers * 1.5 + 1) * 6);

        return {
            passes: passes,
            value: qualityScore + availabilityScore,
            matchScore: matchScore,
            qualityScore: qualityScore,
            availabilityScore: availabilityScore,
            bitrateMbps: bitrateMbps,
            season: release.seasons.indexOf(target.season) >= 0,
            episode: release.explicitEpisode && target.episode >= release.episodeFrom && target.episode <= release.episodeTo
        };
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
    // once an episode is picked (auto-play on a confident match, a small picker otherwise).
    // Season/translation live in the toolbar (the slot Online Mod uses for its balancer picker);
    // anything else is a plain filter list.
    // Left info panel + toolbar row + scrollable list — all built on Lampa.Explorer, the same
    // helper the native full-card view and Online Mod itself use (confirmed live: its
    // constructor auto-populates the left panel from object.movie, no hand-built markup for
    // that part needed at all). Toolbar controls use Lampa's own real
    // `.simple-button.simple-button--filter` markup (also confirmed live) instead of custom
    // CSS, so they inherit native styling for free.
    function TorrentModComponent(object) {
        var movie = object.movie || {};
        var explorer = new Lampa.Explorer(object);
        var scroll = new Lampa.Scroll({ mask: true, over: true, step: 250 });
        var grid = $('<div class="torrent-mod__list"></div>');
        var status = $('<div class="torrent-mod__status"></div>');
        var toolbar = $('<div class="torrent-filter"></div>');
        var hasSeasons = !!(movie.number_of_seasons);
        var state = {
            season: object.season || 0,
            voiceType: 'any',
            resolution: 'any'
        };

        function filterButton(label, value) {
            var el = $(
                '<div class="simple-button simple-button--filter selector">' +
                '<span>' + escapeHtml(label) + '</span><div>' + escapeHtml(value) + '</div></div>'
            );
            return { el: el, setValue: function (text) { el.find('> div').text(text); } };
        }

        // Same slot/markup as Online Mod's own search chip (.filter--search, confirmed live) —
        // Lampa's standard "what am I searching for" control stays first, our own controls
        // (season/voice/filters) come after it, matching how Online Mod layers its own UI on top
        // of Lampa's existing search flow instead of replacing it.
        function searchQueryText(target) {
            var titles = baseTitles(target.movie);
            var base = titles[0] || '';
            if (target.episode) return base + ' S' + pad(target.season) + 'E' + pad(target.episode);
            if (target.season) return base + ' S' + pad(target.season);
            return base;
        }

        var searchLabel = (function () {
            var el = $(
                '<div class="simple-button simple-button--filter selector filter--search">' +
                '<svg><use xlink:href="#sprite-search"></use></svg><div></div></div>'
            );
            return { el: el, setValue: function (text) { el.find('> div').text(text); } };
        })();
        searchLabel.setValue(searchQueryText({ movie: movie, season: state.season }));
        searchLabel.el.on('hover:enter', function () {
            try {
                Lampa.Input.edit({ value: searchLabel.el.find('> div').text() }, function (value) {
                    if (!value) return;
                    state.customQuery = value;
                    searchLabel.setValue(value);
                    selectEpisode(state.lastEpisode || 0);
                });
            } catch (e) {
                notify('Ручное редактирование запроса недоступно');
            }
        });

        var seasonControl = hasSeasons ? filterButton('Сезон', String(state.season || 1)) : null;
        var voiceControl = filterButton('Перевод', 'Любой');
        var filtersControl = filterButton('Фильтры', '');

        toolbar.append(searchLabel.el);
        if (seasonControl) toolbar.append(seasonControl.el);
        toolbar.append(voiceControl.el).append(filtersControl.el);
        scroll.minus();
        scroll.append(grid);
        explorer.appendHead(toolbar);
        explorer.appendFiles(status);
        explorer.appendFiles(scroll.render());

        // Row markup/CSS ported 1:1 from the real, currently-installed Online Mod (inspected live
        // via this app's own /app/ in a browser, DOM + computed styles — not guessed): icon is an
        // absolutely-positioned 2.4em circle at top:-0.3em/left:0, title/subtitle just get
        // padding-left to clear it, rather than a flex row. Own class names, their exact technique.
        function row(title, subtitle) {
            return $(
                '<div class="torrent-mod-row selector">' +
                '<div class="torrent-mod-row__icon">' +
                '<svg viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">' +
                '<circle cx="64" cy="64" r="56" stroke="currentColor" stroke-width="16"></circle>' +
                '<path d="M90.5 64.3827L50 87.7654L50 41L90.5 64.3827Z" fill="currentColor"></path>' +
                '</svg></div>' +
                '<div class="torrent-mod-row__title">' + escapeHtml(title) + '</div>' +
                (subtitle ? '<div class="torrent-mod-row__subtitle">' + escapeHtml(subtitle) + '</div>' : '') +
                '</div>'
            );
        }

        function renderEpisodes(episodes) {
            grid.empty();
            episodes.forEach(function (episode) {
                var number = parseInt(episode.episode_number, 10);
                var view = canonicalTimeline(movie, state.season, number);
                var node = row(
                    'Сезон ' + state.season + ' / Серия ' + number + (episode.name ? ' — ' + episode.name : ''),
                    [episode.air_date, progressText(view)].filter(Boolean).join(' · ')
                );
                if (view && Lampa.Timeline && Lampa.Timeline.render) node.append(Lampa.Timeline.render(view));
                node.on('hover:enter', function () { selectEpisode(number); });
                grid.append(node);
            });
            refreshGrid();
        }

        function renderMovieCard() {
            grid.empty();
            var node = row('Найти раздачи', '');
            node.on('hover:enter', function () { selectEpisode(0); });
            grid.append(node);
            refreshGrid();
        }

        function showMessage(message, retry) {
            status.text(message);
            grid.empty();
            if (retry) {
                var retryNode = row('Повторить', '');
                retryNode.on('hover:enter', retry);
                grid.append(retryNode);
            }
            refreshGrid();
        }

        // Lampa.Explorer.toggle() (called below in this.start) only ever registers ONE named
        // controller — 'explorer', for the left info card — with its own back:Activity.backward()
        // and right:Controller.toggle('content'). It does NOT register 'content' for us; that's
        // left to the caller (confirmed by reading Explorer's toggle() in app.min.js — its own
        // `right` handler just does Controller.toggle('content') and trusts something else owns
        // that name). Without registering it ourselves, Controller.collectionSet() calls from
        // renderEpisodes/renderMovieCard/showMessage silently land on whatever controller happens
        // to be active at that moment (usually still 'explorer', since these often run before the
        // user ever presses right) — overwriting Explorer's own left-card focus collection with our
        // grid rows while leaving Explorer's left/back/toggle handlers in place. That's the actual
        // cause of the broken/erratic back button: back ends up bound to whichever controller last
        // had our rows stomped into its collection, not to a controller we actually own. Registering
        // 'content' properly — symmetric with Explorer's own 'explorer' entry, back returns focus to
        // 'explorer' instead of leaving the activity — makes this screen a well-behaved participant
        // in Lampa's own Controller/Activity navigation instead of a foreign, bolted-on screen.
        //
        // Registered fresh in this.start (not here at construction time) because ActivitySlide.start()
        // — Lampa's own framework code, confirmed live in app.min.js — unconditionally re-registers its
        // own placeholder 'content' controller on every start/restart of this activity (e.g. whenever
        // the user returns here from a pushed sub-screen) *before* calling our component's start(). A
        // one-time registration in the constructor would only win on the very first entry and silently
        // revert to the framework placeholder after any such round-trip.
        //
        // collectionSet(html, append) collects '.selector' elements from BOTH html and append into one
        // flat, spatially-navigable collection (confirmed by reading its body in app.min.js — append's
        // matches just get concat()-ed onto html's). Online Mod's own results screen does exactly this:
        // collectionSet(scroll.render(), files.render()) — its filter/balancer chip row and its result
        // rows end up in the SAME collection, so up/down naturally walks from one into the other. Passing
        // `grid` here instead of `toolbar` was wrong twice over: grid is already a DOM descendant of
        // scroll, so it added nothing, and it left `toolbar` (search/season/voice/filters chips) out of
        // every collection entirely — confirmed live, arrow keys could not reach the toolbar at all, only
        // mouse/touch could. `toolbar` as the second argument fixes both.
        function refreshGrid() {
            try {
                var current = Lampa.Controller.enabled();
                if (current && current.name === 'content') {
                    Lampa.Controller.collectionSet(scroll.render(true), toolbar);
                    Lampa.Controller.collectionFocus(false, scroll.render(true));
                }
            } catch (e) {}
        }

        function registerContentController() {
            Lampa.Controller.add('content', {
                link: this,
                toggle: function () {
                    Lampa.Controller.collectionSet(scroll.render(true), toolbar);
                    Lampa.Controller.collectionFocus(false, scroll.render(true));
                },
                left: function () { if (Navigator.canmove('left')) Navigator.move('left'); else Lampa.Controller.toggle('explorer'); },
                right: function () { Navigator.move('right'); },
                up: function () { if (Navigator.canmove('up')) Navigator.move('up'); else Lampa.Controller.toggle('explorer'); },
                down: function () { Navigator.move('down'); },
                back: function () { Lampa.Controller.toggle('explorer'); }
            });
        }

        function loadEpisodes() {
            status.text('Загрузка списка серий…');
            fetchSeason(movie, state.season).catch(function (error) {
                console.warn('Torrent Mod: TMDB season fetch failed', error);
                return [];
            }).then(function (episodes) {
                episodes = episodes || [];
                var runtimes = episodes.map(function (e) { return parseInt(e.runtime, 10) || 0; }).filter(Boolean);
                state.seasonEpisodeCount = episodes.length || (episodeCounts(movie)[state.season] || 0);
                state.avgRuntimeMinutes = runtimes.length ? runtimes.reduce(function (a, b) { return a + b; }, 0) / runtimes.length : 0;

                if (!episodes.length) {
                    var fallbackCount = episodeCounts(movie)[state.season] || 0;
                    for (var i = 1; i <= fallbackCount; i++) episodes.push({ episode_number: i, name: 'Серия ' + i });
                }
                if (!episodes.length) { showMessage('Список серий недоступен', loadEpisodes); return; }
                status.text('');
                renderEpisodes(episodes);
            });
        }

        // Availability floor on auto-play, checked against the *score* (seeders+peers combined,
        // log-scaled — see scoreCandidate), not raw seeders: a "confident" title/season/episode
        // match with an empty swarm would still auto-play without this — which stalls forever
        // instead of feeling like an online service. Below this we always show the picker so the
        // user can knowingly pick a thin release instead of getting stuck.
        var MIN_AVAILABILITY_FOR_AUTOPLAY = 3;

        function selectEpisode(episode) {
            state.lastEpisode = episode;
            var target = {
                movie: object.movie,
                season: state.season,
                episode: episode,
                seasonEpisodeCount: state.seasonEpisodeCount,
                avgRuntimeMinutes: state.avgRuntimeMinutes,
                customQuery: state.customQuery
            };
            searchLabel.setValue(state.customQuery || searchQueryText(target));
            state.customQuery = null;
            status.text('Ищем' + (episode ? ' S' + pad(state.season) + 'E' + pad(episode) : '') + '…');
            searchTorrentMod(target).then(function (response) {
                if (response.failed) { notify('Jackett недоступен или не ответил'); status.text(''); return; }
                var pool = response.results.filter(function (item) { return matchesTranslation(item, state.voiceType); });
                if (!pool.length) pool = response.results;
                if (state.resolution !== 'any') {
                    var byQuality = pool.filter(function (item) { return item.release.resolution === state.resolution; });
                    if (byQuality.length) pool = byQuality;
                }
                if (!pool.length) { notify('Ничего не найдено'); status.text(''); return; }

                // matchScore is a hard gate here, not a ranking input (see scoreCandidate): wrong
                // title/season/episode candidates are dropped entirely, never just ranked lower.
                pool.forEach(function (item) { item._score = scoreCandidate(item, target); });
                if (enabled('torrent_mod_debug', false)) debugLogCandidates(pool, target);
                var candidates = pool.filter(function (item) { return item._score.passes; });
                candidates.sort(function (a, b) { return b._score.value - a._score.value || b.seeders - a.seeders; });
                status.text('');
                if (!candidates.length) { notify('Похожих раздач не нашлось'); return; }

                var best = candidates[0];
                var next = candidates[1];
                var confident = best._score.availabilityScore >= MIN_AVAILABILITY_FOR_AUTOPLAY &&
                    (!next || best._score.value - next._score.value >= 6 || best.seeders > next.seeders * 2);

                if (confident) startDownload(best, target);
                else showCandidates(candidates.slice(0, 10), target);
            });
        }

        function publishedText(item) {
            if (!item.publishedAt) return '';
            var days = Math.floor((Date.now() - item.publishedAt) / 86400000);
            if (days <= 0) return 'сегодня';
            if (days === 1) return 'вчера';
            if (days < 30) return days + ' дн. назад';
            return new Date(item.publishedAt).toLocaleDateString('ru-RU', { month: 'short', year: 'numeric' });
        }

        function showCandidates(candidates, target) {
            var items = candidates.map(function (item, index) {
                var info = [];
                if (item.tracker) info.push(item.tracker);
                info.push(item.seeders + ' сидов · ' + item.peers + ' пиров');
                var size = formatSize(item.size);
                if (size) info.push(size);
                if (item.release.voiceType) info.push(item.release.voiceType);
                if (item.release.audioChannels) info.push(item.release.audioChannels);
                if (item.release.subtitles) info.push('субтитры');
                var published = publishedText(item);
                if (published) info.push(published);
                return { title: item.title, subtitle: info.join(' · '), torrent: item, selected: index === 0 };
            });
            Lampa.Select.show({
                title: 'Выбор раздачи',
                items: items,
                onSelect: function (choice) { startDownload(choice.torrent, target); }
            });
        }

        function start() {
            if (!hasSeasons) { status.text(''); renderMovieCard(); return; }
            loadEpisodes();
        }

        if (seasonControl) {
            seasonControl.el.on('hover:enter', function () {
                Lampa.Select.show({
                    title: 'Выберите сезон',
                    items: buildSeasonItems(movie, state.season),
                    onSelect: function (choice) {
                        if (choice.season === state.season) return;
                        state.season = choice.season;
                        seasonControl.setValue(String(state.season));
                        loadEpisodes();
                    }
                });
            });
        }

        voiceControl.el.on('hover:enter', function () {
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
                    voiceControl.setValue(choice.title);
                }
            });
        });

        filtersControl.el.on('hover:enter', function () {
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
                    filtersControl.setValue(choice.value === 'any' ? '' : choice.title);
                }
            });
        });

        this.create = function () { return this.render(true); };
        this.render = function (js) { return explorer.render(js); };
        this.start = function () { explorer.toggle(); registerContentController(); start(); };
        this.pause = function () {};
        this.stop = function () {};
        this.destroy = function () {
            cancelSearch();
            try { scroll.destroy(); } catch (e) {}
            try { explorer.destroy(); } catch (e) {}
        };
    }

    // ---------- download + duration-aware smart preload ----------
    //
    // No global patching of Lampa.Player.play/Lampa.Torserver.stream — that would affect every
    // torrent screen in Lampa, not just this one, and is a reliable source of hard-to-debug
    // ordering bugs the moment more than one thing wants to react to playback start. Instead: we
    // already know the torrent's infohash from its own magnet (we picked it ourselves via search,
    // no need to intercept anything to learn it), so we can poll TorrServer's /cache for it
    // directly and independently of whatever the native file-list UI does. We listen to Lampa's
    // own 'torrent_file' event (listening is safe/composable — it's *patching a shared function*
    // that isn't), scoped to only react while `pendingPlayback` is set (i.e. only for downloads
    // *we* just started), auto-pick the right file by scoring season/episode signals in its path,
    // and just call the file's own native `hover:enter` once our duration-based buffer target is
    // ready — that's the real Lampa file click, so playback starts through the exact same path it
    // always would.

    var pendingPlayback = null;

    function extractInfoHash(magnet) {
        var match = String(magnet || '').match(/xt=urn:btih:([a-zA-Z0-9]+)/i);
        return match ? match[1].toLowerCase() : '';
    }

    function torrServerBase() {
        try { if (Lampa.Torserver && Lampa.Torserver.ip) return String(Lampa.Torserver.ip() || '').replace(/\/$/, ''); } catch (e) {}
        return '';
    }

    function preloadFileScore(element, target) {
        var path = String((element && (element.path || element.title)) || '');
        var signals = parseSignals(path);
        var score = 0;
        if (target.episode) {
            if (signals.explicitEpisode && target.episode >= signals.episodeFrom && target.episode <= signals.episodeTo) score += 100;
            else if (signals.explicitEpisode) score -= 100;
        }
        if (signals.explicitSeason) score += signals.seasons.indexOf(target.season) >= 0 ? 30 : -100;
        return score;
    }

    function maybeProceed(pending) {
        if (!pending || pending.clicked || !pending.bestFile) return;
        if (!pending.ready && !pending.timedOut) return;
        pending.clicked = true;
        cleanupSmartPreload(pending);
        try { pending.bestFile.item.trigger('hover:enter'); } catch (e) {}
        if (pendingPlayback === pending) pendingPlayback = null;
    }

    function pickBestFile(pending) {
        if (!pending || pending.clicked || !pending.fileItems.length) return;
        var scored = [];
        for (var i = 0; i < pending.fileItems.length; i++) {
            scored.push({ f: pending.fileItems[i], score: preloadFileScore(pending.fileItems[i].element, pending.target) });
        }
        scored.sort(function (a, b) { return b.score - a.score; });
        pending.bestFile = scored[0].f;
        maybeProceed(pending);
        probeRealTracks(pending);
    }

    // Confirms our title-guessed badges (resolution/codec/audio/subs, all regexed out of the
    // raздача name in parseRelease) against the *actual* file, the same way the MediaInfo plugin
    // does: TorrServer bundles ffprobe for its own transcoding support and exposes it at
    // /ffp/{hash}/{fileId} (confirmed by reading that plugin's own source — this is its whole job).
    // fileId comes from TorrServer's own /torrents listing, not DOM/array position — same lookup
    // MediaInfo itself does (its pickIndex() reads `.id` off that same list). Deliberately skips
    // that plugin's public "Tracks Inspector" fallback for when ffprobe isn't available locally —
    // it's a third-party service outside this project's own infrastructure, inconsistent with
    // keeping everything (Jackett, TorrServer) local/loopback-only; if /ffp/ 400s (no ffprobe on
    // this TorrServer build) we just stay quiet, same as the title-only badges already shown.
    function probeRealTracks(pending) {
        if (!pending || pending.probed || !pending.bestFile) return;
        var base = torrServerBase();
        if (!base) return;
        pending.probed = true;
        var wantPath = String((pending.bestFile.element && (pending.bestFile.element.path || pending.bestFile.element.title)) || '');
        if (!wantPath) return;
        $.ajax({
            url: base + '/torrents', method: 'POST',
            data: JSON.stringify({ action: 'get', hash: pending.hash }),
            dataType: 'json', timeout: 4000
        }).done(function (json) {
            var files = (json && json.file_stats) || [];
            var match = files.filter(function (f) { return f.path && wantPath.indexOf(f.path) >= 0; })[0];
            if (!match || match.id == null) return;
            $.ajax({ url: base + '/ffp/' + pending.hash + '/' + match.id, dataType: 'json', timeout: 6000 })
                .done(function (probe) {
                    var streams = probe && probe.streams;
                    if (!streams || !streams.length || pending.clicked) return;
                    var video = streams.filter(function (s) { return s.codec_type === 'video'; })[0];
                    var audio = streams.filter(function (s) { return s.codec_type === 'audio'; });
                    var subs = streams.filter(function (s) { return s.codec_type === 'subtitle'; });
                    var bits = [];
                    if (video) bits.push((video.height ? video.height + 'p' : '') + (video.codec_name ? ' ' + video.codec_name.toUpperCase() : ''));
                    if (audio.length) bits.push(audio.length + ' ауд.дорожек');
                    if (subs.length) bits.push(subs.length + ' субтитров');
                    bits = bits.filter(Boolean);
                    if (bits.length && pending.html) {
                        pending.html.find('.torrent-mod-preload__title').text('Подтверждено ffprobe: ' + bits.join(' · '));
                    }
                }).fail(function () {});
        }).fail(function () {});
    }

    function onTorrentFile(event) {
        if (!event || !pendingPlayback) return;
        var pending = pendingPlayback;
        if (event.type === 'list_open') {
            pending.fileItems = [];
        } else if (event.type === 'render' && pending.fileItems) {
            pending.fileItems.push({ element: event.element, item: event.item });
            clearTimeout(pending.renderDebounce);
            pending.renderDebounce = setTimeout(function () { pickBestFile(pending); }, 150);
        }
    }

    function cleanupSmartPreload(pending) {
        clearInterval(pending.pollTimer);
        clearInterval(pending.clockTimer);
        clearTimeout(pending.renderDebounce);
        if (pending.html) pending.html.remove();
        try { Lampa.Controller.toggle(pending.previousController || 'content'); } catch (e) {}
    }

    function showSmartPreload(pending) {
        pending.previousController = previousController();
        var timeoutSeconds = pending.timeoutSeconds;
        var html = $([
            '<div class="torrent-mod-preload">',
            ' <div class="torrent-mod-preload__box">',
            '  <div class="torrent-mod-preload__title">Буферизация — под длительность просмотра, не под фиксированный размер</div>',
            '  <div class="torrent-mod-preload__percent">0%</div>',
            '  <div class="torrent-mod-preload__bar"><div></div></div>',
            '  <div class="torrent-mod-preload__stats">Подключение к раздаче…</div>',
            '  <div class="torrent-mod-preload__risk"></div>',
            '  <div class="torrent-mod-preload__buttons">',
            '   <div class="simple-button selector">Отмена</div>',
            '   <div class="simple-button selector">Смотреть сейчас</div>',
            '  </div>',
            ' </div>',
            '</div>'
        ].join(''));
        pending.html = html;
        var buttons = html.find('.simple-button');
        $('body').append(html);

        function cancel() {
            pending.clicked = true;
            cleanupSmartPreload(pending);
            if (pendingPlayback === pending) pendingPlayback = null;
            notify('Отменено');
        }
        function forcePlay() {
            pending.ready = true;
            maybeProceed(pending);
        }
        buttons.eq(0).on('hover:enter click', cancel);
        buttons.eq(1).on('hover:enter click', forcePlay);

        Lampa.Controller.add('torrent_mod_preload', {
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
        Lampa.Controller.toggle('torrent_mod_preload');

        pending.clockTimer = setInterval(function () {
            if ((Date.now() - pending.started) / 1000 >= timeoutSeconds) {
                pending.timedOut = true;
                maybeProceed(pending);
            }
        }, 1000);

        var base = torrServerBase();
        pending.pollTimer = setInterval(function () {
            if (!base || pending.clicked) return;
            $.ajax({
                url: base + '/cache',
                method: 'POST',
                data: JSON.stringify({ action: 'get', hash: pending.hash }),
                dataType: 'json',
                timeout: 2500
            }).done(function (response) {
                if (pending.clicked) return;
                var data = response && (response.Torrent || response);
                if (!data) return;
                var loaded = parseFloat(data.preloaded_bytes) || 0;
                var speed = parseFloat(data.download_speed) || 0;
                var seeds = parseInt(data.connected_seeders, 10) || 0;
                var peers = parseInt(data.active_peers, 10) || 0;
                var percent = pending.targetBytes ? Math.min(100, loaded * 100 / pending.targetBytes) : 0;
                html.find('.torrent-mod-preload__percent').text(Math.round(percent) + '%');
                html.find('.torrent-mod-preload__bar > div').css('width', percent + '%');
                html.find('.torrent-mod-preload__stats').text(
                    formatSize(loaded) + ' / ' + formatSize(pending.targetBytes) +
                    ' · ' + formatSize(speed) + '/с · сиды ' + seeds + ' · пиры ' + peers
                );
                // Already downloading faster than real-time playback needs — safe to start now
                // even short of the nominal buffer target, it won't be outrun.
                var speedMbps = speed * 8 / 1000000;
                var keepsUpWithPlayback = pending.bitrateMbps > 0 && speed > 0 && speedMbps >= pending.bitrateMbps * 0.9;
                if (loaded >= pending.targetBytes || keepsUpWithPlayback) {
                    pending.ready = true;
                    maybeProceed(pending);
                } else {
                    // Speed is holding well below what this bitrate needs, and enough time has
                    // passed to trust the reading (not just a slow start) — say so explicitly
                    // instead of quietly waiting out the timeout: a stall during playback is a
                    // worse experience than an honest heads-up now.
                    var elapsed = (Date.now() - pending.started) / 1000;
                    var risk = elapsed > 8 && pending.bitrateMbps > 0 && speed > 0 && speedMbps < pending.bitrateMbps * 0.5;
                    html.find('.torrent-mod-preload__risk').text(
                        risk ? 'Скорость закачки ниже битрейта — возможны остановки при просмотре' : ''
                    );
                }
            }).fail(function () {});
        }, 1000);
    }

    function startDownload(item, target) {
        notify((item.tracker || 'Torrent Mod') + ' · ' + item.seeders + ' сидов');
        var hash = extractInfoHash(item.magnet);
        var bitrateMbps = item.bitrateMbps || 3;
        var timeoutSeconds = parseInt(field('torrent_mod_preload_timeout', '60'), 10) || 60;
        var leadSeconds = 25;
        var targetBytes = (bitrateMbps * 1000000 / 8) * leadSeconds;

        Lampa.Torrent.start({
            Title: item.title,
            title: item.title,
            MagnetUri: item.magnet,
            Link: item.link,
            poster: (target.movie && (target.movie.img || target.movie.poster_path)) || ''
        }, target.movie);

        if (!hash) return; // can't poll /cache without a hash — let native flow run unassisted

        pendingPlayback = {
            hash: hash,
            item: item,
            target: target,
            bitrateMbps: bitrateMbps,
            targetBytes: targetBytes,
            timeoutSeconds: timeoutSeconds,
            fileItems: [],
            started: Date.now(),
            clicked: false,
            ready: false,
            timedOut: false,
            probed: false
        };
        showSmartPreload(pendingPlayback);
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

        var reference = activity.find('.view--torrent').last();
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

        Lampa.SettingsApi.addParam({
            component: 'torrent_mod',
            param: { name: 'torrent_mod_debug', type: 'trigger', default: false },
            field: { name: 'Отладка поиска', description: 'Таблица разобранных раздач и их оценок в консоли браузера при каждом поиске' }
        });
    }

    // ---------- styles ----------

    function addStyles() {
        if (document.getElementById('torrent-mod-styles')) return;
        var style = document.createElement('style');
        style.id = 'torrent-mod-styles';
        // .torrent-mod-row* mirrors Online Mod's real .online/.online__title structure and spacing
        // 1:1 (absolute icon circle, padding-left text) — inspected live, see the `row()` comment.
        style.textContent = [
            '.torrent-mod__status{opacity:.7;margin:0 0 1em 1.5em;min-height:1.2em}',
            '.torrent-mod__list{display:flex;flex-direction:column;gap:.6em}',
            '.torrent-mod-row{position:relative;padding:.8em;background:rgba(0,0,0,.3);border-radius:.2em}',
            '.torrent-mod-row.focus{background:#fff;color:#111}',
            '.torrent-mod-row.focus .torrent-mod-row__icon{color:#111}',
            '.torrent-mod-row__icon{position:absolute;left:0;top:-.3em;width:2.4em;height:2.4em}',
            '.torrent-mod-row__icon svg{width:2.4em;height:2.4em}',
            '.torrent-mod-row__title{padding-left:2.1em;font-size:1.1em}',
            '.torrent-mod-row__subtitle{padding-left:2.1em;opacity:.65;font-size:.88em;margin-top:.2em}',
            '.view--torrent-mod svg{margin-right:.7em}',
            '.torrent-mod-preload{position:fixed;z-index:10000;inset:0;background:rgba(8,12,20,.92);display:flex;align-items:center;justify-content:center;padding:2em}',
            '.torrent-mod-preload__box{width:min(46em,92vw);background:#182231;border-radius:1.2em;padding:2em;box-shadow:0 1em 5em #000}',
            '.torrent-mod-preload__title{font-size:1.2em;font-weight:700;margin-bottom:.6em}',
            '.torrent-mod-preload__percent{font-size:2.5em;font-weight:700;margin:.4em 0 .15em}',
            '.torrent-mod-preload__bar{height:.65em;background:#2c394b;border-radius:1em;overflow:hidden}',
            '.torrent-mod-preload__bar>div{height:100%;width:0;background:#58d68d;transition:width .25s}',
            '.torrent-mod-preload__stats{margin:1em 0 0;min-height:1.4em;opacity:.85}',
            '.torrent-mod-preload__risk{margin:.3em 0 1.5em;min-height:1.2em;color:#f2b84b;font-size:.9em}',
            '.torrent-mod-preload__buttons{display:flex;gap:.8em}',
            '.torrent-mod-preload .simple-button{padding:.75em 1.2em;background:#2c394b;border-radius:.6em}',
            '.torrent-mod-preload .simple-button.focus{background:#fff;color:#111}'
        ].join('');
        document.head.appendChild(style);
    }

    addStyles();
    addSettings();
    Lampa.Template.add('torrent_mod', '<div></div>');
    Lampa.Component.add('torrent_mod', TorrentModComponent);
    Lampa.Listener.follow('full', addCardButton);
    Lampa.Listener.follow('torrent_file', onTorrentFile);
    console.log('Torrent Mod ' + VERSION + ': ready');
})(jQuery, Lampa);
