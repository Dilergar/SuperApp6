// ============================================
// Voice Engine (core/voice) — константы
// ============================================

const KB = 1024;
const MB = 1024 * KB;

/** Языки транскрипции: auto = автоопределение Whisper (kk-ru вперемешку — ок) */
export const VOICE_LANGUAGES = ['auto', 'ru', 'kk', 'en'] as const;

export const VOICE_LANGUAGE_LABELS: Record<(typeof VOICE_LANGUAGES)[number], string> = {
  auto: 'Авто',
  ru: 'Русский',
  kk: 'Қазақша',
  en: 'English',
};

export const VOICE_TRANSCRIPT_STATUSES = ['queued', 'processing', 'ready', 'error'] as const;

/** Откуда взялась запись Диктофона: загрузка файла | запись в браузере | SuperTerminal6 (будущее) | запись звонка («Журнал звонков») */
export const VOICE_RECORDING_SOURCES = ['upload', 'web', 'terminal', 'call'] as const;

export const VOICE_LIMITS = {
  /** Потолок длительности голосового сообщения в чате, сек */
  maxVoiceMessageSec: 300,
  /** Потолок аудио для синхронной расшифровки POST /voice/stt (команды AI/терминала) */
  maxSyncSttBytes: 25 * MB,
  /** Попыток транскрипции до терминального error */
  transcriptMaxAttempts: 3,
  /** База HTTP-таймаута STT-запроса, мс */
  sttTimeoutBaseMs: 120_000,
  /** Прибавка к таймауту на каждую мс длительности аудио (CPU-whisper медленнее реального времени) */
  sttTimeoutPerAudioFactor: 3,
  /** Потолок HTTP-таймаута STT, мс */
  sttTimeoutMaxMs: 30 * 60 * 1000,
  /** Надбавка бюджета джоба сверх HTTP-таймаута STT: скачивание байтов + ffmpeg-подготовка (probe и транскод — до 10 мин каждый) */
  sttJobOverheadMs: 25 * 60 * 1000,
  /** Запас аренды джоба (leaseUntil) поверх бюджета — крон не переклеймит живой джоб */
  sttLeaseMarginMs: 2 * 60 * 1000,
  /** TTL Redis-лока джоба — больше ХУДШЕГО бюджета (overhead + sttTimeoutMaxMs + margin) */
  sttLockTtlMs: 60 * 60 * 1000,
  /** Столбиков в волне голосового (meta.waveform) */
  waveformBuckets: 96,
  /** Волну считаем только до этой длительности (у часовых записей волна не нужна) */
  waveformMaxDurationMs: 10 * 60 * 1000,
  /** Потолок записи в браузере на странице Диктофона, сек */
  recorderMaxBrowserRecordSec: 3600,
  /** Поллинг статуса транскрипта на вебе: первые полминуты (короткие голосовые), мс */
  pollIntervalMs: 2000,
  /** …после 30 секунд, мс */
  pollIntervalSlowMs: 5000,
  /** …после 3 минут (длинные записи Диктофона — не бомбим API), мс */
  pollIntervalIdleMs: 15000,
} as const;
