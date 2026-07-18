import { z } from 'zod';

/**
 * Fail-fast environment validation, run at the very top of bootstrap() BEFORE Nest starts.
 * Closes the "typo in NODE_ENV silently disables login throttling and opens Swagger" hole:
 * an unknown NODE_ENV value (e.g. "prod", "Production") refuses to boot instead of being
 * treated as not-production. Production additionally REQUIRES an explicit REDIS_URL (without
 * it the RedisService would silently fall back to localhost) and a strong JWT_SECRET.
 */
/**
 * '' в .env = «не задано»: рантайм везде трактует пустую переменную как выключенную
 * фичу (`!!process.env.X`), а скопированный .env.example с пустыми значениями не
 * должен валить бут. Пустая строка срезается ДО схемы → .optional()/.default() работают.
 */
const blank = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema);

const envSchema = z
  .object({
    NODE_ENV: blank(
      z
        .enum(['development', 'test', 'production'], {
          errorMap: () => ({ message: 'должен быть одним из: development | test | production' }),
        })
        .default('development'),
    ),
    DATABASE_URL: blank(z.string({ required_error: 'обязателен (PostgreSQL connection string)' }).min(1)),
    JWT_SECRET: blank(z.string({ required_error: 'обязателен' }).min(8, 'минимум 8 символов')),
    REDIS_URL: blank(z.string().min(1).optional()),
    PORT: blank(z.coerce.number().int().positive().optional()),
    WEB_URL: blank(z.string().url('должен быть URL').optional()),
    // --- Files engine (core/files) ---
    FILES_DRIVER: blank(
      z.enum(['local', 's3'], { errorMap: () => ({ message: 'должен быть local | s3' }) }).default('local'),
    ),
    FILES_LOCAL_ROOT: blank(z.string().min(1).optional()),
    API_PUBLIC_URL: blank(z.string().url('должен быть URL (базовый адрес API для файловых ссылок)').optional()),
    S3_ENDPOINT: blank(z.string().url('должен быть URL S3-эндпоинта').optional()),
    S3_REGION: blank(z.string().min(1).optional()),
    S3_ACCESS_KEY_ID: blank(z.string().min(1).optional()),
    S3_SECRET_ACCESS_KEY: blank(z.string().min(1).optional()),
    S3_BUCKET: blank(z.string().min(1).optional()),
    S3_FORCE_PATH_STYLE: blank(z.enum(['true', 'false']).optional()),
    S3_PUBLIC_BASE_URL: blank(z.string().url().optional()),
    // --- Антивирус файлов (опционально; пусто → скан выключен) ---
    CLAMAV_HOST: blank(z.string().min(1).optional()),
    CLAMAV_PORT: blank(z.coerce.number().int().positive().optional()),
    // --- Голосовой движок (core/voice) — STT; пусто → расшифровка выключена ---
    VOICE_STT_URL: blank(z.string().url('должен быть URL OpenAI-совместимого STT-сервера').optional()),
    VOICE_STT_API_KEY: blank(z.string().min(1).optional()),
    VOICE_STT_MODEL: blank(z.string().min(1).optional()),
    VOICE_STT_MODEL_KK: blank(z.string().min(1).optional()),
    VOICE_STT_MOCK: blank(z.enum(['true', 'false']).optional()),
    // --- Движок звонков (core/calls) — LiveKit; пусто → звонки выключены ---
    LIVEKIT_URL: blank(z.string().url('должен быть URL LiveKit-сервера (http://localhost:7880)').optional()),
    LIVEKIT_API_KEY: blank(z.string().min(1).optional()),
    // Секрет — HMAC-ключ и для room-токенов, и для подписи вебхуков; LiveKit-сервер
    // сам не стартует с секретом короче 32 символов → требуем то же на входе.
    LIVEKIT_API_SECRET: blank(z.string().min(32, 'минимум 32 символа (требование LiveKit)').optional()),
    LIVEKIT_WS_URL: blank(z.string().url('должен быть ws-URL LiveKit для браузера').optional()),
    // Запись звонков: хост-путь выходного каталога egress (bind-mount ↔ /out контейнера);
    // пусто → запись выключена (кнопка ⏺ скрыта)
    LIVEKIT_EGRESS_DIR: blank(z.string().min(1).optional()),
  })
  .superRefine((env, ctx) => {
    if (env.FILES_DRIVER === 's3') {
      const required: Array<keyof typeof env> = [
        'S3_ENDPOINT',
        'S3_REGION',
        'S3_ACCESS_KEY_ID',
        'S3_SECRET_ACCESS_KEY',
        'S3_BUCKET',
      ];
      for (const key of required) {
        if (!env[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key as string],
            message: 'обязателен при FILES_DRIVER=s3',
          });
        }
      }
    }
    // LiveKit включается только целиком: задан любой из трёх → нужны все три
    // (LIVEKIT_WS_URL опционален — выводится из LIVEKIT_URL заменой http→ws)
    const livekitKeys = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'] as const;
    if (livekitKeys.some((k) => !!env[k]) && !livekitKeys.every((k) => !!env[k])) {
      for (const key of livekitKeys) {
        if (!env[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: 'обязателен, когда задан любой из LIVEKIT_*',
          });
        }
      }
    }
    // Запись звонков живёт только поверх включённого LiveKit
    if (env.LIVEKIT_EGRESS_DIR && !env.LIVEKIT_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['LIVEKIT_EGRESS_DIR'],
        message: 'требует включённого LiveKit (LIVEKIT_URL/API_KEY/API_SECRET)',
      });
    }
    if (env.NODE_ENV === 'production') {
      if (!env.REDIS_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['REDIS_URL'],
          message: 'обязателен в production (без него тихий fallback на localhost — отказ троттлинга/шины/локов)',
        });
      }
      if (env.JWT_SECRET && env.JWT_SECRET.length < 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['JWT_SECRET'],
          message: 'в production минимум 32 символа',
        });
      }
    }
  });

export function validateEnv(): void {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new Error(`Некорректная конфигурация окружения (.env):\n${lines.join('\n')}`);
  }
  // Не ошибка, но громкое предупреждение: local-драйвер файлов хранит байты на диске
  // ОДНОГО инстанса. Второй инстанс API молча ломает загрузки (complete → 400), выдачу
  // (raw → ENOENT) и голосовую транскрипцию. Масштабирование по горизонтали = FILES_DRIVER=s3.
  if (result.data.NODE_ENV === 'production' && result.data.FILES_DRIVER === 'local') {
    // eslint-disable-next-line no-console
    console.warn(
      '⚠️  FILES_DRIVER=local в production: файловый движок привязан к диску ОДНОГО инстанса.\n' +
        '    Больше одного инстанса API с этим драйвером поднимать НЕЛЬЗЯ (файлы будут «пропадать»).\n' +
        '    Для горизонтального масштабирования переключитесь на FILES_DRIVER=s3.',
    );
  }
  // Той же природы: каталог egress-записей звонков должен быть ОБЩИМ томом всех инстансов
  // (вебхук финализации приходит на произвольный инстанс за LB).
  if (result.data.NODE_ENV === 'production' && result.data.LIVEKIT_EGRESS_DIR) {
    // eslint-disable-next-line no-console
    console.warn(
      '⚠️  LIVEKIT_EGRESS_DIR в production: каталог должен быть смонтирован на ВСЕХ инстансах API\n' +
        '    (финализация записи выполняется тем инстансом, куда LB доставил вебхук egress_ended).',
    );
  }
}
