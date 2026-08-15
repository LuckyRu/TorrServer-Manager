# Модель скоринга раздач Torrent Mod — справка

Формулы и пороги. За обоснованием и историей — в
[`system-design/torrent-mod-search-pipeline.md`](../system-design/torrent-mod-search-pipeline.md).
Источник истины — входные решения в `Plugins/TorrentModPlugin/search/search-gates.js` и
`scoreCandidate()`/`passesMatchGate()`/`estimatePayload()` в `search/scoring.js`.

## Входные гейты — до попадания в `state.pool`

Порядок: `parse → media-type → title`.

- parse: `empty-record`, `missing-download-link`, `metadata-parse-error`;
- media-type: `ebook-or-document`, `game-distribution`, `audio-only`, `extras-or-bonus`,
  `missing-video-signal`;
- title: `title-mismatch`, `conflicting-title`.

Для каждого этапа логируются `input`, `accepted`, `filtered`, `reasonCounts`, `rejectedTitles` и
`rejected: [{title, reason, details}]`. `metadata-parse.parsed` сообщает только результат parse-gate и
не означает принятия раздачи всем pipeline.

## Гейт (`passesMatchGate`) — кандидат либо проходит целиком, либо не участвует

Отказ, если любое из:

- `titleSimilarity(item.title, target.movie) < 0.34`
- релиз явно называет сезон (`release.explicitSeason`), и он ≠ `target.season`
- задана целевая серия (`target.episode`), релиз явно называет диапазон серий
  (`release.explicitEpisode`), и `target.episode` вне `[episodeFrom, episodeTo]`

## `titleSimilarity()` — сегментация + строгое сопоставление токенов

```
extractSearchTitleSegments(rawTitle):
  декодировать &#39;/&apos;/&quot;/&amp;
  split rawTitle по '/' и '|'
  каждый сегмент обрезать по первому '('/'[' или техническому тегу Sxx/Eyy/1080p/WEB-DL/...
```

Для каждого сегмента × каждого названия из `baseTitles(movie, englishTitle)`:

- точное совпадение после `compact()` → `similarity = 1.0`
- иначе рассматривается, только если **число слов сегмента === числу слов эталона** (это и
  отсеивает субстроковые совпадения вроде «The Boys in the Boat» / «To All the Boys» против
  2-словного «The Boys» — по числу слов они не равны, хотя подстрока совпадает)
- для цели с несколькими значимыми токенами должны совпасть минимум два; поэтому одного `Game`
  недостаточно, чтобы `Darwin's Game` прошло как `Game of Thrones`
- для цели с одним значимым словом и стоп-словами дополнительно должно совпасть не менее 75% всех
  токенов; `Bad Boys` не становится `The Boys`
- осмысленный несовпавший сегмент перед каноническим совпадением даёт `conflicting-title`
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

## `estimatePayload()` — оценка потока всего payload, не видеобитрейт

```
payloadMbps = torrentSizeBytes × 8 / (estimatedDurationMinutes × 60 × 1_000_000)
```

В числителе размер всего торрента: видео, все аудиодорожки, субтитры и дополнительные файлы.
Поэтому поле называется `payloadMbps`, а не `bitrateMbps`.

Результат содержит `confidence: high | medium | low | none`, число покрытых серий, длительность и
текстовое объяснение. Оценка не строится вовсе, если неизвестна длительность фильма/серий или охват:
fallback `42 минуты` удалён.

Охват определяется так:

- фильм — один файл, длительность из TMDB;
- явный диапазон одной серии/сезона — количество эпизодов из заголовка;
- один сезон без диапазона — `episode_count` TMDB;
- несколько сезонов без диапазона — сумма `episode_count` всех названных сезонов;
- многосезонный `E1-N`: если `N` похож на диапазон внутри каждого сезона, используется сумма TMDB;
  иначе диапазон считается сквозным;
