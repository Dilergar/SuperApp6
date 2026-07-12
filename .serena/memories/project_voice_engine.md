# Голосовой движок (core/voice) — 7-й платформенный движок · BUILT 2026-07-13

Все проверки зелёные: `verify-voice.cjs` 31/0 (mock) + live-режим (SKIP-ветка STT), регрессии files/files-consumers/messenger, браузер 0 ошибок консоли, живой Whisper распознал русскую речь на 100% (`detectedLanguage: ru`, спикеры на сегментах).

## Модель
- `VoiceTranscript` (`voice_transcripts`): джоб и результат одной строкой — `fileId @unique` (FK на FileObject, onDelete Cascade) → **1 файл = 1 транскрипт навсегда** (Telegram-модель «Расшифровать», кэш вечен; language влияет только на первый расчёт/после error). Поля: status queued|processing|ready|error, language/detectedLanguage, text, segments Json [{start,end,text,speaker?}], durationMs Int (не BigInt), diarize, attempts, requestedById.
- `VoiceRecording` (`voice_recordings`): сущность Диктофона (ownerId, title, source upload|web|terminal, language, durationMs); файл через FileLink refType=`voice_recording` (несвязанный ready-файл реапится — поэтому запись создаётся СРАЗУ после upload).

## Движок (apps/api/src/core/voice/, @Global)
- **Джобы**: клейм status-guarded `updateMany {fileId,status:'queued'}→processing` (count!==1 → выход) + Redis-лок `voice:stt:<fileId>` TTL 35 мин (> макс. HTTP-таймаута — живой джоб не переклеймится). Ошибки: transient → назад в queued (≤3 попыток), terminal → error + событие. `VoiceCron` */2 мин: потерянные queued (>2 мин) и протухшие processing (>lockTtl).
- **HTTP-таймаут STT** = min(30 мин, 120с + 3×durationMs); fallback от размера ~1 мин/МБ.
- **Драйверы** (`voice-stt.client.ts`, паттерн process-ai-client): `openai_compatible` — multipart POST `{VOICE_STT_URL}/v1/audio/transcriptions` (`/v1` дописывается, если не задан), `response_format=verbose_json`, Bearer `VOICE_STT_API_KEY`, `fs.openAsBlob` (стрим с диска) с фолбэком на readFile; поле `speaker` сегментов мапится защитно. `mock` (`VOICE_STT_MOCK=true`) — канон-текст на 2 спикеров, без сети/ffmpeg (CI). **mock ПЕРЕКРЫВАЕТ URL**. Модель под язык: kk + `VOICE_STT_MODEL_KK` → казахская.
- **Подготовка** (`voice-audio.ts`): ffmpeg-static → 16 кГц mono wav + `highpass=f=80,afftdn=nf=-25,dynaudnorm` — только для STT, играбельный оригинал НЕ трогаем (шумодав живого звука = браузерные constraints при записи); нет бинарников → оригинал в STT (whisper сам декодит).
- **Доступ** = доступ к файлу: `files.getMeta(viewerId, fileId)` (403/404 через резолвер привязки), байты — `files.openRawStream(fileId, null)`. FilesService НЕ менялся.
- **API**: GET `/voice/status` {enabled,mock,diarization,languages} · POST `/voice/transcripts` {fileId,language?,diarize?} (идемпотентно, P2002-catch) · GET `/voice/transcripts/:fileId` · POST `/voice/stt` (multipart ≤25МБ, sync — фундамент AI-команд/SuperTerminal6). События `voice.transcript.ready|failed` на шине.

## Волна (конвейер files)
`processAudio(profile, source)`: для `voice_message` всегда, `dictaphone` ≤10 мин — PCM-декод `-ac 1 -ar 2000 -f s16le` **во временный файл** (`execFF` возвращает stdout строкой — бинарь через него нельзя!) → 96 RMS-бакетов → пик-нормировка 0..100 → `meta.waveform`. Ошибка волны не валит конвейер.

## Потребители
- **Мессенджер**: кнопка 🎤 (`VoiceRecordButton`) → `useVoiceRecorder` (MediaRecorder, constraints echoCancellation/noiseSuppression/autoGainControl, каскад mime `audio/webm;codecs=opus`→`audio/webm`→`audio/mp4` (Safari)→`audio/ogg`) → upload профилем `voice_message` → **существующий** attachment-путь `onSendAttachmentsRef` (нового эндпоинта НЕТ). `AttachmentFileRef` получил `profile?` → превью «🎤 Голосовое сообщение» (сервер `attachmentPreviewText` + веб-фолбэк page.tsx) и ветвление `AudioTile` → `VoiceMessageBubble` (волна клик-seek, скорость ×1/1.5/2, «Расшифровать» → RQ-поллинг 2с → текст под баблом; фолбэк на старый AudioPlayer без волны).
- **Диктофон** `modules/recorder` + веб `/recorder`: refType `voice_recording` (owner-only, allowedProfiles dictaphone+voice_message), профиль `dictaphone` 200MB (== hardMaxSize; потолок платформы НЕ поднимали — зашит в validation/file.ts + multer + ClamAV-лимитах compose), `TranscriptView` (группировка по спикеру, чипы «Спикер N», [m:ss] клик-seek, копирование), уведомления `voice.transcript.ready|failed` (только записям Диктофона, actionUrl `/recorder?id=`), удаление каскадно чистит транскрипт+файл+квоту. `AUDIO_MIME` расширен: +aac/x-m4a/flac.

