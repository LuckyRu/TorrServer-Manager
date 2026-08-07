    // ---------- card button ----------
    import { VERSION } from './state.js';
    import { initialSeason, openTarget } from './season-picker.js';
    import { enabled, previousController } from './utils.js';

    export function addCardButton(event) {
        if (!event || event.type !== 'complite' || !enabled('torrent_mod_enabled', true)) return;
        var movie = event.data && event.data.movie;
        if (!movie) return;
        var activity = event.object && event.object.activity && event.object.activity.render();
        if (!activity || activity.find('.view--torrent-mod').length) return;

        var button = $('<div class="full-start__button selector view--torrent-mod" data-subtitle="v' + VERSION + '">' +
            '<svg viewBox="0 0 64 64" width="34" height="34"><path fill="currentColor" d="M32 4a28 28 0 100 56 28 28 0 000-56zm0 8a20 20 0 110 40 20 20 0 010-40zm0 8a12 12 0 100 24 12 12 0 000-24z"/></svg>' +
            '<span>Torrent Mod</span></div>');
        button.on('hover:enter', function () {
            openTarget(movie, initialSeason(movie), previousController());
        });

        var reference = activity.find('.view--torrent').last();
        if (reference.length) reference.after(button);
        else activity.find('.full-start__buttons').append(button);
    }
