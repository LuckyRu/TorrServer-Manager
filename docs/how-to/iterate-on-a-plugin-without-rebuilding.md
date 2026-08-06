# Как быстро итерировать JS-плагин без пересборки .NET-приложения

Для встроенных плагинов (сейчас — только `TorrentModPlugin.js`, см.
[`reference/architecture-map.md`](../reference/architecture-map.md)) не нужно гонять полный
build/publish/restart-цикл на каждую правку одной строчки.

## Как это работает

`BuiltInPlugins.Read()` сначала проверяет
`%LocalAppData%\TorrServer\dev-plugins\<ИмяФайла>.js` (то же имя файла, что у `EmbeddedResource` в
`.csproj`) и только при его отсутствии читает встроенный ресурс из сборки.

## Шаги

1. Отредактировать `TorrentModPlugin.js` в репозитории как обычно.
2. Скопировать в override-директорию:
   ```bash
   cp TorrentModPlugin.js "$LOCALAPPDATA/TorrServer/dev-plugins/TorrentModPlugin.js"
   ```
3. Дёрнуть локальный (loopback-only) эндпоинт обновления кэша Plugin Hub — **обязательно с `-d ""`**,
   иначе `HttpListener` ответит 411 (нет Content-Length у POST-запроса без тела):
   ```bash
   curl -s -X POST http://127.0.0.1:8095/api/plugins/refresh -d ""
   ```
   Дальше срабатывает обычный путь SHA-256-диффинга — если контент изменился, кэш обновляется без
   пересборки/republish/рестарта процесса.
4. Обновить страницу в браузере (`http://127.0.0.1:8095/app/`), если тестируете там, или дождаться, пока
   ТВ-устройство подхватит новую версию (см. ниже про кэш на стороне устройства).

## Проверка синтаксиса перед деплоем

```bash
node --check TorrentModPlugin.js
```
Дешёвая проверка, ловит опечатки до того, как они дойдут до `Lampa.Component.create`'s try/catch, который
на любое исключение конструктора **молча** подменяет компонент на `nocomponent` (пустой экран «Здесь
пусто», без видимой ошибки) — см.
[`reference/architecture-map.md`](../reference/architecture-map.md#gotchas) за подробностями этой ловушки.

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
