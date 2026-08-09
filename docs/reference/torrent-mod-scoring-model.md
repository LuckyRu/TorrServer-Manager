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
