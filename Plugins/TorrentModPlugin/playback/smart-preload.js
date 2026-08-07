    // ---------- direct playback (no overlay, no pre-start buffering) ----------
    //
    // The user explicitly rejected the smart-preload overlay ("лишний моргающий интерфейс без
    // реальной пользы"): a click must go STRAIGHT to the player. What remains is the silent
    // plumbing that makes direct playback possible at all:
    //
    //   Lampa.Torserver.hash(...)       register the torrent (magnet or .torrent link)
    //     → pollFiles: Torserver.files(hash)  until metadata resolves → file_stats
    //     → pickBestFile()              score season/episode signals in file paths (ours)
    //     → probeSelectedFile()         /ffp ffprobe gate — block unplayable codecs (raw DVDRip
    //                                    class: MPEG-2/MPEG-4 ASP/VC-1/WMV/...) with a toast
    //                                    instead of a black screen; 'unavailable' is not proof
    //                                    of bad, play anyway
    //     → Lampa.Player.play({url, timeline, playlist})
    //
    // Three native side effects of the old Lampa.Torrent.start path are compensated explicitly
    // (native torrent.js used to do them on hover:enter — torrent.js:437/333/446):
    //   1. Favorite.add('history', movie)      — continue-watch card
    //   2. timeline: Timeline.view(parsed.hash) — per-episode watch history (the hash Timeline
    //      reads, NOT the torrent infohash)
    //   3. data.playlist from all playable files of the pack — next-episode inside a season pack
    //      (Player.play wires Playlist from data.playlist, player.js:1243)
    //
    // Plus, still silent: an initial fire-and-forget `&preload` nudge (starts the download before
    // the player asks) and next-episode preloading near the end of the current file (the actual
    // fix for stalls on episode switch). No global patching of Lampa.Player.play / Torserver.stream
    // (ADR-0003).
    import { parseSignals } from '../search/release-parsing.js';
    import { notify, field } from '../shared/utils.js';

    var pendingPlayback = null;

    var PLAYABLE_FORMATS = ['asf', 'wmv', 'divx', 'avi', 'mp4', 'm4v', 'mov', '3gp', '3g2', 'mkv', 'trp', 'tp', 'mts', 'mpg', 'mpeg', 'dat', 'vob', 'rm', 'rmvb', 'm2ts', 'ts'];

    function isPlayableFile(file) {
        var exe = String((file && file.path) || '').split('.').pop().toLowerCase();
        return PLAYABLE_FORMATS.indexOf(exe) >= 0;
    }

    // Video codecs the browser/WebOS cannot decode without TorrServer transcoding (the raw-DVDRip
    // class). This is the ffprobe-level arbiter: the title heuristic (release-parsing compatibility)
    // only suspects, this confirms from the actual file's streams. Pure function for testability.
    var BAD_VIDEO_CODECS = ['mpeg1video', 'mpeg2video', 'mpeg4', 'vc1', 'wmv1', 'wmv2', 'wmv3',
        'msmpeg4v1', 'msmpeg4v2', 'msmpeg4v3', 'h263', 'h263p', 'rv10', 'rv20', 'rv30', 'rv40', 'flv1'];

    export function classifyVideoCodec(codecName) {
        var codec = String(codecName || '').toLowerCase();
        if (!codec) return 'no-video';
        return BAD_VIDEO_CODECS.indexOf(codec) >= 0 ? 'bad' : 'good';
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
        // Format as a TIE-BREAKER only: the right episode/season always wins, but between two
        // equally-matching files prefer a streamable container over "древнее говно" (AVI/MPG/VOB/
        // WMV/RM/FLV) that WebOS can't play without TorrServer transcoding.
        var ext = path.toLowerCase().split('.').pop();
        if (['mp4', 'mkv', 'm4v', 'mov', 'webm', 'ts', 'm2ts', 'mts'].indexOf(ext) >= 0) score += 5;
        else if (['avi', 'mpg', 'mpeg', 'vob', 'wmv', 'asf', 'flv', 'rm', 'rmvb', 'divx'].indexOf(ext) >= 0) score -= 5;
        return score;
    }

    // The stream URL built by Lampa.Torserver.stream() ends with `&play` (or `&preload` when the
    // torrserver_preload setting is on). The `&preload` variant is TorrServer's "start filling the
    // cache" command — fire-and-forget (the response body is a long-lived stream; we resolve on
    // headers via fetch and never read/abort it). Only the play→preload parameter of the OFFICIAL
    // URL is swapped, no invented endpoints.
    function preloadUrlFor(file, hash) {
        var url;
        try { url = Lampa.Torserver.stream(file.path, hash, file.id); } catch (e) { return ''; }
        var preloadUrl = url.replace(/([?&])play$/, '$1preload');
        if (preloadUrl === url && url.indexOf('preload') < 0) preloadUrl = url + '&preload';
        return preloadUrl;
    }

    function firePreload(url) {
        if (!url) return;
        try {
            if (window.fetch) fetch(url, { cache: 'no-store' }).catch(function () {});
            else $.ajax({ url: url, timeout: 15000 }).done(function () {}).fail(function () {});
        } catch (e) {}
    }

    function cleanup(pending) {
        clearInterval(pending.filesTimer);
        if (pendingPlayback === pending) pendingPlayback = null;
    }

    // Registers the torrent with TorrServer directly (POST /torrents action:add, same payload the
    // native screen sends — Torserver.hash). Accepts a magnet OR an HTTP .torrent link: TorrServer
    // downloads and parses the .torrent itself, so a hash arrives in both cases.
    function registerTorrent(pending) {
        var item = pending.item;
        var target = pending.target;
        try {
            Lampa.Torserver.hash({
                title: item.title,
                link: item.magnet || item.link,
                poster: (target.movie && (target.movie.img || target.movie.poster_path)) || ''
            }, function (json) {
                if (pending.clicked) return;
                pending.hash = json && json.hash;
                if (pending.hash) pollFiles(pending);
                else { notify('Не удалось получить hash раздачи'); cleanup(pending); }
            }, function () {
                notify('Не удалось зарегистрировать раздачу в TorrServer');
                cleanup(pending);
            });
        } catch (e) {
            notify('TorrServer недоступен');
            cleanup(pending);
        }
    }

    // Polls Torserver.files(hash) until metadata resolves (file_stats), then filters playable
    // files, enriches them with path_human (Torserver.clearFileName, required by Torserver.parse)
    // and picks the best one. Mirrors the native files() polling (torrent.js:149-169, 2s interval).
    function pollFiles(pending) {
        var attempts = 0;
        var maxAttempts = 45;
        pending.filesTimer = setInterval(function () {
            if (pending.clicked) { clearInterval(pending.filesTimer); return; }
            attempts++;
            try {
                Lampa.Torserver.files(pending.hash, function (json) {
                    if (pending.clicked || pending.bestFile) return;
                    var stats = (json && json.file_stats) || [];
                    var plays = stats.filter(isPlayableFile);
                    if (!plays.length) {
                        if (attempts >= maxAttempts) {
                            clearInterval(pending.filesTimer);
                            notify('Не удалось получить файлы раздачи');
                            cleanup(pending);
                        }
                        return;
                    }
                    clearInterval(pending.filesTimer);
                    pending.allFiles = stats;
                    try { Lampa.Torserver.clearFileName(plays); } catch (e) {}
                    pending.files = plays;
                    pickBestFile(pending);
                });
            } catch (e) {}
            if (attempts >= maxAttempts) clearInterval(pending.filesTimer);
        }, 2000);
    }

    function pickBestFile(pending) {
        if (!pending || pending.clicked || !pending.files || !pending.files.length) return;
        var scored = [];
        for (var i = 0; i < pending.files.length; i++) {
            scored.push({ f: pending.files[i], score: preloadFileScore(pending.files[i], pending.target) });
        }
        scored.sort(function (a, b) { return b.score - a.score; });
        pending.bestFile = scored[0].f;
        // Silent nudge: ask TorrServer to warm this file before the player's stream request lands.
        firePreload(preloadUrlFor(pending.bestFile, pending.hash));
        probeSelectedFile(pending);
    }

    // ffprobe gate — the final arbiter for "древнее говно" (raw DVDRip → MPEG-2 etc.): the title
    // heuristic only suspects, this confirms from the actual file. A CONFIRMED-bad video codec (or
    // no video stream) blocks playback with an honest toast — black screen instead of the series is
    // worse. 'unavailable' (no ffprobe on this TorrServer build) is NOT proof of bad — play anyway.
    // Matches the picked file by exact id (not a path substring).
    function probeSelectedFile(pending) {
        if (!pending || pending.probed || !pending.bestFile) return;
        var base = torrServerBase();
        if (!base) { startDirectPlayback(pending); return; }
        pending.probed = true;
        $.ajax({
            url: base + '/torrents', method: 'POST',
            data: JSON.stringify({ action: 'get', hash: pending.hash }),
            dataType: 'json', timeout: 4000
        }).done(function (json) {
            var files = (json && json.file_stats) || [];
            var match = files.filter(function (f) { return String(f.id) === String(pending.bestFile.id); })[0];
            if (!match || match.id == null) { startDirectPlayback(pending); return; }
            $.ajax({ url: base + '/ffp/' + pending.hash + '/' + match.id, dataType: 'json', timeout: 6000 })
                .done(function (probe) {
                    if (pending.clicked) return;
                    var streams = probe && probe.streams;
                    if (!streams || !streams.length) { startDirectPlayback(pending); return; }
                    var video = streams.filter(function (s) { return s.codec_type === 'video'; })[0];
                    var verdict = video ? classifyVideoCodec(video.codec_name) : 'no-video';
                    if (verdict === 'bad') {
                        notify('Формат видео ' + String(video.codec_name || '').toUpperCase() + ' не поддерживается на этом устройстве — выберите другую раздачу');
                        cleanup(pending);
                        return;
                    }
                    if (verdict === 'no-video') {
                        notify('В раздаче не найден видеопоток — выберите другую раздачу');
                        cleanup(pending);
                        return;
                    }
                    startDirectPlayback(pending);
                }).fail(function () { startDirectPlayback(pending); });
        }).fail(function () { startDirectPlayback(pending); });
    }

    // Builds the player playlist from ALL playable files of the pack — the native torrent screen
    // used to do this (torrent.js:415-429) and handed it to Player.playlist, which is what made
    // "next episode" inside a season pack work via Video.ended → Playlist.next(). We reproduce it
    // so that behaviour doesn't regress.
    function buildPlaylist(pending) {
        var hash = pending.hash;
        var movie = (pending.target && pending.target.movie) || {};
        var files = pending.files || [];
        var playlist = [];
        files.forEach(function (file) {
            var info = {};
            try { info = Lampa.Torserver.parse({ movie: movie, files: files, filename: file.path_human, path: file.path }); } catch (e) {}
            playlist.push({
                title: file.path_human || file.path,
                first_title: movie.name || movie.title,
                card: movie,
                url: Lampa.Torserver.stream(file.path, hash, file.id),
                season: info.season,
                episode: info.episode,
                path: file.path,
                timeline: Lampa.Timeline.view(info.hash)
            });
        });
        return playlist;
    }

    // Starts playback through the exact data shape the native screen builds for a file element
    // (torrent.js:336-350): url from Torserver.stream, timeline from Torserver.parse, plus the
    // playlist. Player.play itself wires Playlist from data.playlist (player.js:1243).
    function startDirectPlayback(pending) {
        if (pending.clicked) return;
        pending.clicked = true;
        var file = pending.bestFile;
        var target = pending.target;
        var movie = (target && target.movie) || {};
        var hash = pending.hash;
        if (!hash || !file) { cleanup(pending); return; }

        var files = pending.files || [];
        var info = {};
        try { info = Lampa.Torserver.parse({ movie: movie, files: files, filename: file.path_human, path: file.path }); } catch (e) {}

        // Compensated native side effect #1: continue-watch card (torrent.js:437).
        try { if (movie.id) Lampa.Favorite.add('history', movie, 100); } catch (e) {}

        var data = {
            url: Lampa.Torserver.stream(file.path, hash, file.id),
            torrent_hash: hash,
            title: file.path_human || file.path,
            first_title: movie.name || movie.title,
            card: movie,
            season: info.season,
            episode: info.episode,
            path: file.path,
            timeline: Lampa.Timeline.view(info.hash),
            playlist: buildPlaylist(pending)
        };

        try { Lampa.Player.play(data); } catch (e) { console.warn('Torrent Mod: Player.play failed', e); }
        // Native torrent.js also routes back from the player to the modal/previous screen
        // (Player.callback + Controller.toggle('modal'), torrent.js:442-445).
        try { Lampa.Player.callback(function () { Lampa.Controller.toggle('modal'); }); } catch (e) {}
        // Warm the NEXT episode's cache while this one plays — the fix for stalls on episode switch.
        try { startNextEpisodePreload(pending); } catch (e) {}
        cleanup(pending);
    }

    // Pre-load the NEXT file of the pack while the current one is still playing (the actual fix for
    // "прерывания на дозагрузку" when the player switches to the next episode via the playlist):
    // as the current file approaches its end (~85% or <=60s left), ask TorrServer to warm the next
    // playable file's cache so Playlist.next() starts with data already downloaded. One file only,
    // fire-and-forget, gated by the torrent_mod_preload_next setting; nothing is shown and nothing
    // in the player/playlist is touched (ADR-0003).
    function startNextEpisodePreload(pending) {
        var files = pending.files || [];
        if (files.length < 2) return;
        if (!field('torrent_mod_preload_next', true)) return;
        var curId = pending.bestFile && String(pending.bestFile.id);
        var next = null;
        var found = false;
        for (var i = 0; i < files.length; i++) {
            if (!found) {
                if (String(files[i].id) === curId) found = true;
                continue;
            }
            next = files[i];
            break;
        }
        if (!next) return; // current file is the last one in the pack

        var fired = false;
        function onTime(e) {
            if (fired || !e || !(e.duration > 0)) return;
            var current = e.current || 0;
            var remaining = e.duration - current;
            if (remaining > 0 && (current >= e.duration * 0.85 || remaining <= 60)) {
                fired = true;
                try { Lampa.PlayerVideo.listener.remove('timeupdate', onTime); } catch (err) {}
                firePreload(preloadUrlFor(next, pending.hash));
            }
        }
        try { Lampa.PlayerVideo.listener.follow('timeupdate', onTime); } catch (e2) {}
        // If the player goes away before the trigger, drop the listener instead of leaking it.
        function onPlayerDestroy() {
            try { Lampa.PlayerVideo.listener.remove('timeupdate', onTime); } catch (e3) {}
            try { Lampa.Player.listener.remove('destroy', onPlayerDestroy); } catch (e4) {}
        }
        try { Lampa.Player.listener.follow('destroy', onPlayerDestroy); } catch (e5) {}
    }

    function torrServerBase() {
        try { if (Lampa.Torserver && Lampa.Torserver.ip) return String(Lampa.Torserver.ip() || '').replace(/\/$/, ''); } catch (e) {}
        return '';
    }

    export function startDownload(item, target) {
        // A new download implicitly cancels any still-pending one (an impatient double-pick during
        // the Jackett search window).
        if (pendingPlayback && !pendingPlayback.clicked) cleanup(pendingPlayback);

        notify((item.tracker || 'Torrent Mod') + ' · ' + item.seeders + ' сидов');
        pendingPlayback = {
            hash: '',
            item: item,
            target: target,
            files: [],
            allFiles: [],
            bestFile: null,
            clicked: false,
            probed: false,
            filesTimer: null
        };
        registerTorrent(pendingPlayback);
    }
