// Выбор файла и сборка данных плеера. Раньше этот слой не был покрыт вовсе, а именно из него
// пришли последние живые дефекты: потерянный torrent_hash в элементах плейлиста и выбор не той
// серии в паке. Функции здесь чистые либо принимают зависимости параметром, поэтому проверяются
// без плеера и без сети.

import './helpers/mock-lampa.mjs';
import { createRunner } from './helpers/test-runner.mjs';
import assert from 'node:assert/strict';

import { isPlayableFile, filePath, fileExtension, extensionScore } from '../playback/file-selection-common.js';
import { scoreMovieFile, pickMovieFile } from '../playback/movie-file-selection.js';
import { parseSeriesFileLayout, scoreSeriesFile, pickSeriesFile } from '../playback/series-file-selection.js';
import { buildSeriesPlayerData } from '../playback/series-player.js';
import { buildMoviePlayerData } from '../playback/movie-player.js';
import { buildPlaylist } from '../playback/smart-preload.js';
import { parseSignals } from '../search/parse/release-parsing.js';

const runner = createRunner();

// ---------- общие примитивы ----------

runner.test('расширение читается из машинного пути, человеческого и заголовка', () => {
    assert.equal(filePath({ path: 'a/b.mkv', path_human: 'ignored' }), 'a/b.mkv');
    // TorrServer и раскладки Jackett заполняют разные поля; потерять валидное видео нельзя.
    assert.equal(filePath({ path_human: 'Сезон 1/Серия 1.avi' }), 'Сезон 1/Серия 1.avi');
    assert.equal(filePath({ title: 'movie.mp4' }), 'movie.mp4');
    assert.equal(filePath(null), '');
});

runner.test('расширение не путается с query и fragment', () => {
    assert.equal(fileExtension({ path: 'video.mkv?token=1' }), 'mkv');
    assert.equal(fileExtension({ path: 'video.MP4#t=10' }), 'mp4');
    assert.equal(fileExtension({ path: 'no-extension' }), '');
});

runner.test('воспроизводимость определяется по расширению', () => {
    ['mkv', 'avi', 'mp4', 'ts', 'rmvb'].forEach((ext) => {
        assert.ok(isPlayableFile({ path: 'f.' + ext }), ext + ' обязан считаться видео');
    });
    ['srt', 'nfo', 'jpg', 'txt'].forEach((ext) => {
        assert.ok(!isPlayableFile({ path: 'f.' + ext }), ext + ' не видео');
    });
});

runner.test('современные контейнеры получают преимущество перед устаревшими', () => {
    assert.ok(extensionScore('a.mkv') > 0);
    assert.ok(extensionScore('a.avi') < 0);
    assert.equal(extensionScore('a.bin'), 0);
});

// ---------- фильм ----------

runner.test('сэмплы и трейлеры не выигрывают у самого фильма', () => {
    const movie = { path: 'Movie.2024.1080p.mkv', length: 8_000_000_000 };
    // Артефакт крупнее фильма встречается реально: «extras» бывают увесистыми.
    const sample = { path: 'Movie.2024.sample.mkv', length: 9_000_000_000 };
    assert.ok(scoreMovieFile(sample) < scoreMovieFile(movie));
    assert.equal(pickMovieFile([sample, movie]), movie);
});

runner.test('при сопоставимом размере выигрывает контейнер, который стримится', () => {
    const legacy = { path: 'Movie.avi', length: 4_000_000_000 };
    const modern = { path: 'Movie.mkv', length: 4_000_000_000 };
    assert.equal(pickMovieFile([legacy, modern]), modern);
});

runner.test('пустой список файлов не роняет выбор', () => {
    assert.equal(pickMovieFile([]), null);
    assert.equal(pickMovieFile(null), null);
});

// ---------- сериал ----------

runner.test('сезон читается из имени каталога в разных написаниях', () => {
    const cases = [
        ['Show/Season-7/file.mkv', 7],
        ['Show/Season 07/file.mkv', 7],
        ['Show/7 сезон/file.mkv', 7],
        ['Show/Сезон 7/file.mkv', 7],
        ['Show/S07/file.mkv', 7],
        ['Show/bonus/file.mkv', 0]
    ];
    cases.forEach(([path, expected]) => {
        assert.equal(parseSeriesFileLayout({ path }).season, expected, path);
    });
});

