    // Entry point — bundled by esbuild (see package.json's build:plugin script) into the single
    // classic script Lampa actually loads (no <script type="module"> — the target device is an LG
    // WebOS TV browser, not worth the module-loading risk there). Every other file in this folder
    // is a real ES module now; this one just wires the top-level registration together and guards
    // against double-injection the same way the plugin always has.
    import { VERSION } from './shared/state.js';
    import { addCardButton } from './ui/card-button.js';
    import { addSettings } from './ui/settings.js';
    import { addStyles } from './ui/styles.js';
    import { TorrentModComponent } from './ui/results-screen.js';

    function main() {
        if (!window.Lampa || window.torrent_mod_ready) return;
        window.torrent_mod_ready = true;

        addStyles();
        addSettings();
        Lampa.Template.add('torrent_mod', '<div></div>');
        Lampa.Component.add('torrent_mod', TorrentModComponent);
        Lampa.Listener.follow('full', addCardButton);
        console.log('Torrent Mod ' + VERSION + ': ready');
    }

    main();
