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
    import { hubBase } from '../shared/state.js';
    import { isPlayableFile, pickBestFile as pickBestPlayableFile } from './file-selection.js';
    import { buildMoviePlayerData } from './movie-player.js';
    import { buildSeriesPlayerData } from './series-player.js';

    var currentSession = null;
    var sessionSeq = 0;
    var REGISTERED_HASH_CACHE = 'torrent_mod_registered_hashes';
    var REGISTERED_HASH_CACHE_MAX = 200;

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

    function needsAudioTranscode(streams) {
        var audio = (streams || []).filter(function (stream) { return stream.codec_type === 'audio'; });
        if (!audio.length) return false;
        // These codecs are accepted by the browser/WebOS HTML5 player in the containers we emit.
        // AC-3/E-AC-3/DTS/TrueHD tracks are common in Russian BDRips but are not decodable by the
        // target browser; Plugin Hub's ffmpeg route converts the first audio track to stereo AAC.
        var browserCodecs = ['aac', 'mp3', 'opus', 'vorbis', 'flac'];
        return audio.every(function (stream) {
            return browserCodecs.indexOf(String(stream.codec_name || '').toLowerCase()) < 0;
        });
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

    function streamUrlFor(session, file) {
        if (session.useGst) {
            var base = torrServerBase();
            if (base) return base + '/gst/' + encodeURIComponent(session.hash) + '/master.m3u8?index=' + encodeURIComponent(file.id) + '&audio=0';
        }
        if (session.transcodeAudio)
            return hubBase + '/transcode/' + encodeURIComponent(session.hash) + '/' + encodeURIComponent(file.id);
        return Lampa.Torserver.stream(file.path, session.hash, file.id);
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

    function registeredHashKey(item) {
        // Jackett's protected /dl URL can change between searches while the torrent itself stays
        // identical. Use release identity rather than the ephemeral URL so selecting the same
        // movie again does not make TorrServer add the same infohash a second time.
        return [item.tracker || '', item.title || '', item.size || ''].join('|');
    }

    function readRegisteredHash(item) {
        try {
            var all = Lampa.Storage.cache(REGISTERED_HASH_CACHE, REGISTERED_HASH_CACHE_MAX, {}) || {};
            return all[registeredHashKey(item)] || '';
        } catch (e) { return ''; }
    }

    function rememberRegisteredHash(item, hash) {
        if (!hash) return;
        try {
            var all = Lampa.Storage.cache(REGISTERED_HASH_CACHE, REGISTERED_HASH_CACHE_MAX, {}) || {};
            all[registeredHashKey(item)] = hash;
            Lampa.Storage.set(REGISTERED_HASH_CACHE, all);
        } catch (e) {}
    }

    // Registers the torrent with TorrServer directly (POST /torrents action:add). We intentionally
    // do NOT call Lampa.Torserver.hash here: this Lampa build passes its JSON string with jQuery's
    // default application/x-www-form-urlencoded content type (visible in DevTools), while
    // TorrServer's endpoint only accepts application/json. Series happened to work on paths where
    // the request was not exercised in the same way; movie selection exposed the malformed request
    // reliably. Keep the native payload shape, but send it with the correct content type ourselves.
    function registerTorrent(session) {
        var item = session.item;
        var target = session.target;
        var source = item.magnet ? 'magnet' : 'torrent-link';
        var base = torrServerBase();
        if (!base) {
            console.warn('Torrent Mod: TorrServer URL не настроен', { mode: session.mode });
            notify('TorrServer недоступен');
            session.dispose();
            return;
        }
        var saveToDb = false;
        try { saveToDb = Lampa.Storage.get('torrserver_savedb', 'false'); } catch (e) {}
        var title = '[LAMPA] ' + String(item.title || '').replace('??', '?');
        var payload = {
            action: 'add',
            link: item.magnet || item.link,
            title: title,
            poster: (target.movie && (target.movie.img || target.movie.poster_path)) || '',
            data: '',
            save_to_db: saveToDb
        };

        function useRegisteredHash(hash) {
            if (!session.alive || !hash) return;
            session.hash = hash;
            pollFiles(session);
        }

        function addTorrent() {
            try {
                $.ajax({
                    url: base + '/torrents',
                    method: 'POST',
                    contentType: 'application/json',
                    data: JSON.stringify(payload),
                    dataType: 'json',
                    timeout: source === 'torrent-link' ? 65000 : 30000
                }).done(function (json) {
                    if (!session.alive || session.clicked) return;
                    session.hash = json && json.hash;
                    if (session.hash) {
                        rememberRegisteredHash(item, session.hash);
                        pollFiles(session);
                    } else {
                        console.warn('Torrent Mod: action:add вернул пустой hash', json);
                        notify('Не удалось получить hash раздачи');
                        session.dispose();
                    }
                }).fail(function (xhr, status, error) {
                    if (!session.alive) return;
                    console.warn('Torrent Mod: /torrents action:add fail', {
                        mode: session.mode,
                        source: source,
                        title: item.title,
                        status: status,
                        error: error,
                        response: xhr && xhr.responseText
                    });
                    notify('Не удалось зарегистрировать раздачу в TorrServer');
                    session.dispose();
                });
            } catch (e) {
                console.warn('Torrent Mod: /torrents action:add бросил', e);
                notify('TorrServer недоступен');
                session.dispose();
            }
        }

        function findExistingTorrent(onMissing) {
            // The persisted hash cache is the fast path. The list fallback covers a fresh browser
            // profile, a cleared Lampa storage, and a URL token that changed since the last search.
            // Match the exact Lampa title first; the fallback without the prefix handles torrents
            // created by the native Lampa screen.
            $.ajax({
                url: base + '/torrents',
                method: 'POST',
                contentType: 'application/json',
                data: JSON.stringify({ action: 'list' }),
                dataType: 'json',
                timeout: 5000
            }).done(function (list) {
                var plainTitle = title.replace(/^\[LAMPA\]\s*/i, '');
                var found = (Array.isArray(list) ? list : []).filter(function (entry) {
                    var entryTitle = String(entry && entry.title || '');
                    return entry && entry.hash && (entryTitle === title || entryTitle === plainTitle || entryTitle.replace(/^\[LAMPA\]\s*/i, '') === plainTitle);
                })[0];
                if (found) useRegisteredHash(found.hash);
                else onMissing();
            }).fail(onMissing);
        }

        var knownHash = readRegisteredHash(item);
        if (knownHash) {
            // Validate the cached hash first. If TorrServer was restarted and the torrent is no
            // longer available, fall back to one normal add; never blindly reuse stale state.
            $.ajax({
                url: base + '/torrents',
                method: 'POST',
                contentType: 'application/json',
                data: JSON.stringify({ action: 'get', hash: knownHash }),
                dataType: 'json',
                timeout: 5000
            }).done(function (json) {
                if (session.alive && json && (json.hash || json.title)) useRegisteredHash(knownHash);
                else if (session.alive) addTorrent();
            }).fail(function () {
                if (session.alive) addTorrent();
            });
        } else {
            findExistingTorrent(addTorrent);
        }
    }

    // Polls Torserver.files(hash) until metadata resolves (file_stats), then filters playable
    // files, enriches them with path_human (Torserver.clearFileName, required by Torserver.parse)
    // and picks the best one. Mirrors the native files() polling (torrent.js:149-169, 2s interval).
    function pollFiles(session) {
        var attempts = 0;
        var maxAttempts = 45;
        function attempt() {
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
                            console.warn('Torrent Mod: metadata не пришли за ' + (maxAttempts * 2) + 'с, hash=' + session.hash);
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
            } catch (e) { console.warn('Torrent Mod: Torserver.files бросил', e); }
            if (attempts >= maxAttempts) clearInterval(session.filesTimer);
        }
        session.filesTimer = setInterval(attempt, 2000);
        // Do not deliberately sleep for the first interval: metadata is usually already available
        // when action:add returns, and this exact 2-second gap was visible before the player appeared.
        attempt();
    }

    function pickBestFile(session) {
        if (!session.alive || session.clicked || !session.files || !session.files.length) return;
        session.bestFile = pickBestPlayableFile(session.files, session.target, parseSignals);
        if (!session.bestFile) return;
        console.log('Torrent Mod: выбран файл', {
            mode: session.mode,
            torrent: session.item.title,
            file: session.bestFile.path,
            size: session.bestFile.length || session.bestFile.size || 0
        });
        // Silent nudge: ask TorrServer to warm this file before the player's stream request lands.
        firePreload(preloadUrlFor(session.bestFile, session.hash));
        // Playback is not gated on ffprobe. The player/HLS pipeline can start immediately; ffprobe
        // continues in the background for diagnostics and codec warnings. Waiting here made a
        // perfectly playable torrent sit behind /torrents + /ffp timeouts before showing anything.
        session.useGst = true;
        startDirectPlayback(session);
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
            // contentType matters: jQuery defaults POST bodies to application/x-www-form-urlencoded,
            // which TorrServer answers with 400 — the ffprobe gate silently fell back to direct
            // playback (or worse) on real devices (found by the user via DevTools network tab).
            contentType: 'application/json',
            data: JSON.stringify({ action: 'get', hash: session.hash }),
            dataType: 'json', timeout: 4000
        }).done(function (json) {
            if (!session.alive) return;
            var files = (json && json.file_stats) || [];
            var match = files.filter(function (f) { return String(f.id) === String(session.bestFile.id); })[0];
            if (!match || match.id == null) { startWithPreferredTransport(session); return; }
            $.ajax({ url: base + '/ffp/' + session.hash + '/' + match.id, dataType: 'json', timeout: 6000 })
                .done(function (probe) {
                    if (!session.alive) return;
                    var streams = probe && probe.streams;
                    if (!streams || !streams.length) { startWithPreferredTransport(session); return; }
                    session.transcodeAudio = needsAudioTranscode(streams);
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
                    startWithPreferredTransport(session);
                }).fail(function () {
                    console.warn('Torrent Mod: /ffp запрос не удался — играем без проверки формата');
                    if (session.alive) startWithPreferredTransport(session);
                });
        }).fail(function () {
            console.warn('Torrent Mod: /torrents get не удался — играем без проверки формата');
            if (session.alive) startWithPreferredTransport(session);
        });
    }

    function startWithPreferredTransport(session) {
        if (!session.alive || session.clicked) return;
        var base = torrServerBase();
        if (!base) { startDirectPlayback(session); return; }
        // Do not wait for the manifest here. HLS.js must own that loading state: waiting for the
        // first master/init segment before opening Player made every launch look frozen for up to
        // 60 seconds. The player opens immediately, shows its native loader, and HLS.js updates the
        // duration/seek bar as soon as the VOD manifest arrives.
        session.useGst = true;
        startDirectPlayback(session);
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
                url: streamUrlFor(session, file),
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

        // Compensated native side effect #1: continue-watch card (torrent.js:437).
        try { if (movie.id) Lampa.Favorite.add('history', movie, 100); } catch (e) {}

        var data = session.mode === 'movie'
            ? buildMoviePlayerData(session)
            : buildSeriesPlayerData(session, buildPlaylist, function (file) { return streamUrlFor(session, file); });

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
            mode: target.mode || 'series',
            hash: '',
            item: item,
            target: target,
            files: [],
            allFiles: [],
            bestFile: null,
            clicked: false,
            probed: false,
            transcodeAudio: false,
            useGst: false,
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
