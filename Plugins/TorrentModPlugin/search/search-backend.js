    import { buildQueries as buildQueriesForTarget } from './query-building.js';
    import { compact, unique } from '../shared/utils.js';
    import { startParallelSearch } from './parallel-search.js';
    import { passesSearchTitleGate } from './scoring.js';
    import { log } from '../shared/core/log.js';

    function mapTorrent(raw, parseReleaseForMode) {
        if (!raw) return null;
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
            release: parseReleaseForMode ? parseReleaseForMode(title) : null
        };
    }

    function filterSearchNoise(items, target, source, query) {
        var rejected = [];
        var accepted = items.filter(function (item) {
            if (passesSearchTitleGate(item, target)) return true;
            rejected.push(item);
            return false;
        });
        log('search', 'title-gate: фильтрация явного шума', {
            query: query || target.englishTitle || target.movie.title || target.movie.name || '',
            source: source,
            input: items.length,
            accepted: accepted.length,
            filtered: rejected.length,
            rejectedTitles: rejected.map(function (item) { return item.title; })
        });
        return accepted;
    }

    function searchOneQuery(text) {
        return new Promise(function (resolve) {
            var rawResults = [];
            var indexers = [];
            var anyOk = false;
            startParallelSearch(text, function (entry) {
                anyOk = anyOk || entry.ok;
                indexers.push({ id: entry.id, name: entry.name, ok: entry.ok, error: entry.error, elapsedMs: entry.elapsedMs });
                if (entry.ok) (entry.results || []).forEach(function (raw) { rawResults.push(raw); });
            }, function (failed) {
                resolve({ rawResults: rawResults, indexers: indexers, failed: failed || !anyOk });
            });
        });
    }

    export function searchTorrentMod(target, parseReleaseForMode, buildQueriesForMode) {
        var queries = (buildQueriesForMode || buildQueriesForTarget)(target);
        if (!queries.length) return Promise.resolve({ results: [], indexers: [], failed: true });

        return Promise.all(queries.map(searchOneQuery)).then(function (responses) {
            var ok = responses.filter(function (response) { return !response.failed; });
            if (!ok.length) return { results: [], indexers: [], failed: true };

            var allRaw = [];
            var indexers = [];
            ok.forEach(function (response) {
                response.rawResults.forEach(function (raw) { allRaw.push(raw); });
                indexers = indexers.concat(response.indexers);
            });

            var mapped = allRaw.map(function (raw) { return mapTorrent(raw, parseReleaseForMode); }).filter(Boolean);
            mapped = filterSearchNoise(mapped, target, 'searchTorrentMod', queries.join(' | '));
            var results = unique(mapped, function (item) {
                return compact(item.magnet || item.link || (item.title + '|' + item.size));
            });

            return { results: results, indexers: indexers, failed: false };
        });
    }

    export function searchTorrentModProgressive(target, parseReleaseForMode, buildQueriesForMode, onIndexerResult, onDone, scope, onIndexerList) {
        var query = ((buildQueriesForMode || buildQueriesForTarget)(target))[0];
        if (!query) { onDone(true); return { cancel: function () {} }; }

        var seen = {};
        return startParallelSearch(query, function (entry) {
            var mapped = entry.ok
                ? (entry.results || []).map(function (raw) { return mapTorrent(raw, parseReleaseForMode); }).filter(Boolean)
                : [];
            mapped = filterSearchNoise(mapped, target, entry.name, query);
            var deduped = mapped.filter(function (item) {
                var id = compact(item.magnet || item.link || (item.title + '|' + item.size));
                if (!id || seen[id]) return false;
                seen[id] = true;
                return true;
            });
            onIndexerResult({ id: entry.id, name: entry.name, ok: entry.ok, error: entry.error, elapsedMs: entry.elapsedMs, items: deduped });
        }, onDone, scope, onIndexerList);
    }
