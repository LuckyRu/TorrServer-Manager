    // ---------- download + duration-aware smart preload (direct playback, no native torrent UI) ----------
    //
    // Plays through the SAME public Lampa APIs the native torrent screen uses, but WITHOUT opening
    // that screen at all (the user already picked a series — being dumped into Lampa's native
    // "choose a file" list is exactly what this module exists to prevent). Pipeline, as designed
    // by the architect (see docs/system-design/torrent-mod-unified-pool.md, «прямой путь»):
    //
    //   Lampa.Torserver.hash(...)          register the torrent (magnet or .torrent link)
    //     → Torserver.files(hash)          poll until TorrServer resolves metadata → file_stats
    //     → pickBestFile()                 score season/episode signals in file paths (ours)
    //     → Torserver.stream(path,hash,id) official stream URL (never invent our own)
    //     → Lampa.Player.play({url, timeline, playlist})
    //
    // Three native side effects of the old Lampa.Torrent.start path are compensated here explicitly
    // (native torrent.js used to do them on hover:enter — torrent.js:437/333/446):
    //   1. Favorite.add('history', movie)   — continue-watch card
    //   2. timeline: Timeline.view(parsed.hash) — per-episode watch history (parsed via
    //      Torserver.parse, which produces the SAME hash Timeline.watchedEpisode reads; this is NOT
    //      the torrent infohash)
    //   3. data.playlist from all playable files of the pack — next-episode inside a season pack
    //      (Player.play sets Playlist from data.playlist, player.js:1243)
    //
    // Still no global patching of Lampa.Player.play / Lampa.Torserver.stream (ADR-0003): we call
    // the public APIs with explicit arguments, we don't wrap them.
    import { parseSignals } from '../search/release-parsing.js';
    import { field, notify, previousController, formatSize } from '../shared/utils.js';

    var pendingPlayback = null;

    var LEAD_SECONDS = 25;

    var PLAYABLE_FORMATS = ['asf', 'wmv', 'divx', 'avi', 'mp4', 'm4v', 'mov', '3gp', '3g2', 'mkv', 'trp', 'tp', 'mts', 'mpg', 'mpeg', 'dat', 'vob', 'rm', 'rmvb', 'm2ts', 'ts'];

    function isPlayableFile(file) {
        var exe = String((file && file.path) || '').split('.').pop().toLowerCase();
        return PLAYABLE_FORMATS.indexOf(exe) >= 0;
    }

    // Bytes of the SELECTED file's buffer actually downloaded, computed from TorrServer /cache's
    // per-piece bitmap (Pieces: {index → {Completed}}) restricted to the file's own piece range
    // [fileStart, fileEnd). Counting the whole torrent's preloaded_bytes was the bug: other files
    // ("левые места") inflated readiness while the needed series had nothing. Continuous-from-start
    // only — playback starts at the beginning of the file, so a completed piece further into the
    // file (e.g. preloaded tail for seeking) must not count as buffer. Each piece contributes only
    // its INTERSECTION with [fileStart, fileEnd) — a piece straddling the file's start boundary is
    // not counted whole (found by the architect).
    export function fileLoadedBytes(pieces, pieceLength, fileStart, fileEnd) {
        if (!pieces || !(pieceLength > 0) || fileStart == null || !(fileEnd > fileStart)) return 0;
        var start = Math.floor(fileStart / pieceLength);
        var end = Math.ceil(fileEnd / pieceLength);
        var loaded = 0;
        for (var p = start; p < end; p++) {
            var piece = pieces[p];
            if (!piece || !piece.Completed) break;
            var pieceStart = p * pieceLength;
            var pieceEnd = pieceStart + pieceLength;
            loaded += Math.min(pieceEnd, fileEnd) - Math.max(pieceStart, fileStart);
        }
        return loaded;
    }

    function torrServerBase() {
        try { if (Lampa.Torserver && Lampa.Torserver.ip) return String(Lampa.Torserver.ip() || '').replace(/\/$/, ''); } catch (e) {}
        return '';
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
        // WMV/RM/FLV) that WebOS can't play without TorrServer transcoding (architect's Etap:
        // «древние торренты»). Extension is a heuristic, not proof — small weights on purpose.
        var ext = path.toLowerCase().split('.').pop();
        if (['mp4', 'mkv', 'm4v', 'mov', 'webm', 'ts', 'm2ts', 'mts'].indexOf(ext) >= 0) score += 5;
        else if (['avi', 'mpg', 'mpeg', 'vob', 'wmv', 'asf', 'flv', 'rm', 'rmvb', 'divx'].indexOf(ext) >= 0) score -= 5;
        return score;
    }

    function maybeProceed(pending) {
        if (!pending || pending.clicked) return;
        if (!pending.ready && !pending.timedOut) return;
        pending.clicked = true;
        cleanupSmartPreload(pending);
        if (pending.bestFile) {
            startDirectPlayback(pending);
        } else {
            // Timed out or force-played, but no file ever got picked (metadata never resolved —
            // dead/stalled magnet or genuinely zero peers). There is deliberately no native file
            // screen to fall back to; say so explicitly and leave the user with Отмена (the
            // overlay is gone by now, they are back on the results screen).
            notify(pending.error || 'Не удалось определить файл автоматически');
        }
        if (pendingPlayback === pending) pendingPlayback = null;
    }

    // Picks the best playable file from the metadata TorrServer has resolved (file_stats), scoring
    // season/episode signals in the file path like before — just from the API response instead of
    // the native screen's torrent_file events. Once a file is chosen we explicitly KICK OFF the
    // file preload (see initiatePreload) — /cache polling alone only reads state, it never starts
    // the download (the native screen used to do it via its own preload() on hover:enter; losing
    // that request in the direct-playback rewrite was the root cause of the "0%, nothing loads"
    // report, found by the architect).
    function pickBestFile(pending) {
        if (!pending || pending.clicked || !pending.files || !pending.files.length) return;
        var scored = [];
        for (var i = 0; i < pending.files.length; i++) {
            scored.push({ f: pending.files[i], score: preloadFileScore(pending.files[i], pending.target) });
        }
        scored.sort(function (a, b) { return b.score - a.score; });
        pending.bestFile = scored[0].f;
        // Byte range of the picked file inside the torrent — computed over the FULL file_stats
        // (subtitles, samples, junk included!), matched by file id. Summing only playable files
        // shifted the range and made readiness wrong (found by the architect).
        var allFiles = pending.allFiles || [];
        var offset = 0;
        var foundId = String(pending.bestFile.id);
        for (var j = 0; j < allFiles.length; j++) {
            if (String(allFiles[j].id) === foundId) break;
            offset += parseInt(allFiles[j].length, 10) || 0;
        }
        pending.fileStart = offset;
        pending.fileLength = parseInt(pending.bestFile.length, 10) || 0;
        pending.fileEnd = offset + pending.fileLength;
        if (pending.fileLength > 0) pending.targetBytes = Math.min(pending.targetBytes, pending.fileLength);
        initiatePreload(pending);
        probeRealTracks(pending);
        maybeProceed(pending);
    }

    // The stream URL built by Lampa.Torserver.stream() ends with `&play` (or `&preload` when the
    // torrserver_preload setting is on). The `&preload` variant is the actual "start filling the
    // cache" command for TorrServer — the native screen fired it first, then polled `&stat`
    // (torrent.js preload(), 258-309). We fire it on pick and re-fire it (throttled) while the
    // selected file's buffer stays empty, because TorrServer may download other files in its own
    // order. Fire-and-forget: the response body is a long-lived stream, so we resolve on headers
    // (fetch) and never read/abort it (a short $.ajax timeout used to kill the request).
    // Deliberately only swaps the play→preload parameter of the OFFICIAL URL (no invented endpoints).
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

    function initiatePreload(pending) {
        if (!pending || !pending.bestFile || !pending.hash || pending.clicked) return;
        var now = Date.now();
        if (now - (pending.lastPreloadAt || 0) < 8000) return; // throttled
        if ((pending.preloadAttempts || 0) >= 5) return;
        var base = torrServerBase();
        if (!base) return;
        pending.lastPreloadAt = now;
        pending.preloadAttempts = (pending.preloadAttempts || 0) + 1;
        firePreload(preloadUrlFor(pending.bestFile, pending.hash));
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

    // Confirms our title-guessed badges (resolution/codec/audio/subs, all regexed out of the
    // raздача name in parseRelease) against the *actual* file, the same way the MediaInfo plugin
    // does: TorrServer bundles ffprobe for its own transcoding support and exposes it at
    // /ffp/{hash}/{fileId} (confirmed by reading that plugin's own source — this is its whole job).
    // fileId comes from TorrServer's own file_stats, not DOM/array position. Deliberately skips
    // that plugin's public "Tracks Inspector" fallback for when ffprobe isn't available locally —
    // it's a third-party service outside this project's own infrastructure, inconsistent with
    // keeping everything (Jackett, TorrServer) local/loopback-only; if /ffp/ 400s (no ffprobe on
    // this TorrServer build) we just stay quiet, same as the title-only badges already shown.
    function probeRealTracks(pending) {
        if (!pending || pending.probed || !pending.bestFile) return;
        var base = torrServerBase();
        if (!base) return;
        pending.probed = true;
        $.ajax({
            url: base + '/torrents', method: 'POST',
            data: JSON.stringify({ action: 'get', hash: pending.hash }),
            dataType: 'json', timeout: 4000
        }).done(function (json) {
            var files = (json && json.file_stats) || [];
            // Match by exact file id, not a path substring (substring matching could grab the wrong
            // file) — found by the architect.
            var match = files.filter(function (f) { return String(f.id) === String(pending.bestFile.id); })[0];
            if (!match || match.id == null) return;
            $.ajax({ url: base + '/ffp/' + pending.hash + '/' + match.id, dataType: 'json', timeout: 6000 })
                .done(function (probe) {
                    var streams = probe && probe.streams;
                    if (!streams || !streams.length || pending.clicked) return;
                    var video = streams.filter(function (s) { return s.codec_type === 'video'; })[0];
                    var audio = streams.filter(function (s) { return s.codec_type === 'audio'; });
                    var subs = streams.filter(function (s) { return s.codec_type === 'subtitle'; });
                    var bits = [];
                    // Real container from ffprobe, when TorrServer exposes it (e.g. avi/matroska/mp4)
                    var formatName = probe && probe.format && (probe.format.format_name || probe.format.format);
                    if (formatName) bits.push(String(formatName).toUpperCase());
                    if (video) bits.push((video.height ? video.height + 'p' : '') + (video.codec_name ? ' ' + video.codec_name.toUpperCase() : ''));
                    if (audio.length) bits.push(audio.length + ' ауд.дорожек');
                    if (subs.length) bits.push(subs.length + ' субтитров');
                    bits = bits.filter(Boolean);
                    if (bits.length && pending.html) {
                        pending.html.find('.torrent-mod-preload__title').text('Подтверждено ffprobe: ' + bits.join(' · '));
                    }
                    // Real bitrate from the actual file (format.bit_rate, or size/duration) — far
                    // more accurate than the title-based estimate. Recompute the duration-based
                    // target from it (capped by the file size); the buffer usually takes seconds,
                    // ffprobe arrives in milliseconds, so this lands well before readiness.
                    var formatInfo = probe && probe.format;
                    var realBitrate = 0;
                    if (formatInfo) {
                        if (parseFloat(formatInfo.bit_rate) > 0) realBitrate = parseFloat(formatInfo.bit_rate) / 1000000;
                        else if (parseFloat(formatInfo.size) > 0 && parseFloat(formatInfo.duration) > 0) {
                            realBitrate = (parseFloat(formatInfo.size) * 8) / (parseFloat(formatInfo.duration) * 1000000);
                        }
                    }
                    if (realBitrate > 0) {
                        pending.effectiveBitrateMbps = realBitrate;
                        // Also update the keepUp comparison base — it compares download speed to
                        // pending.bitrateMbps, which stayed the title-based estimate otherwise
                        // (found by the architect).
                        pending.bitrateMbps = realBitrate;
                        var target = (realBitrate * 1000000 / 8) * LEAD_SECONDS;
                        if (pending.fileLength) target = Math.min(target, pending.fileLength);
                        pending.targetBytes = target;
                    }
                }).fail(function () {});
        }).fail(function () {});
    }

    function cleanupSmartPreload(pending) {
        clearInterval(pending.pollTimer);
        clearInterval(pending.clockTimer);
        clearInterval(pending.filesTimer);
        if (pending.html) pending.html.remove();
        try { Lampa.Controller.toggle(pending.previousController || 'content'); } catch (e) {}
    }

    function showSmartPreload(pending) {
        pending.previousController = previousController();
        var timeoutSeconds = pending.timeoutSeconds;
        var html = $([
            '<div class="torrent-mod-preload">',
            ' <div class="torrent-mod-preload__box">',
            '  <div class="torrent-mod-preload__title">Буферизация — под длительность просмотра, не под фиксированный размер</div>',
            '  <div class="torrent-mod-preload__percent">0%</div>',
            '  <div class="torrent-mod-preload__bar"><div></div></div>',
            '  <div class="torrent-mod-preload__stats">Подключение к раздаче…</div>',
            '  <div class="torrent-mod-preload__risk"></div>',
            '  <div class="torrent-mod-preload__buttons">',
            '   <div class="simple-button selector">Отмена</div>',
            '   <div class="simple-button selector">Смотреть сейчас</div>',
            '  </div>',
            ' </div>',
            '</div>'
        ].join(''));
        pending.html = html;
        var buttons = html.find('.simple-button');
        $('body').append(html);

        function cancel() {
            pending.clicked = true;
            cleanupSmartPreload(pending);
            if (pendingPlayback === pending) pendingPlayback = null;
            notify('Отменено');
        }
        function forcePlay() {
            pending.ready = true;
            maybeProceed(pending);
        }
        buttons.eq(0).on('hover:enter click', cancel);
        buttons.eq(1).on('hover:enter click', forcePlay);

        Lampa.Controller.add('torrent_mod_preload', {
            toggle: function () {
                Lampa.Controller.collectionSet(html);
                Lampa.Controller.collectionFocus(buttons.eq(1)[0], html);
            },
            left: function () { Navigator.move('left'); },
            right: function () { Navigator.move('right'); },
            up: function () { Navigator.move('up'); },
            down: function () { Navigator.move('down'); },
            back: cancel
        });
        Lampa.Controller.toggle('torrent_mod_preload');

        pending.clockTimer = setInterval(function () {
            var elapsed = (Date.now() - pending.started) / 1000;
            if (elapsed >= timeoutSeconds && pending.bestFile) {
                // Buffer target not met in time (or metadata was slow but a file IS picked) — start
                // playback anyway; the native path's own preload also gave up at a deadline.
                pending.timedOut = true;
                maybeProceed(pending);
            } else if (elapsed >= timeoutSeconds * 2) {
                // Double the budget when NO file has been picked yet: metadata for .torrent links can
                // legitimately take longer than the playback timeout, and force-playing without a
                // file is meaningless. After 2x give up with an honest error instead of an eternal
                // overlay (found by the architect: the single 60s timeout used to fire before
                // Torserver.files ever resolved, killing the whole flow).
                pending.timedOut = true;
                pending.error = 'Не удалось получить файлы раздачи';
                maybeProceed(pending);
            }
        }, 1000);

        var base = torrServerBase();
        pending.pollTimer = setInterval(function () {
            // /cache is meaningless until the hash is known (registration can take a moment for
            // .torrent links); skip ticks until then.
            if (!base || !pending.hash || pending.clicked) return;
            $.ajax({
                url: base + '/cache',
                method: 'POST',
                data: JSON.stringify({ action: 'get', hash: pending.hash }),
                dataType: 'json',
                timeout: 2500
            }).done(function (response) {
                if (pending.clicked) return;
                var root = response || {};
                var data = root.Torrent || root;
                if (!data) return;
                var speed = parseFloat(data.download_speed) || 0;
                var seeds = parseInt(data.connected_seeders, 10) || 0;
                var peers = parseInt(data.active_peers, 10) || 0;
                // Buffer of the SELECTED file only, via the /cache piece bitmap (root-level Pieces +
                // PiecesLength) restricted to the file's own byte range. Fallback to the whole
                // torrent's preloaded_bytes only when per-file geometry is unavailable. This is the
                // fix for "левые места качаются": other files used to inflate readiness.
                var loaded = fileLoadedBytes(root.Pieces, parseFloat(root.PiecesLength) || 0, pending.fileStart, pending.fileEnd);
                if (!loaded && (pending.fileStart == null || !root.Pieces)) {
                    loaded = parseFloat(data.preloaded_bytes) || 0;
                }
                var percent = pending.targetBytes ? Math.min(100, loaded * 100 / pending.targetBytes) : 0;
                html.find('.torrent-mod-preload__percent').text(Math.round(percent) + '%');
                html.find('.torrent-mod-preload__bar > div').css('width', percent + '%');
                html.find('.torrent-mod-preload__stats').text(
                    formatSize(loaded) + ' / ' + formatSize(pending.targetBytes) +
                    ' · ' + formatSize(speed) + '/с · сиды ' + seeds + ' · пиры ' + peers
                );
                // TorrServer may download other files in its own order — if the picked file's buffer
                // is still empty, nudge it again (throttled inside initiatePreload) instead of
                // waiting out the timeout.
                if (loaded === 0 && pending.hash && pending.bestFile && !pending.clicked) initiatePreload(pending);
                // Already downloading faster than real-time playback needs — safe to start EARLY.
                // The user reported the overlay vanishing instantly and the player buffering itself,
                // so this is no longer a single-tick check: "fast enough" must be BOTH a stable
                // speed (N consecutive ticks at >=90% of the needed bitrate — a 1-second spike from
                // peers joining proves nothing) AND a real chunk of the buffer already downloaded
                // (>=50% of the duration-based target, i.e. ~12s of playback buffer). A 100%-of-target
                // load still wins outright.
                var speedMbps = speed * 8 / 1000000;
                var keepsUp = pending.bitrateMbps > 0 && speed > 0 && speedMbps >= pending.bitrateMbps * 0.9;
                pending.keepUpTicks = keepsUp ? (pending.keepUpTicks || 0) + 1 : 0;
                var earlyButReal = pending.keepUpTicks >= 5 && loaded >= pending.targetBytes * 0.5;
                if (loaded >= pending.targetBytes || earlyButReal) {
                    pending.ready = true;
                    maybeProceed(pending);
                } else {
                    // Speed is holding well below what this bitrate needs, and enough time has
                    // passed to trust the reading (not just a slow start) — say so explicitly
                    // instead of quietly waiting out the timeout: a stall during playback is a
                    // worse experience than an honest heads-up now.
                    var elapsed = (Date.now() - pending.started) / 1000;
                    var risk = elapsed > 8 && pending.bitrateMbps > 0 && speed > 0 && speedMbps < pending.bitrateMbps * 0.5;
                    html.find('.torrent-mod-preload__risk').text(
                        risk ? 'Скорость закачки ниже битрейта — возможны остановки при просмотре' : ''
                    );
                }
            }).fail(function () {});
        }, 1000);
    }

    // Registers the torrent with TorrServer directly (POST /torrents action:add, same payload the
    // native screen sends — Torserver.hash). Accepts a magnet OR an HTTP .torrent link: TorrServer
    // downloads and parses the .torrent itself, so a hash arrives in both cases (no bencode parsing
    // on our side, and no need for the old resolveHashByTitle polling).
    function registerTorrent(pending) {
        var item = pending.item;
        var target = pending.target;
        function fail(message) {
            if (pending.clicked) return;
            pending.error = message;
            if (pending.html) pending.html.find('.torrent-mod-preload__title').text(message);
        }
        try {
            Lampa.Torserver.hash({
                title: item.title,
                link: item.magnet || item.link,
                poster: (target.movie && (target.movie.img || target.movie.poster_path)) || ''
            }, function (json) {
                if (pending.clicked) return;
                pending.hash = json && json.hash;
                if (pending.hash) pollFiles(pending);
                else fail('Не удалось получить hash раздачи');
            }, function () {
                fail('Не удалось зарегистрировать раздачу в TorrServer');
            });
        } catch (e) {
            fail('TorrServer недоступен');
        }
    }

    // Polls Torserver.files(hash) until metadata resolves (file_stats), then filters playable
    // files, enriches them with path_human (Torserver.clearFileName, required by Torserver.parse)
    // and picks the best one. Mirrors the native files() polling (torrent.js:149-169, 2s interval).
    function pollFiles(pending) {
        var attempts = 0;
        var maxAttempts = 45;
        pending.filesTimer = setInterval(function () {
            if (pending.clicked || pending.bestFile) { clearInterval(pending.filesTimer); return; }
            attempts++;
                try {
                    Lampa.Torserver.files(pending.hash, function (json) {
                        if (pending.clicked || pending.bestFile) return;
                        var stats = (json && json.file_stats) || [];
                        var plays = stats.filter(isPlayableFile);
                        if (!plays.length) {
                            if (attempts >= maxAttempts) {
                                clearInterval(pending.filesTimer);
                                pending.error = 'Не удалось получить файлы раздачи';
                                maybeProceed(pending);
                            }
                            return;
                        }
                        clearInterval(pending.filesTimer);
                        // Full file_stats (all files, not just playable) — the byte ranges of the
                        // picked file are computed over this (see pickBestFile).
                        pending.allFiles = stats;
                        try { Lampa.Torserver.clearFileName(plays); } catch (e) {}
                        pending.files = plays;
                        pickBestFile(pending);
                    });
                } catch (e) {}
            if (attempts >= maxAttempts) clearInterval(pending.filesTimer);
        }, 2000);
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
        var file = pending.bestFile;
        var target = pending.target;
        var movie = (target && target.movie) || {};
        var hash = pending.hash;
        if (!hash || !file) return;

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
    }

    export function startDownload(item, target) {
        // Found live during an independent review pass: nothing prevented a second startDownload()
        // call while an earlier one was still pending (not yet clicked) — an impatient double-pick
        // during the several-second Jackett search window is enough. Treat starting a new download
        // as implicitly cancelling whichever one was still pending, same as pressing Отмена would
        // have — tears its timers/overlay down before the new one starts fresh.
        if (pendingPlayback && !pendingPlayback.clicked) {
            pendingPlayback.clicked = true;
            cleanupSmartPreload(pendingPlayback);
        }

        notify((item.tracker || 'Torrent Mod') + ' · ' + item.seeders + ' сидов');
        var bitrateMbps = item.bitrateMbps || 3;
        var timeoutSeconds = parseInt(field('torrent_mod_preload_timeout', '60'), 10) || 60;
        var targetBytes = (bitrateMbps * 1000000 / 8) * LEAD_SECONDS;

        pendingPlayback = {
            hash: '',
            item: item,
            target: target,
            bitrateMbps: bitrateMbps,
            effectiveBitrateMbps: 0,
            targetBytes: targetBytes,
            timeoutSeconds: timeoutSeconds,
            files: [],
            allFiles: [],
            bestFile: null,
            fileStart: null,
            fileLength: 0,
            fileEnd: 0,
            preloadAttempts: 0,
            lastPreloadAt: 0,
            keepUpTicks: 0,
            started: Date.now(),
            clicked: false,
            ready: false,
            timedOut: false,
            probed: false,
            error: ''
        };
        showSmartPreload(pendingPlayback);
        registerTorrent(pendingPlayback);
    }
