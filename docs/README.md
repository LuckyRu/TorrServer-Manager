# Документация TorrServerManager

Эта папка организована по методологии [Diataxis](https://diataxis.fr/) — документация делится на
четыре рода по тому, **зачем** её читают, а не по теме:

| Раздел | Отвечает на | Когда открывать |
|---|---|---|
| [`tutorials/`](tutorials/) | «Проведи меня за руку» | Первый раз трогаешь проект |
| [`how-to/`](how-to/) | «Как мне сделать X?» | Знаешь, что нужно, не помнишь шаги |
| [`reference/`](reference/) | «Как это устроено точно?» | Нужен точный факт: порт, формула, эндпоинт |
| [`explanation/`](explanation/) | «Почему это так, а не иначе?» | Нужен контекст, а не инструкция |

Плюс два раздела не из классического Diataxis, но обязательных для агентного мира, где решения
принимаются быстро и их важно не забыть:

- [`adr/`](adr/) — Architecture Decision Records: короткие протоколы «был выбор → выбрали X → вот почему,
  вот что отвергли». Не переписываются задним числом — если решение отменили, пишется новый ADR со
  ссылкой на старый, а не правится история.
- [`system-design/`](system-design/) — глубокие разборы того, как что-то работает *и как мы это узнали*.
  Это не пересказ кода, а протокол исследования: что проверили вживую, какой код читали, что оказалось
  не так, как казалось. Процессные документы, а не только результат.

## Чем это отличается от CLAUDE.md

[`CLAUDE.md`](../CLAUDE.md) в корне репозитория — это инструкции для Claude Code (агента), которые
подгружаются в контекст автоматически на каждой сессии: конвенции, команды сборки, и очень плотный
журнал находок вперемешку с архитектурой. Он оптимизирован для машинного чтения за один проход, не для
человека, который хочет разобраться в чём-то одном.

`docs/` — то же знание, но разложенное по полочкам для человека и с сохранением связей между
документами. Знание не дублируется бездумно: `CLAUDE.md` — плотный конспект с прямыми ссылками на файлы
кода; `docs/` — тот же материал, реструктурированный по Diataxis, с оглавлением и явными ссылками между
ADR/system-design/reference там, где одно объясняет другое. Когда факт меняется, источником истины
становится тот документ, где он логически живёт (обычно `docs/reference/` или `docs/system-design/`), и
`CLAUDE.md` при следующей правке должен на него ссылаться, а не дублировать текст.

## Карта

- **Только начинаешь?** → [`tutorials/first-plugin-tweak.md`](tutorials/first-plugin-tweak.md)
- **Нужно выпустить изменение?** → [`how-to/release-a-change.md`](how-to/release-a-change.md)
- **Нужно пересобрать TorrServer с расширенным GST-пайплайном?** →
  [`how-to/rebuild-patched-torrserver.md`](how-to/rebuild-patched-torrserver.md)
- **Нужно собрать Jackett из downstream-форка?** →
  [`how-to/rebuild-patched-jackett.md`](how-to/rebuild-patched-jackett.md)
- **Правишь JS-плагин и не хочешь пересобирать .exe?** →
  [`how-to/iterate-on-a-plugin-without-rebuilding.md`](how-to/iterate-on-a-plugin-without-rebuilding.md)
- **Нужно проверить, как на самом деле ведёт себя Lampa?** →
  [`how-to/verify-lampa-behavior-live.md`](how-to/verify-lampa-behavior-live.md)
- **Точная карта компонентов** → [`reference/architecture-map.md`](reference/architecture-map.md)
- **API Lampa для плагинов** (Component/Activity, Explorer/Scroll/Filter/Select/Controller, Template,
  TMDB, дизайн-токены, нативные парсеры сезонов/серий) → [`reference/lampa-plugin-api.md`](reference/lampa-plugin-api.md)
- **API плеера Lampa** (`Player.play(data)` контракт, GST-first вместо `url_reserve`, потенциальный
  `data.ffprobe` трек-пикер, плейлист/переключение серий, события `PlayerVideo`/`Panel`) →
  [`reference/lampa-player-api.md`](reference/lampa-player-api.md)
- **Порты, пути, эндпоинты** → [`reference/ports-paths-and-endpoints.md`](reference/ports-paths-and-endpoints.md)
- **GStreamer: устойчивость к хаотичному плееру** (аудит с разбором кода — зависание на записи под
  локом задачи, вытеснение задач при смене серии, неотменяемые перемотки; реализованные правки и
  инварианты, которые нельзя сломать при разборе конфликтов патчей) →
  [`system-design/gstreamer-pipeline-robustness.md`](system-design/gstreamer-pipeline-robustness.md)
- **GStreamer: точность перемотки** (почему индекс keyframe'ов и точная перемотка — разные вопросы,
  матрица «контейнер × режим», несовместимость флагов `ACCURATE` и `KEY_UNIT`, три точки обрезки и
  почему они в разных местах пайплайна) →
  [`system-design/gstreamer-seek-accuracy.md`](system-design/gstreamer-seek-accuracy.md)
- **GStreamer: организация пайплайнов по форматам** (проект: почему решение «как играть файл»
  переоткрывается в семи местах и как это даёт расхождения; два живых дефекта с доказательствами —
  неизвестный кодек собирает пайплайн без видеодорожки, `TranscodeVP8` не читается; целевая модель
  Capabilities → Plan → реализация и порядок перехода) →
  [`system-design/gst-pipeline-plan-architecture.md`](system-design/gst-pipeline-plan-architecture.md)
- **Три идентичности: клиент, пайплайн, торрент** (целевая модель тракта `клиент → HTTP → GST →
  торрент` для нескольких домашних клиентов: как HTTP различает клиентов, почему пайплайн на пару
  «клиент + файл», как масштабировать кэш и бюджет соединений одного торрента) →
  [`system-design/three-identities-client-pipeline-torrent.md`](system-design/three-identities-client-pipeline-torrent.md)
  — и пошаговый план работ к нему:
  [`system-design/three-identities-implementation-plan.md`](system-design/three-identities-implementation-plan.md)
- **Сценарии использования и план автотестов** (карта пользовательских сценариев с режимами отказа,
  аудит покрытия — что покрыто иллюзорно, приёмы детерминированных тестов на гонки, матрица
  «дефект → тест») → [`system-design/scenarios-and-test-plan.md`](system-design/scenarios-and-test-plan.md)
- **Один торрент — несколько потоков: конкурентность** (что делят одновременные воспроизведения
  одной раздачи: подтверждённые гонки закрытые и оставшиеся, проход вытеснения, который меняет то,
  что измеряет, гейт торрента, выключающийся под нагрузкой) →
  [`system-design/one-torrent-many-streams-concurrency.md`](system-design/one-torrent-many-streams-concurrency.md)
- **Формула оценки раздач Torrent Mod** (гейт, скоринг, сегодняшний фикс шумного поиска по названию) →
  [`reference/torrent-mod-scoring-model.md`](reference/torrent-mod-scoring-model.md)
- **Справочник по граблям JS/API Torrent Mod** (кириллица в регэкспах, `Component.create`,
  identity для персиста, порядок null-проверок) → [`reference/torrent-mod-gotchas.md`](reference/torrent-mod-gotchas.md)
- **Почему Jackett не слушает LAN напрямую** →
  [`explanation/why-jackett-stays-loopback.md`](explanation/why-jackett-stays-loopback.md)
- **Как вообще с Lampa работать плагину, чтобы не ломать её** (Controller/Activity/Explorer/Select/
  Scroll — 10 задокументированных багов и общий контракт) →
  [`system-design/lampa-navigation-contract.md`](system-design/lampa-navigation-contract.md)
- **Как устроен поиск/скоринг/буферизация Torrent Mod целиком** →
  [`system-design/torrent-mod-search-pipeline.md`](system-design/torrent-mod-search-pipeline.md)
- **Какие трекеры поддержаны, как оформлены их раздачи и в каком порядке работают парсеры**
  (профиль каждого трекера, порядок правил разбора, замеры извлечения по девяти трекерам,
  особенности фильмов, сериалов и азиатской продукции, коды отказов) →
  [`reference/torrent-mod-tracker-formats.md`](reference/torrent-mod-tracker-formats.md)
- **Что ещё имеет смысл сделать в поиске** (категории Jackett вместо угадывания типа, переизмерение
  справочника скриптом, алиасы файлом, медленный индексатор, дешёвое упрочнение парсера; и что
  осознанно не сделано) → [`system-design/torrent-mod-search-backlog.md`](system-design/torrent-mod-search-backlog.md)
- **Целевая архитектура поиска** (профиль произведения вместо пары фильм/сериал, правила трекеров как
  данные, год, азиатский контент, диагностика; замеры по 1780 живым заголовкам девяти трекеров) →
  [`system-design/torrent-mod-search-architecture.md`](system-design/torrent-mod-search-architecture.md)
- **План перестройки Torrent Mod на единый пул раздач** →
  [`system-design/torrent-mod-unified-pool.md`](system-design/torrent-mod-unified-pool.md)
- **Доменная архитектура Torrent Mod** (Store/State/Interactors, `shared/core/` примитивы надёжности,
  селекторы, урок о границе View/Domain) →
  [`system-design/torrent-mod-domain-architecture.md`](system-design/torrent-mod-domain-architecture.md)
- **Пошаговая оптимизация рендера Torrent Mod** (живой baseline на 211 раздачах, memoized projections,
  rAF batching, keyed DOM и виртуальный picker) →
  [`system-design/torrent-mod-render-performance.md`](system-design/torrent-mod-render-performance.md)
- **Параллельный поиск по трекерам** (протокол start/poll/cancel, lifecycle scope, именованный
  виджет трекеров, история про то, где на самом деле проходит граница View и Domain) →
  [`system-design/torrent-mod-parallel-search.md`](system-design/torrent-mod-parallel-search.md)
- **Бэклог: выбор аудиодорожки** (почему субтитры уже работают, а звук нет; что нужно поменять в
  самом TorrServer; история исследования) → [`system-design/torrent-mod-audio-tracks-backlog.md`](system-design/torrent-mod-audio-tracks-backlog.md)
- **MVP: предпочтительная аудиодорожка в сериалах** (probe-preflight, выбор студии для каждой
  серии и контролируемый GST-перезапуск с сохранением позиции) → [`system-design/torrent-mod-audio-track-mvp.md`](system-design/torrent-mod-audio-track-mvp.md)
- **Бэклог: capability-aware GST/HLS playback** (remux по реальным возможностям браузера,
  fallback на транскодирование только после decode error) →
  [`system-design/torrent-mod-playback-capability-fallback-backlog.md`](system-design/torrent-mod-playback-capability-fallback-backlog.md)
- **Все зафиксированные архитектурные решения** → [`adr/`](adr/) (см. `adr/README.md` за списком, включая
  [ADR-0006](adr/0006-native-player-fallback-not-ffprobe-gate.md) — исторический, заменён актуализацией ADR-0003)
