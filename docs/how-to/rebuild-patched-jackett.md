# Собрать Jackett из форка

Jackett подключён как git submodule [`external/Jackett`](../../external/Jackett) из форка
[`LuckyRu/Jackett`](https://github.com/LuckyRu/Jackett). Рабочая downstream-ветка форка —
`jackett-manager`; родительский репозиторий фиксирует конкретный commit через gitlink, поэтому
clean clone всегда собирает именно проверенный исходный код.

## Версионирование

Теги форка имеют форму:

```text
v<upstream>-JackettManager.<downstream>
```

Например, `v0.24.2413-JackettManager.1` означает официальный Jackett `v0.24.2413` плюс
первую downstream-итерацию. Часть до `-JackettManager` обязана быть стабильным тегом
upstream `Jackett/Jackett`; сборщик проверяет и GitHub Release, и commit тега. Суффикс
увеличивается при каждом выпуске изменений форка. Рабочее состояние между тегами получает
версию `...-dev.<коммитов после тега>.g<sha>[.dirty]` и не может пройти `-RequireRelease`.

Ветка и первый тег уже опубликованы в форке:

```text
https://github.com/LuckyRu/Jackett/tree/jackett-manager
v0.24.2413-JackettManager.1
```

Порядок обновления такой же, как у TorrServer: сначала commit/тег в форке, затем обновление
gitlink `external/Jackett` в родительском репозитории отдельным коммитом.

## Сборка

После clone:

```powershell
git clone --recurse-submodules <repository-url>
Set-Location <repository-directory>
powershell -ExecutionPolicy Bypass -File .\scripts\build-all.ps1
```

Для уже существующего clone:

```powershell
git submodule update --init --recursive
```

`build-all.ps1` проверяет downstream-тег и upstream-базу Jackett, после чего выполняет
self-contained publish `src/Jackett.Server/Jackett.Server.csproj` для `win-x64`/`net9.0`.
Артефакты складываются в:

```text
publish\Jackett\App\JackettConsole.exe
publish\TorrServer.exe
publish\TorrServerManager.exe
```

Версия Jackett в бинарнике остаётся числовой upstream-версией (её понимает штатный UI и
обновлятор), а downstream-версия хранится в `InformationalVersion` и в баннере сборки.

Релизный прогон требует, чтобы оба submodule были на своих downstream-тегах, рабочие деревья
были чистыми, а gitlink родителя совпадал с HEAD:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-all.ps1 -RequireRelease
```

Без `-RequireRelease` сборщик явно помечает дев-состояние, но продолжает сборку для локальной
проверки. Исходники submodule не форматируются и не патчатся на месте; промежуточные файлы
остаются в игнорируемом `.build\`/`bin\`.

## Установка локального артефакта

Содержимое `publish\Jackett\App` копируется в `%ProgramData%\Jackett\App` после остановки
Jackett. Конфигурация и индексаторы находятся отдельно в `%ProgramData%\Jackett` и не должны
перезаписываться. Менеджер продолжает запускать `JackettConsole.exe` с `--NoUpdates`, поэтому
обновление исходной fork-версии выполняется через новый source-release, а не встроенным
updater Jackett.
