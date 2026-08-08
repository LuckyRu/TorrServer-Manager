// ---------- movie player adapter ----------
//
// Movie playback has no season/episode metadata and no episode playlist. Keep that contract explicit
// instead of passing a series-shaped `{season: 0, episode: 0}` object into Lampa.Player.
import { hubBase } from '../shared/state.js';

function parseMovieFile(file, files, movie) {
    try {
        return Lampa.Torserver.parse({ movie: movie, files: files, filename: file.path_human, path: file.path }) || {};
    } catch (e) { return {}; }
}

export function buildMoviePlayerData(session) {
    var file = session.bestFile;
    var movie = (session.target && session.target.movie) || {};
    var info = parseMovieFile(file, session.files || [], movie);
    var torrBase = '';
    try { torrBase = String(Lampa.Torserver.ip() || '').replace(/\/$/, ''); } catch (e) {}
    var url = session.useGst && torrBase
        ? torrBase + '/gst/' + encodeURIComponent(session.hash) + '/master.m3u8?index=' + encodeURIComponent(file.id) + '&audio=0'
        : session.transcodeAudio
        ? hubBase + '/transcode/' + encodeURIComponent(session.hash) + '/' + encodeURIComponent(file.id)
        : Lampa.Torserver.stream(file.path, session.hash, file.id);
    var data = {
        url: url,
        torrent_hash: session.hash,
        title: file.path_human || file.path,
        first_title: movie.name || movie.title,
        card: movie,
        path: file.path
    };
    if (info.hash && Lampa.Timeline && Lampa.Timeline.view) data.timeline = Lampa.Timeline.view(info.hash);
    return data;
}
