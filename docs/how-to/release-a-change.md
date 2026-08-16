# Как выпустить изменение

1. Внести правки в коде.
2. Поднять `<Version>` в `TorrServerManager.csproj` по SemVer2 — на каждое пользовательски заметное
   изменение. Версия обязана быть видна в UI главного окна и в подсказке трея (`NotifyIcon.Text`), не
   только в метаданных сборки — это уже сделано (`MainForm.ReadAppVersion()` читает
   `AssemblyInformationalVersion`), новых мест подключать не нужно.
2a. **Если менялся `Plugins/TorrentModPlugin/` — поднять ещё и `VERSION` в
   `Plugins/TorrentModPlugin/shared/state.js`.** Это отдельная от менеджера версия: она видна
   пользователю на кнопке карточки (`data-subtitle="v…"`) и стоит в каждой строке лога плагина, по
   которой потом разбирают проблему. Забывается легко — версия менеджера поднимается в csproj и
   выглядит достаточной, а плагин при этом уезжает в прод под старым номером. Однажды так и вышло:
   17 коммитов подряд ушли под `0.1.4`, включая полную перестройку поиска, и по логу с прода нельзя
   было понять, какой код там на самом деле.
3. Собрать и проверить, что билд чистый:
   ```bash
   dotnet build TorrServerManager.csproj -c Release
   ```
4. Закоммитить — по-русски, Conventional Commits (`тип(область): суть`), коротко, без пересказа диффа
   построчно.
5. Опубликовать self-contained single-file exe:
   ```bash
   dotnet publish TorrServerManager.csproj -c Release
   ```
   Результат: `bin\Release\net10.0-windows\win-x64\publish\TorrServerManager.exe`.
6. Задеплоить в реально работающую установку:
   - остановить запущенный `TorrServerManager.exe`;
   - скопировать свежесобранный `.exe` поверх `%LocalAppData%\Programs\TorrServer\TorrServerManager.exe`;
   - запустить снова с флагом `--background` (тот же флаг, что использует автозапуск).

   `TorrServer.exe`/`JackettConsole.exe` — независимые процессы, перезапускать их для деплоя менеджера не
   нужно.

Линтера в проекте нет; для `.cs`-кода единственная проверка на этом этапе — `dotnet build` чистый. Для
JS-плагина (`Plugins/TorrentModPlugin/`) перед сборкой обязательно:
```bash
npm run test:plugin
```
(`test/{parsing,domain,smoke}.test.mjs` — pure-функции парсинга/скоринга/доменных сценариев, без
браузера). `dotnet build`/`dotnet publish` сами прогоняют `npm run build:plugin` через
`BuildTorrentModPluginBundle`-таргет и падают на синтаксической ошибке бандла, но НЕ проверяют
регресс поведения — тесты нужны отдельно.

**Если стоит dev-override плагина — снести его перед деплоем** (см. следующий раздел): иначе
задеплоенный `.exe` тихо продолжит отдавать старый JS поверх свежего встроенного ресурса, и различие
не будет заметно без явной проверки SHA-256 в `GET /api/config`.

После деплоя, если менялся JS-плагин, обновить его кэш на уже запущенном экземпляре без перезапуска
процесса (`TorrServerManager.exe` перезапускается самим деплоем и сам подхватывает новый встроенный
ресурс, но кэш Plugin Hub на диске нужно перепроверить явно):
```bash
curl -s -X POST -H "Content-Length: 0" http://127.0.0.1:8095/api/plugins/refresh
```

## Если менялся TorrServer

Порядок обратный привычному: сначала тег в форке, потом gitlink в родителе. До второго коммита
субмодуль опережает gitlink, и сборка честно помечает себя дев-сборкой
(`…-TorrentMod.1.6-dev.2.g1a2b3c4` вместо голого тега). Это нормальное состояние в работе, но
выпускать такое нельзя: релизный прогон —
```bash
powershell -ExecutionPolicy Bypass -File .\scripts\build-all.ps1 -RequireRelease
```
Он падает, если HEAD субмодуля не на теге, дерево грязное или gitlink ещё не обновлён. Подробности
и таблица состояний — в [`rebuild-patched-torrserver.md`](rebuild-patched-torrserver.md).

## Если менялся Jackett

Порядок такой же: сначала commit и downstream-тег в форке `LuckyRu/Jackett` на ветке
`jackett-manager`, затем обновление gitlink `external/Jackett` в родительском репозитории.
Теги имеют форму `v<upstream>-JackettManager.<downstream>`, например
`v0.24.2413-JackettManager.1`. Полный релизный прогон проверяет официальный upstream-тег,
чистое дерево и совпадение gitlink:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-all.ps1 -RequireRelease
```

В результате `publish\Jackett\App` содержит self-contained `JackettConsole.exe`, который
можно установить в `%ProgramData%\Jackett\App` без перезаписи пользовательской конфигурации.
Подробная схема версий и локальная сборка описаны в
[`rebuild-patched-jackett.md`](rebuild-patched-jackett.md).

## Если менялся только JS-плагин

Полный цикл (build → publish → deploy) не обязателен для итерации — см.
[`iterate-on-a-plugin-without-rebuilding.md`](iterate-on-a-plugin-without-rebuilding.md). Полный цикл
нужен, когда изменения готовы «насовсем» — тогда JS попадает в embedded resource собранного `.exe`.
