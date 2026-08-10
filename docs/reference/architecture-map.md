# Карта компонентов

Справочная, не объяснительная страница — что где лежит и что делает, коротко. За «почему» — в
[`explanation/`](../explanation/) и [`adr/`](../adr/); за глубоким разбором конкретных подсистем — в
[`system-design/`](../system-design/). Подробный, постоянно обновляемый первоисточник —
[`CLAUDE.md`](../../CLAUDE.md) в корне репозитория; эта страница — его сжатая карта для быстрой
ориентации.

## Точка входа и жизненный цикл

| Файл | Роль |
|---|---|
| `Program.cs` | Entry point. Single-instance через именованный `Mutex`; сигнализирует уже запущенному инстансу через `EventWaitHandle` `Local\TorrServerManager.Show`. |
| `MainForm.cs` | Трей/окно статуса. Опрос статуса каждые 2.5с. Закрытие окна прячет в трей; выход — только через пункт трея. |
| `AppPaths.cs` | Единый источник путей и портов. |
| `AppLog.cs` | Файловый логгер (`manager.log`), ошибки логирования проглатываются — логирование не должно ронять трей-приложение. |
| `IconFactory.cs` | Рендер иконки трея (GDI+, буква «T» + цветной статус-индикатор). |

## Управляемые процессы

| Файл | Роль |
|---|---|
| `ServerController.cs` | `TorrServer.exe` как дочерний процесс: старт/стоп/рестарт, HTTP health-check `127.0.0.1:8090`, версия из `--version` (формат `MatriX.x.x.x`). |
| `JackettController.cs` | `JackettConsole.exe` та же схема, без службы Windows и UAC. Флаги: `-z --DataFolder <dir> -p 9117 --NoUpdates`. |
| `ProcessRecoveryTracker.cs` | Состояние supervisor для TorrServer, Jackett и FlareSolverr: порог HTTP-сбоев, экспоненциальный backoff и журналирование восстановления. Ручной Stop меняет желаемое состояние и не компенсируется автозапуском. |
| `UpdateService.cs` | Проверяет GitHub Releases TorrServer и сравнивает версии. Установка намеренно отключена: локальный GST patch требует обновления исходников и пересборки. |
| `FirewallService.cs` | На старте — non-elevated проверка правил `Get-NetFirewallRule`; если нет — один elevated `New-NetFirewallRule` (`-EncodedCommand`, один UAC-запрос) для портов TorrServer/Plugin Hub. Jackett правило не нужно (loopback-only). |

## Plugin Hub (`PluginHub.cs`) — крупнейший файл

Свой `HttpListener` на `:8095`. См.
[`reference/ports-paths-and-endpoints.md`](ports-paths-and-endpoints.md) за полным списком эндпоинтов.

- Панель управления плагинами на `/`.
- Кэширование плагинов (`lampa-cache/`, SHA-256-диффинг), раздача по `/plugins/{cacheKey}.js`.
- `/lampa.js` — bootstrap loader, читает `/api/config`, инжектит включённые плагины.
- `/jackett/*` — reverse proxy к loopback Jackett (см. [ADR-0002](../adr/0002-jackett-loopback-reverse-proxy.md)).
- `/api/torrent-search` — агрегированный поиск через Jackett для Torrent Mod.
- Хостинг самого Lampa web-app (`/app/*`) с автообновлением по `assembly.json`.

### Gotchas

- `HttpListenerRequest.Url.AbsolutePath` обрезает конечный слэш — маршруты `/app` и `/app/` нужно
  обрабатывать в одной ветке, иначе редирект зацикливается.
- `LoadConfiguration()`'s catch-all раньше мог стереть **всю** конфигурацию плагинов из-за ошибки в
  ОДНОЙ записи (см. фикс в `PluginHub.cs Validate()` — `builtin://` схема теперь принимается структурно
  валидной независимо от того, зарегистрирован ли ещё такой плагин).
- `/plugins/*.js` и `/lampa.js` отдаются с `Cache-Control: no-cache` (не `no-store`) + `ETag`, с реальным
  304 на `If-None-Match` — без этого устройство в LAN может бесконечно держать устаревшую копию, не
  спрашивая сервер вообще; `no-cache` вместо `no-store` сохраняет дешёвую реревалидацию (204 без тела).
- `HttpListener` требует `Content-Length` даже на пустой POST — `curl -X POST` без `-H "Content-Length: 0"`
  или `-d ""` получит 411. Актуально для `/api/plugins/refresh` и любого другого mutating-эндпоинта.
- Прямой бинд Jackett на `0.0.0.0` отвергнут — `JackettConsole.exe` отказывается слушать публично без
  elevated-запуска (собственная внутренняя проверка, не HTTP.SYS/URL-ACL); отсюда reverse-proxy `/jackett/*`
  вместо прямого LAN-доступа к Jackett. См. [ADR-0002](../adr/0002-jackett-loopback-reverse-proxy.md) и
  [`explanation/why-jackett-stays-loopback.md`](../explanation/why-jackett-stays-loopback.md).

## Плагины Lampa

| Файл | Роль |
|---|---|
| `BuiltInPlugins.cs` | Массив `BuiltInPluginDefinition` (id/url/name/category/embedded resource); `Read()` сначала проверяет dev-override директорию (см. [`how-to/iterate-on-a-plugin-without-rebuilding.md`](../how-to/iterate-on-a-plugin-without-rebuilding.md)). |
| `TorrentModPlugin.js` | Единственный встроенный плагин сейчас. Поиск+просмотр торрентов, свой экран. Глубокий разбор — [`system-design/torrent-mod-search-pipeline.md`](../system-design/torrent-mod-search-pipeline.md) и [`system-design/lampa-navigation-contract.md`](../system-design/lampa-navigation-contract.md). |

`SmartTsPlugin.js` — предшественник, убран (см. [ADR-0001](../adr/0001-torrent-mod-own-screen.md) и
запись в `BuiltInPlugins.cs`/`CLAUDE.md` про удаление).

### `Lampa.Component.create`'s ловушка (важно для отладки)

Любое исключение в конструкторе компонента **молча** подменяется на `nocomponent` (пустой экран «Здесь
пусто»), без видимой ошибки пользователю. Реальная причина — в `console.log('Component', 'create
error', ...)` в devtools, смотреть его первым, если экран не рендерится.