- релиз без season/episode-сигналов получает только низкую уверенность.

Для текущего сезона используются точные runtime эпизодов TMDB, когда доступен полный диапазон;
иначе — средняя длительность с понижением confidence.

## `qualityScore` — визуальные метаданные и только low-payload penalty

```
resolution = { 2160p: 16, 1080p: 12, 720p: 7, 480p: 3, unknown: 6 }
source     = { Remux: 4, BDRip: 3, WEB-DL: 3, WEBRip: 2, HDTV/HDRip: 1 }
hdr        = +2
```

`parseRelease()` хранит в `release.hdr` три значения — `'DV' | 'HDR' | ''`, — но скоринг читает
поле как булево, поэтому Dolby Vision и HDR10 получают одинаковые `+2`. Различие доживает только
до бейджа в выдаче. Фильтра по HDR нет (есть `bitrate`, `resolution`, `translator`, `voiceType`).
Про то, что DV до плеера не доезжает, — в разделе о старте playback ниже.

Высокий payload не уменьшает качество. Оценка потока используется только как слабое свидетельство
недостаточного кодирования. Минимумы H.264: `2160p→10, 1080p→3.5, 720p→1.8, 480p→0.8`; для H.265
они умножаются на `0.6`, для HDR — на `1.15`. Максимальный штраф — 8 баллов и масштабируется по
confidence (`high=1`, `medium=0.65`, `low=0.25`, `none=0`).

Ограничение высокого потока остаётся явным пользовательским фильтром, а не скрытым штрафом качества.

## `availabilityScore`

```
if seeders == 0: availabilityScore = 0
else:
  seedScore   = min(20, ln(seeders + 1) × 5)
  demandScore = min(2, ln(leechers + 1) × 0.4)
  availabilityScore = seedScore + demandScore
```

`raw.Peers` Jackett — число leechers. Оно хранится как `item.leechers`; `item.peers` оставлен как
совместимый alias. Личеры дают только небольшой сигнал спроса и никогда не создают доступность без
хотя бы одного сидера.

## `streamingRiskPenalty`

Число сидеров не гарантирует скорость, но до подключения к swarm это единственный доступный proxy
устойчивости. Для оценок payload с `high`/`medium` confidence:

```
requiredSeeders = max(3, payloadMbps × 1.25)
если seeders < requiredSeeders:
  streamingRiskPenalty = 8 × (1 − seeders / requiredSeeders) × confidenceWeight
confidenceWeight: high=1, medium=0.65
```

Штраф не объявляет раздачу непригодной: он ставит более лёгкий поток с существенно более здоровым
swarm выше тяжёлой раздачи с малым запасом по сидерам. Точную скорость можно измерить только после
регистрации выбранного торрента, поэтому все кандидаты заранее не прогреваются.

## `matchScore` и `matchConfidenceScore`

```
matchScore = round(titleSimilarity × 40)
           + (release.explicitSeason && seasons.includes(target.season) ? 20 : 0)
           + (target.episode && release.explicitEpisode && episode в диапазоне ? 40 : 0)
```

После hard gate в итог входит небольшой `matchConfidenceScore = clamp(matchScore / 25, 0, 4)`.
Поэтому точные season/episode-сигналы разбивают близкие результаты, но не перекрывают качество и swarm.

## `pipelinePenalty`

- `RAW DVD`: `8`;
- AV1: `3` из-за стоимости декодирования/транскодирования;
- остальные рискованные legacy-кодеки/контейнеры: `5`.

Это риск серверного GST-пайплайна, а не способность браузера декодировать исходный файл.

## Итог и автоплей

```
value = qualityScore + availabilityScore + matchConfidenceScore
        - streamingRiskPenalty - pipelinePenalty

confident =
  best.seeders >= 3
  && best.matchScore >= 40
  && best.availabilityScore >= MIN_AVAILABILITY_FOR_AUTOPLAY (4)
  && (!next || best.value − next.value >= 6 || best.seeders > next.seeders × 2)
```

