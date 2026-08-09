# ADR-0003: Torrent Mod не патчит `Lampa.Player`/`Lampa.Torserver` глобально

**Статус:** Принято
**Актуализировано:** 2026-08-09

## Контекст

Torrent Mod должен запускать выбранную раздачу и поддерживать переходы между файлами
season-pack, не меняя глобальное поведение Lampa для других источников и плагинов.

Ранее для этого использовались `Lampa.Torrent.start(...)`, нативный экран выбора файлов,
отдельный preload-overlay и поллинг `/cache`. Эта схема была заменена: экран Lampa был
лишним для Torrent Mod, а глобальные monkey-patch'и создавали бы конфликт с другими
плагинами.

## Решение

Не переопределять `Lampa.Player.play`, `Lampa.Torserver.stream` и связанные глобальные
методы. Playback остаётся отдельной сессией в
[`playback/smart-preload.js`](../../Plugins/TorrentModPlugin/playback/smart-preload.js):

1. Проверить сохранённый hash раздачи через `POST /torrents {action:'get'}`.
2. Если hash отсутствует или устарел, найти уже зарегистрированный торрент через
   `POST /torrents {action:'list'}` либо добавить его через `POST /torrents {action:'add'}`.
3. Опросить `Torserver.files(hash)` до появления `file_stats` и выбрать подходящий
   playable-файл по режиму фильма/сериала.
4. Отправить fire-and-forget preload-запрос для выбранного файла.
5. Запросить `/gst/{hash}/probe?index={fileId}`, выбрать audio track и вызвать
   `Lampa.Player.play(data)` с GST URL, `voiceovers`, timeline и playlist.

Для каждого файла Player получает один TorrServer GST/HLS URL с `audio=<trackIndex>` и
`hls_manifest_timeout: 60000`. Прямой stream и `url_reserve` не используются. У следующего
элемента season-pack playlist URL отложен: Lampa вызывает его перед переходом, после чего плагин
выполняет probe, задаёт `voiceovers` и продолжает play готовым GST URL.

## Жизненный цикл сессии

Каждый запуск получает `alive` и идемпотентный `dispose()`:

- новый запуск отменяет предыдущую незавершённую сессию;
- поздние ответы `/torrents` и `files()` проверяют `alive` и не могут запустить
  устаревшую раздачу;
- polling metadata и listeners next-episode preload удаляются при завершении;
- playback-сессия живёт дольше экрана результатов и завершается при уничтожении
  самого Lampa Player.

## Fallback и ограничения

На проблеме GST Torrent Mod не делает transport fallback и не выбирает автоматически другой
файл. При ошибке probe плеер не открывается; при ошибке ручного переключения preference не
сохраняется. Пользователь может повторить запуск или выбрать другую раздачу.

Preload следующего файла season-pack выполняется отдельно: примерно на 85% текущего
видео или за 60 секунд до конца отправляется тихий preload-запрос для следующего
playable-файла. Он не патчит Player и не меняет playlist.

## Последствия

- Нет глобального влияния на другие плагины и native torrent flow Lampa.
- У всех файлов одинаковый GST-first путь с предсказуемыми codecs, subtitles и audio tracks.
- Первый старт ждёт metadata probe и GST manifest.
- Вся логика регистрации, выбора файла и lifecycle остаётся локальной playback-сессии.
- Реальный GST-first playback требует live-проверки на устройстве: Node-тесты проверяют
  доменный flow и metadata matching, но не GStreamer pipeline.

Историческая модель с `Lampa.Torrent.start`, overlay и ручным `/cache`-поллингом
сохранена только в истории разработки и больше не является текущим контрактом.
