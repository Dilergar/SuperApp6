import { z } from 'zod';

/**
 * Fail-fast environment validation, run at the very top of bootstrap() BEFORE Nest starts.
 * Closes the "typo in NODE_ENV silently disables login throttling and opens Swagger" hole:
 * an unknown NODE_ENV value (e.g. "prod", "Production") refuses to boot instead of being
 * treated as not-production. Production additionally REQUIRES an explicit REDIS_URL (without
 * it the RedisService would silently fall back to localhost) and a strong JWT_SECRET.
 */
const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'], {
        errorMap: () => ({ message: 'должен быть одним из: development | test | production' }),
      })
      .default('development'),
    DATABASE_URL: z.string({ required_error: 'обязателен (PostgreSQL connection string)' }).min(1),
    JWT_SECRET: z.string({ required_error: 'обязателен' }).min(8, 'минимум 8 символов'),
    REDIS_URL: z.string().min(1).optional(),
    PORT: z.coerce.number().int().positive().optional(),
    WEB_URL: z.string().url('должен быть URL').optional(),
    // --- Files engine (core/files) ---
    FILES_DRIVER: z
      .enum(['local', 's3'], { errorMap: () => ({ message: 'должен быть local | s3' }) })
      .default('local'),
    FILES_LOCAL_ROOT: z.string().min(1).optional(),
    API_PUBLIC_URL: z.string().url('должен быть URL (базовый адрес API для файловых ссылок)').optional(),
    S3_ENDPOINT: z.string().url('должен быть URL S3-эндпоинта').optional(),
    S3_REGION: z.string().min(1).optional(),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    S3_BUCKET: z.string().min(1).optional(),
    S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).optional(),
    S3_PUBLIC_BASE_URL: z.string().url().optional(),
    // --- Антивирус файлов (опционально; пусто → скан выключен) ---
    CLAMAV_HOST: z.string().min(1).optional(),
    CLAMAV_PORT: z.coerce.number().int().positive().optional(),
    // --- Голосовой движок (core/voice) — STT; пусто → расшифровка выключена ---
    VOICE_STT_URL: z.string().url('должен быть URL OpenAI-совместимого STT-сервера').optional(),
    VOICE_STT_API_KEY: z.string().min(1).optional(),
    VOICE_STT_MODEL: z.string().min(1).optional(),
    VOICE_STT_MODEL_KK: z.string().min(1).optional(),
    VOICE_STT_MOCK: z.enum(['true', 'false']).optional(),
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
}
