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

/** Список адресов через запятую (белый список узлов): каждая запись обязана быть URL */
const urlList = (what: string) =>
  blank(
    z
      .string()
      .min(1)
      .refine(
        (v) =>
          v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
            .every((s) => z.string().url().safeParse(s).success),
        `${what}: a URL, or several URLs separated by commas`,
      )
      .optional(),
  );

/**
 * Единый предикат окружения для ВСЕЙ платформы. Dev/test — только явно объявленные;
 * всё остальное (опечатка, а главное — НЕЗАДАННАЯ переменная) трактуется как production.
 *
 * Читаем сырой process.env, а не разобранную схему: у NODE_ENV в схеме стоит
 * .default('development'), и сверка по result.data означала бы «забыли переменную в
 * контейнере ⇒ считаем это дев-окружением» — ровно наоборот к тому, что нужно.
 *
 * Записывать разобранный дефолт обратно в process.env НЕЛЬЗЯ: тогда при незаданной
 * переменной NODE_ENV станет 'development', и это ОТКРОЕТ Swagger (main.ts), включит
 * dev-полигон джобов (jobs.module/jobs.controller) и ВЫКЛЮЧИТ троттлер (app.module) —
 * защита ослабнет, а не усилится. Идиома ниже уже принята в этих трёх местах.
 */
export const isDevEnv = (): boolean =>
  process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
export const isProdEnv = (): boolean => !isDevEnv();

/**
 * IANA-зона, известная ICU этого Node. Неизвестная зона роняет `toLocaleString`/
 * `Intl.DateTimeFormat` RangeError'ом уже В МОМЕНТ подписи или расчёта календаря —
 * ловим её на старте, а не на первом документе.
 */
const isIanaTimeZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const envSchema = z
  .object({
    NODE_ENV: blank(
      z
        .enum(['development', 'test', 'production'], {
          errorMap: () => ({ message: 'must be one of: development | test | production' }),
        })
        .default('development'),
    ),
    DATABASE_URL: blank(z.string({ required_error: 'is required (PostgreSQL connection string)' }).min(1)),
    JWT_SECRET: blank(z.string({ required_error: 'is required' }).min(8, 'at least 8 characters')),
    // Время жизни access/refresh-токенов в записи jsonwebtoken/ms ('15m', '30d', '2 days').
    // Дефолты '15m' / '30d' живут в core/auth (auth.module / auth.service), которые читают
    // сырой process.env — схема лишь пропускает значение, формат не сужаем (ms принимает
    // и числа-секунды, и словесные интервалы; своя регулярка отвергла бы законное).
    JWT_EXPIRES_IN: blank(z.string().min(1).optional()),
    JWT_REFRESH_EXPIRES_IN: blank(z.string().min(1).optional()),
    REDIS_URL: blank(z.string().min(1).optional()),
    PORT: blank(z.coerce.number().int().positive().optional()),
    // Базовый адрес веба: редирект после OAuth, PostMessageOrigin редактора документов
    // и адрес гостевой ссылки `${WEB_URL}/s/<токен>` (core/share-links).
    WEB_URL: blank(z.string().url('must be a URL').optional()),
    // Часовой пояс детерминированного форматирования дат: штампы и протокол подписи
    // (core/sign), сутки производственного календаря (modules/hr). Потребители читают
    // сырой process.env с дефолтом 'Asia/Almaty' — .default() здесь ничего бы не дал,
    // поэтому его нет; проверяем лишь, что заданная зона существует.
    APP_TIMEZONE: blank(
      z.string().min(1).refine(isIanaTimeZone, 'must be an IANA time zone (Asia/Almaty, for example)').optional(),
    ),
    // --- Files engine (core/files) ---
    FILES_DRIVER: blank(
      z.enum(['local', 's3'], { errorMap: () => ({ message: 'must be local | s3' }) }).default('local'),
    ),
    FILES_LOCAL_ROOT: blank(z.string().min(1).optional()),
    // База абсолютных адресов НАШЕГО API: файловые ссылки, откат DOCS_WOPI_PUBLIC_URL,
    // QR подписи, ссылки документов. Пусто → http://localhost:${PORT||3001}.
    API_PUBLIC_URL: blank(z.string().url('must be a URL (the base API address for file links)').optional()),
    S3_ENDPOINT: blank(z.string().url('must be an S3 endpoint URL').optional()),
    S3_REGION: blank(z.string().min(1).optional()),
    S3_ACCESS_KEY_ID: blank(z.string().min(1).optional()),
    S3_SECRET_ACCESS_KEY: blank(z.string().min(1).optional()),
    S3_BUCKET: blank(z.string().min(1).optional()),
    S3_FORCE_PATH_STYLE: blank(z.enum(['true', 'false']).optional()),
    S3_PUBLIC_BASE_URL: blank(z.string().url().optional()),
    // --- Антивирус файлов (опционально; пусто → скан выключен) ---
    CLAMAV_HOST: blank(z.string().min(1).optional()),
    CLAMAV_PORT: blank(z.coerce.number().int().positive().optional()),
    // --- PDF-рендер блочных документов (Gotenberg, профиль pdf); пусто → выключен ---
    GOTENBERG_URL: blank(z.string().url('must be a Gotenberg URL (http://localhost:3030)').optional()),
    // --- Голосовой движок (core/voice) — STT; пусто → расшифровка выключена ---
    VOICE_STT_URL: blank(z.string().url('must be the URL of an OpenAI-compatible STT server').optional()),
    VOICE_STT_API_KEY: blank(z.string().min(1).optional()),
    VOICE_STT_MODEL: blank(z.string().min(1).optional()),
    VOICE_STT_MODEL_KK: blank(z.string().min(1).optional()),
    VOICE_STT_MOCK: blank(z.enum(['true', 'false']).optional()),
    // --- Движок звонков (core/calls) — LiveKit; пусто → звонки выключены ---
    LIVEKIT_URL: blank(z.string().url('must be a LiveKit server URL (http://localhost:7880)').optional()),
    LIVEKIT_API_KEY: blank(z.string().min(1).optional()),
    // Секрет — HMAC-ключ и для room-токенов, и для подписи вебхуков; LiveKit-сервер
    // сам не стартует с секретом короче 32 символов → требуем то же на входе.
    LIVEKIT_API_SECRET: blank(z.string().min(32, 'at least 32 characters (a LiveKit requirement)').optional()),
    LIVEKIT_WS_URL: blank(z.string().url('must be the LiveKit ws URL for the browser').optional()),
    // Запись звонков: хост-путь выходного каталога egress (bind-mount ↔ /out контейнера);
    // пусто → запись выключена (кнопка ⏺ скрыта)
    LIVEKIT_EGRESS_DIR: blank(z.string().min(1).optional()),
    // --- Движок документов (core/docs) — WOPI-клиент; пусто → документы выключены ---
    // Адрес(а) редактора: белый список узлов, из которого DocsRouterService выбирает базу
    // ПО ДОКУМЕНТУ (липко на время сессии). Никогда не берётся из пользовательского ввода:
    // это адрес, на который наш сервер ходит сам (discovery/convert-to) — иначе SSRF.
    DOCS_EDITOR_URL: urlList('DOCS_EDITOR_URL'),
    // Адрес НАШЕГО API, каким его видит КОНТЕЙНЕР редактора (WOPISrc резолвится изнутри
    // контейнера, а iframe грузится браузером — в разработке это разные адреса, обычно
    // http://host.docker.internal:3001). Пусто → откат на API_PUBLIC_URL. Пропуск этой
    // переменной — причина классического «WOPI::CheckFileInfo failed».
    DOCS_WOPI_PUBLIC_URL: blank(z.string().url('must be the API URL as seen FROM the editor container').optional()),
    // Ключ подписи WOPI-токенов. Пусто → выводится из JWT_SECRET (JWT_SECRET и так мастер-ключ
    // нескольких подсистем); отдельная переменная даёт возможность ротировать её независимо.
    DOCS_TOKEN_SECRET: blank(z.string().min(32, 'at least 32 characters').optional()),
    // --- Движок гостевых ссылок (core/share-links) ---
    // Ключ подписи ГОСТЕВЫХ пропусков (пропуск человека, уже открывшего ссылку).
    // Пусто → выводится из JWT_SECRET отдельной строкой контекста; отдельная переменная
    // позволяет ротировать её независимо. Адрес самой ссылки строится из WEB_URL.
    // Других переменных у движка нет — внешних зависимостей у него тоже нет.
    SHARE_LINK_SECRET: blank(z.string().min(32, 'at least 32 characters').optional()),
    // --- Кабинет платформы (core/platform) ---
    // Секрет токена КАБИНЕТА — отдельный от продуктового (утечка ключа продукта не даёт
    // подделать токен кабинета). В production ОБЯЗАТЕЛЕН (superRefine ниже); в
    // development пусто → производный от JWT_SECRET отдельной строкой контекста.
    PLATFORM_JWT_SECRET: blank(z.string().min(32, 'at least 32 characters').optional()),
    // Стоп-кран: `false` → все маршруты /platform/* отвечают 404 без деплоя кода.
    PLATFORM_CONSOLE_ENABLED: blank(z.enum(['true', 'false']).optional()),
    // --- Движок уведомлений (core/notifications) — web push (VAPID). Пусто → push выключен:
    // тумблер «уведомления браузера» в вебе не показывается, доставки `skipped: driver_not_configured`.
    // Пара генерируется один раз: `npx web-push generate-vapid-keys`.
    WEB_PUSH_VAPID_PUBLIC_KEY: blank(z.string().min(32).optional()),
    WEB_PUSH_VAPID_PRIVATE_KEY: blank(z.string().min(16).optional()),
    // Контакт для push-служб (mailto: или https:) — обязателен по спецификации VAPID
    WEB_PUSH_SUBJECT: blank(z.string().regex(/^(mailto:|https:)/, 'mailto:… or https://…').optional()),
    // --- Движок подтверждений (core/verify) — SMS-OTP ---
    SMS_DRIVER: blank(
      z.enum(['kazinfoteh', 'mock'], { errorMap: () => ({ message: 'must be kazinfoteh | mock' }) }).optional(),
    ),
    KIT_USERNAME: blank(z.string().min(1).optional()),
    KIT_PASSWORD: blank(z.string().min(1).optional()),
    // Альфа-имя отправителя. Дефолта нет намеренно: чужое имя шлюз отобьёт, а
    // диагностировать это по «provider status» долго.
    KIT_ORIGINATOR: blank(z.string().min(1).optional()),
    // Адрес HTTP-шлюза (пусто → боевой kazinfoteh.org:9507/api); вынесен под staging.
    KIT_URL: blank(z.string().url().optional()),
    // Обязательность SMS-подтверждения: пусто = secure-by-default (production → да).
    // 'true' — форс полного пути в dev; 'false' — аварийный рубильник в production.
    VERIFY_REQUIRED: blank(z.enum(['true', 'false']).optional()),
    // Тест-карта "+7700…:111111,…" — SMS не шлётся, код фиксированный (CI/verify-скрипты).
    // В production карта игнорируется, если не задан явный VERIFY_TEST_PHONES_ALLOW_PROD.
    VERIFY_TEST_PHONES: blank(z.string().min(1).optional()),
    VERIFY_TEST_PHONES_ALLOW_PROD: blank(z.enum(['true', 'false']).optional()),
    VERIFY_SMS_HOURLY_BUDGET: blank(z.coerce.number().int().positive().optional()),
    // Домен для origin-bound строки в SMS («@domain #code» — автозаполнение iOS/Android)
    VERIFY_SMS_ORIGIN_DOMAIN: blank(z.string().min(1).optional()),
    // Сколько прокси-хопов перед API доверять при разборе X-Forwarded-For (обычно '1'
    // за одним балансировщиком; можно список подсетей). Пусто → XFF игнорируется и
    // req.ip = адрес сокета. Всё, что считается «по IP» (троттлер, IP-эшелоны
    // core/verify), зависит от этой настройки — см. main.ts.
    TRUST_PROXY: blank(z.string().min(1).optional()),
    // --- Движок подписи (core/sign) ---
    // Верификатор ЭЦП. Пусто → `ncanode`, если задан NCANODE_URL, иначе `mock`.
    // MOCK В PRODUCTION НЕ «чуть хуже»: движок в этом режиме ОТВЕРГАЕТ ЭЦП, потому
    // что непроверенная подпись выдаёт за электронную цифровую подпись то, чем она
    // не является. ПЭП по SMS при этом работает.
    SIGN_VERIFY_DRIVER: blank(
      z.enum(['ncanode', 'mock'], { errorMap: () => ({ message: 'must be ncanode | mock' }) }).optional(),
    ),
    // Адрес верификатора. Как и адрес редактора документов, берётся ТОЛЬКО из env:
    // на него ходит наш сервер, значит из пользовательского ввода это был бы SSRF.
    // Сборка образа — infra/sign-verifier/ (SDK НУЦ не коммитится).
    NCANODE_URL: blank(z.string().url('must be the verifier URL (http://localhost:14579)').optional()),
    // Мост подписания через eGov Mobile (Smart Bridge, сервис NITEC-S-5096).
    // Пусто → mock: QR рисуется, но ведёт на наш же одноразовый адрес.
    SIGN_QR_DRIVER: blank(
      z.enum(['smartbridge', 'mock'], { errorMap: () => ({ message: 'must be smartbridge | mock' }) }).optional(),
    ),
    SMARTBRIDGE_URL: blank(z.string().url('must be the Smart Bridge URL').optional()),
    SMARTBRIDGE_CLIENT_ID: blank(z.string().min(1).optional()),
    SMARTBRIDGE_CLIENT_SECRET: blank(z.string().min(1).optional()),
    // --- Процессы (modules/processes) ---
    // База ПУБЛИЧНЫХ адресов вебхуков: внешние системы дёргают
    // `${API_URL}/api/processes/webhook/:token`. Пусто → http://localhost:${PORT||3001}.
    // Отдельная от API_PUBLIC_URL переменная (исторически); читается сырым process.env.
    API_URL: blank(z.string().url('must be a URL (the base for public process-webhook addresses)').optional()),
    // --- Google Calendar (modules/google-calendar) — OAuth; пусто → интеграция инертна ---
    // Включается только целиком: isConfigured() = заданы все три. Неполный набор — не
    // ошибка бута, а выключенная интеграция (в отличие от LiveKit): календарь без Google
    // полностью работоспособен, ронять всё приложение из-за него неправильно.
    GOOGLE_CLIENT_ID: blank(z.string().min(1).optional()),
    GOOGLE_CLIENT_SECRET: blank(z.string().min(1).optional()),
    // Должен совпадать с redirect в консоли Google:
    // `${API_PUBLIC_URL}/api/v1/integrations/google/callback`.
    GOOGLE_REDIRECT_URI: blank(z.string().url('must be a URL (…/api/v1/integrations/google/callback)').optional()),
    // Публичный адрес для push-уведомлений (events.watch); Google принимает только HTTPS.
    // Пусто → watch не регистрируется, синхронизация идёт поллингом.
    GOOGLE_WEBHOOK_URL: blank(z.string().url('must be a public HTTPS URL for Google push').optional()),
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
            message: 'is required when FILES_DRIVER=s3',
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
            message: 'is required whenever any LIVEKIT_* is set',
          });
        }
      }
    }
    // Запись звонков живёт только поверх включённого LiveKit
    if (env.LIVEKIT_EGRESS_DIR && !env.LIVEKIT_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['LIVEKIT_EGRESS_DIR'],
        message: 'requires LiveKit to be enabled (LIVEKIT_URL/API_KEY/API_SECRET)',
      });
    }
    // Движок документов: редактор ходит на НАШ API за содержимым файла, поэтому адрес,
    // по которому мы для него доступны, обязан быть известен ЯВНО. Молчаливый откат на
    // дефолт API_PUBLIC_URL (http://localhost:PORT) означал бы «localhost внутри чужого
    // контейнера» — редактор открывался бы с ошибкой на каждом документе.
    if (env.DOCS_EDITOR_URL && !env.DOCS_WOPI_PUBLIC_URL && !env.API_PUBLIC_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DOCS_WOPI_PUBLIC_URL'],
        message:
          'is required with DOCS_EDITOR_URL (the API address as seen FROM the editor container, ' +
          'usually http://host.docker.internal:3001) — or set API_PUBLIC_URL instead',
      });
    }
    // Верификатор ЭЦП включается только целиком: `ncanode` без адреса — это
    // молчаливый откат на mock, то есть «подпись принимается непроверенной».
    if (env.SIGN_VERIFY_DRIVER === 'ncanode' && !env.NCANODE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['NCANODE_URL'],
        message: 'is required when SIGN_VERIFY_DRIVER=ncanode (image build — infra/sign-verifier/)',
      });
    }
    // Мост eGov Mobile — тоже целиком: без кредов он не мост, а mock.
    if (env.SIGN_QR_DRIVER === 'smartbridge') {
      for (const key of ['SMARTBRIDGE_URL', 'SMARTBRIDGE_CLIENT_ID', 'SMARTBRIDGE_CLIENT_SECRET'] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: 'is required when SIGN_QR_DRIVER=smartbridge (service request NITEC-S-5096)',
          });
        }
      }
    }
    // Kazinfoteh включается только целиком
    if (env.SMS_DRIVER === 'kazinfoteh') {
      for (const key of ['KIT_USERNAME', 'KIT_PASSWORD', 'KIT_ORIGINATOR'] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: 'is required when SMS_DRIVER=kazinfoteh',
          });
        }
      }
    }
    // isProdEnv(), а не env.NODE_ENV === 'production': незаданная переменная должна
    // подчиняться прод-требованиям, а не проскакивать по дефолту схемы.
    if (isProdEnv()) {
      if (!env.REDIS_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['REDIS_URL'],
          message: 'is required in production (without it there is a silent fallback to localhost — throttling, the bus and locks all fail)',
        });
      }
      if (env.JWT_SECRET && env.JWT_SECRET.length < 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['JWT_SECRET'],
          message: 'at least 32 characters in production',
        });
      }
      // Токен кабинета платформы подписывается СВОИМ секретом: производный от JWT_SECRET
      // допустим только в development (утечка ключа продукта не должна открывать кабинет).
      if (!env.PLATFORM_JWT_SECRET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['PLATFORM_JWT_SECRET'],
          message: 'is required in production (the platform console token must not derive from JWT_SECRET)',
        });
      }
    }
  });

