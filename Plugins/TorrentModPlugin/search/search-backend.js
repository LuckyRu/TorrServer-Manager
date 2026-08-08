    // ---------- search backend ----------
    // Raw Jackett response mapping (mapTorrent) and the actual multi-query fetch/merge
    // orchestration (searchTorrentMod) — the two functions that talk to /api/torrent-search.
    // Scoring/gating of the results this returns lives in scoring.js, not here.
    import { hubBase } from '../shared/state.js';
    import { buildQueries as buildQueriesForTarget } from './query-building.js';
    import { compact, unique, request } from '../shared/utils.js';

    function mapTorrent(raw, parseReleaseForMode) {
        // A single malformed entry (raw is null/undefined) used to throw here, and since this runs
        // inside allResults.map() with no per-item try/catch, that exception propagated all the way
        // out to searchTorrentMod's own outer .catch() — silently discarding *every* query's
        // results, not just the one bad entry, and reporting the generic "Jackett недоступен" even
        // though most or all of the merged data was actually fine. Found during an independent
        // review pass; matches the existing null-return convention two lines below (no magnet and
        // no link → null, filtered out downstream by .filter(Boolean)) rather than introducing a
        // new failure mode.
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

    export function searchTorrentMod(target, parseReleaseForMode, buildQueriesForMode) {
        var queries = (buildQueriesForMode || buildQueriesForTarget)(target);
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

            var mapped = allResults.map(function (raw) { return mapTorrent(raw, parseReleaseForMode); }).filter(Boolean);
            var results = unique(mapped, function (item) {
                return compact(item.magnet || item.link || (item.title + '|' + item.size));
            });

            return { results: results, indexers: Object.keys(indexerMap).map(function (k) { return indexerMap[k]; }), failed: false };
        }).catch(function () {
            return { results: [], indexers: [], failed: true };
        });
    }
