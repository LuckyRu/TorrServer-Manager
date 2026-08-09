    // ---------- GST-only playback with audio-track preflight ----------
    //
    // The user explicitly rejected the smart-preload overlay ("лишний моргающий интерфейс без
    // реальной пользы"): a click must go STRAIGHT to the player. What remains is the silent
    // plumbing that makes playback possible at all:
    //
    //   register torrent                POST /torrents action:add
    //     → pollFiles: Torserver.files(hash)  until metadata resolves → file_stats
    //     → pickBestFile()              score season/episode signals in file paths (ours)
    //     → GET /gst/:hash/probe        discover actual audio tracks
    //     → Lampa.Player.play({GST url, voiceovers, timeline, playlist})
    //
    // TRANSPORT: every file is opened through TorrServer GST/HLS. The direct browser stream does not
    // provide a portable contract for embedded audio tracks, subtitles, or codecs across WebOS TVs.
    // A probe always precedes Player.play: it supplies `voiceovers` and selects either the user's
    // saved studio or the first audio track. Do not patch global Lampa Player/Torserver APIs.
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
    // Plus, still silent: an initial fire-and-forget `&preload` cache nudge and next-episode
    // cache warming near the end of the current file. This uses Torserver.stream only to obtain
    // TorrServer's official preload URL; it is never a Player transport. No global patching of
    // Lampa.Player.play / Torserver.stream (ADR-0003).
    import { parseSignals } from '../shared/release-signals.js';
    import { notify, field, previousController } from '../shared/utils.js';
    import { MODE_MOVIE, MODE_SERIES } from '../shared/state.js';
    import { isPlayableFile, pickBestFile as pickBestPlayableFile } from './file-selection.js';
    import { buildMoviePlayerData } from './movie-player.js';
    import { buildSeriesPlayerData } from './series-player.js';
    import { normalizeAudioTracks, preferenceFromTrack, resolvePreferredTrack } from './audio-tracks.js';
    import { log, warn } from '../shared/core/log.js';

    var currentSession = null;
    var sessionSeq = 0;
    var REGISTERED_HASH_CACHE = 'torrent_mod_registered_hashes';
    var REGISTERED_HASH_CACHE_MAX = 200;
    var AUDIO_PREFERENCE_CACHE = 'torrent_mod_audio_preference';
    var AUDIO_PREFERENCE_CACHE_MAX = 200;

    // The normal TorrServer stream endpoint accepts `&preload` to start filling the torrent cache.
    // Do not obtain this URL from Lampa.Torserver.stream(): when its global `torrserver_gts` switch
    // is on, it returns a GST master URL instead and a cache nudge would accidentally create an
    // audio=0 GST task before our probe has selected the real track.
    function preloadUrlFor(file, hash) {
        var base = torrServerBase();
        if (!base || !file) return '';
        var sourceName = String(file.path || '').split(/[\\/]/).pop();
        if (!sourceName) return '';
        return base + '/stream/' + encodeURIComponent(sourceName) + '?link=' + encodeURIComponent(hash) + '&index=' + encodeURIComponent(file.id) + '&preload';
    }

    function gstStreamUrl(session, file, audioIndex, seconds) {
        var base = torrServerBase();
        if (!base) return '';
        var url = base + '/gst/' + encodeURIComponent(session.hash) + '/master.m3u8?index=' + encodeURIComponent(file.id) + '&audio=' + encodeURIComponent(audioIndex);
        if (typeof seconds === 'number' && isFinite(seconds) && seconds > 0) url += '&seconds=' + encodeURIComponent(Math.floor(seconds));
        return url;
    }

    // A prepared file has a concrete GST URL and metadata. hls.js needs the long timeout because
    // TorrServer can still wait for pieces of a torrent before returning the manifest.
    function urlsFor(session, file) {
        return (session.transports && session.transports[String(file.id)]) || {};
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

    function audioPreferenceKey(session) {
        var target = session.target || {};
        var movie = target.movie || {};
        if (session.mode !== MODE_SERIES || !movie.id) return '';
        return String(movie.id) + ':' + String(target.season || 0);
    }

    function readAudioPreference(session) {
        var key = audioPreferenceKey(session);
        if (!key) return null;
        try {
            var all = Lampa.Storage.cache(AUDIO_PREFERENCE_CACHE, AUDIO_PREFERENCE_CACHE_MAX, {}) || {};
            return all[key] || null;
        } catch (e) { return null; }
    }

    function rememberAudioPreference(session, preference) {
        var key = audioPreferenceKey(session);
        if (!key || !preference) return;
        try {
            var all = Lampa.Storage.cache(AUDIO_PREFERENCE_CACHE, AUDIO_PREFERENCE_CACHE_MAX, {}) || {};
            all[key] = preference;
            Lampa.Storage.set(AUDIO_PREFERENCE_CACHE, all);
        } catch (e) {}
    }

    function currentPlaybackSeconds() {
        try {
            var video = Lampa.PlayerVideo && Lampa.PlayerVideo.video && Lampa.PlayerVideo.video();
            var seconds = Number(video && video.currentTime);
            return isFinite(seconds) && seconds > 0 ? seconds : 0;
        } catch (e) { return 0; }
    }

    function voiceoversFor(session, file, tracks, selectedIndex) {
        return tracks.map(function (track) {
            return {
                index: track.index,
                language: track.language,
                label: track.label,
                extra: track.extra,
                selected: track.index === selectedIndex,
                onSelect: function () { switchAudioTrack(session, file, track.index); }
            };
        });
    }

    function selectedTrackFor(session, file, tracks) {
        var preferred = resolvePreferredTrack(session.audioPreference, tracks);
        if (preferred) return preferred;
        if (session.audioPreference && !session.missingPreferenceByFile[String(file.id)]) {
            session.missingPreferenceByFile[String(file.id)] = true;
            notify('Выбранный перевод не найден, включена первая дорожка');
        }
        return tracks[0] || null;
    }

    function probeFile(session, file, done, fail) {
        var id = String(file.id);
        var cached = session.probes[id];
        if (cached) { done(cached); return; }
        var base = torrServerBase();
        if (!base) { fail('TorrServer недоступен'); return; }

        try {
            $.ajax({
                url: base + '/gst/' + encodeURIComponent(session.hash) + '/probe?index=' + encodeURIComponent(file.id),
                method: 'GET',
                dataType: 'json',
                timeout: 35000
            }).done(function (probe) {
                if (!session.alive) return;
                var tracks = normalizeAudioTracks(probe);
                if (!tracks.length) { fail('В файле не найдены аудиодорожки'); return; }
                session.probes[id] = tracks;
                done(tracks);
            }).fail(function (xhr, status, error) {
                if (!session.alive) return;
                warn('playback', 'probeFile: GST probe failed', { file: file.path, status: status, error: error, response: xhr && xhr.responseText });
                fail('Не удалось получить дорожки файла');
            });
        } catch (e) {
            warn('playback', 'probeFile: GST probe threw', e);
            fail('Не удалось получить дорожки файла');
        }
    }

    function storeTransport(session, file, tracks, selected, seconds, done, fail) {
        if (!selected) { fail('В файле не найдены аудиодорожки'); return; }
        var transport = {
            url: gstStreamUrl(session, file, selected.index, seconds),
            hls_manifest_timeout: 60000,
            audioIndex: selected.index,
            voiceovers: voiceoversFor(session, file, tracks, selected.index)
        };
        if (!transport.url) { fail('TorrServer недоступен'); return; }
        session.transports[String(file.id)] = transport;
        done(transport);
    }

    function prepareTransport(session, file, seconds, done, fail) {
        probeFile(session, file, function (tracks) {
            if (!session.alive) return;
            storeTransport(session, file, tracks, selectedTrackFor(session, file, tracks), seconds, done, fail);
        }, fail);
    }

    function prepareSelectedTransport(session, file, audioIndex, seconds, done, fail) {
        probeFile(session, file, function (tracks) {
            if (!session.alive) return;
            var selected = tracks.filter(function (track) { return track.index === audioIndex; })[0];
            if (!selected) { fail('Выбранная дорожка больше недоступна'); return; }
            storeTransport(session, file, tracks, selected, seconds, done, fail);
        }, fail);
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
        log('playback', 'registerTorrent: "' + item.title + '" (' + source + ', ' + item.tracker + ')');
        if (!base) {
            warn('playback', 'registerTorrent: TorrServer URL не настроен', { mode: session.mode });
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
            log('playback', 'registerTorrent: используем hash ' + hash);
            session.hash = hash;
            pollFiles(session);
        }

        function addTorrent() {
            log('playback', 'registerTorrent: добавляю новый торрент (' + source + ')');
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
                        log('playback', 'registerTorrent: добавлен, hash=' + session.hash);
                        rememberRegisteredHash(item, session.hash);
                        pollFiles(session);
                    } else {
                        warn('playback', 'registerTorrent: action:add вернул пустой hash', json);
                        notify('Не удалось получить hash раздачи');
                        session.dispose();
                    }
                }).fail(function (xhr, status, error) {
                    if (!session.alive) return;
                    warn('playback', 'registerTorrent: /torrents action:add fail', {
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
                warn('playback', 'registerTorrent: /torrents action:add бросил', e);
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
                if (found) { log('playback', 'registerTorrent: найден уже зарегистрированный торрент по списку'); useRegisteredHash(found.hash); }
                else onMissing();
            }).fail(onMissing);
        }

        var knownHash = readRegisteredHash(item);
        if (knownHash) {
            log('playback', 'registerTorrent: проверяю кэшированный hash ' + knownHash);
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
                else if (session.alive) { log('playback', 'registerTorrent: кэшированный hash протух, добавляю заново'); addTorrent(); }
            }).fail(function () {
                if (session.alive) { log('playback', 'registerTorrent: не удалось проверить кэшированный hash, добавляю заново'); addTorrent(); }
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
        log('playback', 'pollFiles: старт опроса метаданных, hash=' + session.hash);
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
                            warn('playback', 'pollFiles: metadata не пришли за ' + (maxAttempts * 2) + 'с, hash=' + session.hash);
                            session.dispose();
                        }
                        return;
                    }
                    clearInterval(session.filesTimer);
                    log('playback', 'pollFiles: метаданные получены, попытка ' + attempts + ', файлов=' + plays.length);
                    session.allFiles = stats;
                    try { Lampa.Torserver.clearFileName(plays); } catch (e) {}
                    session.files = plays;
                    pickBestFile(session);
                });
            } catch (e) { warn('playback', 'pollFiles: Torserver.files бросил', e); }
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
        log('playback', 'pickBestFile: выбран файл "' + session.bestFile.path + '"', {
            mode: session.mode,
            torrent: session.item.title,
            size: session.bestFile.length || session.bestFile.size || 0
        });
        // Silent nudge: ask TorrServer to start filling this file's cache while GST probes it.
        firePreload(preloadUrlFor(session.bestFile, session.hash));
        prepareTransport(session, session.bestFile, 0, function (transport) {
            if (!session.alive) return;
            session.activeFile = session.bestFile;
            session.activeAudioIndex = transport.audioIndex;
            startGstPlayback(session);
        }, function (message) {
            if (!session.alive) return;
            warn('playback', 'pickBestFile: preflight failed', { file: session.bestFile.path, message: message });
            notify(message + '. Проверьте GStreamer и повторите запуск');
            session.dispose();
        });
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
            playlist.push(createPlaylistItem(session, file, info, movie, urlsFor(session, file)));
        });
        return playlist;
    }

    function createPlaylistItem(session, file, info, movie, transport) {
        var item = {
            title: file.path_human || file.path,
            first_title: movie.name || movie.title,
            card: movie,
            season: info.season,
            episode: info.episode,
            path: file.path,
            timeline: Lampa.Timeline.view(info.hash)
        };
        if (transport.url) {
            item.url = transport.url;
            item.hls_manifest_timeout = transport.hls_manifest_timeout;
            item.voiceovers = transport.voiceovers;
            item.callback = function () {
                session.activeFile = file;
                session.activeAudioIndex = transport.audioIndex;
            };
        } else {
            item.url = deferredPlaylistUrl(session, file, item);
        }
        return item;
    }

    function deferredPlaylistUrl(session, file, item) {
        return function (continuePlayback) {
            if (!session.alive) return;
            session.playlistTransition = true;
            prepareTransport(session, file, 0, function (transport) {
                if (!session.alive) return;
                item.url = transport.url;
                item.hls_manifest_timeout = transport.hls_manifest_timeout;
                item.voiceovers = transport.voiceovers;
                item.callback = function () {
                    session.activeFile = file;
                    session.activeAudioIndex = transport.audioIndex;
                };
                continuePlayback();
                // Lampa's callback destroys then immediately creates its next Player synchronously.
                // Keep the session alive through that destroy event; clear on the next task turn.
                setTimeout(function () { session.playlistTransition = false; }, 0);
            }, function (message) {
                if (!session.alive) return;
                session.playlistTransition = false;
                warn('playback', 'playlist preflight failed', { file: file.path, message: message });
                notify(message + '. Выберите другой файл');
                try { Lampa.Player.close(); } catch (e) { session.dispose(); }
            });
        };
    }

    function detachPlayerLifecycle(session) {
        if (!session.playerCleanup) return;
        try { session.playerCleanup(); } catch (e) {}
        session.playerCleanup = null;
    }

    function bindPlayerLifecycle(session) {
        detachPlayerLifecycle(session);
        try {
            var onPlaybackEnd = function () {
                if (!session.playlistTransition && !session.switching) session.dispose();
            };
            Lampa.Player.listener.follow('destroy', onPlaybackEnd);
            session.playerCleanup = function () {
                try { Lampa.Player.listener.remove('destroy', onPlaybackEnd); } catch (e) {}
            };
            session.nextCleanup.push(detachPlayerLifecycle.bind(null, session));
        } catch (e) {}
    }

    function switchAudioTrack(session, file, audioIndex) {
        if (!session.alive || session.switching || !file || audioIndex === session.activeAudioIndex) return;
        session.switching = true;
        var track = (session.probes[String(file.id)] || []).filter(function (item) { return item.index === audioIndex; })[0];
        session.pendingAudioPreference = preferenceFromTrack(track);
        notify('Переключение перевода…');

        prepareSelectedTransport(session, file, audioIndex, currentPlaybackSeconds(), function (transport) {
            if (!session.alive) return;
            session.activeFile = file;
            session.activeAudioIndex = transport.audioIndex;
            restartGstPlayback(session, file);
        }, function (message) {
            if (!session.alive) return;
            session.pendingAudioPreference = null;
            session.switching = false;
            notify(message);
        });
    }

    function watchTrackSwitch(session) {
        var settled = false;
        var timer = null;
        function cleanup() {
            if (timer) clearTimeout(timer);
            try { Lampa.PlayerVideo.listener.remove('canplay', onCanPlay); } catch (e) {}
            try { Lampa.PlayerVideo.listener.remove('error', onError); } catch (e) {}
        }
        function finish(ok) {
            if (settled) return;
            settled = true;
            cleanup();
            if (!session.alive) return;
            if (ok && session.pendingAudioPreference) rememberAudioPreference(session, session.pendingAudioPreference);
            if (!ok) notify('Не удалось переключить перевод');
            session.pendingAudioPreference = null;
            session.switching = false;
        }
        function onCanPlay() { finish(true); }
        function onError(event) { if (!event || event.fatal !== false) finish(false); }
        try {
            Lampa.PlayerVideo.listener.follow('canplay', onCanPlay);
            Lampa.PlayerVideo.listener.follow('error', onError);
            timer = setTimeout(function () { finish(false); }, 70000);
        } catch (e) { finish(false); }
    }

    function restartGstPlayback(session, file) {
        // Lampa does not expose a source-replace API. `close()` synchronously destroys the old video;
        // the switching guard keeps the playback session alive until the new GST Player is created.
        try { Lampa.Player.close(); } catch (e) {}
        if (!session.alive) return;
        session.clicked = false;
        watchTrackSwitch(session);
        startGstPlayback(session);
    }

    // Starts playback through the exact data shape the native screen builds for a file element
    // (torrent.js:336-350). Player.play itself wires Playlist from data.playlist (player.js:1243).
    function startGstPlayback(session) {
        if (!session.alive || session.clicked) return;
        session.clicked = true;
        var file = session.activeFile || session.bestFile;
        var target = session.target;
        var movie = (target && target.movie) || {};
        var hash = session.hash;
        if (!hash || !file || !urlsFor(session, file).url) { warn('playback', 'startGstPlayback: нет GST URL, отмена'); session.dispose(); return; }

        // Compensated native side effect #1: continue-watch card (torrent.js:437).
        try { if (movie.id) Lampa.Favorite.add('history', movie, 100); } catch (e) {}

        var data = session.mode === MODE_MOVIE
            ? buildMoviePlayerData(session, function (item) { return urlsFor(session, item); }, file)
            : buildSeriesPlayerData(session, buildPlaylist, function (item) { return urlsFor(session, item); }, file);

        log('playback', 'startGstPlayback: запуск Player.play', { mode: session.mode, hasUrl: !!data.url, audio: session.activeAudioIndex, playlistLength: (data.playlist || []).length });

        // Which controller the Torrent Mod screen had before playback — the player's Back should
        // return there, not to a 'modal' that may not exist (native torrent.js routes to modal
        // because ITS caller is a modal; ours is the screen, found by the architect).
        var backController = previousController() || 'content';

        var started = false;
        try { Lampa.Player.play(data); started = true; } catch (e) { warn('playback', 'startGstPlayback: Player.play failed', e); }
        if (!started) { session.dispose(); return; }
        try { Lampa.Player.callback(function () { Lampa.Controller.toggle(backController); }); } catch (e) {}
        // Warm the NEXT episode's cache while this one plays — the fix for stalls on episode switch.
        // The session must STAY ALIVE for these listeners to work: disposing here would strip them
        // immediately and silently kill next-episode preloading (found in review).
        try { startNextEpisodePreload(session); } catch (e) {}
        // Release the session when the player itself goes away (but keep it across a controlled
        // audio switch and Lampa's destroy→play playlist transition).
        bindPlayerLifecycle(session);
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
        var currentFile = session.activeFile || session.bestFile;
        var curId = currentFile && String(currentFile.id);
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
                log('playback', 'startNextEpisodePreload: прогреваю следующий файл "' + next.path + '"');
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
            mode: target.mode || MODE_SERIES,
            hash: '',
            item: item,
            target: target,
            files: [],
            allFiles: [],
            bestFile: null,
            activeFile: null,
            activeAudioIndex: null,
            probes: {},
            transports: {},
            missingPreferenceByFile: {},
            audioPreference: null,
            pendingAudioPreference: null,
            switching: false,
            playlistTransition: false,
            playerCleanup: null,
            clicked: false,
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
        session.audioPreference = readAudioPreference(session);
        return session;
    }

    export function startDownload(item, target) {
        log('playback', 'startDownload: "' + item.title + '" (' + item.tracker + ', ' + item.seeders + ' сидов), mode=' + (target && target.mode));
        // A new launch disposes any still-pending one — its late async callbacks become harmless
        // because they all check session.alive (found by the architect: pending.clicked alone was
        // not a lifecycle token, so an old /files callback could start the wrong torrent).
        if (currentSession) { log('playback', 'startDownload: отменяю предыдущую незавершённую сессию #' + currentSession.id); currentSession.dispose(); }

        notify((item.tracker || 'Torrent Mod') + ' · ' + item.seeders + ' сидов');
        var session = createSession(item, target);
        currentSession = session;
        registerTorrent(session);
    }
