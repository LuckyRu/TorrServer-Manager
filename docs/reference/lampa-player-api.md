# Lampa: API плеера для торрент-плагинов

Справочная страница, дополняющая [`lampa-plugin-api.md`](lampa-plugin-api.md) — тот файл покрывает
Component/Activity/Template/Explorer/Storage в целом, эта фокусируется на `Lampa.Player` и всём, что
вокруг него (`PlayerVideo`, `Playlist`, `Panel`, `Torserver`), поскольку именно здесь
`TorrentModPlugin.js` (`playback/`) делает самое рискованное — запускает воспроизведение напрямую,
без нативного экрана торрентов. Источник, как и у соседнего файла — реальные (не минифицированные)
исходники в `vendor/lampa-source/` (гитигнорированы, только для разработки). Факты — с указанием
файла и строки в `vendor/lampa-source`, чтобы можно было перепроверить самостоятельно.

Страница обновлена для GST-first контракта Torrent Mod: плагин получает metadata через GST probe и
передаёт один GST/HLS URL с точным индексом audio. Здесь зафиксирован сам API Lampa и точки, которые
следует перепроверить при обновлении Lampa.

## Слои: `Player` — не то же самое, что `PlayerVideo`

Как и с Component/Activity, здесь два разных модуля, которые легко перепутать:

- **`Lampa.Player`** (`interaction/player.js`) — оркестратор экрана плеера целиком: препролл-реклама,
  фон, Panel (нижняя панель управления), Info (заголовок/статистика), Footer (описание карточки),
  Playlist, сохранение позиции просмотра, скип-кнопка интро/титров. Публичный вход — `Player.play(data)`.
- **`Lampa.PlayerVideo`** (`interaction/player/video.js`, alias `Video` внутри player.js) — обёртка над
  реальным HTML5 `<video>`/HLS-движком: URL, субтитры, звуковые дорожки, события декодирования.
  `Player` слушает события `PlayerVideo`, ретранслирует часть из них на свой собственный `listener`
  как публичный API плагина.
- **`Lampa.PlayerPlaylist`** (`interaction/player/playlist.js`, alias `Playlist`) — список файлов
  текущего воспроизведения (следующая серия и т.п.), полностью отдельный от истории просмотра.

Плагин работает с `Lampa.Player.play(data)`, `Lampa.Player.listener`, `Lampa.PlayerVideo.listener` —
три точки, которые реально используются в `playback/smart-preload.js`.

## `Player.play(data)` — контракт `data`

`play(data)` (`interaction/player.js:1191`) присваивает переданный объект внутренней переменной
`work` — именно `work`, а не сам `data`, читают все последующие обработчики событий, так что
«текущее состояние плеера» всегда means «то, что было передано в
последний `play()`». Поля, которые реально читаются реализацией (полный список, не только то, что
использует этот плагин):

| Поле | Смысл |
|---|---|
| `url` | Обязательное. URL потока — то, что реально уходит в `PlayerVideo.url()`. |
| `url_reserve` | Резервный URL встроенного Lampa fallback; Torrent Mod его намеренно не передаёт. |
| `torrent_hash` | Хэш торрента. Влияет на `hls_manifest_timeout` (см. ниже) и на статистику/хартбиты. |
| `title` | Заголовок эпизода/файла — то, что видно в панели плеера. |
| `first_title` | Заголовок карточки целиком (название фильма/сериала), отдельно от `title`. |
| `card` | Объект фильма/сериала — по нему `Footer.appendAbout()` рисует описание под плеером. |
| `season`, `episode` | Числа, для отображения и для `Timeline`-логики серий. |
| `path` | Путь файла внутри торрента — не показывается, служебное. |
| `timeline` | `Lampa.Timeline.view(hash)` — объект прогресса просмотра для истории «продолжить». |
| `playlist` | Массив объектов той же формы (см. ниже) — плейлист для «следующая серия». |
| `subtitles` | Передаётся в `Video.customSubs(...)` — свои сабы поверх/вместо нативных. |
| `voiceovers` | Передаётся в `Panel.setTracks(...)` — список аудиодорожек для панели переключения. |
| `translate` | Объект `{tracks: [...]}` — то же самое, что и `voiceovers`/`data.ffprobe`, но напрямую. |
| `ffprobe` | **Не используется этим плагином, но существует** — см. раздел ниже. |
| `quality` | Объект `{label: url, ...}` — варианты качества для панели переключения. |
| `segments` | Интро/титры-скип сегменты, `Segments.set(...)`. |
| `tv` / `iptv` | Флаги режима — влияют на CSS-класс и на то, рисуется ли `Footer.appendAbout`. |
| `hls_manifest_timeout` | Обычно выставляется автоматически (см. ниже), но можно и передать явно. |

