# Бэклог: capability-aware playback для GST/HLS

Не менять текущий GST-first pipeline до отдельной реализации этой задачи.

## Цель

Не транскодировать видео, если текущий браузер или webOS-плеер умеет воспроизводить
конкретный codec из probe. Сначала использовать remux, а переходить к H.264/SDR только
после подтверждённой ошибки декодирования или явного пользовательского выбора.

## План

1. Добавить в Torrent Mod capability-check для native HLS и MSE:
   `video.canPlayType()` и `MediaSource.isTypeSupported()` с фактическим codec из GST probe.
2. Добавить в Lampa Player флаг предпочтения native HLS, чтобы webOS не переводился
   без необходимости на HLS.js/MSE.
3. Добавить профиль GST-задачи в URL и ключ pipeline:
   `direct` — remux, `transcode` — принудительный fallback.
4. При ошибке декодирования повторить запуск текущего файла с `profile=transcode`.
   Ошибки сети, manifest timeout и отсутствие torrent-данных не должны включать транскодирование.
5. Сохранять профиль только в рамках текущей player-сессии; предпочтение аудиоперевода
   и профиль воспроизведения не смешивать.
6. На webOS отключать клиентскую audio normalization, если она использует
   `AudioContext.createMediaElementSource()`.

## Критерии готовности

- H.265/HDR на совместимом телевизоре проходит без видеокодера.
- Браузер с поддержкой H.265 получает remux, а не H.264 fallback.
- Несовместимый browser получает H.264/SDR только после capability-check или decode error.
- Смена аудиодорожки сохраняет выбранный профиль и не добавляет несколько audio renditions
  в один HLS manifest.
