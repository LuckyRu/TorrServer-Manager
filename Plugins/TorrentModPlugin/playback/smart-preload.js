    import { parseSignals } from '../shared/release-signals.js';
    import { notify, field, previousController } from '../shared/utils.js';
    import { MODE_MOVIE, MODE_SERIES } from '../shared/state.js';
    import { isPlayableFile, pickBestFile as pickBestPlayableFile, parseSeriesFileLayout } from './file-selection.js';
    import { buildMoviePlayerData } from './movie-player.js';
    import { buildSeriesPlayerData } from './series-player.js';
    import { normalizeAudioTracks, preferenceFromTrack, resolvePreferredTrack } from './audio-tracks.js';
    import { log, warn } from '../shared/core/log.js';
    import { createLifecycle } from '../shared/core/lifecycle.js';
    import {
        sourceBitrateBps,
        probeDurationSeconds,
        browserBufferSeconds,
        expectedSourcePiece,
        torrentBuffer,
        smoothDownloadBps,
        assessPlaybackHealth,
        playbackHealthLabel,
        playbackHealthDotCount
    } from './playback-health.js';

    var currentSession = null;
    var sessionSeq = 0;
    var REGISTERED_HASH_CACHE = 'torrent_mod_registered_hashes';
    var REGISTERED_HASH_CACHE_MAX = 200;
    var AUDIO_PREFERENCE_CACHE = 'torrent_mod_audio_preference';
    var AUDIO_PREFERENCE_CACHE_MAX = 200;
    var PREPARING_CONTROLLER = 'torrent_mod_player_preparing';

    function updatePreparation(session, phase, text) {
        if (!session || !session.alive) return;
        session.phase = phase || session.phase;
        var shell = session.preparationShell;
        if (!shell || !shell.find) return;
        try {
            var label = text || 'Подготовка воспроизведения…';
            shell.find('.torrent-mod-player-preparing__title').text(label);
            shell.find('.player-info__name').text(label);
            shell.find('.head-backward__title').text('Плеер');
        } catch (e) {}
    }

    function removePreparationOverlay(session) {
        if (!session || !session.preparationOverlay) return;
        try { session.preparationOverlay.remove(); } catch (e) {}
        session.preparationOverlay = null;
    }

    // Player.play(data.url) can't take a function for the first play; Player.render() mounts the real shell early instead (docs/reference/lampa-player-api.md).
    function openPreparationShell(session) {
        if (!session || !session.alive || !Lampa.Player || !Lampa.Player.render) return;
        try {
            var shell = Lampa.Player.render();
            if (!shell || !shell.addClass) return;
            session.preparationShell = shell;
            session.preparationMounted = true;
            shell.addClass('player--loading player--panel-visible torrent-mod-player-preparing');
            session.preparationOverlay = $(
                '<div class="torrent-mod-player-preparing__overlay">' +
                    '<span class="torrent-mod-player-preparing__spinner"></span>' +
                    '<div class="torrent-mod-player-preparing__title">Подготовка воспроизведения…</div>' +
                    '<div class="torrent-mod-player-preparing__hint">Назад — отменить</div>' +
                '</div>'
            );
            shell.append(session.preparationOverlay);
            try { shell.find('.player-info__error').addClass('hide').text(''); } catch (e) {}
            updatePreparation(session, 'registering', 'Подключение к раздаче…');
            $('body').addClass('player--viewing').append(shell);
            session.scope.track(function () { closePreparationShell(session, true); });

            Lampa.Controller.add(PREPARING_CONTROLLER, {
                invisible: true,
                toggle: function () {},
                back: function () {
                    if (!session.alive || currentSession !== session) return;
                    log('playback', 'preflight отменён через Controller.back, session #' + session.id);
                    session.cancelled = true;
                    session.dispose();
                },
                stop: function () {
                    if (session.alive && currentSession === session) {
                        session.cancelled = true;
                        session.dispose();
                    }
                }
            });
            Lampa.Controller.toggle(PREPARING_CONTROLLER);
        } catch (e) {
            try {
                if (session.preparationShell) {
                    session.preparationShell.removeClass('player--loading player--panel-visible torrent-mod-player-preparing');
                    removePreparationOverlay(session);
                    session.preparationShell.detach();
                }
                $('body').removeClass('player--viewing');
            } catch (cleanupError) {}
            session.preparationShell = null;
            session.preparationMounted = false;
            warn('playback', 'Не удалось открыть оболочку Player для preflight', e);
        }
    }

    function closePreparationShell(session, restoreController) {
        if (!session || !session.preparationMounted) return;
        session.preparationMounted = false;
        var shell = session.preparationShell;
        session.preparationShell = null;
        try {
            shell.removeClass('player--loading player--panel-visible torrent-mod-player-preparing');
            removePreparationOverlay(session);
            // detach(), not remove(): this is Lampa's shared Player DOM with its own handlers.
            shell.detach();
        } catch (e) {}
        try { $('body').removeClass('player--viewing'); } catch (e) {}
        if (restoreController) {
            try {
                if (Lampa.Controller.enabled().name === PREPARING_CONTROLLER) {
                    Lampa.Controller.toggle(session.backController || 'content');
                }
            } catch (e) {}
        }
    }

    // Keep the preflight shell/overlay up until Player announces 'ready' — detaching earlier reopens the black gap Player.play's own preload() takes to fill.
    function handoffPreparationShell(session) {
        if (!session || !session.preparationMounted) return function () {};
        var settled = false;
        var untrack = null;
        function cleanupListener() {
            try { Lampa.Player.listener.remove('ready', onReady); } catch (e) {}
            if (untrack) {
                var release = untrack;
                untrack = null;
                release();
            }
        }
        function onReady() {
            if (settled) return;
            settled = true;
            cleanupListener();
            if (!session.preparationMounted) return;
            session.preparationMounted = false;
            var shell = session.preparationShell;
            session.preparationShell = null;
            try { shell.removeClass('player--loading player--panel-visible torrent-mod-player-preparing'); } catch (e) {}
            removePreparationOverlay(session);
            // Not detached: ownership of this DOM node has already passed to native Player.play.
        }
        try {
            Lampa.Player.listener.follow('ready', onReady);
            untrack = session.scope.track(cleanupListener);
        } catch (e) {
            return function () {};
        }
        return cleanupListener;
    }

    function activateFileScope(session, file) {
        var id = file ? String(file.id) : '';
        if (session.fileScope && session.fileScope.isAlive() && session.fileScopeId === id) return session.fileScope;
        if (session.fileScope) session.fileScope.dispose();
        session.fileScope = session.scope.child();
        session.fileScopeId = id;
        session.nextEpisodeCleanup = null;
        return session.fileScope;
    }

    // Built directly, not via Lampa.Torserver.stream(): with the global torrserver_gts switch on, that returns a GST URL and would preempt our own audio-track probe with an audio=0 task.
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
        var fileScope = activateFileScope(session, file);
        var cached = session.probes[id];
        if (cached) { done(cached); return; }
        var base = torrServerBase();
        if (!base) { fail('TorrServer недоступен'); return; }
        var attempt = 0;
        function run() {
            if (!session.alive || !fileScope.isAlive()) return;
            attempt++;
            try {
                var request = $.ajax({
                    url: base + '/gst/' + encodeURIComponent(session.hash) + '/probe?index=' + encodeURIComponent(file.id),
                    method: 'GET',
                    dataType: 'json',
                    timeout: 35000
                });
                var untrackRequest = fileScope.track(function () {
                    try { if (request && request.abort) request.abort(); } catch (e) {}
                });
                request.done(function (probe) {
                    untrackRequest();
                    if (!session.alive || !fileScope.isAlive()) return;
                    var tracks = normalizeAudioTracks(probe);
                    if (!tracks.length) { fail('В файле не найдены аудиодорожки'); return; }
                    session.probeInfo[id] = probe;
                    session.probes[id] = tracks;
                    done(tracks);
                }).fail(function (xhr, status, error) {
                    untrackRequest();
                    if (!session.alive || !fileScope.isAlive()) return;
                    var code = Number(xhr && xhr.status) || 0;
                    var response = String(xhr && xhr.responseText || '');
                    var deterministic = (code >= 400 && code < 500) || /unsupported container/i.test(response);
                    warn('playback', 'probeFile: GST probe failed', { file: file.path, attempt: attempt, status: status, code: code, error: error, response: response });
                    if (attempt < 2 && !deterministic) {
                        updatePreparation(session, 'probing', 'Повторный анализ аудиодорожек…');
                        fileScope.setTimeout(run, 1200);
                        return;
                    }
                    fail(deterministic ? 'Формат файла не поддерживается GStreamer' : 'Не удалось получить дорожки файла');
                });
            } catch (e) {
                warn('playback', 'probeFile: GST probe threw', e);
                if (attempt < 2) {
                    fileScope.setTimeout(run, 1200);
                } else fail('Не удалось получить дорожки файла');
            }
        }
        run();
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
        // Release identity, not Jackett's /dl URL: that URL can change between searches for the same torrent.
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

    // Not Lampa.Torserver.hash: this Lampa build sends its JSON payload as application/x-www-form-urlencoded, which TorrServer's endpoint rejects — same payload shape, sent with the correct content type ourselves.
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
            updatePreparation(session, 'metadata', 'Получение списка файлов…');
            pollFiles(session);
        }

        function addTorrent() {
            if (!session.alive) return;
            log('playback', 'registerTorrent: добавляю новый торрент (' + source + ')');
            updatePreparation(session, 'registering', source === 'torrent-link' ? 'Загрузка torrent-файла…' : 'Подключение к раздаче…');
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
                        updatePreparation(session, 'metadata', 'Получение списка файлов…');
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
            // Fallback for a fresh profile/cleared storage/changed URL token; matches native-screen torrents too via the title without the [LAMPA] prefix.
            $.ajax({
                url: base + '/torrents',
                method: 'POST',
                contentType: 'application/json',
                data: JSON.stringify({ action: 'list' }),
                dataType: 'json',
                timeout: 5000
            }).done(function (list) {
                if (!session.alive) return;
                var plainTitle = title.replace(/^\[LAMPA\]\s*/i, '');
                var found = (Array.isArray(list) ? list : []).filter(function (entry) {
                    var entryTitle = String(entry && entry.title || '');
                    return entry && entry.hash && (entryTitle === title || entryTitle === plainTitle || entryTitle.replace(/^\[LAMPA\]\s*/i, '') === plainTitle);
                })[0];
                if (found) { log('playback', 'registerTorrent: найден уже зарегистрированный торрент по списку'); useRegisteredHash(found.hash); }
                else onMissing();
            }).fail(function () { if (session.alive) onMissing(); });
        }

        var knownHash = readRegisteredHash(item);
        if (knownHash) {
            log('playback', 'registerTorrent: проверяю кэшированный hash ' + knownHash);
            // Validated, not blindly reused: a TorrServer restart can invalidate a cached hash.
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

    // Mirrors native files() polling (torrent.js:149-169, 2s interval) up to file_stats resolving.
    function pollFiles(session) {
        var attempts = 0;
        var maxAttempts = 45;
        log('playback', 'pollFiles: старт опроса метаданных, hash=' + session.hash);
        updatePreparation(session, 'metadata', 'Получение списка файлов…');
        session.filesDeadline = session.scope.setTimeout(function () {
            if (!session.alive || session.bestFile) return;
            clearInterval(session.filesTimer);
            session.filesTimer = null;
            warn('playback', 'pollFiles: metadata не пришли за отведённое время, hash=' + session.hash);
            notify('Не удалось получить файлы раздачи');
            session.dispose();
        }, maxAttempts * 2000 + 2500);
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
                    clearTimeout(session.filesDeadline);
                    session.filesTimer = null;
                    session.filesDeadline = null;
                    log('playback', 'pollFiles: метаданные получены, попытка ' + attempts + ', файлов=' + plays.length);
                    session.allFiles = stats;
                    try { Lampa.Torserver.clearFileName(plays); } catch (e) {}
                    session.files = plays;
                    pickBestFile(session);
                });
            } catch (e) { warn('playback', 'pollFiles: Torserver.files бросил', e); }
            if (attempts >= maxAttempts) {
                clearInterval(session.filesTimer);
                session.filesTimer = null;
            }
        }
        session.filesTimer = session.scope.setInterval(attempt, 2000);
        // Called immediately, not after the first interval: metadata is usually already there when action:add returns.
        attempt();
    }

    function pickBestFile(session) {
        if (!session.alive || session.clicked || !session.files || !session.files.length) return;
        session.bestFile = pickBestPlayableFile(session.files, session.target, parseSignals);
        if (!session.bestFile) return;
        log('playback', 'pickBestFile: выбран файл "' + session.bestFile.path + '"', {
            mode: session.mode,
            torrent: session.item.title,
            size: session.bestFile.length || session.bestFile.size || 0,
            target: session.mode === MODE_SERIES ? {
                season: session.target.season,
                episode: session.target.episode
            } : null,
            pathLayout: session.mode === MODE_SERIES ? parseSeriesFileLayout(session.bestFile) : null
        });
        updatePreparation(session, 'probing', 'Анализ аудиодорожек…');
        // Silent nudge: ask TorrServer to start filling this file's cache while GST probes it.
        firePreload(preloadUrlFor(session.bestFile, session.hash));
        prepareTransport(session, session.bestFile, 0, function (transport) {
            if (!session.alive) return;
            session.activeFile = session.bestFile;
            session.activeAudioIndex = transport.audioIndex;
            updatePreparation(session, 'starting', 'Запуск воспроизведения…');
            startGstPlayback(session);
        }, function (message) {
            if (!session.alive) return;
            warn('playback', 'pickBestFile: preflight failed', { file: session.bestFile.path, message: message });
            notify(message + '. Проверьте GStreamer и повторите запуск');
            session.dispose();
        });
    }

    // All playable files of the pack, mirroring native torrent.js:415-429 — this is what powers "next episode" via Video.ended -> Playlist.next().
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
                activateFileScope(session, file);
                session.activeFile = file;
                session.activeAudioIndex = transport.audioIndex;
                startPlaybackHealth(session, file);
                startNextEpisodePreload(session);
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
                    activateFileScope(session, file);
                    session.activeFile = file;
                    session.activeAudioIndex = transport.audioIndex;
                    startPlaybackHealth(session, file);
                    startNextEpisodePreload(session);
                };
                continuePlayback();
                // Cleared next tick, not synchronously: Lampa's callback destroys and recreates the Player synchronously, and the session must stay alive through that destroy event.
                session.scope.setTimeout(function () { session.playlistTransition = false; }, 0);
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
            session.scope.track(detachPlayerLifecycle.bind(null, session));
        } catch (e) {}
    }

    function startPlaybackHealth(session, file) {
        if (session.healthCleanup) session.healthCleanup();
        if (!session.alive || !file) return;
        var fileScope = activateFileScope(session, file);
        var shell;
        try { shell = Lampa.Player.render(); } catch (e) { return; }
        if (!shell || !shell.find) return;

        var indicator = $('<div class="torrent-mod-playback-health torrent-mod-playback-health--unknown"><span></span><span></span><span></span><span></span><span></span></div>');
        var nativePieces = shell.find('.value--pieces');
        nativePieces.after(indicator);
        shell.addClass('torrent-mod-health-active');

        var request = null;
        var cache = null;
        var smoothSpeed = null;
        var sampledAt = 0;
        var stopped = false;
        var interval = null;
        var untrackCleanup = null;

        function renderHealth() {
            if (stopped || !session.alive || !fileScope.isAlive()) return;
            var video = null;
            try { video = Lampa.PlayerVideo.video(); } catch (e) {}
            var browserSeconds = browserBufferSeconds(video);
            var probe = session.probeInfo[String(file.id)] || {};
            var duration = probeDurationSeconds(probe);
            var expected = expectedSourcePiece(cache, session.allFiles, file, video && video.currentTime, duration, browserSeconds);
            var source = torrentBuffer(cache, expected);
            var bitrate = sourceBitrateBps(probe, file);
            var sourceSeconds = bitrate ? source.bytes * 8 / bitrate : 0;
            var health = assessPlaybackHealth({
                browserSeconds: browserSeconds,
                sourceSeconds: sourceSeconds,
                sourceBitrateBps: bitrate,
                downloadBps: smoothSpeed,
                readyState: video && video.readyState,
                paused: video && video.paused,
                hasHeartbeat: !!cache
            });
            indicator.removeClass('torrent-mod-playback-health--unknown torrent-mod-playback-health--good torrent-mod-playback-health--warning torrent-mod-playback-health--critical');
            indicator.addClass('torrent-mod-playback-health--' + health.state);
            var label = playbackHealthLabel(health);
            var filled = playbackHealthDotCount(health);
            try { indicator.attr('title', label).attr('aria-label', label); } catch (e) {}
            for (var i = 1; i < 5; i++) indicator.find('span').eq(i).toggleClass('active', i < filled);
        }

        function poll() {
            renderHealth();
            if (request || stopped) return;
            var base = torrServerBase();
            if (!base || !session.hash) return;
            request = $.ajax({
                url: base + '/gst/' + encodeURIComponent(session.hash) + '/heartbeat',
                method: 'GET',
                dataType: 'json',
                timeout: 2500
            }).done(function (data) {
                if (stopped || !fileScope.isAlive()) return;
                cache = data || {};
                var torrent = cache.Torrent || cache.torrent || {};
                var rawSpeed = Number(torrent.download_speed || torrent.DownloadSpeed || 0) * 8;
                var now = Date.now();
                smoothSpeed = smoothDownloadBps(smoothSpeed, rawSpeed, sampledAt ? (now - sampledAt) / 1000 : 2);
                sampledAt = now;
                renderHealth();
            }).always(function () { request = null; });
        }

        function cleanup() {
            if (stopped) return;
            stopped = true;
            if (request && request.abort) {
                try { request.abort(); } catch (e) {}
            }
            request = null;
            if (interval) clearInterval(interval);
            interval = null;
            try { indicator.remove(); } catch (e) {}
            try { shell.removeClass('torrent-mod-health-active'); } catch (e) {}
            if (session.healthCleanup === cleanup) session.healthCleanup = null;
            if (untrackCleanup) {
                var untrack = untrackCleanup;
                untrackCleanup = null;
                untrack();
            }
        }

        session.healthCleanup = cleanup;
        untrackCleanup = fileScope.track(cleanup);
        interval = setInterval(poll, 2000);
        if (interval && interval.unref) interval.unref();
        poll();
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
        var fileScope = activateFileScope(session, session.activeFile);
        var settled = false;
        var timer = null;
        var untrackCleanup = null;
        function cleanup() {
            if (untrackCleanup) {
                var untrack = untrackCleanup;
                untrackCleanup = null;
                untrack();
            }
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
            untrackCleanup = fileScope.track(cleanup);
            timer = fileScope.setTimeout(function () { finish(false); }, 70000);
        } catch (e) { finish(false); }
    }

    function restartGstPlayback(session, file) {
        // No source-replace API: close() destroys the old video synchronously; the switching guard keeps the session alive until the new Player is created.
        try { Lampa.Player.close(); } catch (e) {}
        if (!session.alive) return;
        session.clicked = false;
        watchTrackSwitch(session);
        startGstPlayback(session);
    }

    // Mirrors the data shape the native screen builds for a file element (torrent.js:336-350).
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

        // Captured before the preparation shell mounts: reading Controller.enabled() here would return PREPARING_CONTROLLER instead of the screen Back should actually return to.
        var backController = session.backController || 'content';

        var started = false;
        var cancelHandoff = handoffPreparationShell(session);
        try { Lampa.Player.play(data); started = true; } catch (e) { warn('playback', 'startGstPlayback: Player.play failed', e); }
        if (!started) {
            cancelHandoff();
            closePreparationShell(session, false);
            notify('Не удалось открыть плеер');
            try { Lampa.Controller.toggle(backController); } catch (e) {}
            session.dispose();
            return;
        }
        session.phase = 'started';
        startPlaybackHealth(session, file);
        try { Lampa.Player.callback(function () { Lampa.Controller.toggle(backController); }); } catch (e) {}
        try { startNextEpisodePreload(session); } catch (e) {}
        // Not on audio-switch or the playlist's own destroy->play transition — only when the player itself actually goes away.
        bindPlayerLifecycle(session);
    }

    // Silent cache warm-up for the next file near the end of the current one (docs/adr/0003-no-global-player-patching.md); listeners live on the file scope so an episode switch clears them without ending the Player session.
    function startNextEpisodePreload(session) {
        if (session.nextEpisodeCleanup) session.nextEpisodeCleanup();
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

        var fileScope = activateFileScope(session, currentFile);
        var fired = false;
        var untrackCleanup = null;
        function cleanup() {
            if (untrackCleanup) {
                var untrack = untrackCleanup;
                untrackCleanup = null;
                untrack();
            }
            try { Lampa.PlayerVideo.listener.remove('timeupdate', onTime); } catch (e6) {}
            try { Lampa.Player.listener.remove('destroy', onPlayerDestroy); } catch (e7) {}
            if (session.nextEpisodeCleanup === cleanup) session.nextEpisodeCleanup = null;
        }
        function onTime(e) {
            if (!session.alive || !fileScope.isAlive() || fired || !e || !(e.duration > 0)) return;
            var current = e.current || 0;
            var remaining = e.duration - current;
            if (remaining > 0 && (current >= e.duration * 0.85 || remaining <= 60)) {
                fired = true;
                cleanup();
                log('playback', 'startNextEpisodePreload: прогреваю следующий файл "' + next.path + '"');
                firePreload(preloadUrlFor(next, session.hash));
            }
        }
        function onPlayerDestroy() { cleanup(); }
        try { Lampa.PlayerVideo.listener.follow('timeupdate', onTime); } catch (e2) {}
        try { Lampa.Player.listener.follow('destroy', onPlayerDestroy); } catch (e5) {}
        session.nextEpisodeCleanup = cleanup;
        untrackCleanup = fileScope.track(cleanup);
    }

    function createSession(item, target) {
        var scope = createLifecycle();
        var session = {
            id: ++sessionSeq,
            scope: scope,
            fileScope: null,
            fileScopeId: '',
            mode: target.mode || MODE_SERIES,
            hash: '',
            item: item,
            target: target,
            backController: previousController() || 'content',
            phase: 'created',
            cancelled: false,
            preparationShell: null,
            preparationOverlay: null,
            preparationMounted: false,
            files: [],
            allFiles: [],
            bestFile: null,
            activeFile: null,
            activeAudioIndex: null,
            probes: {},
            probeInfo: {},
            transports: {},
            missingPreferenceByFile: {},
            audioPreference: null,
            pendingAudioPreference: null,
            switching: false,
            playlistTransition: false,
            playerCleanup: null,
            clicked: false,
            filesTimer: null,
            filesDeadline: null,
            nextEpisodeCleanup: null,
            healthCleanup: null,
            dispose: function () {
                scope.dispose(function () {
                    session.filesTimer = null;
                    session.filesDeadline = null;
                    session.fileScope = null;
                    session.nextEpisodeCleanup = null;
                    if (currentSession === session) currentSession = null;
                });
            }
        };
        Object.defineProperty(session, 'alive', { get: function () { return scope.isAlive(); } });
        session.audioPreference = readAudioPreference(session);
        return session;
    }

    export function startDownload(item, target) {
        log('playback', 'startDownload: "' + item.title + '" (' + item.tracker + ', ' + item.seeders + ' сидов), mode=' + (target && target.mode));
        // Disposed, not left running: every async callback checks session.alive, so a stale session's late /files response can't start the wrong torrent.
        if (currentSession) { log('playback', 'startDownload: отменяю предыдущую незавершённую сессию #' + currentSession.id); currentSession.dispose(); }

        notify((item.tracker || 'Torrent Mod') + ' · ' + item.seeders + ' сидов');
        var session = createSession(item, target);
        currentSession = session;
        openPreparationShell(session);
        registerTorrent(session);
    }
