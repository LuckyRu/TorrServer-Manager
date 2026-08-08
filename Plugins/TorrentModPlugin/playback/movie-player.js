// ---------- movie player adapter ----------
//
// Movie playback has no season/episode metadata and no episode playlist. Keep that contract explicit
// instead of passing a series-shaped `{season: 0, episode: 0}` object into Lampa.Player.
//
// The stream URL is injected (streamUrl(file)) rather than rebuilt here — smart-preload.js's own
// streamUrlFor is the single place that decides GST/transcode-audio/direct transport, and
// series-player.js already receives it the same way. An earlier version of this file re-derived the
// identical GST/transcode/direct branching inline instead, including its own separate
// Lampa.Torserver.ip() call — a second copy of transport logic that a future change to the real one
// (e.g. GST URL shape, audio track handling) could silently miss (found in review).
function parseMovieFile(file, files, movie) {
    try {
        return Lampa.Torserver.parse({ movie: movie, files: files, filename: file.path_human, path: file.path }) || {};
    } catch (e) { return {}; }
}

export function buildMoviePlayerData(session, streamUrl) {
    var file = session.bestFile;
    var movie = (session.target && session.target.movie) || {};
    var info = parseMovieFile(file, session.files || [], movie);
    var data = {
        url: streamUrl(file),
        torrent_hash: session.hash,
        title: file.path_human || file.path,
        first_title: movie.name || movie.title,
        card: movie,
        path: file.path
    };
    if (info.hash && Lampa.Timeline && Lampa.Timeline.view) data.timeline = Lampa.Timeline.view(info.hash);
    return data;
}
