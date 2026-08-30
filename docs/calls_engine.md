# core/calls — движок звонков

> Аудио/видеокомнаты уровня Google Meet на LiveKit OSS self-host (Apache-2.0; техники устойчивости Meet из коробки). Комната привязана к сущности полиморфно; доступ решает резолвер потребителя. Инертен без `LIVEKIT_*`.

## Модель

- **`CallSession`** — созвон (`roomName='call_<id>'`; полиморфно refType+refId БЕЗ FK; партиальный unique «одна active на ref» руками в миграции — гонка первых токенов гасится P2002→перечитать) + **`CallSessionParticipant`** (журнал; «открытая строка» = leftAt IS NULL; вебхуки at-least-once → идемпотентно).
- **Сессия ≠ сущность-родитель**: `room_finished` закрывает СЕССИЮ; встреча/чат живут (новый вход = новая сессия).

## Контракт потребителя

```ts
CallsRefRegistry.register(refType, { canJoin, canModerate, onJoinAuthorized?, resolveWorkspaceId? })
// onJoinAuthorized — СИНХРОННАЯ материализация участника при выдаче токена
// (шина at-most-once не годится; токен = единственный вход, покрытие 100%)
```
Вход — генерик `POST /calls/token {refType, refId}` (get-or-create сессии). Токен подписывается ЛОКАЛЬНО (identity=userId, roomAdmin=canModerate).

## Вебхук и модерация

`POST /calls/livekit/webhook` (@Public+@SkipThrottle; подпись WebhookReceiver по СЫРОМУ телу — express.raw до body-parser, оба префикса). `deleteRoom` best-effort (БД — истина); kick/mute БРОСАЮТ 502 при недоступности LiveKit («модерация не врёт»). `CallsCron` реконсилирует зависшие active по listRooms (LiveKit недоступен → прогон пропущен, НЕ закрывать вслепую).

## Запись (подсистема движка; LiveKit Egress, audio-only OGG)

`CallRecording` (recording→processing→ingesting→ready|error; партиальный unique «одна активная на сессию») + `CallRecordingClaim` («Получить запись»: каждый клеймант получает ПОЛНУЮ запись; файл общий, владелец/квота = включивший). Финализация — джоб `calls.recording.finalize` (двухрежимный: снимок egress из вебхука ЛИБО сам опрашивает LiveKit; **активный egress = тихий выход**, не транзиент-ретрай) + `calls.recording.deliver` на клейманта через `CallsRecordingRegistry.register(refType, {onReady})` (потребитель — Диктофон). Копирование из `LIVEKIT_EGRESS_DIR` (исходник не потребляется — редрайв переживает краш); `fileId` фиксируется сразу после инжеста (ретрай не съедает квоту дважды).

⚠️ Серверу LiveKit ОБЯЗАТЕЛЕН блок `redis:` в конфиге — без него «egress not connected».

## Устойчивость к слабой сети

Сервер: `rtc.congestion_control.allow_pause: true` (в коде default OFF!) — при заторе видео паузится, аудио живёт. Клиент (всё в `CallRoomShell` — единственная точка `new Room`): RED+DTX+simulcast+backupCodec + **VP9 SVC** (`CALL_VIDEO_CODEC='vp9'` → L3T3_KEY; Safari через backupCodec VP8) + `AudioPresets.speech` + `prepareConnection`. ⚠️ **screenshare запинен на VP8** (`{videoCodec:'vp8'}` в ControlsBar) — SVC-кодек размыл бы текст. UX: баннер «Слабая сеть», бейдж 📶, эконом-режим 🎧 «только звук» (авто при Poor≥5с/Lost; механика = `setSubscribed(false)` remote-камер — работает при adaptiveStream; ⚠️ MediaTile: `videoOn` требует `publication.isSubscribed`, иначе чёрный тайл вместо аватара).

## Веб-кит (`components/calls/`)

PreJoin (превью/устройства/localStorage `sa6_call_devices`) · CallRoomShell (**Room создаётся ВНУТРИ useEffect — StrictMode-safe**; ошибка устройств НЕ рушит вход; adaptiveStream+dynacast) · CallStage/MediaTile (видео ∥ PersonAvatar; своё зеркалится; отсюда же экспортируется ScreenShareTile — contentHint 'detail') · ControlsBar · ParticipantsPanel (kick/mute через серверные ручки) · CallResilience. Страница комнаты — `next/dynamic ssr:false`.

## Dev-инструменты

Плохая сеть: `cap_add: NET_ADMIN` у контейнера → `tc qdisc … netem delay 200ms loss 15%` (бьёт весь трафик, тесты короткие); наблюдение — chrome://webrtc-internals. `LIVEKIT_NODE_IP` = LAN-IP для второго устройства.

Порты dev-контейнера: 7880 ws+api · 7881 TCP-fallback · **7882/udp — ЕДИНЫЙ muxed-порт** (диапазон портов на Docker-Windows не работает — потому порт один). Вебхук контейнер→host идёт через `host.docker.internal`. Самому LiveKit-серверу Redis не нужен; блок `redis:` в конфиге обязателен только для egress (см. выше).

## API (кратко)

`GET /calls/status` · `POST /calls/token` · `POST /calls/rooms/:sessionId/end|kick|mute` · `recording/start|stop|claim` · вебхук. События `call.*` на шине несут refType/refId (+`participantUserIds` в ended — потребители классифицируют «пропущенный» без чтения таблиц движка).

## Потребители

`office_room` (Виртуальный офис — [office.md](office.md)) · `chat` (звонки мессенджера — [messenger.md](messenger.md)) · записи → Диктофон ([recorder.md](recorder.md)).

## Прод-хвост

TURN 443/TLS + wss + use_external_ip («не подключается из офисных сетей») · RNNoise-WASM · Opus DRED (ждать браузеров) — [roadmap.md](roadmap.md).

## Проверка

`verify-calls.cjs`, `verify-messenger-calls.cjs`, `verify-call-recording.cjs`, `verify-office.cjs`.
