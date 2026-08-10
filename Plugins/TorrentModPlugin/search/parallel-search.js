    import { hubBase } from '../shared/state.js';
    import { request } from '../shared/utils.js';
    import { log } from '../shared/core/log.js';

    var POLL_INTERVAL_MS = 600;

    // onIndexerResult fires once per indexer in completion order; onDone fires once when all have reported; onIndexerList (optional) fires once, synchronously, with the full configured-indexer list.
    export function startParallelSearch(query, onIndexerResult, onDone, scope, onIndexerList) {
        var cancelled = false;
        var jobId = null;
        var untrackTimer = null;
        // /poll always returns the full accumulated list — this ensures each indexer crosses onIndexerResult exactly once.
        var delivered = {};

        function scheduleNextPoll() {
            var scheduler = scope ? scope.setTimeout : setTimeout;
            var id = scheduler(poll, POLL_INTERVAL_MS);
            // clearTimeout(id) works either way — scope.setTimeout still returns a real native timer id (see lifecycle.js).
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
                // Best-effort — PluginHub's own stale-job sweep (CleanupStaleSearchJobs) is the backstop if this never arrives.
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