Ранжирование внутри прошедших гейт: сортировка по `value` убыв., затем по `seeders` убыв.

## Публикация и другие поля кандидата

- `publishedAt` — из `raw.PublishDate` (Jackett), не из заголовка. В UI: «сегодня» / «вчера» /
  «N дн. назад» / `MMM YYYY` (>30 дней).
- `audioChannels`, `subtitles` — из `parseRelease()`, показываются в подписи кандидата в пикере, в скоринг
  не входят.
- `translators` — список студий перевода из `parseRelease()`, по курируемому неполному списку
  `TRANSLATOR_STUDIOS` (LostFilm, NewStudio, Jaskier, Кубик в Кубе, Кураж-Бамбей и др.), матчится
  через `containsWord()` — ручная проверка границ слова, устойчивая к кириллице (обычный regex
  `\b` не формирует границу вокруг кириллических слов), и допускает точки/подчёркивания/дефисы
  вместо пробелов (`Кубик.в.Кубе` == `Кубик в Кубе`). Все найденные студии сохраняются в порядке
  появления в title и отображаются вместе; список предпочитается перед общим `voiceType`
  везде, где строится инфо-строка кандидата (бейджи, пикер, debug-таблица). Список студий не хранится в
  state: `poolTranslators(state.pool)` вычисляет уникальные значения в порядке появления. Пользовательский
  выбор хранится отдельно в `state.filters.translator` (или `'any'`). Фильтр «Студия» матчится по любому
  элементу массива, поэтому раздача с несколькими студиями остаётся доступной для каждой из них.
- `sourceType` — тип источника (WEB-DL/BDRip/Remux/HDTV/...) из `parseRelease()`. Отображается и
  даёт небольшой вклад в `qualityScore`, который не может перекрыть большую разницу в доступности.
- `audioTrackCount` — число аудиодорожек из `parseRelease()`, отображается, в скоринг не входит.

## Связь со стартом playback

Скоринг кандидата определяет, какую раздачу показывать или запускать, но больше не
управляет собственным duration-based буфером. После выбора playback-код:

- проверяет/получает hash торрента;
- ждёт `file_stats` и выбирает playable-файл;
- сразу вызывает `Lampa.Player.play()`.

Предзагрузки **для запускаемого файла нет**: она тянет голову файла и конкурирует с пайплайном,
который может играть с середины — на живом замере старт вырос с 15 до 48 секунд. Тихий `&preload`
остался только для прогрева **следующей** серии (`playback/smart-preload.js`).

Транспорт — **всегда GST/HLS**, без исключений: `storeTransport()` в
`playback/smart-preload.js` безусловно подставляет `/gst/<hash>/master.m3u8`, прямого стрима и
`url_reserve` в коде нет ([`ADR-0003`](../adr/0003-no-global-player-patching.md),
[`lampa-player-api.md`](lampa-player-api.md)). Из этого следуют два ограничения, которых скоринг
не видит:

- **звук перекодируется.** AAC копируется как есть, всё остальное декодируется и жмётся в AAC
  256 кбит/с; число каналов сохраняется до 8 (`effectiveAACChannels`). То есть TrueHD Atmos и
  DTS-HD MA доезжают до плеера как AAC 5.1 без объектных метаданных — раздача, выбранная ради
  Atmos, звучит как AAC;
- **Dolby Vision не доезжает вообще.** `mp4mux` из GStreamer 1.28 принимает H.265 только как
  `{ hvc1, hev1 }` и не умеет писать `dvcC`; caps `video/x-dolby-vision` в плагине нет. У DV
  Profile 7/8.1 остаётся HDR10-база, и картинка выходит корректным HDR10 без DV; у Profile 5
  HDR10-базы нет, и корректно показать его этот тракт не может.

Буферизацию выполняет сам Lampa/TorrServer stream.
