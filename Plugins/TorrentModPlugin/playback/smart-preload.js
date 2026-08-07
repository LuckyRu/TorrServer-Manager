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
    // PLAYBACK SESSION (architect's lifecycle isolation): every launch is a session object with
    // `alive` + `dispose()`. All async continuations (Torserver.hash/files, /ffp, /cache, player
    // listeners) check `session.alive` first — so a late callback from a cancelled/superseded
    // launch can never start playback or leak listeners. `dispose()` is idempotent: clears timers,
    // removes player/video listeners, drops the session reference. The Torrent Mod SCREEN does NOT
    // own the session — playback intentionally outlives the screen (the player keeps running after
    // the results screen is gone); only a new startDownload or the player's own destroy disposes it.
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
    // the player asks) and next-episode preloading near the end of the current file. No global
    // patching of Lampa.Player.play / Torserver.stream (ADR-0003).
    import { parseSignals } from '../search/release-parsing.js';
    import { notify, field, previousController } from '../shared/utils.js';

    var currentSession = null;
    var sessionSeq = 0;

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
        // equally-matching files prefer a streamable container over "древнее говно".
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

    function torrServerBase() {
        try { if (Lampa.Torserver && Lampa.Torserver.ip) return String(Lampa.Torserver.ip() || '').replace(/\/$/, ''); } catch (e) {}
        return '';
    }

    // Registers the torrent with TorrServer directly (POST /torrents action:add, same payload the
    // native screen sends — Torserver.hash). Accepts a magnet OR an HTTP .torrent link: TorrServer
    // downloads and parses the .torrent itself, so a hash arrives in both cases.
    function registerTorrent(session) {
        var item = session.item;
        var target = session.target;
        try {
            Lampa.Torserver.hash({
                title: item.title,
                link: item.magnet || item.link,
                poster: (target.movie && (target.movie.img || target.movie.poster_path)) || ''
            }, function (json) {
                if (!session.alive || session.clicked) return;
                session.hash = json && json.hash;
                if (session.hash) pollFiles(session);
                else { notify('Не удалось получить hash раздачи'); session.dispose(); }
            }, function () {
                if (!session.alive) return;
                notify('Не удалось зарегистрировать раздачу в TorrServer');
                session.dispose();
            });
        } catch (e) {
            notify('TorrServer недоступен');
            session.dispose();
        }
    }

    // Polls Torserver.files(hash) until metadata resolves (file_stats), then filters playable
    // files, enriches them with path_human (Torserver.clearFileName, required by Torserver.parse)
    // and picks the best one. Mirrors the native files() polling (torrent.js:149-169, 2s interval).
    function pollFiles(session) {
        var attempts = 0;
        var maxAttempts = 45;
        session.filesTimer = setInterval(function () {
            if (!session.alive || session.clicked) { clearInterval(session.filesTimer); return; }
            attempts++;
            try {
                Lampa.Torserver.files(session.hash, function (json) {
                    if (!session.alive || session.clicked || session.bestFile) return;
                    var stats = (json && json.file_stats) || [];
                    var plays = stats.filter(isPlayableFile);
                    if (!plays.length) {
                        if (attempts >= maxAttempts) {
                            clearInterval(session.filesTimer);
                            notify('Не удалось получить файлы раздачи');
                            session.dispose();
                        }
                        return;
                    }
                    clearInterval(session.filesTimer);
                    session.allFiles = stats;
                    try { Lampa.Torserver.clearFileName(plays); } catch (e) {}
                    session.files = plays;
                    pickBestFile(session);
                });
            } catch (e) {}
            if (attempts >= maxAttempts) clearInterval(session.filesTimer);
        }, 2000);
    }

    function pickBestFile(session) {
        if (!session.alive || session.clicked || !session.files || !session.files.length) return;
        var scored = [];
        for (var i = 0; i < session.files.length; i++) {
            scored.push({ f: session.files[i], score: preloadFileScore(session.files[i], session.target) });
        }
        scored.sort(function (a, b) { return b.score - a.score; });
        session.bestFile = scored[0].f;
        // Silent nudge: ask TorrServer to warm this file before the player's stream request lands.
        firePreload(preloadUrlFor(session.bestFile, session.hash));
        probeSelectedFile(session);
    }

    // ffprobe gate — the final arbiter for "древнее говно": the title heuristic only suspects,
    // this confirms from the actual file. A CONFIRMED-bad video codec (or no video stream) blocks
    // playback with an honest toast — black screen instead of the series is worse. 'unavailable'
    // (no ffprobe on this TorrServer build) is NOT proof of bad — play anyway.
    function probeSelectedFile(session) {
        if (!session.alive || session.probed || !session.bestFile) return;
        var base = torrServerBase();
        if (!base) { startDirectPlayback(session); return; }
        session.probed = true;
        $.ajax({
            url: base + '/torrents', method: 'POST',
            data: JSON.stringify({ action: 'get', hash: session.hash }),
            dataType: 'json', timeout: 4000
        }).done(function (json) {
            if (!session.alive) return;
            var files = (json && json.file_stats) || [];
            var match = files.filter(function (f) { return String(f.id) === String(session.bestFile.id); })[0];
            if (!match || match.id == null) { startDirectPlayback(session); return; }
            $.ajax({ url: base + '/ffp/' + session.hash + '/' + match.id, dataType: 'json', timeout: 6000 })
                .done(function (probe) {
                    if (!session.alive) return;
                    var streams = probe && probe.streams;
                    if (!streams || !streams.length) { startDirectPlayback(session); return; }
                    var video = streams.filter(function (s) { return s.codec_type === 'video'; })[0];
                    var verdict = video ? classifyVideoCodec(video.codec_name) : 'no-video';
                    if (verdict === 'bad') {
                        notify('Формат видео ' + String(video.codec_name || '').toUpperCase() + ' не поддерживается на этом устройстве — выберите другую раздачу');
                        session.dispose();
                        return;
                    }
                    if (verdict === 'no-video') {
                        notify('В раздаче не найден видеопоток — выберите другую раздачу');
                        session.dispose();
                        return;
                    }
                    startDirectPlayback(session);
                }).fail(function () { if (session.alive) startDirectPlayback(session); });
        }).fail(function () { if (session.alive) startDirectPlayback(session); });
    }

    // Builds the player playlist from ALL playable files of the pack — the native torrent screen
    // used to do this (torrent.js:415-429) and handed it to Player.playlist, which is what made
    // "next episode" inside a season pack work via Video.ended → Playlist.next(). We reproduce it
    // so that behaviour doesn't regress.
    function buildPlaylist(session) {
        var hash = session.hash;
        var movie = (session.target && session.target.movie) || {};
        var files = session.files || [];
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
    // (torrent.js:336-350). Player.play itself wires Playlist from data.playlist (player.js:1243).
    function startDirectPlayback(session) {
        if (!session.alive || session.clicked) return;
        session.clicked = true;
        var file = session.bestFile;
        var target = session.target;
        var movie = (target && target.movie) || {};
        var hash = session.hash;
        if (!hash || !file) { session.dispose(); return; }

        var files = session.files || [];
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
            playlist: buildPlaylist(session)
        };

        // Which controller the Torrent Mod screen had before playback — the player's Back should
        // return there, not to a 'modal' that may not exist (native torrent.js routes to modal
        // because ITS caller is a modal; ours is the screen, found by the architect).
        var backController = previousController() || 'content';

        var started = false;
        try { Lampa.Player.play(data); started = true; } catch (e) { console.warn('Torrent Mod: Player.play failed', e); }
        if (!started) { session.dispose(); return; }
        try { Lampa.Player.callback(function () { Lampa.Controller.toggle(backController); }); } catch (e) {}
        // Warm the NEXT episode's cache while this one plays — the fix for stalls on episode switch.
        // The session must STAY ALIVE for these listeners to work: disposing here would strip them
        // immediately and silently kill next-episode preloading (found in review).
        try { startNextEpisodePreload(session); } catch (e) {}
        // Release the session when the player itself goes away (or on a newer startDownload, which
        // disposes the current session). This listener is also removed by dispose via nextCleanup.
        try {
            var onPlaybackEnd = function () { session.dispose(); };
            Lampa.Player.listener.follow('destroy', onPlaybackEnd);
            session.nextCleanup.push(function () { try { Lampa.Player.listener.remove('destroy', onPlaybackEnd); } catch (err) {} });
        } catch (e) {}
    }

    // Pre-load the NEXT file of the pack while the current one is still playing (the actual fix for
    // "прерывания на дозагрузку" when the player switches to the next episode via the playlist):
    // as the current file approaches its end (~85% or <=60s left), ask TorrServer to warm the next
    // playable file's cache so Playlist.next() starts with data already downloaded. One file only,
    // fire-and-forget, gated by the torrent_mod_preload_next setting; nothing is shown and nothing
    // in the player/playlist is touched (ADR-0003). Listeners are registered on the SESSION and
    // removed by session.dispose() — they must not outlive the launch (found by the architect).
    function startNextEpisodePreload(session) {
        var files = session.files || [];
        if (files.length < 2) return;
        if (!field('torrent_mod_preload_next', true)) return;
        var curId = session.bestFile && String(session.bestFile.id);
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
            if (!session.alive || fired || !e || !(e.duration > 0)) return;
            var current = e.current || 0;
            var remaining = e.duration - current;
            if (remaining > 0 && (current >= e.duration * 0.85 || remaining <= 60)) {
                fired = true;
                try { Lampa.PlayerVideo.listener.remove('timeupdate', onTime); } catch (err) {}
                firePreload(preloadUrlFor(next, session.hash));
            }
        }
        function onPlayerDestroy() {
            try { Lampa.PlayerVideo.listener.remove('timeupdate', onTime); } catch (e3) {}
            try { Lampa.Player.listener.remove('destroy', onPlayerDestroy); } catch (e4) {}
        }
        try { Lampa.PlayerVideo.listener.follow('timeupdate', onTime); } catch (e2) {}
        try { Lampa.Player.listener.follow('destroy', onPlayerDestroy); } catch (e5) {}
        // Register removal on the session so dispose() also clears them (e.g. the player never
        // fired 'destroy' — play threw, or the launch was superseded).
        session.nextCleanup = session.nextCleanup || [];
        session.nextCleanup.push(function () {
            try { Lampa.PlayerVideo.listener.remove('timeupdate', onTime); } catch (e6) {}
            try { Lampa.Player.listener.remove('destroy', onPlayerDestroy); } catch (e7) {}
        });
    }

    function createSession(item, target) {
        var session = {
            id: ++sessionSeq,
            alive: true,
            hash: '',
            item: item,
            target: target,
            files: [],
            allFiles: [],
            bestFile: null,
            clicked: false,
            probed: false,
            filesTimer: null,
            nextCleanup: [],
            dispose: function () {
                if (!session.alive) return;
                session.alive = false;
                clearInterval(session.filesTimer);
                session.filesTimer = null;
                var cleanups = session.nextCleanup || [];
                session.nextCleanup = [];
                cleanups.forEach(function (fn) { try { fn(); } catch (e) {} });
                if (currentSession === session) currentSession = null;
            }
        };
        return session;
    }

    export function startDownload(item, target) {
        // A new launch disposes any still-pending one — its late async callbacks become harmless
        // because they all check session.alive (found by the architect: pending.clicked alone was
        // not a lifecycle token, so an old /ffp or /files callback could start the wrong torrent).
        if (currentSession) currentSession.dispose();

        notify((item.tracker || 'Torrent Mod') + ' · ' + item.seeders + ' сидов');
        var session = createSession(item, target);
        currentSession = session;
        registerTorrent(session);
    }
