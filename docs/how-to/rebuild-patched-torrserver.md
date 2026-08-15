# Пересобрать TorrServer с расширенным GST-пайплайном

Расширения GST находятся в форке [`LuckyRu/TorrServer`](https://github.com/LuckyRu/TorrServer)
отдельными содержательными коммитами ветки `torrserver-manager`. Родительский репозиторий
фиксирует точный downstream-коммит через gitlink `external/TorrServer`; отдельный lock-файл не
нужен и намеренно не используется. Релизные теги имеют формат
`MatriX.<upstream>-TorrentMod.<version>`, например `MatriX.142.2-TorrentMod.1.0`.

Для обычной сборки всего продукта используйте [`../../scripts/build-all.ps1`](../../scripts/build-all.ps1):
он инициализирует `external/TorrServer`, находит ближайший downstream-тег `MatriX.*-TorrentMod.*` в
истории того commit'а, который сейчас выписан, извлекает из него upstream-базу и подтверждает её
совпадение с официальным стабильным релизом upstream. В бинарник передаётся полный downstream-тег
`MatriX.142.2-TorrentMod.1.0`, поэтому версия самого бинарника отражает модифицированную сборку.
Updater сравнивает из этого значения только upstream-базу с официальными релизами. Субмодуль не
изменяется: сборщик копирует только его `server/` во временный `.build/`.

Для clean clone:

```powershell
git clone --recurse-submodules <repository-url>
Set-Location <repository-directory>
git submodule status --recursive
powershell -ExecutionPolicy Bypass -File .\scripts\build-all.ps1
```

Если репозиторий уже склонирован без субмодулей:

```powershell
git submodule update --init --recursive
```

Обновление источника выполняется атомарно: в форке обновляется ветка `torrserver-manager`, после
чего родительский репозиторий обновляет gitlink одним коммитом. В clean clone Git получает ровно
этот commit; поле `branch = torrserver-manager` в `.gitmodules` служит подсказкой для сопровождающих,
но не заменяет pin.

## Дев-сборка и релиз

Между этими двумя коммитами субмодуль по построению опережает gitlink, и `git submodule update`
в этот момент выписал бы предыдущий релиз в detached HEAD, молча собрав старый код. Поэтому
сборщик синхронизирует субмодуль **только вперёд**:

| Состояние субмодуля относительно gitlink | Что делает `build-all.ps1` |
|---|---|
| совпадает | ничего |
| впереди (рабочая ветка) | оставляет как есть, помечает сборку дев-сборкой |
| позади | `merge --ff-only` до gitlink |
| разошлись | останавливается: свести ветки — решение сопровождающего, не сборщика |

Сборка считается дев-сборкой, если выполнено хотя бы одно: HEAD субмодуля впереди ближайшего
downstream-тега, рабочее дерево изменено, либо gitlink родителя ещё указывает на другой commit.
Тогда в `-X server/version.Version` уходит не голый тег, а
`MatriX.142.2-TorrentMod.1.6-dev.<коммитов после тега>.g<sha>[.dirty]`, и причины печатаются
жёлтым блоком до и после сборки. Этот суффикс распознают `ServerController` и `UpdateService`,
поэтому в окне менеджера видно именно дев-версию, а сравнение с upstream по-прежнему идёт только
по части `MatriX.*`.

Ключ `-RequireRelease` превращает любой признак дев-состояния в ошибку — им проверяют, что
выпускается ровно то, что помечено тегом и записано в gitlink.

## Что поддержано

- Matroska/WebM — `matroskademux`;
- MP4, M4V, MOV, 3GP — `qtdemux`;
- AVI — `avidemux`, только при включённом `TranscodeAVI`;
- ASF/WMV — `asfdemux`;
- FLV — `flvdemux`.

Для неизвестного видеокодека внутри этих контейнеров GST использует `decodebin` и заново кодирует
в H.264. Нужный декодер всё равно должен присутствовать в установленном GStreamer runtime.

TS/M2TS, VOB/MPEG-PS и Ogg намеренно не включены: их demuxer выдаёт пады с идентификатором потока,
а не `audio_N`/`video_N`. Простая подстановка demuxer сломает выбор аудиодорожки. Для них нужна
отдельная реализация динамической привязки падов по результату probe.

## Сборка

Ручное применение patch-файлов больше не требуется: они мигрированы в историю форка и удалены
из этого репозитория. Для локального полного прогона достаточно:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-all.ps1
```

Скрипт форматирует GST-код, запускает `go test -tags=gst ./gstreamer`, собирает
`TorrServer.exe` с тегами `nosqlite,gst` и публикует Manager.

Скрипт сам берёт downstream-тег из истории субмодуля, проверяет его upstream-часть и передаёт
версию в `-X server/version.Version` — голый тег для релиза, тег с суффиксом `-dev.…` для рабочей
ветки (см. «Дев-сборка и релиз» выше).

Перед заменой установленного бинарника остановить `TorrServerManager.exe`, иначе его supervisor
может перезапустить старый TorrServer. Скопировать новый файл поверх `TorrServer.exe` и снова
запустить менеджер с `--background`. После запуска проверить `http://127.0.0.1:8090/gst/echo`:
у `gst_discoverer` и `gstreamer` должно быть `works: true`.

## Clean clone и выпуск

```powershell
git submodule update --init --recursive
powershell -ExecutionPolicy Bypass -File .\scripts\build-all.ps1 -RequireRelease
```

Скрипт требует Git с доступом к `git@github.com:LuckyRu/TorrServer.git`, .NET 10 SDK и Node.js. Версия
Go читается из `external\TorrServer\server\go.mod`, затем берётся с PATH либо скачивается в
`.tools\go-1.25.7\`; копия исходников и промежуточные файлы лежат в `.build\`. Обе папки
игнорируются Git и не являются частью поставки. GStreamer runtime не компилируется из исходников:
его устанавливает/контролирует Manager на целевой машине.