export function validateEnv(): void {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new Error(`Invalid environment configuration (.env):\n${lines.join('\n')}`);
  }
  // Не ошибка, но громкое предупреждение: local-драйвер файлов хранит байты на диске
  // ОДНОГО инстанса. Второй инстанс API молча ломает загрузки (complete → 400), выдачу
  // (raw → ENOENT) и голосовую транскрипцию. Масштабирование по горизонтали = FILES_DRIVER=s3.
  if (isProdEnv() && result.data.FILES_DRIVER === 'local') {
    // eslint-disable-next-line no-console
    console.warn(
      '⚠️  FILES_DRIVER=local in production: the files engine is bound to the disk of a SINGLE instance.\n' +
        '    More than one API instance with this driver MUST NOT be started (files would seem to vanish).\n' +
        '    Switch to FILES_DRIVER=s3 to scale horizontally.',
    );
  }
  // Аварийный рубильник SMS-подтверждения в production — законно, но громко:
  // регистрация без подтверждения номера возвращает дыру «занял чужой номер —
  // получил его приглашения».
  // Прод почти всегда стоит за балансировщиком/CDN. Без TRUST_PROXY req.ip у ВСЕХ
  // запросов равен адресу этого прокси: IP-лимиты движка подтверждений и троттлер
  // платформы схлопываются в один общий счётчик и начинают резать живых людей.
  if (isProdEnv() && !result.data.TRUST_PROXY) {
    // eslint-disable-next-line no-console
    console.warn(
      '⚠️  TRUST_PROXY is not set in production: X-Forwarded-For is ignored and req.ip is the proxy address.\n' +
        '    If the API sits behind a balancer, set the hop count (usually TRUST_PROXY=1),\n' +
        '    otherwise every client shares one rate-limit counter. If the API faces the internet directly, this is fine.',
    );
  }
  if (isProdEnv() && result.data.VERIFY_REQUIRED === 'false') {
    // eslint-disable-next-line no-console
    console.warn(
      '⚠️  VERIFY_REQUIRED=false in production: the SMS phone confirmation is OFF.\n' +
        '    Accounts are created without proving phone ownership — set it back to true as soon as possible.',
    );
  }
  // Драйвер SMS выбирается по СОВПАДЕНИЮ с 'kazinfoteh', то есть незаданная переменная
  // молча даёт mock: реальные SMS никуда не уходят и никто не может зарегистрироваться.
  // Сами коды в лог больше не попадают (см. VerifySmsService), но состояние всё равно
  // нерабочее — объявляем его громко.
  if (isProdEnv() && result.data.SMS_DRIVER !== 'kazinfoteh') {
    // eslint-disable-next-line no-console
    console.warn(
      '⚠️  SMS_DRIVER is not set in production: the verification engine runs on the mock driver,\n' +
        '    no SMS is actually sent — sign-up and password reset are unavailable to real people.\n' +
        '    Set SMS_DRIVER=kazinfoteh together with KIT_USERNAME/KIT_PASSWORD/KIT_ORIGINATOR.',
    );
  }
  // Верификатор ЭЦП в production без адреса = mock. Это НЕ деградация «чуть хуже»:
  // движок в таком режиме ОТВЕРГАЕТ электронную подпись, потому что принять
  // непроверенную значило бы выдать её за ЭЦП. Говорим об этом громко — иначе
  // «почему у нас не работает подписание документов» выясняется от клиента.
  if (isProdEnv() && result.data.SIGN_VERIFY_DRIVER !== 'ncanode' && !result.data.NCANODE_URL) {
    // eslint-disable-next-line no-console
    console.warn(
      '🚨 The digital-signature verifier is not configured in production: ECP signing is OFF (an\n' +
        '    unverified signature cannot be accepted). The simple SMS signature keeps working.\n' +
        '    Set NCANODE_URL — the image build and the runbook are in infra/sign-verifier/.',
    );
  }
  // Той же природы: каталог egress-записей звонков должен быть ОБЩИМ томом всех инстансов
  // (вебхук финализации приходит на произвольный инстанс за LB).
  if (isProdEnv() && result.data.LIVEKIT_EGRESS_DIR) {
    // eslint-disable-next-line no-console
    console.warn(
      '⚠️  LIVEKIT_EGRESS_DIR in production: the directory must be mounted on EVERY API instance\n' +
        '    (the recording is finalized by whichever instance the balancer delivered egress_ended to).',
    );
  }
}
