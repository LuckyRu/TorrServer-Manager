# Пересобрать TorrServer с расширенным GST-пайплайном

Патч [`../../patches/torrserver-gstreamer-container-support.patch`](../../patches/torrserver-gstreamer-container-support.patch)
расширяет GST-first транспорт Torrent Mod. Для обычной сборки всего продукта используйте
[`../../scripts/build-all.ps1`](../../scripts/build-all.ps1): он сам скачивает зафиксированный
commit TorrServer, применяет этот patch и собирает оба бинарника. Ручные шаги ниже нужны только
для отладки TorrServer отдельно.

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

```powershell
Set-Location <TorrServer-source>\server
git apply --check <TorrServerManager>\patches\torrserver-gstreamer-container-support.patch
git apply <TorrServerManager>\patches\torrserver-gstreamer-container-support.patch
gofmt -w gstreamer
go test -tags=gst ./gstreamer
go build '-tags=nosqlite,gst' -trimpath '-ldflags=-s -w -checklinkname=0' -o TorrServer.exe ./cmd
```

Перед заменой установленного бинарника остановить `TorrServerManager.exe`, иначе его supervisor
может перезапустить старый TorrServer. Скопировать новый файл поверх `TorrServer.exe` и снова
запустить менеджер с `--background`. После запуска проверить `http://127.0.0.1:8090/gst/echo`:
у `gst_discoverer` и `gstreamer` должно быть `works: true`.

## Clean clone

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-all.ps1
```

Скрипт требует Git, .NET 10 SDK и Node.js. Go 1.25.7 берётся с PATH либо скачивается в
`.tools\go-1.25.7\`; исходники TorrServer и промежуточные файлы лежат в `.build\`. Обе папки
игнорируются Git и не являются частью поставки. GStreamer runtime не компилируется из исходников:
его устанавливает/контролирует Manager на целевой машине.
