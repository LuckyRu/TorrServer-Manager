// ---------- GST audio track metadata and preference matching ----------
//
// TorrServer's /gst/:hash/probe response is the only authoritative mapping between a media file
// and the `audio=N` parameter accepted by its HLS endpoint. Keep parsing and preference matching
// pure: the player/session layer owns network requests and Lampa callbacks.

function value(raw, upper, lower) {
    if (!raw) return undefined;
    if (typeof raw[upper] !== 'undefined') return raw[upper];
    return raw[lower];
}

export function normalizeTrackName(value) {
    return String(value || '').toLowerCase().replace(/[^a-zа-яё0-9]+/gi, '');
}

function trackLabel(track, position) {
    if (track.title) return track.title;
    if (track.language) return track.language.toUpperCase();
    return 'Дорожка ' + (position + 1);
}

// Accept both Go's default JSON field names (`Tracks`, `Index`) and camelCase. The latter keeps
// this code compatible with a future API that adds explicit JSON tags.
export function normalizeAudioTracks(probe) {
    var source = (probe && (probe.Tracks || probe.tracks)) || [];
    var result = [];
    var seen = {};
    if (!Array.isArray(source)) return result;

    source.forEach(function (raw) {
        var type = String(value(raw, 'Type', 'type') || '').toLowerCase();
        var index = Number(value(raw, 'Index', 'index'));
        if (type !== 'audio' || !isFinite(index) || seen[index]) return;
        seen[index] = true;

        var title = String(value(raw, 'Title', 'title') || '').trim();
        var language = String(value(raw, 'Language', 'language') || '').trim();
        var codec = String(value(raw, 'Codec', 'codec') || value(raw, 'CapsName', 'capsName') || '').trim();
        var channels = Number(value(raw, 'Channels', 'channels')) || 0;
        result.push({
            index: index,
            language: language,
            label: trackLabel({ title: title, language: language }, result.length),
            title: title,
            extra: { codec: codec, channels: channels }
        });
    });
    return result;
}

export function preferenceFromTrack(track) {
    if (!track) return null;
    var titleNormalized = normalizeTrackName(track.title || track.label);
    // A language-only record would make every Russian track an apparent match. Do not persist one.
    if (!titleNormalized) return null;
    return {
        language: String(track.language || '').toLowerCase(),
        titleNormalized: titleNormalized,
        label: track.label || track.title || ''
    };
}

export function resolvePreferredTrack(preference, tracks) {
    if (!preference || !preference.titleNormalized || !Array.isArray(tracks)) return null;
    var language = String(preference.language || '').toLowerCase();
    var matches = tracks.filter(function (track) {
        var sameTitle = normalizeTrackName(track.title || track.label) === preference.titleNormalized;
        var trackLanguage = String(track.language || '').toLowerCase();
        return sameTitle && (!language || !trackLanguage || trackLanguage === language);
    });
    return matches.length === 1 ? matches[0] : null;
}
