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
  /**
   * Потолок HTTP-таймаута STT, мс. Держим согласованным с арендой джоба
   * `voice.transcribe` (см. VOICE_JOB_LEASE_MS): аренда обязана перекрывать ВЕСЬ
   * бюджет обработчика (probe 10 мин + транскод 10 мин + этот таймаут + скачивание
   * и ожидание семафора), иначе reaper переклеймит джоб прямо во время расшифровки
   * и запустит вторую — двойная оплата облачного STT / двойная загрузка whisper.
   * Прежние 30 мин были заведомо малы для профиля dictaphone (до ~3.5ч аудио).
   */
  sttTimeoutMaxMs: 60 * 60 * 1000,
  /**
   * Аренда джоба `voice.transcribe`, мс. Считается как probe (10 мин) + транскод
   * (10 мин) + sttTimeoutMaxMs (60 мин) + запас на скачивание байт из хранилища и
   * ожидание общего медиа-семафора. Меняешь любое слагаемое — правь и это число:
   * аренда МЕНЬШЕ реального бюджета обработчика означает переклейм reaper'ом во
   * время работы, то есть вторую параллельную расшифровку того же файла.
   */
  jobLeaseMs: 100 * 60 * 1000,
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