Torrent Mod сейчас заполняет: GST `url`, `hls_manifest_timeout`, `torrent_hash`, `title`,
`first_title`, `card`, `voiceovers`, `season`/`episode` (только сериалы), `path`, `timeline`,
`playlist` (только сериалы). `url_reserve` намеренно не передаётся.

## GST-first вместо `url_reserve`

`url_reserve` остаётся общей возможностью Lampa, но Torrent Mod от неё отказался: до каждого
`Player.play` выполняется `/gst/{hash}/probe`, а единственным источником становится GST/HLS URL с
точным `audio=<trackIndex>`. Это даёт один контракт для codecs, встроенных subtitles и audio tracks.
При ошибке нет скрытого direct fallback; плагин сообщает об ошибке и не сохраняет неуспешно выбранное
предпочтение.

Для season-pack `Playlist.listener.follow('select', ...)` (`interaction/player.js:388`) поддерживает
`item.url` как функцию. Torrent Mod использует этот callback, чтобы выполнить probe непосредственно
перед переходом на следующий файл, записать полученные GST URL и `voiceovers` в item и продолжить
плейбек. На Android текущая ветка Lampa фильтрует playlist до строковых URL, поэтому этот сценарий
требует отдельной live-проверки.

Верхнеуровневый `data.url` функции не поддерживает: `play()` вызывает для него `indexOf()`,
`preload()` — `replace()`, после чего значение напрямую передаётся в `Video.url()`
(`interaction/player.js:1198-1250`). Поэтому Torrent Mod не может открыть первый Player через тот
же lazy-контракт, что следующую серию.

Для раннего UI используется публичный `Player.render()`: уже инициализированный DOM Player
монтируется с нативными классами `player--loading` и `player--panel-visible`, но без media source.
Одних классов недостаточно: внутренние `Info`/`Panel` Lampa остаются скрыты до `play()`, поэтому
Torrent Mod добавляет в эту же оболочку свой минимальный overlay со spinner и текущей стадией.
После обязательного probe обычный `Player.play(data)` принимает готовые GST URL и `voiceovers`, но
уже смонтированный общий DOM не отсоединяется. Overlay снимается только по `Player.ready`, после чего
оболочкой полностью владеет Lampa. Это исключает чёрный промежуток между preflight и штатным Player.
Если пользователь нажал Back до handoff, плагин закрывает оболочку и уничтожает player lifecycle
scope; поздний callback уничтоженного player/file scope не вызывает `Player.play`.

## `data.ffprobe` — нативная альтернатива ручному парсингу аудиодорожек

Найдено при чтении `play()` целиком (`interaction/player.js:1202-1208`), актуально для любой будущей
попытки сделать пикер аудиодорожек: если `data.ffprobe` задан (и `data.translate` ещё не массив),
`play()` сам вызывает `tracksFromFfprobe(data.ffprobe)` (`interaction/player/track_info.js`) и
записывает результат в `data.translate.tracks` — то есть **Lampa сама умеет превратить сырой JSON от
ffprobe в список дорожек для панели переключения**, без ручного построения `#EXT-X-MEDIA` записей в
HLS-манифесте.

Это прямо относится к недавнему инциденту (`CLAUDE.md`, запись про откат GST-мультиплексирования
аудиодорожек v1.17.23→v1.17.24): та попытка вручную переписывала `master.m3u8` через прокси в
`PluginHub.cs`, добавляя лишний медленный HTTP-запрос на каждый плейбек и в итоге подвесившая
TorrServer. `data.ffprobe` — путь, которым эта задача решается **без** переписывания манифеста и без
серверного прокси вообще: просто передать сырой `/ffp`-ответ TorrServer'а как есть в `Player.play()`,
и пусть Lampa сама строит панель дорожек. Не реализовано (ffprobe-запрос сейчас не делается вообще —
см. `CLAUDE.md`), но если аудио-пикер снова понадобится — начинать отсюда, не с ручного HLS.

## `hls_manifest_timeout` и `Torserver.gstWork()` — Lampa уже знает, что GST медленный

