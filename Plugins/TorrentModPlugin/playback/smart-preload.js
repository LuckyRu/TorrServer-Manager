    // ---------- download + duration-aware smart preload ----------
    //
    // No global patching of Lampa.Player.play/Lampa.Torserver.stream — that would affect every
    // torrent screen in Lampa, not just this one, and is a reliable source of hard-to-debug
    // ordering bugs the moment more than one thing wants to react to playback start. Instead: we
    // already know the torrent's infohash from its own magnet (we picked it ourselves via search,
    // no need to intercept anything to learn it), so we can poll TorrServer's /cache for it
    // directly and independently of whatever the native file-list UI does. We listen to Lampa's
    // own 'torrent_file' event (listening is safe/composable — it's *patching a shared function*
    // that isn't), scoped to only react while `pendingPlayback` is set (i.e. only for downloads
    // *we* just started), auto-pick the right file by scoring season/episode signals in its path,
    // and just call the file's own native `hover:enter` once our duration-based buffer target is
    // ready — that's the real Lampa file click, so playback starts through the exact same path it
    // always would.
    import { parseSignals } from '../search/release-parsing.js';
    import { field, notify, previousController, formatSize } from '../shared/utils.js';

    var pendingPlayback = null;

    function extractInfoHash(magnet) {
        var match = String(magnet || '').match(/xt=urn:btih:([a-zA-Z0-9]+)/i);
        return match ? match[1].toLowerCase() : '';
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
        return score;
    }

    function maybeProceed(pending) {
        if (!pending || pending.clicked || !pending.bestFile) return;
        if (!pending.ready && !pending.timedOut) return;
        pending.clicked = true;
        cleanupSmartPreload(pending);
        try { pending.bestFile.item.trigger('hover:enter'); } catch (e) {}
        if (pendingPlayback === pending) pendingPlayback = null;
    }

    function pickBestFile(pending) {
        if (!pending || pending.clicked || !pending.fileItems.length) return;
        var scored = [];
        for (var i = 0; i < pending.fileItems.length; i++) {
            scored.push({ f: pending.fileItems[i], score: preloadFileScore(pending.fileItems[i].element, pending.target) });
        }
        scored.sort(function (a, b) { return b.score - a.score; });
        pending.bestFile = scored[0].f;
        maybeProceed(pending);
        probeRealTracks(pending);
    }

    // Confirms our title-guessed badges (resolution/codec/audio/subs, all regexed out of the
    // raздача name in parseRelease) against the *actual* file, the same way the MediaInfo plugin
    // does: TorrServer bundles ffprobe for its own transcoding support and exposes it at
    // /ffp/{hash}/{fileId} (confirmed by reading that plugin's own source — this is its whole job).
    // fileId comes from TorrServer's own /torrents listing, not DOM/array position — same lookup
    // MediaInfo itself does (its pickIndex() reads `.id` off that same list). Deliberately skips
    // that plugin's public "Tracks Inspector" fallback for when ffprobe isn't available locally —
    // it's a third-party service outside this project's own infrastructure, inconsistent with
    // keeping everything (Jackett, TorrServer) local/loopback-only; if /ffp/ 400s (no ffprobe on
    // this TorrServer build) we just stay quiet, same as the title-only badges already shown.
    function probeRealTracks(pending) {
        if (!pending || pending.probed || !pending.bestFile) return;
        var base = torrServerBase();
        if (!base) return;
        pending.probed = true;
        var wantPath = String((pending.bestFile.element && (pending.bestFile.element.path || pending.bestFile.element.title)) || '');
        if (!wantPath) return;
        $.ajax({
            url: base + '/torrents', method: 'POST',
            data: JSON.stringify({ action: 'get', hash: pending.hash }),
            dataType: 'json', timeout: 4000
        }).done(function (json) {
            var files = (json && json.file_stats) || [];
            var match = files.filter(function (f) { return f.path && wantPath.indexOf(f.path) >= 0; })[0];
            if (!match || match.id == null) return;
            $.ajax({ url: base + '/ffp/' + pending.hash + '/' + match.id, dataType: 'json', timeout: 6000 })
                .done(function (probe) {
                    var streams = probe && probe.streams;
                    if (!streams || !streams.length || pending.clicked) return;
                    var video = streams.filter(function (s) { return s.codec_type === 'video'; })[0];
                    var audio = streams.filter(function (s) { return s.codec_type === 'audio'; });
                    var subs = streams.filter(function (s) { return s.codec_type === 'subtitle'; });
                    var bits = [];
                    if (video) bits.push((video.height ? video.height + 'p' : '') + (video.codec_name ? ' ' + video.codec_name.toUpperCase() : ''));
                    if (audio.length) bits.push(audio.length + ' ауд.дорожек');
                    if (subs.length) bits.push(subs.length + ' субтитров');
                    bits = bits.filter(Boolean);
                    if (bits.length && pending.html) {
                        pending.html.find('.torrent-mod-preload__title').text('Подтверждено ffprobe: ' + bits.join(' · '));
                    }
                }).fail(function () {});
        }).fail(function () {});
    }

    export function onTorrentFile(event) {
        if (!event || !pendingPlayback) return;
        var pending = pendingPlayback;
        if (event.type === 'list_open') {
            pending.fileItems = [];
        } else if (event.type === 'render' && pending.fileItems) {
            pending.fileItems.push({ element: event.element, item: event.item });
            clearTimeout(pending.renderDebounce);
            pending.renderDebounce = setTimeout(function () { pickBestFile(pending); }, 150);
        }
    }

    function cleanupSmartPreload(pending) {
        clearInterval(pending.pollTimer);
        clearInterval(pending.clockTimer);
        clearTimeout(pending.renderDebounce);
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
            if ((Date.now() - pending.started) / 1000 >= timeoutSeconds) {
                pending.timedOut = true;
                maybeProceed(pending);
            }
        }, 1000);

        var base = torrServerBase();
        pending.pollTimer = setInterval(function () {
            if (!base || pending.clicked) return;
            $.ajax({
                url: base + '/cache',
                method: 'POST',
                data: JSON.stringify({ action: 'get', hash: pending.hash }),
                dataType: 'json',
                timeout: 2500
            }).done(function (response) {
                if (pending.clicked) return;
                var data = response && (response.Torrent || response);
                if (!data) return;
                var loaded = parseFloat(data.preloaded_bytes) || 0;
                var speed = parseFloat(data.download_speed) || 0;
                var seeds = parseInt(data.connected_seeders, 10) || 0;
                var peers = parseInt(data.active_peers, 10) || 0;
                var percent = pending.targetBytes ? Math.min(100, loaded * 100 / pending.targetBytes) : 0;
                html.find('.torrent-mod-preload__percent').text(Math.round(percent) + '%');
                html.find('.torrent-mod-preload__bar > div').css('width', percent + '%');
                html.find('.torrent-mod-preload__stats').text(
                    formatSize(loaded) + ' / ' + formatSize(pending.targetBytes) +
                    ' · ' + formatSize(speed) + '/с · сиды ' + seeds + ' · пиры ' + peers
                );
                // Already downloading faster than real-time playback needs — safe to start now
                // even short of the nominal buffer target, it won't be outrun.
                var speedMbps = speed * 8 / 1000000;
                var keepsUpWithPlayback = pending.bitrateMbps > 0 && speed > 0 && speedMbps >= pending.bitrateMbps * 0.9;
                if (loaded >= pending.targetBytes || keepsUpWithPlayback) {
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

    export function startDownload(item, target) {
        notify((item.tracker || 'Torrent Mod') + ' · ' + item.seeders + ' сидов');
        var hash = extractInfoHash(item.magnet);
        var bitrateMbps = item.bitrateMbps || 3;
        var timeoutSeconds = parseInt(field('torrent_mod_preload_timeout', '60'), 10) || 60;
        var leadSeconds = 25;
        var targetBytes = (bitrateMbps * 1000000 / 8) * leadSeconds;

        Lampa.Torrent.start({
            Title: item.title,
            title: item.title,
            MagnetUri: item.magnet,
            Link: item.link,
            poster: (target.movie && (target.movie.img || target.movie.poster_path)) || ''
        }, target.movie);

        if (!hash) return; // can't poll /cache without a hash — let native flow run unassisted

        pendingPlayback = {
            hash: hash,
            item: item,
            target: target,
            bitrateMbps: bitrateMbps,
            targetBytes: targetBytes,
            timeoutSeconds: timeoutSeconds,
            fileItems: [],
            started: Date.now(),
            clicked: false,
            ready: false,
            timedOut: false,
            probed: false
        };
        showSmartPreload(pendingPlayback);
    }
