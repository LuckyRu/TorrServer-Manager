# Порты, пути, эндпоинты

Источник истины в коде: `AppPaths.cs` для путей/портов, `PluginHub.cs` для маршрутов. Эта страница —
её актуальный слепок; при расхождении верить коду.

## Порты

| Порт | Сервис | Доступность |
|---|---|---|
| `8090` | TorrServer | LAN (правило файервола) |
| `8095` | Plugin Hub | LAN (правило файервола) |
| `9117` | Jackett | только `127.0.0.1` — см. [ADR-0002](../adr/0002-jackett-loopback-reverse-proxy.md) |
| `8191` | FlareSolverr | только `127.0.0.1`, запускается менеджером для Jackett |

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
| `%ProgramData%\FlareSolverr\flaresolverr\` | Официальный FlareSolverr для Windows x64 (`flaresolverr.exe` и встроенный Chromium); менеджер обновляет каталог атомарно с резервным откатом |

## Эндпоинты Plugin Hub (`:8095`)

| Метод | Путь | Назначение | Доступ |
|---|---|---|---|
| `GET` | `/` | HTML-панель управления плагинами | LAN |
| `GET` | `/health` | Проверка живости | LAN |
| `GET` | `/api/config` | Текущая конфигурация (JSON) | LAN |
| `POST` | `/api/config` | Сохранить конфигурацию + запустить рефреш | loopback |
| `POST` | `/api/plugins/refresh` | Форс-рефреш кэша плагинов (нужен `-d ""` в curl) | loopback |
| `GET` | `/api/search-rules` | Студии перевода из `data\search-rules.json` (пополняются без пересборки) | LAN |
| `GET` | `/api/torrent-search/start` | Запустить поиск: возвращает `{jobId, totalIndexers, indexers[]}`, по одной задаче на индексатор | LAN |
| `GET` | `/api/torrent-search/poll` | Накопленные результаты и состояние каждого индексатора (`ok`, `elapsedMs`) | LAN |
| `GET` | `/api/torrent-search/cancel` | Отмена поиска. Именно `GET`: `HttpListener` требует `Content-Length` даже на пустом `POST` | LAN |
| `GET` | `/lampa.js` | Bootstrap loader — читает `/api/config`, инжектит включённые плагины | LAN |
| `GET` | `/plugins/{cacheKey}.js` | Закэшированный плагин (по SHA-256-based ключу) | LAN |
| `GET` | `/favicon.ico` | Иконка хостимого Lampa-приложения для WebOS/WebView | LAN |
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

### Ссылки в `/api/torrent-search` — loopback, потому что их потребляет TorrServer

Jackett кладёт в `Link` результата свой loopback download-эндпоинт (`http://127.0.0.1:9117/dl/...`).
`PluginHub` переписывает их на **`http://127.0.0.1:8095/jackett/...`** (наш reverse-proxy). Это
намеренно loopback, а не LAN-IP: единственный потребитель этих ссылок — **TorrServer на этом же
ПК** (плагин передаёт `link` в JSON `POST /torrents`, ТВ сам `.torrent` не скачивает). Переписывание
на LAN-IP было живым багом: TorrServer не мог дозвониться до собственного LAN-адреса
(`dial tcp 192.168.10.108:8095: connection refused` в `server.log`), и все раздачи, отдающие только
`.torrent`-ссылку без magnet (сейчас так все настроенные индексаторы), зависали навсегда.
Текущий Torrent Mod отправляет этот `link` в TorrServer напрямую через JSON `POST /torrents`;
телевизор не скачивает `.torrent` сам.

## Эндпоинты TorrServer, на которые опирается Torrent Mod (не наш код, для справки)

| Путь | Назначение |
|---|---|
| `POST /torrents {action:'list'}` | Поиск уже зарегистрированной раздачи по title/hash перед повторным добавлением |
| `POST /torrents {action:'add', link, title, ...}` | Регистрация magnet или loopback `.torrent`-ссылки |
| `POST /torrents {action:'get', hash}` | Список файлов раздачи (`file_stats[]`, у каждого свой `.id`, не позиция в массиве) |
| `GET /gst/{hash}/master.m3u8?index={fileId}&audio=0&client={id}` | **Единственный транспорт воспроизведения**: GST/HLS. Плейлист уводит на `/gst/{hash}/c/{token}/…`, дальше сессия несётся в самом URL |
| `GET /stream/...` | **Не** транспорт воспроизведения. Используется только для тихого `&preload` — прогрева следующей серии ([ADR-0003](../adr/0003-no-global-player-patching.md): `url_reserve` не передаётся, fallback на прямой поток отсутствует намеренно) |
| `POST /cache {action:'get', hash}` | Справочный API статуса буферизации; текущий Torrent Mod не поллит его для собственного pre-start buffer |
| `GET /ffp/{hash}/{fileId}` | ffprobe-снятые характеристики потоков (реальные, не угаданные из названия); 400, если TorrServer не нашёл `ffprobe`; менеджер его не ставит, так что на наших установках — всегда 400 |
