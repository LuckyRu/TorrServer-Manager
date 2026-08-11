# Пересобрать TorrServer с расширенным GST-пайплайном

Два патча накладываются на официальный исходник TorrServer, в этом порядке:

1. [`../../patches/torrserver-gstreamer-container-support.patch`](../../patches/torrserver-gstreamer-container-support.patch)
   — расширяет GST-first транспорт Torrent Mod. Один плоский файл, накладывается `git apply`.
2. [`../../patches/torrserver-gstreamer-robustness/`](../../patches/torrserver-gstreamer-robustness/)
   — устойчивость пайплайна к хаотичному поведению плеера (аренда сегмента вне лока задачи,
   контекстно-зависимый лок при seek); разбор — [`../system-design/gstreamer-pipeline-robustness.md`](../system-design/gstreamer-pipeline-robustness.md).
   Не один файл, а упорядоченная серия `git format-patch` (`0001-*.patch`, `0002-*.patch`, ...),
   накладывается `git am` поверх первого патча. Серия, а не squash, чтобы у каждой логической
   правки было своё сообщение коммита и свой дифф — иначе при следующем изменении пришлось бы
   перегенерировать один плоский файл целиком, и история самого TorrServerManager показывала бы
   diff-плоского-файла-к-плоскому-файлу вместо читаемых шагов.

Для обычной сборки всего продукта используйте [`../../scripts/build-all.ps1`](../../scripts/build-all.ps1):
он сам скачивает официальный стабильный release TorrServer по тегу `MatriX.*` и накатывает оба
патча в правильном порядке. Без параметров скрипт использует тег из `config\torrserver-release.lock`.
Для проверки нового релиза можно передать тег явно: `-TorrServerTag MatriX.142.2`, а после проверки
обновить lock-файл. Ветки, произвольные commit и draft/prerelease не принимаются.

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

`git am` (нужен для серии robustness) требует настоящего git-репозитория с закоммиченным
индексом — `git init`, затем коммит сразу после первого патча, до серии:

```powershell
Set-Location <TorrServer-source>
git init -q .
git apply --check <TorrServerManager>\patches\torrserver-gstreamer-container-support.patch
git apply <TorrServerManager>\patches\torrserver-gstreamer-container-support.patch
git add -A
git -c user.name=build -c user.email=build@local commit -q -m import

$env:GIT_AUTHOR_NAME = 'build'; $env:GIT_AUTHOR_EMAIL = 'build@local'
$env:GIT_COMMITTER_NAME = 'build'; $env:GIT_COMMITTER_EMAIL = 'build@local'
Get-ChildItem <TorrServerManager>\patches\torrserver-gstreamer-robustness\*.patch |
    Sort-Object Name | ForEach-Object { git am $_.FullName }

Set-Location server
gofmt -w gstreamer
go test -tags=gst ./gstreamer
go build '-tags=nosqlite,gst' -trimpath '-ldflags=-s -w -checklinkname=0' -o TorrServer.exe ./cmd
```

Автор/коммиттер задаются через окружение процесса, а не `git config` — это чужой временный клон,
трогать чью-то git-identity незачем и небезопасно на CI-машине.

Для release-сборки версия должна совпадать с официальным тегом: добавьте
`-X server/version.Version=MatriX.<version>` в `-ldflags`.

Перед заменой установленного бинарника остановить `TorrServerManager.exe`, иначе его supervisor
может перезапустить старый TorrServer. Скопировать новый файл поверх `TorrServer.exe` и снова
запустить менеджер с `--background`. После запуска проверить `http://127.0.0.1:8090/gst/echo`:
у `gst_discoverer` и `gstreamer` должно быть `works: true`.

## Clean clone

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-all.ps1 -TorrServerTag MatriX.142.2
```

Скрипт требует Git, .NET 10 SDK и Node.js. Версия Go читается из `server\go.mod` выбранного
release, затем берётся с PATH либо скачивается в
`.tools\go-1.25.7\`; исходники TorrServer и промежуточные файлы лежат в `.build\`. Обе папки
игнорируются Git и не являются частью поставки. GStreamer runtime не компилируется из исходников:
его устанавливает/контролирует Manager на целевой машине.