## Инфра
- Контейнер: `docker compose --profile voice up -d` → `hwdsl2/whisper-server` (MIT, faster-whisper + диаризация sherpa-onnx/pyannote, OpenAI-совместимый). **Требует `WHISPER_API_KEY`** (дев-дефолт `superapp6-voice-dev`, healthcheck с Bearer). Модель `WHISPER_MODEL`: дев=small (52с загрузка), прод=large-v3-turbo/GPU (`:cuda`).
- `.env`: `VOICE_STT_URL=http://localhost:9000`, `VOICE_STT_API_KEY=superapp6-voice-dev`. CI (`ci.yml`) пишет `VOICE_STT_MOCK=true` → verify-voice гоняет полный пайплайн без контейнера.

## Казахский (решение пользователя: НЕ обучаем сами)
whisper мультиязычный из коробки; при недостатке качества: (а) self-host дообученная открытая `abilmansplus/whisper-turbo-ksc2` (WER ~9%, корпус KSC2 1200ч с kk-ru code-switching; нужна ct2-конвертация) через `VOICE_STT_MODEL_KK`, (б) облако ElevenLabs Scribe (kk WER 5–10%, диаризация встроена) — новым драйвером в тот же реестр.

## Грабли (пойманы при стройке)
- **MIME-вариации браузеров (поймано юзером на реальном mp3)**: Windows-Chromium отдаёт `.mp3` как `audio/mp3`, не `audio/mpeg` → 400 на init профиля. Фикс 2026-07-13: `audio/mp3`+`audio/x-flac` добавлены в AUDIO_MIME (shared/constants/files.ts); веб-нормализация пустого/octet-stream MIME по расширению — `normalizeAudioMime` в recorder/page.tsx (сервер-сниф magic-bytes всё равно перепроверяет содержимое); алерты загрузки показывают `err.response.data.message` (конверт AllExceptionsFilter), а не axios-заглушку «Request failed with status code 400». Вторая волна того же дня: `.webm` ОС регистрирует как ВИДЕО (video/webm) → пикер accept="audio/*" его прятал, whitelist резал повторную загрузку собственной записи — фикс: accept с явными расширениями (.webm и др.) + ремап video/webm→audio/webm в `normalizeAudioMime`. Плюс продуктовая дырка: «Расшифровать» была только у голосовых баблов — теперь `TranscriptBlock` экспортирован и вешается на ЛЮБОЕ аудио-вложение чата (AudioTile: AudioPlayer + TranscriptBlock). Формат записи: getUserMedia constraints + `channelCount:1` (моно), MediaRecorder Opus 48 кГц @ 64 кбпс; STT-препроцессинг → 16 кГц mono wav (родной формат Whisper).
- **React Query**: `setQueryData` НЕ перевзводит `refetchInterval` устоявшегося запроса → после него обязательно `invalidateQueries` (иначе поллинг транскрипта не стартует; в мессенджере работало случайно — запрос включался заново через enabled).
- PowerShell: `$env:X='y' && cmd` — parse error, только `;`; `$disconnect` в `node -e` съедается PS.
- Browser pane блокирует микрофон → состояние `denied` проверено, реальная запись — ручная QA (Chrome/Firefox/Safari).
- verify: STT-проверки только на mock (live непредсказуем, фикстура — синус); wav-фикстура синтезируется в скрипте (RIFF-заголовок + синус), magic-bytes sniff пропускает (audio/vnd.wave в AUDIO_CONTAINER_MIME).

## Отложено (слоты готовы)
Streaming STT (whisper-server умеет SSE; live-субтитры звонков/терминала) · протоколы собраний (LLM поверх segments, адаптер как process-ai-client) · поиск по транскриптам (провайдер core/search) · LiveKit-звонки (egress → файл → тот же пайплайн) · ESP SuperTerminal6 (sync `/voice/stt` + chunked upload + source='terminal' готовы) · mobile-запись (expo-av, фаза mobile) · Redis-семафор параллельных STT-джобов.
