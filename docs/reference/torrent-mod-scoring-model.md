# Модель скоринга раздач Torrent Mod — справка

Формулы и пороги. За обоснованием и историей — в
[`system-design/torrent-mod-search-pipeline.md`](../system-design/torrent-mod-search-pipeline.md).
Источник истины — `scoreCandidate()`/`passesMatchGate()`/`estimateBitrateMbps()` в `TorrentModPlugin.js`.

## Гейт (`passesMatchGate`) — кандидат либо проходит целиком, либо не участвует

Отказ, если любое из:

- `titleSimilarity(item.title, target.movie) < 0.34`
- релиз явно называет сезон (`release.explicitSeason`), и он ≠ `target.season`
- задана целевая серия (`target.episode`), релиз явно называет диапазон серий
  (`release.explicitEpisode`), и `target.episode` вне `[episodeFrom, episodeTo]`

## `titleSimilarity()` — сегментация + строгое сопоставление по числу слов

```
extractTitleSegments(rawTitle):
  split rawTitle по '/'          // конвенция "Локализованное / Оригинальное (режиссёр) [год]"
  каждый сегмент обрезается по первому '(' или '['   // метаданные всегда начинаются здесь
```

Для каждого сегмента × каждого названия из `baseTitles(movie, englishTitle)`:

- точное совпадение после `compact()` → `similarity = 1.0`
- иначе засчитывается, только если **число слов сегмента === числу слов эталона** (это и
  отсеивает субстроковые совпадения вроде «The Boys in the Boat» / «To All the Boys» против
  2-словного «The Boys» — по числу слов они не равны, хотя подстрока совпадает), **и** пересекается
  непустая доля токенов длиной > 2 вне `STOPWORDS`
- **никакого fallback на "мешок слов"**, если число слов не совпало — намеренно, тот же принцип,
  что и у гейта («принять ложноотрицательные, но не ложноположительные»)

`STOPWORDS` (EN+RU, каждое отдельным словом): `the a an of and in on to for is it` /
`и в на о из для по с а к у`.

## `target.englishTitle` — обход non-Latin `original_title`

`fetchEnglishTitle(movie, mode)` (`metadata/tmdb.js`) — запрос TMDB `/movie/{id}` или `/tv/{id}`
с `language=en-US`; при сетевой ошибке `ok('')`, поиск не блокируется. Нужен, потому что
`original_title`/`original_name` — родной алфавит для не-латинских шоу (напр. японский), а
русскоязычные трекеры называют релизы кириллицей + английским — сопоставление с оригинальным
названием бесполезно. Кэшируется в `state.englishTitle` (`null` = ещё не запрошен, `''` =
запрошен и пуст, иначе строка); `ensureEnglishTitle()` (`episodes-interactor.js`) дедуплицирует
конкурентные вызовы через in-flight promise. `baseTitles(movie, englishTitle)` и
`defaultSearchName()` предпочитают его вместо `original_title` — и для текста запроса в Jackett,
и для списка эталонных названий при сопоставлении.

## `qualityScore` — треугольный пик

```
REFERENCE_BITRATE_MBPS = { '2160p': 18, '1080p': 6, '720p': 3, '480p': 1.5 }
reference   = REFERENCE_BITRATE_MBPS[resolution] × (codec === 'H.265' ? 0.6 : 1)
deviation   = |bitrateMbps − reference| / reference
qualityScore = max(0, 20 × (1 − deviation))
+ 10, если resolution === torrent_mod_preferred_quality (настройка) и она не 'any'
```

`bitrateMbps` = `estimateBitrateMbps(item, target)`:
```
covered            = release.explicitEpisode ? (episodeTo − episodeFrom + 1) : max(1, target.seasonEpisodeCount || 1)
perEpisodeBytes     = item.size / covered
runtimeSeconds      = (target.avgRuntimeMinutes || 42) × 60
bitrateMbps         = perEpisodeBytes × 8 / (runtimeSeconds × 1_000_000)
```

## `availabilityScore`

```
availabilityScore = min(24, log(seeders + peers × 1.5 + 1) × 6)
```

## `matchScore` — только для отображения/отладки, в ранжирование не входит

```
matchScore = round(titleSimilarity × 40)
           + (release.explicitSeason && seasons.includes(target.season) ? 20 : 0)
           + (target.episode && release.explicitEpisode && episode в диапазоне ? 40 : 0)
```

## Итог и автоплей

```
value = qualityScore + availabilityScore   // matchScore не входит — он уже отработал как гейт

confident =
  best.availabilityScore >= MIN_AVAILABILITY_FOR_AUTOPLAY (3)
  && (!next || best.value − next.value >= 6 || best.seeders > next.seeders × 2)
```

Ранжирование внутри прошедших гейт: сортировка по `value` убыв., затем по `seeders` убыв.

## Публикация и другие поля кандидата

- `publishedAt` — из `raw.PublishDate` (Jackett), не из заголовка. В UI: «сегодня» / «вчера» /
  «N дн. назад» / `MMM YYYY` (>30 дней).
- `audioChannels`, `subtitles` — из `parseRelease()`, показываются в подписи кандидата в пикере, в скоринг
  не входят.
- `translator` — студия перевода из `parseRelease()`, по курируемому неполному списку
  `TRANSLATOR_STUDIOS` (LostFilm, NewStudio, Jaskier, Кубик в Кубе, Кураж-Бамбей и др.), матчится
  через `containsWord()` — ручная проверка границ слова, устойчивая к кириллице (обычный regex
  `\b` не формирует границу вокруг кириллических слов), и допускает точки/подчёркивания/дефисы
  вместо пробелов (`Кубик.в.Кубе` == `Кубик в Кубе`). Предпочитается перед общим `voiceType`
  везде, где строится инфо-строка кандидата (бейджи, пикер, debug-таблица), но **не** участвует в
  фильтре «Перевод» — смешение конкретных студий и общих категорий МПВ/АПВ/Дубляж в одном списке
  посчитано нежелательным.
- `sourceType` — тип источника (WEB-DL/BDRip/Remux/HDTV/...) из `parseRelease()`, отображается, в
  скоринг не входит.
- `audioTrackCount` — число аудиодорожек из `parseRelease()`, отображается, в скоринг не входит.

## Связь со стартом playback

Скоринг кандидата определяет, какую раздачу показывать или запускать, но больше не
управляет собственным duration-based буфером. После выбора playback-код:

- проверяет/получает hash торрента;
- ждёт `file_stats` и выбирает playable-файл;
- отправляет тихий `&preload`-запрос;
- сразу вызывает `Lampa.Player.play()`.

Буферизацию выполняет сам Lampa/TorrServer stream. Для несовместимого с браузером
потока Lampa один раз использует `url_reserve` с GST/HLS. Подробности и ограничения
описаны в [`ADR-0003`](../adr/0003-no-global-player-patching.md) и
[`lampa-player-api.md`](lampa-player-api.md).
