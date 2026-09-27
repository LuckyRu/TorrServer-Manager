# Разобрать сбой на телевизоре

На телевизоре нет devtools, а Lampa там играет иначе, чем в браузере: на LG со встроенным Chromium
старше 120 она отдаёт HLS нативному плееру, а не hls.js. Поэтому Torrent Mod сам отправляет свой журнал
и журнал плеера Lampa в менеджер.

## Где журнал

`%LOCALAPPDATA%\TorrServer\logs\clients.log`, при 10 МБ старый уходит в `clients.previous.log`.

```text
2026-09-27 21:14:05.312  c:31a4f3e4fd54cb22  192.168.10.57  ---- webos, Lampa 3.3.4, Torrent Mod 0.10.0, http://…/app/index.html, UA: …
2026-09-27 21:14:09.870  c:31a4f3e4fd54cb22  192.168.10.57  INFO  playback: switchAudioTrack: 0 → 5 {"session":2}
2026-09-27 21:14:09.902  c:31a4f3e4fd54cb22  192.168.10.57  INFO  lampa:Player: play url http://…/master.m3u8?index=1&audio=5…
```

- Время — часы устройства; строка `----` приходит в первом батче после загрузки страницы.
- `c:…` — тот же хеш, что `client=c:…` в `server.log`: по нему запись с телевизора и запрос на сервере
  находятся одним поиском.
- `lampa:Player`, `lampa:WebOS`, `lampa:Errors`, `lampa:Warnings`, `lampa:Ad` — записи самой Lampa, всё
  остальное — Torrent Mod (`playback:`, `search:` и т. д.).

## Как разобрать

1. Попросить воспроизвести сбой и назвать примерное время.
2. Найти клиента и окно по времени:

   ```powershell
   Select-String -Path "$env:LOCALAPPDATA\TorrServer\logs\clients.log" -Pattern 'switchAudioTrack|lampa:Errors' | Select-Object -Last 40
   ```

3. Тот же `c:…` искать в `server.log`: пришёл ли запрос, с какой дорожкой, чем ответил сервер. Если в
   `clients.log` плагин запрос отправил, а в `server.log` его нет — сбой между плеером телевизора и сервером.

## Что уходит и когда

Записи `log`/`warn` Torrent Mod и перечисленные категории консоли Lampa, пачками раз в 5 с (сразу после
`warn`), через `sendBeacon`, а без него — простым `POST` без preflight. Пачка ≤ 48 КБ: больше `sendBeacon`
молча не отправит. Пока хаб недоступен, копится не больше 400 записей. Модуль —
`Plugins/TorrentModPlugin/shared/core/remote-log.js`, приёмник — `Services/ClientLogSink.cs`.

Выключается в Lampa: Настройки → Torrent Mod → «Журнал на ПК». Плагин, загруженный не с хаба, журнал
не отправляет: адрес хаба он берёт из URL своего скрипта.

## Ограничения приёмника

`POST /api/client-log` открыт для всей LAN — иначе телевизор не смог бы ничего сообщить. Поэтому тело
не больше 64 КБ, не больше 500 записей, с одного адреса не больше 120 запросов и 2 МБ в минуту (сверх —
`429`), управляющие символы заменяются пробелами, каждая запись — одна строка. Проверить приёмник:

```powershell
curl.exe -s -o NUL -w "%{http_code}" -X POST -H "Content-Type: text/plain" `
  --data '{"client":"test","version":"0","entries":[{"t":0,"l":"info","s":"check","m":"hello"}]}' `
  http://127.0.0.1:8095/api/client-log
```

Ответ `204`, в конце `clients.log` — строка `c:9f86d081884c7d65 … INFO  check: hello`.
