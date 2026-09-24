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
| `ServerController.cs` | `TorrServer.exe` как дочерний процесс: старт/стоп/рестарт, HTTP health-check `127.0.0.1:8090`, downstream-версия из `--version` (формат `MatriX.x.x-TorrentMod.x.x`); версия кэшируется по времени изменения и размеру `.exe`. LAN-адрес — адаптер со шлюзом по умолчанию, а не первый попавшийся (коммутатор Hyper-V/WSL тоже числится Ethernet с частным адресом). |
| `JackettController.cs` | `JackettConsole.exe` та же схема, без службы Windows и UAC. Флаги: `-z --DataFolder <dir> -p 9117 --NoUpdates`. |
| `ProcessRecoveryTracker.cs` | Состояние supervisor для TorrServer, Jackett и FlareSolverr: порог HTTP-сбоев, экспоненциальный backoff и журналирование восстановления. Ручной Stop меняет желаемое состояние и не компенсируется автозапуском. |
| `UpdateService.cs` | Проверяет официальные upstream-релизы TorrServer и сравнивает их с upstream-базой локального downstream-тега. Установка не выполняется: новая база требует rebase downstream-ветки и пересборки. |
| `LanAccessService.cs` | Доступ из LAN: правила файервола для TorrServer/Plugin Hub и резервирование URL `http://+:8095/` под SID пользователя (без него `HttpListener` не слушает все интерфейсы без прав администратора). Проверка — без повышения прав (`Get-NetFirewallRule`, `netsh http show urlacl`); всё недостающее создаётся одним elevated-шагом, одним UAC-запросом. Выполняется последним шагом старта: службы не ждут ответа на UAC. Jackett правило не нужно (loopback-only). |

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

- Меняющие `POST` (`/api/config`, `/api/plugins/refresh`) принимаются только с loopback **и** без `Origin` либо с `Origin`
  самой панели (`http://127.0.0.1:8095`, `localhost`): любая страница в браузере на этом ПК тоже ходит на 127.0.0.1.
  CORS разрешает только `GET` — Lampa с других origin хаб лишь читает.
- `hls.js` 1.4+ берёт таймауты фрагментов только из `fragLoadPolicy`; старые `fragLoading*` в его умолчаниях игнорируются.
  Хаб дописывает к отдаваемому `vender/hls/hls.js` скрипт, который поднимает `Hls.DefaultConfig.fragLoadPolicy`
  (первый байт — до 60 с: сегмент GST после перемотки бывает дольше 10 с). Заменам текста в `app.min.js` нужен якорь;
  если его нет, в `manager.log` пишется `Lampa patch not applied` — Lampa обновляется сама, и патч не должен молча отваливаться.

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
| `TorrentModPlugin.js` | Единственный встроенный плагин сейчас. Поиск+просмотр торрентов, свой экран. Глубокий разбор — [`system-design/torrent-mod-search-pipeline.md`](../system-design/torrent-mod-search-pipeline.md), [`system-design/lampa-navigation-contract.md`](../system-design/lampa-navigation-contract.md) и [план оптимизации рендера](../system-design/torrent-mod-render-performance.md). |

`SmartTsPlugin.js` — предшественник, убран (см. [ADR-0001](../adr/0001-torrent-mod-own-screen.md) и
запись в `BuiltInPlugins.cs`/`CLAUDE.md` про удаление).

### `Lampa.Component.create`'s ловушка (важно для отладки)

Любое исключение в конструкторе компонента **молча** подменяется на `nocomponent` (пустой экран «Здесь
пусто»), без видимой ошибки пользователю. Реальная причина — в `console.log('Component', 'create
error', ...)` в devtools, смотреть его первым, если экран не рендерится.