`play()` (`interaction/player.js:1200`): если `data.torrent_hash` задан и `Torserver.gstWork()`
истинно, `data.hls_manifest_timeout` автоматически выставляется в `60000` (60 секунд). Это прямое
подтверждение независимым источником того, что было измерено вживую в этом проекте отдельно (см.
`CLAUDE.md`): TorrServer-ный `/gst/.../master.m3u8` отвечает не мгновенно (в этом проекте замерено
~20с на прогрев реального GStreamer pipeline) — сама Lampa уже закладывает под это до 60с терпения на
загрузку манифеста, когда знает, что играет GST-поток.

`Torserver.gstWork()` (`interaction/torserver.js:137-139`) остаётся настройкой нативной Lampa.
Torrent Mod строит GST URL самостоятельно, поэтому его GST-first путь не зависит от этого
глобального тумблера. Для тихого cache-preload он тоже не вызывает `Lampa.Torserver.stream()`:
при включённом тумблере тот вернул бы GST master и создал бы audio=0 task до preflight. Вместо этого
плагин строит явный `/stream/{name}?link={hash}&index={fileId}&preload`; это cache nudge, не Player
transport.

## Плейлист: `data.playlist`, переключение серий

Элементы `data.playlist` — объекты той же формы, что и верхнеуровневый `data` (`url`, `voiceovers`,
`title`, `season`, `episode`, `timeline`, ...). `Player.play()` вызывает `Playlist.set(data.playlist)`
один раз при первом запуске (`interaction/player.js:1243`); дальше переключением рулит
`Playlist.next()`/`Playlist.prev()` (дергаются из `Panel.listener.follow('next'/'prev', ...)`,
`interaction/player.js:279,284`, — то есть кнопки/жесты панели) и `Video.listener.follow('ended', ...)`
(автопереход на следующий файл по завершении текущего). Оба пути в итоге эмитят `Playlist`-событие
`'select'`, которое сначала разрешает lazy GST URL, затем вызывает `play(e.item)`.

## События `PlayerVideo.listener` (полный список из `interaction/player.js`)

Все обработчики зарегистрированы в `init()` внутри `player.js` и определяют, что `PlayerVideo` реально
умеет сообщать наружу — этот список получен построчным поиском по `Video.listener.follow(...)` в файле,
не догадкой:

`timeupdate`, `progress`, `canplay`, `play`, `pause`, `rewind`, `ended`, `tracks`, `subs`, `levels`,
`videosize`, `error`, `translate`, `loadeddata`, `reset_continue`.

Из них Torrent Mod использует `timeupdate` (cache-preload следующей серии), `canplay` (подтверждение
ручного выбора и сохранение preference) и `error` (отбрасывает неуспешный выбор). `destroy` — событие
не `PlayerVideo`, а `Lampa.Player.listener`; плагин слушает его отдельно для освобождения сессии.

## События `Panel.listener` (нижняя панель управления)

`mouse_rewind`, `playpause`, `playlist`, `size`, `speed`, `prev`, `next`, `rprev`, `rnext`, `subsview`,
`visible`, `to_start`, `to_end`, `fullscreen`, `pip`, `quality`, `flow`, `share` — все обработчики
пользовательских действий на нижней панели (кнопки, свайпы, клавиши). Плагин их не слушает
напрямую — это внутренняя механика самого `Player`, а не точка расширения для сторонних плагинов;
задокументировано здесь только для полноты картины и на случай, если понадобится диагностировать,
почему конкретная кнопка панели ведёт себя так, а не иначе.

## Известные ограничения (для этого плагина конкретно)

- **Нет глобального патчинга `Lampa.Player.play`/`Lampa.Torserver.stream`** — осознанное архитектурное
  решение, задокументировано в `CLAUDE.md` (ADR-0003). Всё в этом файле про то, что передавать В
  `Player.play(data)` как параметры, а не про переопределение самих функций.
- **Нет transport fallback:** после отказа от direct stream Torrent Mod не передаёт `url_reserve`.
- **`hls_manifest_timeout` выставляется автоматически только когда `torrent_hash` задан** — если он
  когда-либо перестанет передаваться (например для не-торрент-потоков), таймаут вернётся к дефолтному,
  что может быть недостаточно для GST resume-сценариев. Стоит помнить при будущих изменениях
  `buildMoviePlayerData`/`buildSeriesPlayerData`.
