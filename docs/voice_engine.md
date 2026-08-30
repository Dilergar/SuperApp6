# core/voice — голосовой движок (STT)

> Транскрипция аудио для всех сервисов: **1 файл = 1 транскрипт навсегда** (Telegram-модель), доступ = доступ к файлу. Инертен без env.

## Модель

`VoiceTranscript` — джоб и результат одной строкой (`fileId @unique`, FK Cascade). Исполнение — джоб `voice.transcribe` (core/jobs, очередь voice, cap 2, аренда `VOICE_LIMITS.jobLeaseMs` ≈100 мин ≥ суммы внутренних таймаутов); доменный клейм `queued|processing→processing` + **монотонный клейм-токен `attempts` СТРОКИ** на всех финальных записях (зомби-заход прошлого джоба не затирает свежий результат); терминальный error пишет и `onDiscard`. Заражённый файл → 400/терминал.

## Драйверы STT (реестр)

- `openai_compatible` — multipart `POST {VOICE_STT_URL}/v1/audio/transcriptions` verbose_json (self-host whisper-server, OpenAI, Groq); постоянные отказы 4xx (кроме 408/429) → `JobDiscardError`.
- `mock` (`VOICE_STT_MOCK=true` — перекрывает URL; канон-текст на 2 спикеров, CI гоняет весь пайплайн).
- Модель под язык: `VOICE_STT_MODEL_KK` — слот дообученной казахской (whisper-turbo-ksc2, корпус KSC2 открыт).

Self-host: профиль voice → `hwdsl2/whisper-server` (faster-whisper + диаризация; `WHISPER_API_KEY` обязателен).

## Подготовка звука

`VoiceAudioPrep` — ffmpeg 16кГц mono wav + денойз (только для STT, оригинал не трогаем; нет бинарников → оригинал в STT). Байты: local — прямой путь с диска (`localPathFor`), s3 → tmp. Обвязка ffmpeg — общая `shared/ffmpeg/ffmpeg.util.ts`. HTTP-таймаут = min(30мин, 120с+3×длительность).

Волна (`meta.waveform`) — считает конвейер core/files по капабилити профиля `waveform: true` (96 RMS-бакетов; кап ≤10 мин fail-closed).

## Сервисный API потребителям

`VoiceService.requestTranscript(userId, {fileId, language?, diarize?})` (идемпотентно) · `transcribeSync` (короткие AI-команды ≤25МБ) · `getStatusesForFiles` (батч) · `deleteForReapedFiles` (транскрипты ТОЛЬКО прибранных файлов — шаренный файл сохраняет общий транскрипт). События `voice.transcript.ready|failed` несут `links` файла — потребители фильтруют по refType без своих запросов.

## HTTP API

`GET /voice/status` → `{enabled, mock}` · `POST /voice/transcripts` · `GET /voice/transcripts/:fileId` (поллинг) · `POST /voice/stt` (sync — фундамент голосовых AI-команд и SuperTerminal6).

## Веб-кит

`useVoiceRecorder` (MediaRecorder, NS/EC/AGC, каскад mime; `stop()` на неактивном рекордере собирает чанки, а не теряет запись) · `VoiceMessageBubble` (волна клик-seek, скорость, «Расшифровать») · `TranscriptView` (спикеры, [m:ss] клик-seek) · **`useVoiceTranscript`** — общий поллинг-хук: СВОЙ setTimeout-цикл по dataUpdatedAt с бэкоффом 2с→5с→15с (⚠️ `refetchInterval` RQ не перевзводится после setQueryData — проверено, поэтому руками).

## Ловушки

- Классификация «голосовое» и превью — общие хелперы shared (`isVoiceNoteProfile`/`attachmentPreviewText`).
- `duration=Infinity` у headerless-webm лечится сик-трюком.
- Карты расширение↔MIME — в shared (`AUDIO_EXT_TO_MIME`); веб нормализует пустой/octet-stream MIME по расширению.

## Проверка

`verify-voice.cjs` (в CI — mock; на live/off — SKIP).
