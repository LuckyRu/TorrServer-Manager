function parseMovieFile(file, files, movie) {
    try {
        return Lampa.Torserver.parse({ movie: movie, files: files, filename: file.path_human, path: file.path }) || {};
    } catch (e) { return {}; }
}

export function buildMoviePlayerData(session, urlsFor, file) {
    file = file || session.activeFile || session.bestFile;
    var movie = (session.target && session.target.movie) || {};
    var info = parseMovieFile(file, session.files || [], movie);
    var urls = urlsFor(file);
    var data = {
        url: urls.url,
        hls_manifest_timeout: urls.hls_manifest_timeout,
        torrent_hash: session.hash,
        title: file.path_human || file.path,
        first_title: movie.name || movie.title,
        card: movie,
        path: file.path
    };
    if (urls.voiceovers) data.voiceovers = urls.voiceovers;
    if (info.hash && Lampa.Timeline && Lampa.Timeline.view) data.timeline = Lampa.Timeline.view(info.hash);
    return data;
}
