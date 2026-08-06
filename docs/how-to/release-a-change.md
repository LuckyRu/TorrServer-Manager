# Как выпустить изменение

1. Внести правки в коде.
2. Поднять `<Version>` в `TorrServerManager.csproj` по SemVer2 — на каждое пользовательски заметное
   изменение. Версия обязана быть видна в UI главного окна и в подсказке трея (`NotifyIcon.Text`), не
   только в метаданных сборки — это уже сделано (`MainForm.ReadAppVersion()` читает
   `AssemblyInformationalVersion`), новых мест подключать не нужно.
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
   - сохранить старый экзешник рядом как `TorrServerManager.v<старая-версия>.bak.exe` (тот же паттерн,
     что у уже лежащих `.bak.exe` файлов);
   - скопировать свежесобранный `.exe` поверх `%LocalAppData%\Programs\TorrServer\TorrServerManager.exe`;
   - запустить снова с флагом `--background` (тот же флаг, что использует автозапуск).

   `TorrServer.exe`/`JackettConsole.exe` — независимые процессы, перезапускать их для деплоя менеджера не
   нужно.

Тестов и линтера в проекте нет — единственная проверка на этом этапе: `dotnet build` чистый.

## Если менялся только JS-плагин

Полный цикл (build → publish → deploy) не обязателен для итерации — см.
[`iterate-on-a-plugin-without-rebuilding.md`](iterate-on-a-plugin-without-rebuilding.md). Полный цикл
нужен, когда изменения готовы «насовсем» — тогда JS попадает в embedded resource собранного `.exe`.
