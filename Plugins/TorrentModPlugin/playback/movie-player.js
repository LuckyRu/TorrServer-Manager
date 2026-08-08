// ---------- movie player adapter ----------
//
// Movie playback has no season/episode metadata and no episode playlist. Keep that contract explicit
// instead of passing a series-shaped `{season: 0, episode: 0}` object into Lampa.Player.
//
// The URLs are injected (urlsFor(file) -> {url, url_reserve}) rather than rebuilt here —
// smart-preload.js's own urlsFor is the single place that decides transport (direct stream by
// default, GST as url_reserve — see its own header comment for why), and series-player.js already
// receives it the same way. An earlier version of this file re-derived transport branching inline
// instead, including its own separate Lampa.Torserver.ip() call — a second copy of transport logic
// that a future change to the real one could silently miss (found in review).
function parseMovieFile(file, files, movie) {
    try {
        return Lampa.Torserver.parse({ movie: movie, files: files, filename: file.path_human, path: file.path }) || {};
    } catch (e) { return {}; }
}

export function buildMoviePlayerData(session, urlsFor) {
    var file = session.bestFile;
    var movie = (session.target && session.target.movie) || {};
    var info = parseMovieFile(file, session.files || [], movie);
    var urls = urlsFor(file);
    var data = {
        url: urls.url,
        url_reserve: urls.url_reserve,
        torrent_hash: session.hash,
        title: file.path_human || file.path,
        first_title: movie.name || movie.title,
        card: movie,
        path: file.path
    };
    if (info.hash && Lampa.Timeline && Lampa.Timeline.view) data.timeline = Lampa.Timeline.view(info.hash);
    return data;
}
