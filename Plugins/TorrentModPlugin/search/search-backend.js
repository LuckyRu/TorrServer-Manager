    // ---------- search backend ----------
    // Raw Jackett mapping + query orchestration; scoring/gating lives in scoring.js.
    import { buildQueries as buildQueriesForTarget } from './query-building.js';
    import { compact, unique } from '../shared/utils.js';
    import { startParallelSearch } from './parallel-search.js';

    // A single malformed entry (raw is null/undefined) used to throw here, and since this ran
    // inside a plain .map() with no per-item try/catch, that exception propagated all the way out
    // to the caller's own outer .catch() — silently discarding *every* query's results, not just
    // the one bad entry. Found during an independent review pass; matches the existing null-return
    // convention two lines below (no magnet and no link → null, filtered out downstream by
    // .filter(Boolean)) rather than introducing a new failure mode.
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

    // Runs ONE query through the parallel-per-indexer backend (parallel-search.js), collecting
    // every indexer's own contribution as it arrives. Used by searchTorrentMod below to reproduce
    // the old single-Promise contract for callers that don't need progressive updates (season lazy
    // load, customQuery manual search) — those needed zero changes when this file moved off the old
    // single blocking aggregate call, since the external shape here is unchanged.
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
            var results = unique(mapped, function (item) {
                return compact(item.magnet || item.link || (item.title + '|' + item.size));
            });

            return { results: results, indexers: indexers, failed: false };
        });
    }

    // Progressive variant for the whole-work pool search specifically (episodes-interactor.js's
    // loadAllTorrents) — this search is ALWAYS exactly one query (season:0 → buildQueries emits
    // just the title, no season/episode suffix; see docs/system-design/torrent-mod-unified-pool.md,
    // Этап 1), so there's no multi-query merge to coordinate here the way searchTorrentMod above
    // has to. `onIndexerResult({id, name, ok, error, elapsedMs, items})` fires once per indexer, in
    // completion order (fastest first) — `items` are already mapped AND deduped against everything
    // seen so far in THIS search, so the caller can merge them straight into its pool without
    // re-running its own dedup pass per indexer. `onDone(failed)` fires once, after the last
    // indexer (or immediately if the search never started at all — Jackett down/no API key).
    // Returns `{cancel}` — the caller (episodes-interactor.js) is responsible for calling it when a
    // manual retry/new search context supersedes this one; `scope`, if given, gets the underlying
    // poll timer registered into it so leaving the screen cancels it automatically. `onIndexerList`
    // is passed straight through to startParallelSearch — see its own doc comment.
    export function searchTorrentModProgressive(target, parseReleaseForMode, buildQueriesForMode, onIndexerResult, onDone, scope, onIndexerList) {
        var query = ((buildQueriesForMode || buildQueriesForTarget)(target))[0];
        if (!query) { onDone(true); return { cancel: function () {} }; }

        var seen = {};
        return startParallelSearch(query, function (entry) {
            var mapped = entry.ok
                ? (entry.results || []).map(function (raw) { return mapTorrent(raw, parseReleaseForMode); }).filter(Boolean)
                : [];
            var deduped = mapped.filter(function (item) {
                var id = compact(item.magnet || item.link || (item.title + '|' + item.size));
                if (!id || seen[id]) return false;
                seen[id] = true;
                return true;
            });
            onIndexerResult({ id: entry.id, name: entry.name, ok: entry.ok, error: entry.error, elapsedMs: entry.elapsedMs, items: deduped });
        }, onDone, scope, onIndexerList);
    }
