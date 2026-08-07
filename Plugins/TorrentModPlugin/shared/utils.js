    // ---------- utils ----------
    import { searchRequests } from './state.js';

    export function field(name, fallback) {
        var value;
        try { value = Lampa.Storage.field(name); } catch (e) { value = undefined; }
        return typeof value === 'undefined' || value === null || value === '' ? fallback : value;
    }

    export function enabled(name, fallback) {
        var value = field(name, fallback);
        return value === true || value === 1 || value === 'true' || value === '1';
    }

    export function pad(value) {
        value = parseInt(value, 10) || 0;
        return value < 10 ? '0' + value : String(value);
    }

    export function compact(value) {
        return String(value || '')
            .toLowerCase()
            .replace(/ё/g, 'е')
            .replace(/[^a-zа-я0-9]+/gi, ' ')
            .replace(/^\s+|\s+$/g, '');
    }

    export function unique(items, key) {
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
    export function escapeHtml(text) {
        return String(text == null ? '' : text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    export function notify(message) {
        if (Lampa.Noty && Lampa.Noty.show) Lampa.Noty.show(message);
        else console.log('Torrent Mod:', message);
    }

    // Behind the `torrent_mod_debug` setting (off by default). Prints a table of every scored
    // candidate for a search — raw title, everything parseRelease() extracted from it, and the
    // three score components — so parsing/scoring quality on real raздачи (especially season
    // packs with inconsistent naming) can be checked directly in devtools without guessing.
    export function debugLogCandidates(candidates, target) {
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
                    source: r.sourceType,
                    hdr: r.hdr,
                    codec: r.codec,
                    voice: r.voiceType,
                    translator: r.translator,
                    audioTracks: r.audioTracks || '',
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

    export function previousController() {
        try { return Lampa.Controller.enabled().name; } catch (e) { return 'content'; }
    }

    export function formatSize(value) {
        if (!value) return '';
        if (typeof value === 'string' && /[a-zа-я]/i.test(value)) return value;
        var bytes = parseFloat(value);
        return isNaN(bytes) ? '' : Lampa.Utils.bytesToSize(bytes);
    }

    export function request(url, timeout, postData) {
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

    export function cancelSearch() {
        searchRequests.splice(0).forEach(function (network) {
            try { network.clear(); } catch (e) {}
        });
    }
