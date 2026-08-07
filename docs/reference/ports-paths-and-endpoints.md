# Порты, пути, эндпоинты

Источник истины в коде: `AppPaths.cs` для путей/портов, `PluginHub.cs` для маршрутов. Эта страница —
её актуальный слепок; при расхождении верить коду.

## Порты

| Порт | Сервис | Доступность |
|---|---|---|
| `8090` | TorrServer | LAN (правило файервола) |
| `8095` | Plugin Hub | LAN (правило файервола) |
| `9117` | Jackett | только `127.0.0.1` — см. [ADR-0002](../adr/0002-jackett-loopback-reverse-proxy.md) |

## Пути на диске

| Путь | Назначение |
|---|---|
| `%LocalAppData%\Programs\TorrServer\` | Установочная директория (`TorrServer.exe`, `TorrServerManager.exe`) |
| `%LocalAppData%\TorrServer\` | Состояние/данные/логи менеджера |
| `%LocalAppData%\TorrServer\data\` | Данные TorrServer |
| `%LocalAppData%\TorrServer\logs\` | `server.log`, `manager.log` |
| `%LocalAppData%\TorrServer\lampa-plugins.json` | Конфигурация Plugin Hub (список плагинов, режим поиска) |
| `%LocalAppData%\TorrServer\lampa-cache\` | SHA-256-кэш скачанных плагинов |
| `%LocalAppData%\TorrServer\lampa-app\` | Хостящаяся статика самого Lampa web-app |
| `%LocalAppData%\TorrServer\lampa-app-state.json` | Состояние авто-обновления Lampa web-app |
| `%LocalAppData%\TorrServer\dev-plugins\` | Override-директория для быстрой JS-итерации, см. [`how-to/iterate-on-a-plugin-without-rebuilding.md`](../how-to/iterate-on-a-plugin-without-rebuilding.md) |
| `%ProgramData%\Jackett\` | Установка Jackett (`App\JackettConsole.exe`, `Indexers\`, `ServerConfig.json`) |

## Эндпоинты Plugin Hub (`:8095`)

| Метод | Путь | Назначение | Доступ |
|---|---|---|---|
| `GET` | `/` | HTML-панель управления плагинами | LAN |
| `GET` | `/health` | Проверка живости | LAN |
| `GET` | `/api/config` | Текущая конфигурация (JSON) | LAN |
| `POST` | `/api/config` | Сохранить конфигурацию + запустить рефреш | loopback |
| `POST` | `/api/plugins/refresh` | Форс-рефреш кэша плагинов (нужен `-d ""` в curl) | loopback |
| `GET` | `/api/torrent-search?query=` | Агрегированный поиск по всем индексаторам Jackett для Torrent Mod | LAN |
| `GET` | `/lampa.js` | Bootstrap loader — читает `/api/config`, инжектит включённые плагины | LAN |
| `GET` | `/plugins/{cacheKey}.js` | Закэшированный плагин (по SHA-256-based ключу) | LAN |
| `GET`/etc | `/app/*` | Статика самого Lampa web-app (`yumata/lampa` дистрибутив) | LAN |
| `GET` | `/jackett/*` | Reverse proxy к loopback Jackett, путь+query один в один | LAN |

### Заглушки в статике `/app/` (Lampa запрашивает сама)

Lampa при каждом старте стучится в корень хостимого приложения за двумя файлами, которых в
`yumata/lampa`-дистрибутиве нет. Чтобы не было шумных 404 в консоли (у `modification.js` 404 ещё и
приходил с JSON MIME — браузер отказывался выполнять его как скрипт), `PluginHub` отдаёт валидные
заглушки:

| Путь | Заглушка | Зачем это Lampa |
|---|---|---|
| `GET /app/plugins_black_list.json` | `[]` (пустой массив) | Чёрный список плагинов; Lampa добавляет его в Status-строку `custom` (`src/core/plugins.js`, `loadBlackList`) |
| `GET /app/plugins/modification.js` | пустой JS-скрипт (`// no-op stub`) | Собственный плагин `modification.js` — не входит в эту сборку Lampa |

Реализация: `PluginHub.WriteLampaAppFileAsync` (до проверки существования файла на диске).
Если когда-нибудь понадобится реальный чёрный список — заменить заглушку на настоящий JSON-массив
подстрок (формат: `["lampa.line.pm", "cub.rip/…"]`, Lampa фильтрует плагины по подстроке).

`/api/smart-search` существовал для убранного `SmartTsPlugin.js`, удалён вместе с ним.

### Кэш-заголовки, на которые можно полагаться

`/plugins/{cacheKey}.js` и `/lampa.js` — оба `Cache-Control: no-cache`, первый ещё и honours
`If-None-Match` реальным 304. Устройство в LAN обязано перепроверять с сервером перед использованием
кэшированной копии — без этого правки могли годами не доходить до реального устройства даже после
пересборки/republish.

## Эндпоинты TorrServer, на которые опирается Torrent Mod (не наш код, для справки)

| Путь | Назначение |
|---|---|
| `POST /torrents {action:'get', hash}` | Список файлов раздачи (`file_stats[]`, у каждого свой `.id`, не позиция в массиве) |
| `POST /cache {action:'get', hash}` | Статус буферизации (`preloaded_bytes`, `download_speed`, `connected_seeders`, `active_peers`) |
| `GET /ffp/{hash}/{fileId}` | ffprobe-снятые характеристики потоков (реальные, не угаданные из названия); 400, если на этой сборке TorrServer нет `ffprobe` |
