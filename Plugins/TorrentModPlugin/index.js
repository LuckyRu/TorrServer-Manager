    import { VERSION, hubBase } from './shared/state.js';
    import { addCardButton } from './ui/card-button.js';
    import { addSettings } from './ui/settings.js';
    import { addStyles } from './ui/styles.js';
    import { TorrentModComponent } from './ui/torrent-mod-component.js';
    import { log, applyDebugSetting } from './shared/core/log.js';
    import { startRemoteLog } from './shared/core/remote-log.js';
    import { clientId } from './playback/client-identity.js';
    import { describeEnvironment } from './shared/device-environment.js';
    import { traceNativeAudioTracks } from './playback/audio-track-trace.js';
    import { enabled } from './shared/utils.js';

    function main() {
        if (!window.Lampa || window.torrent_mod_ready) return;
        window.torrent_mod_ready = true;

        startRemoteLog({
            hubBase: hubBase,
            version: VERSION,
            client: clientId,
            isEnabled: function () { return enabled('torrent_mod_remote_log', true); },
            environment: describeEnvironment
        });
        if (enabled('torrent_mod_remote_log', true)) traceNativeAudioTracks();
        applyDebugSetting(enabled('torrent_mod_debug', false));
        addStyles();
        addSettings();
        Lampa.Template.add('torrent_mod', '<div></div>');
        Lampa.Component.add('torrent_mod', TorrentModComponent);
        Lampa.Listener.follow('full', addCardButton);
        try {
            Lampa.Storage.set('torrserver_gts', true);
            if (Lampa.Torserver && Lampa.Torserver.connected)
                Lampa.Torserver.connected(function () {}, function () {});
        } catch (e) {}
        log('boot', 'плагин загружен, версия ' + VERSION);
    }

    main();