runner.test('номер серии из начала имени читается только внутри каталога сезона', () => {
    assert.equal(parseSeriesFileLayout({ path: 'Show/Season-3/05. Название.mkv' }).episode, 5);
    assert.equal(parseSeriesFileLayout({ path: 'Show/Season-3/[07] Название.mkv' }).episode, 7);
    // Без каталога сезона ведущее число слишком легко спутать с годом или качеством.
    assert.equal(parseSeriesFileLayout({ path: 'Show/05. Название.mkv' }).episode, 0);
});

runner.test('в паке сезонов выбирается запрошенная серия, а не соседняя', () => {
    const files = [
        { id: 1, path: 'The Big Bang Theory/Season-7/The Big Bang Theory - S07E04.avi' },
        { id: 2, path: 'The Big Bang Theory/Season-7/The Big Bang Theory - S07E05.avi' },
        { id: 3, path: 'The Big Bang Theory/Season-8/The Big Bang Theory - S08E05.avi' }
    ];
    const picked = pickSeriesFile(files, { season: 7, episode: 5 }, parseSignals);
    assert.equal(picked.id, 2, 'выбран ' + (picked && picked.path));
});

runner.test('чужой сезон проигрывает даже при совпавшем номере серии', () => {
    const wrongSeason = { path: 'Show/Season-8/Show - S08E05.mkv' };
    const rightSeason = { path: 'Show/Season-7/Show - S07E05.mkv' };
    const target = { season: 7, episode: 5 };
    assert.ok(scoreSeriesFile(rightSeason, target, parseSignals) > scoreSeriesFile(wrongSeason, target, parseSignals));
});

runner.test('раскладка каталога важнее сигналов из имени файла', () => {
    // Каталог знает сезон точно, имя файла — лишь предположение парсера.
    const byDirectory = { path: 'Show/Season-2/03. Серия.mkv' };
    assert.deepEqual(parseSeriesFileLayout(byDirectory), { season: 2, episode: 3 });
});

// ---------- данные плеера ----------

function seriesSession(overrides) {
    const files = [
        { id: 1, path: 'Show/Season-1/S01E01.mkv', path_human: 'S01E01.mkv' },
        { id: 2, path: 'Show/Season-1/S01E02.mkv', path_human: 'S01E02.mkv' }
    ];
    return Object.assign({
        hash: 'abc123',
        alive: true,
        files,
        allFiles: files,
        activeFile: files[0],
        bestFile: files[0],
        target: { movie: { id: 1, name: 'Show' }, season: 1, episode: 1 },
        transports: {
            1: { url: 'http://server/gst/abc123/master.m3u8?index=1', hls_manifest_timeout: 60000 },
            2: { url: 'http://server/gst/abc123/master.m3u8?index=2', hls_manifest_timeout: 60000 }
        },
        probeInfo: {}
    }, overrides || {});
}

runner.test('данные плеера несут хеш торрента', () => {
    const session = seriesSession();
    const data = buildSeriesPlayerData(session, () => [], (file) => session.transports[String(file.id)], session.files[0]);
    assert.equal(data.torrent_hash, 'abc123');
    assert.ok(data.url);
});

// Регрессия: Lampa опрашивает статистику торрента по torrent_hash ТЕКУЩЕГО элемента плейлиста.
// В данных первого запуска поле было, а в элементах плейлиста — нет, и после перехода на
// следующую серию опрос уходил на /gst/undefined/heartbeat.
runner.test('каждый элемент плейлиста несёт хеш торрента', () => {
    const session = seriesSession();
    const playlist = buildPlaylist(session);

    assert.equal(playlist.length, session.files.length);
    playlist.forEach((item, index) => {
        assert.equal(item.torrent_hash, 'abc123', 'элемент ' + index + ' потерял хеш торрента');
    });
});

runner.test('элементы плейлиста сохраняют путь и заголовок каждого файла', () => {
    const session = seriesSession();
    const playlist = buildPlaylist(session);
    assert.deepEqual(playlist.map((item) => item.path), session.files.map((file) => file.path));
    assert.ok(playlist.every((item) => item.title));
});

runner.test('данные плеера фильма несут хеш торрента', () => {
    const file = { id: 1, path: 'Movie.mkv', path_human: 'Movie.mkv' };
    const session = {
        hash: 'def456',
        alive: true,
        files: [file],
        activeFile: file,
        bestFile: file,
        target: { movie: { id: 2, title: 'Movie' } },
        transports: { 1: { url: 'http://server/gst/def456/master.m3u8?index=1' } },
        probeInfo: {}
    };
    const data = buildMoviePlayerData(session, (f) => session.transports[String(f.id)], file);
    assert.equal(data.torrent_hash, 'def456');
    assert.equal(data.path, 'Movie.mkv');
});

await runner.run();
