# Как быстро итерировать JS-плагин без пересборки .NET-приложения

Для встроенных плагинов (сейчас — только `TorrentModPlugin.js`, см.
[`reference/architecture-map.md`](../reference/architecture-map.md)) не нужно гонять полный
build/publish/restart-цикл на каждую правку одной строчки.

## Как это работает

`BuiltInPlugins.Read()` сначала проверяет
`%LocalAppData%\TorrServer\dev-plugins\<ИмяФайла>.js` (то же имя файла, что у `EmbeddedResource` в
`.csproj`) и только при его отсутствии читает встроенный ресурс из сборки.

## Шаги

Исходник живёт как настоящие ES-модули под `Plugins/TorrentModPlugin/` (не один плоский файл — см.
[`reference/architecture-map.md`](../reference/architecture-map.md) за структурой папок), поэтому
итерация идёт через esbuild, не через ручное копирование:

1. Отредактировать нужные файлы под `Plugins/TorrentModPlugin/` как обычно.
2. Запустить один раз (или держать в фоне) — оба пишут в тот же override-путь, который
   `BuiltInPlugins.Read()` проверяет первым:
   ```bash
   npm run dev:plugin          # esbuild watch — пересобирает на каждое сохранение, не завершается
   # либо разово:
   npm run install:plugin-dev  # тот же билд, но один раз и с выходом (для CI/задач)
   ```
3. Дёрнуть локальный (loopback-only) эндпоинт обновления кэша Plugin Hub — **обязательно с телом**
   (даже пустым), иначе `HttpListener` ответит 411 (нет `Content-Length` у POST без тела):
   ```bash
   curl -s -X POST -H "Content-Length: 0" http://127.0.0.1:8095/api/plugins/refresh
   ```
   Дальше срабатывает обычный путь SHA-256-диффинга — если контент изменился, кэш обновляется без
   пересборки/republish/рестарта процесса.
4. Обновить страницу в браузере (`http://127.0.0.1:8095/app/`), если тестируете там, или дождаться, пока
   ТВ-устройство подхватит новую версию (см. ниже про кэш на стороне устройства).

**Перед «настоящим» деплоем (см. [`release-a-change.md`](release-a-change.md)) обязательно удалить
override-файл** (`%LocalAppData%\TorrServer\dev-plugins\TorrentModPlugin.js`) — иначе задеплоенный
`.exe` тихо продолжит отдавать старый dev-JS поверх свежего встроенного ресурса, и это не будет заметно
без явной проверки хеша. Это реально происходило.

## Проверка перед деплоем

```bash
npm run test:plugin   # test/{parsing,domain,smoke}.test.mjs — pure-функции и доменные сценарии
npm run build:plugin   # финальная сборка бандла esbuild'ом, ловит синтаксис/резолв импортов
```
Дешёвая, но не покрывает DOM/Lampa-интеграцию — та часть остаётся live-verified (см.
[`verify-lampa-behavior-live.md`](verify-lampa-behavior-live.md)). Синтаксическая опечатка, которая всё
же доедет до рантайма, обычно проявится как `Lampa.Component.create`'s try/catch, который на любое
исключение конструктора **молча** подменяет компонент на `nocomponent` (пустой экран «Здесь пусто», без
видимой ошибки) — см. [`reference/architecture-map.md`](../reference/architecture-map.md#gotchas) и
[`reference/torrent-mod-gotchas.md`](../reference/torrent-mod-gotchas.md) за подробностями этой ловушки.

## Кэш на стороне устройства

`/plugins/*.js` и `/lampa.js` отдаются с `Cache-Control: no-cache` + `ETag` (см.
[`reference/ports-paths-and-endpoints.md`](../reference/ports-paths-and-endpoints.md)) — устройство в LAN
обязано перепроверить с сервером перед каждым использованием кэшированной копии, так что обновление,
сделанное шагами выше, должно доходить до реального ТВ на следующей же загрузке экрана/приложения без
ручных танцев с очисткой кэша на самом устройстве.

## Когда это НЕ подходит

- Правки в `.cs`-файлах — нужен полный цикл, см. [`release-a-change.md`](release-a-change.md).
- Добавление/удаление самого встроенного плагина как сущности (запись в `BuiltInPlugins.Definitions`,
  `<EmbeddedResource>` в `.csproj`) — тоже требует пересборки; dev-override работает только для контента
  уже зарегистрированного плагина.
