# Диктофон (RecorderModule, B2C)

> Потребитель core/voice (прото-Plaud): запись/загрузка собрания → транскрипт со спикерами. Дом будущих протоколов собраний, записей SuperTerminal6 и «Журнала звонков».

## Модель

- **`VoiceRecording`** — запись; файл через `FileLink refType='voice_recording'` (owner-only; allowedProfiles dictaphone+voice_message). Создаётся СРАЗУ по завершении upload (окно orphan-реапа). `source`: upload|web|terminal|call.
- Транскрипция — через общий `/voice/*` (диаризация, язык Авто/Рус/Каз/Eng). Длительность — из meta файла с добором из транскрипта.
- Удаление каскадно чистит связи+файл+квоту; транскрипт удаляется ТОЛЬКО у прибранных файлов (файл, живущий вложением чата, сохраняет общий транскрипт — «1 файл = 1 транскрипт»).
- **«Журнал звонков»** — вкладка (`source='call'`): хук `CallsRecordingRegistry.register('chat')` на КАЖДОГО клейманта создаёт `VoiceRecording(callRecordingId)` + linkFile (файл ОБЩИЙ; владелец/квота = включивший запись; идемпотентность `@@unique([callRecordingId, ownerId])`) + notify.
- Уведомления `voice.transcript.ready|failed` с дип-линком `?id=` — только записям Диктофона (чат не пингуем); общий файл нотифит каждого клейманта (итерируются ВСЕ линки voice_recording).
- Профиль `dictaphone` 200MB == hardMaxSize (потолок зашит в 3 местах: validation + multer + ClamAV).

## API

`GET /recorder/recordings` (+файл+статус транскрипта батчем) · `POST /recorder/recordings {fileId, title?, source?, language?}` · `PATCH /:id {title}` → лёгкий `{id,title}` · `DELETE /:id`.

## Веб (`/recorder`)

Запись в браузере (≤1ч, авто-стоп с ре-энтри-гардом) / загрузка файла → «Расшифровать» → `TranscriptView` (чипы «Спикер N», [m:ss] клик-seek, копирование); дип-линк `?id=` защищён от затирания до загрузки списка; деталь под `key={rec.id}`. Одностраничник вне сайдбар-каркаса осознанно (переедет вместе с разделами протоколов).

## Отложено

Streaming STT (live-субтитры) · протоколы (LLM поверх segments) · поиск по транскриптам · ESP-терминал · mobile-запись.

## Проверка

`verify-voice.cjs` (включая регрессию «шаренный файл переживает удаление записи»), `verify-call-recording.cjs`.
