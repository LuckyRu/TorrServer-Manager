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
| `UpdateService.cs` | Проверка/скачивание/установка обновлений TorrServer с GitHub Releases, SHA-256, откат при неудачном старте. |
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
- `/plugins/*.js` и `/lampa.js` отдаются с `Cache-Control: no-cache` — без этого устройство в LAN может
  бесконечно держать устаревшую копию, не спрашивая сервер вообще.

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
