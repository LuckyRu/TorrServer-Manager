// Diagnostics for the audio-track menu on the TV, where choosing a translation silenced the video
// and never reached our onSelect. Logs only; nothing here changes what Lampa or the video do.
import { log, warn } from '../shared/core/log.js';

var menuLoggedAt = 0;

function shortStack(error) {
    return String(error && error.stack || '').split('\n').slice(2, 8).map(function (line) {
        return line.trim().replace(/\(?(?:https?|file):\/\/[^)\s]*\/([^/)\s]+)\)?/g, '$1');
    }).join(' | ');
}

// Lampa's menu writes title on every item when it opens and enabled on the chosen one before it
// calls onSelect: accessors on our own items show which of the two ever happens.
export function traceMenuItem(item) {
    var title = '';
    var enabled = false;
    Object.defineProperty(item, 'title', {
        enumerable: true,
        configurable: true,
        get: function () { return title; },
        set: function (value) {
            title = value;
            if (Date.now() - menuLoggedAt > 2000) {
                menuLoggedAt = Date.now();
                log('playback', 'меню дорожек Lampa собрано из нашего списка');
            }
        }
    });
    Object.defineProperty(item, 'enabled', {
        enumerable: true,
        configurable: true,
        get: function () { return enabled; },
        set: function (value) {
            enabled = value;
            if (value) log('playback', 'меню дорожек: Lampa отметила наш пункт ' + item.index + ' (' + item.label + ')');
        }
    });
    return item;
}

// Who switches the video's own audio off. The stack names the Lampa function that did it.
export function traceNativeAudioTracks() {
    if (typeof AudioTrack === 'undefined' || !AudioTrack.prototype) return;
    var descriptor = Object.getOwnPropertyDescriptor(AudioTrack.prototype, 'enabled');
    if (!descriptor || !descriptor.set || !descriptor.configurable) return;
    Object.defineProperty(AudioTrack.prototype, 'enabled', {
        configurable: true,
        enumerable: descriptor.enumerable,
        get: descriptor.get,
        set: function (value) {
            try {
                warn('playback', 'родная дорожка видео id=' + this.id + ' label=' + this.label + ': enabled = ' + value, shortStack(new Error()));
            } catch (e) {}
            return descriptor.set.call(this, value);
        }
    });
}
