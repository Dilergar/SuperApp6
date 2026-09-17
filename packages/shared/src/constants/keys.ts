// ============================================================
// core/keys — лимиты и сроки (автодефолты грилла 2026-09-14 по решениям гигантов)
// ============================================================

export const KEYS_LIMITS = {
  /** Ротация KEK (rewrap фоном), дней */
  kekRotationDays: 365,
  /** Ротация ключей подписи JWT, дней (с перекрытием) */
  signingRotationDays: 90,
  /** Новая версия подписи из `pending` в `active` — не раньше, чем протух кэш JWKS */
  signingActivateDelayMin: 15,
  /** Кэш JWKS у внешних верификаторов, секунд (Cache-Control) */
  jwksCacheSec: 600,
  /** Кэш распакованных KEK в памяти процесса, секунд */
  kekCacheSec: 300,
  /** Микро-кэш эпохи Redis, мс (заморозка/ротация доезжает за это время) */
  epochCacheMs: 1000,
  /** От `destroy_scheduled` до `destroyed`, дней (= срок архива организации) */
  destroyDelayDays: 30,
  /** Личный ключ (PAT): дефолт и потолок, дней */
  patDefaultDays: 90,
  patMaxDays: 365,
  /** Ключ бота: дефолт, дней; «бессрочно» — только owner с IP-allowlist */
  botKeyDefaultDays: 365,
  /** Живых секретов в семействе (ротация с перекрытием) */
  familyMaxLive: 2,
  /** Окно grace старого секрета при ротации, дней */
  graceMaxDays: 7,
  /** Батч `last_used_at`/`use_count` из Redis в БД, секунд */
  lastUsedFlushSec: 60,
  /** Кэш результата проверки ключа, секунд */
  keyCacheSec: 60,
  /** Ретеншн журнала обращений ключей, дней */
  accessLogRetentionDays: 90,
  /** Отказов 401/403 на связку IP+префикс ключа за час до блокировки (модель Discord) */
  authFailPerHour: 50,
  /** Потолок обращений одного ключа в минуту (троттлер по ключу, Redis-корзина минуты) */
  requestsPerMinute: 600,
  /** Потолок объёма выгрузки одним ключом в сутки, строк списков (аномалия Salesloft) */
  exportRowsPerDay: 200_000,
  /** Окно step-up `keys_manage`, минут */
  stepUpMinutes: 15,
  /** Уведомления об истечении: за N дней */
  expiringNoticeDays: [14, 1] as const,
  /** Фильтр «не использовались N дней» */
  idleDays: 90,
  /** Фильтр «истекают за N дней» */
  expiringDays: 14,
  /** Grace для повторного предъявления прокрученного refresh-токена (сетевой ретрай), секунд */
  refreshReuseGraceSec: 10,
  /** Байт энтропии в теле ключа (≥ 256 бит) */
  secretBytes: 32,
  /** Ключ показывается один раз; last4 — для маски */
  last4: 4,
  /** Поле «для чего» — обязательное */
  purposeMinLength: 3,
  purposeMaxLength: 300,
  nameMaxLength: 80,
  storedHintMaxLength: 200,
  /** IP-allowlist: записей не больше */
  ipAllowlistMax: 32,
  /** Страница реестра и журнала */
  registryPageSize: 50,
  journalPageSize: 50,
  /** Батч фоновых перешифровок / бэкфилла ПДн */
  rewrapBatch: 500,
  /** Re-fetch неизвестного `kid` из БД — не чаще раза в N секунд на процесс */
  unknownKidRefetchSec: 5,
} as const;

/** Исходящие вебхуки (core/webhooks). */
export const WEBHOOK_LIMITS = {
  /** Попыток доставки с экспоненциальным бэкоффом до ~3 суток */
  maxAttempts: 12,
  backoffBaseSec: 30,
  backoffCapSec: 6 * 3600,
  /** Таймаут запроса к endpoint'у, мс */
  timeoutMs: 10_000,
  /** Допуск timestamp подписи у получателя (Standard Webhooks), секунд */
  toleranceSec: 300,
  /** Старый секрет после ротации живёт не дольше, часов */
  prevSecretHours: 24,
  /** Подряд провалов доставки до автоотключения endpoint'а */
  failuresToDisable: 50,
  /** Потолок тела события, байт */
  maxPayloadBytes: 64 * 1024,
  /** Аудит битой подписью: раз в сутки (модель Discord) */
  probeIntervalHours: 24,
  /** Ретеншн доставок, дней */
  deliveryRetentionDays: 30,
  /** Событий на endpoint не больше */
  maxEventsPerEndpoint: 100,
  /** Показ последних доставок в карточке */
  recentDeliveries: 20,
} as const;

/** Redis-ключи движка (единый префикс — kill-switch и наблюдаемость). */
export const KEYS_REDIS = {
  epoch: 'keys:epoch',
  apiKey: (keyId: string) => `keys:api:${keyId}`,
  lastUsed: 'keys:last-used',
  authFail: (ip: string, prefix: string) => `keys:fail:${ip}:${prefix}`,
  /** Корзина минуты троттлера по ключу (`minute` = floor(epoch / 60 000)) */
  rate: (keyId: string, minute: number) => `keys:rate:${keyId}:${minute}`,
  exportRows: (keyId: string, day: string) => `keys:export:${keyId}:${day}`,
  stepUp: (userId: string) => `keys:stepup:${userId}`,
} as const;
