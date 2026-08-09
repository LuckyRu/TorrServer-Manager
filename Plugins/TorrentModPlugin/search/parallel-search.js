    // ---------- parallel per-indexer search client ----------
    //
    // Talks to PluginHub's /api/torrent-search/{start,poll,cancel} — a parallel-per-indexer redesign
    // of the old single blocking aggregate call to Jackett's own /indexers/all/results (see
    // PluginHub.cs's own header comment on WriteTorrentSearchStartAsync for the full story): one
    // slow/broken indexer used to hold up every OTHER indexer's already-ready results for up to the
    // full 45s ceiling — a real, repeated "мучительно больно ждать" complaint, not a hypothetical
    // one. Now each indexer is queried independently and in parallel server-side, and this module
    // polls for whichever have already answered.
    //
    // Plain GET polling via the existing `request()` helper (shared/utils.js, itself built on
    // Lampa.Reguest) — deliberately NOT fetch()/ReadableStream HTTP streaming, which would need a
    // browser API with no track record on the target LG WebOS TV browser this whole plugin is built
    // around (the same caution behind TorrentModPlugin's own IIFE-not-ESM bundling decision).
    // Matches this codebase's own established polling shape (playback/smart-preload.js's pollFiles),
    // not a new pattern.
    import { hubBase } from '../shared/state.js';
    import { request } from '../shared/utils.js';
    import { log } from '../shared/core/log.js';

    var POLL_INTERVAL_MS = 600;

    // `onIndexerResult(entry)` fires EXACTLY once per indexer, in COMPLETION order (fastest first)
    // — entry is `{id, name, ok, error, elapsedMs, results}` where `results` is the raw
    // Jackett-shaped array (unmapped — this module only knows about transport, the caller
    // maps/scores). `onDone(failed)` fires exactly once, either after every indexer has reported or
    // immediately if the job itself never started (Jackett down / no API key — `failed` true,
    // `onIndexerResult` never called in that case). `onIndexerList(list)`, if given, fires once,
    // synchronously within the /start response handler, with the FULL configured-indexer list
    // (`{id, name}[]`) before any individual result has necessarily arrived — this is what lets the
    // widget show every tracker as a named, spinning "pending" entry from the very first paint
    // instead of an opaque "ждём ещё N" count (requested directly by the user: "в панели
    // показывать со спиннером кого ещё ждём"). Returns `{cancel}`: stops polling and asks the
    // server to abort any still-in-flight per-indexer requests — the caller is responsible for
    // calling it when a manual retry/new search supersedes this one; `scope`
    // (shared/core/lifecycle.js), if given, gets the poll timer registered into it too, so leaving
    // the screen mid-search cancels it automatically without the caller having to remember a
    // separate cleanup step.
    export function startParallelSearch(query, onIndexerResult, onDone, scope, onIndexerList) {
        var cancelled = false;
        var jobId = null;
        var untrackTimer = null;
        // /poll always returns the FULL accumulated indexer list so far (PluginHub.cs), not just
        // what's new since the last tick — without this guard, every indexer that already reported
        // would be re-delivered to onIndexerResult on every subsequent ~600ms poll until the job is
        // done, duplicating it in the caller's own poolIndexers list once per tick. Found while
        // wiring up the per-tracker status widget, not from a live report.
        var delivered = {};

        function scheduleNextPoll() {
            var scheduler = scope ? scope.setTimeout : setTimeout;
            var id = scheduler(poll, POLL_INTERVAL_MS);
            // Only the raw scope path returns something worth remembering to untrack (plain
            // setTimeout has nothing to untrack) — cancel() below just clears via clearTimeout(id)
            // directly either way, which works for both (scope.setTimeout still returns a real
            // native timer id, see lifecycle.js).
            untrackTimer = id;
        }

        function stopPolling() {
            if (untrackTimer !== null) { clearTimeout(untrackTimer); untrackTimer = null; }
        }

        function cancel() {
            if (cancelled) return;
            cancelled = true;
            stopPolling();
            if (jobId) {
                // Best-effort — nothing downstream depends on this actually landing; the server's
                // own stale-job sweep (PluginHub.cs, CleanupStaleSearchJobs) is the backstop if the
                // request itself never arrives (page closing, network blip on the way out).
                request(hubBase + '/api/torrent-search/cancel?jobId=' + encodeURIComponent(jobId), 5000);
            }
        }

        function poll() {
            if (cancelled) return;
            request(hubBase + '/api/torrent-search/poll?jobId=' + encodeURIComponent(jobId), 15000).then(function (data) {
                if (cancelled) return;
                if (!data) { cancelled = true; onDone(true); return; }
                (data.indexers || []).forEach(function (entry) {
                    if (delivered[entry.id]) return;
                    delivered[entry.id] = true;
                    onIndexerResult(entry);
                });
                if (data.done) { cancelled = true; onDone(false); return; }
                scheduleNextPoll();
            });
        }

        request(hubBase + '/api/torrent-search/start?query=' + encodeURIComponent(query), 15000).then(function (data) {
            if (cancelled) return;
            if (!data || !data.jobId) { cancelled = true; onDone(true); return; }
            jobId = data.jobId;
            log('search', 'startParallelSearch: "' + query + '", jobId=' + jobId + ', трекеров=' + data.totalIndexers);
            if (onIndexerList) onIndexerList(data.indexers || []);
            poll();
        });

        return { cancel: cancel };
    }
