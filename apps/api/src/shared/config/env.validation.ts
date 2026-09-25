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
 * Обязателен ли явный пакет согласий там, где среда вправе его не требовать (создание
 * организации). Secure-by-default: всё, кроме объявленных development/test, — да;
 * `CONSENTS_REQUIRED` перекрывает в обе стороны (образец — `VERIFY_REQUIRED`).
 */
export const consentsRequired = (): boolean => {
  const flag = process.env.CONSENTS_REQUIRED;
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return isProdEnv();
};

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
    // Читается ТОЛЬКО стражем main.ts: в production флаги отладчика/heap-snapshot в NODE_OPTIONS
    // роняют бут (память процесса содержит распакованные ключи). Схема не ограничивает значение.
    NODE_OPTIONS: blank(z.string().optional()),
    NODE_ENV: blank(
      z
        .enum(['development', 'test', 'production'], {
          errorMap: () => ({ message: 'must be one of: development | test | production' }),
        })
        .default('development'),
    ),
    DATABASE_URL: blank(z.string({ required_error: 'is required (PostgreSQL connection string)' }).min(1)),
    // --- Движок ключей (core/keys) ---
    // Провайдер корня доверия: `software` — файл с правами 0600 (KEYS_ROOT_KEY_FILE),
    // `pkcs11` — HSM/сертифицированная СКЗИ (слот, реализация — по заключению юриста).
    KEYS_PROVIDER: blank(z.enum(['software', 'pkcs11'], { errorMap: () => ({ message: 'must be software | pkcs11' }) }).optional()),
    // Файл корневого ключа (32 байта hex/base64/raw), создаётся церемонией
    // `apps/api/scripts/keys-init-root.cjs`. Production — ОБЯЗАТЕЛЕН (superRefine ниже);
    // development пусто → `./.keys/root.key` генерируется при первом старте (громкий warn).
    KEYS_ROOT_KEY_FILE: blank(z.string().min(1).optional()),
    // Окно ротации корня: файл СЛЕДУЮЩЕГО корня (церемония). Пока задан, инстанс читает версии
    // под обоими корнями, а команда `keys.root.rotate` перешивает их порциями в фоне.
    KEYS_ROOT_KEY_FILE_NEXT: blank(z.string().min(1).optional()),
    // Legacy HS256: до этой даты верификаторы принимают токены старого формата, подписанные
    // JWT_SECRET_LEGACY (окно = 30 дней refresh). После — HS256 выключен, секрет обязан уйти из env.
    KEYS_LEGACY_HS256_UNTIL: blank(z.string().datetime({ message: 'must be an ISO date-time (2026-10-14T00:00:00Z)' }).optional()),
    // Прежний мастер-секрет — только на legacy-окне (подпись новых токенов им не идёт никогда).
    // JWT_SECRET принимается как устаревший синоним на то же окно.
    JWT_SECRET_LEGACY: blank(z.string().min(8, 'at least 8 characters').optional()),
    JWT_SECRET: blank(z.string().min(8, 'at least 8 characters').optional()),
    // Режим чтения ПДн на окне dual-write миграции: `legacy` (старые колонки) | `encrypted` (`*_enc`/`*_bi`).
    KEYS_PII_READ_MODE: blank(z.enum(['legacy', 'encrypted'], { errorMap: () => ({ message: 'must be legacy | encrypted' }) }).optional()),
    /** Dev-полигон вебхуков: доставка на http://127.0.0.1 (сьют поднимает приёмник). В production запрещено. */
    WEBHOOKS_DEV_LOOPBACK: blank(z.enum(['true', 'false']).optional()),
    // Метрики Prometheus `GET /metrics` (shared/metrics): токен скрейпера. Задан → Bearer
    // обязателен; пусто → в production маршрут отвечает 404, в development открыт.
    METRICS_TOKEN: blank(z.string().min(16, 'at least 16 characters').optional()),
    // Отчёты бэкапов и учений восстановления (core/lifecycle): Bearer + ключ HMAC тела; пусто — в production 404
    LIFECYCLE_OPS_TOKEN: blank(z.string().min(32, 'at least 32 characters').optional()),
    // Источник восстановления арендатора (core/lifecycle): кластер, поднятый из бэкапа на точку
    // времени (PITR), роль только на чтение. Пусто — в production команды восстановления
    // отказывают, в development источником служит основная база (сьют).
    LIFECYCLE_RESTORE_SOURCE_URL: blank(z.string().min(1).optional()),
    // Заделы под pkcs11 (читаются провайдером при KEYS_PROVIDER=pkcs11).
    KEYS_PKCS11_MODULE: blank(z.string().min(1).optional()),
    KEYS_PKCS11_SLOT: blank(z.coerce.number().int().min(0).optional()),
    KEYS_PKCS11_PIN: blank(z.string().min(1).optional()),
    KEYS_PKCS11_KEY_LABEL: blank(z.string().min(1).optional()),
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
    // УСТАРЕЛ (окно legacy): прежний ключ HMAC WOPI-токенов формата `v1.…`. Читается только
    // для ПРОВЕРКИ токенов, выданных до движка ключей, и только пока открыто окно
    // KEYS_LEGACY_HS256_UNTIL; новые токены подписывает keystore (аудитория `wopi`).
    DOCS_TOKEN_SECRET: blank(z.string().min(32, 'at least 32 characters').optional()),
    // --- Движок гостевых ссылок (core/share-links) ---
    // УСТАРЕЛ (окно legacy): прежний ключ HMAC гостевых пропусков `v1.…` — только проверка
    // старых пропусков до KEYS_LEGACY_HS256_UNTIL; новые подписывает keystore (`share_link`).
    // Адрес самой ссылки строится из WEB_URL; других переменных у движка нет.
    SHARE_LINK_SECRET: blank(z.string().min(32, 'at least 32 characters').optional()),
    // --- Кабинет платформы (core/platform) ---
    // УСТАРЕЛ (окно legacy): прежний HS256-секрет токена кабинета — только проверка токенов,
    // выданных до движка ключей, пока открыто окно KEYS_LEGACY_HS256_UNTIL. Новые токены
    // кабинета подписывает keystore своей парой (аудитория `platform` ≠ `product`), поэтому
    // отдельный секрет больше не нужен; после окна переменная обязана уйти (superRefine).
    PLATFORM_JWT_SECRET: blank(z.string().min(32, 'at least 32 characters').optional()),
    // Стоп-кран: `false` → все маршруты /platform/* отвечают 404 без деплоя кода.
    PLATFORM_CONSOLE_ENABLED: blank(z.enum(['true', 'false']).optional()),
    // --- Продуктовая аналитика (core/analytics) ---
    // Стоп-кран движка: `false` → приём отвечает 202 без записи, `track()` молчит.
    ANALYTICS_ENABLED: blank(z.enum(['true', 'false']).optional()),
    // Консьюмер stream'а и outbox на ЭТОМ инстансе (выключают на инстансах только-HTTP).
    ANALYTICS_CONSUMER_ENABLED: blank(z.enum(['true', 'false']).optional()),
    // Ретенция сырья, дней (13 месяцев по умолчанию); роллапы живут вечно.
    ANALYTICS_RAW_RETENTION_DAYS: blank(z.coerce.number().int().min(35).max(3650).optional()),
    // Приблизительный потолок stream'а приёма; сброс по классам — с 80 % и 95 %.
    ANALYTICS_STREAM_MAXLEN: blank(z.coerce.number().int().min(10_000).max(50_000_000).optional()),
    // Порог k-анонимности ячейки разбиения (меньше людей — ячейка скрыта).
    ANALYTICS_K_ANON: blank(z.coerce.number().int().min(2).max(1000).optional()),
    // Префиксы номеров внутренних/тестовых аккаунтов через запятую (помечаются is_internal).
    ANALYTICS_INTERNAL_PHONE_PREFIXES: blank(
      z.string().regex(/^\+\d{3,15}(,\s*\+\d{3,15})*$/, 'phone prefixes like +7700999,+770012').optional(),
    ),
    // Реплика / роль только-чтение для запросов Кабинета (пусто → основной пул).
    ANALYTICS_READ_DATABASE_URL: blank(z.string().min(1).optional()),
    // statement_timeout запроса Кабинета по сырью, мс.
    ANALYTICS_QUERY_TIMEOUT_MS: blank(z.coerce.number().int().min(500).max(120_000).optional()),
    // --- Идемпотентность повторов (core/idempotency) ---
    // Режим движка. Пусто = `enforce` (защита с первого запуска); `observe` — окно
    // выката (заявки заводятся, отказов нет), `off` — полный стоп-кран.
    IDEMPOTENCY_MODE: blank(z.enum(['off', 'observe', 'enforce']).optional()),
    // Сколько дней живёт запись о ключе (окно защиты от повтора).
    IDEMPOTENCY_KEY_TTL_DAYS: blank(z.coerce.number().int().min(1).max(90).optional()),
    // Сколько часов живёт СНИМОК тела ответа (реплей с телом).
    IDEMPOTENCY_RESPONSE_TTL_HOURS: blank(z.coerce.number().int().min(1).max(720).optional()),
    // Аренда исполнения, мс: дольше — и упавший процесс держит ключ зря.
    IDEMPOTENCY_LEASE_MS: blank(z.coerce.number().int().min(5_000).max(600_000).optional()),
    // Потолок снимаемого тела, байт; больше — повтор отвечает `already_completed` без тела.
    IDEMPOTENCY_MAX_RESPONSE_BYTES: blank(z.coerce.number().int().min(1024).max(4 * 1024 * 1024).optional()),
    // Метка сборки в строке ключа — диагностика снимков старой формы DTO после деплоя.
    APP_BUILD: blank(z.string().min(1).max(64).optional()),
    // --- Журнал безопасности (core/audit) ---
    // Интервал подписанных дайджестов целостности, минут (пусто = 5).
    AUDIT_DIGEST_INTERVAL_MIN: blank(z.coerce.number().int().min(1).max(60).optional()),
    // Срок хранения месяца в PostgreSQL, лет (пусто = 3). Ниже 3 не бывает: пол держит и
    // функция сброса `audit_drop_partition` в самой базе.
    AUDIT_RETENTION_YEARS: blank(z.coerce.number().int().min(3).max(25).optional()),
    // Выгрузка закрытых месяцев в объектное хранилище (NDJSON+gzip + подписанный манифест).
    // Пусто = включено; 'false' — аварийный стоп (месяц без архива не сбрасывается НИКОГДА).
    AUDIT_ARCHIVE_ENABLED: blank(z.enum(['true', 'false']).optional()),
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
    // Движок согласий (core/consents): обязателен ли ЯВНЫЙ пакет согласий при создании организации.
    // Пусто = secure-by-default (production → да). В development/test без поля `consents` сервер
    // принимает действующие версии пакета сам (сиды и verify-сьюты живут без правок); `true` — форс в dev.
    // Регистрация человека требует согласий ВСЕГДА — рубильника у неё нет.
    CONSENTS_REQUIRED: blank(z.enum(['true', 'false']).optional()),
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
    // Имя гео-заголовка страны, который ставит край сети и ЗАТИРАЕТ у клиента (за Cloudflare —
    // `cf-ipcountry`). Страна журнала безопасности и новизна «вход из новой страны» — только из
    // него; пусто — страны нет (заголовки клиента не доверяются).
    GEO_COUNTRY_HEADER: blank(z.string().regex(/^[A-Za-z0-9-]{1,64}$/).optional()),
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
      // Движок ключей: корень доверия в production называется явно и лежит в файле с
      // правами (или в HSM) — молчаливая генерация при старте недопустима: второй
      // копии у второго человека не будет, и потеря диска = потеря всех данных.
      if ((env.KEYS_PROVIDER ?? 'software') === 'software' && !env.KEYS_ROOT_KEY_FILE) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['KEYS_ROOT_KEY_FILE'],
          message: 'is required in production (run apps/api/scripts/keys-init-root.cjs — the key ceremony; never generated silently)',
        });
      }
      if (env.KEYS_PROVIDER === 'pkcs11') {
        for (const key of ['KEYS_PKCS11_MODULE', 'KEYS_PKCS11_SLOT', 'KEYS_PKCS11_PIN', 'KEYS_PKCS11_KEY_LABEL'] as const) {
          if (env[key] === undefined) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'is required when KEYS_PROVIDER=pkcs11' });
          }
        }
      }
      // Legacy HS256 в production живёт только датированным окном; истёкшее окно — ошибка бута
      if (env.WEBHOOKS_DEV_LOOPBACK === 'true') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['WEBHOOKS_DEV_LOOPBACK'], message: 'must not be true in production: webhooks go only to public https addresses' });
      }
      const legacy = env.JWT_SECRET_LEGACY ?? env.JWT_SECRET;
      if (legacy) {
        if (!env.KEYS_LEGACY_HS256_UNTIL) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['KEYS_LEGACY_HS256_UNTIL'],
            message: 'is required in production while JWT_SECRET_LEGACY (or JWT_SECRET) is set: the HS256 window must have an end date',
          });
        } else if (new Date(env.KEYS_LEGACY_HS256_UNTIL).getTime() <= Date.now()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['JWT_SECRET_LEGACY'],
            message: 'the HS256 window (KEYS_LEGACY_HS256_UNTIL) has ended — remove JWT_SECRET_LEGACY/JWT_SECRET from the environment',
          });
        } else if (new Date(env.KEYS_LEGACY_HS256_UNTIL).getTime() > Date.now() + 45 * 86_400_000) {
          // Окно = срок жизни refresh-токена (30 дней) + запас. Дата «в 2099 году» превратила бы
          // временный допуск HS256 общим секретом в постоянный — а весь смысл окна в том, что оно кончается
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['KEYS_LEGACY_HS256_UNTIL'],
            message: 'must be at most 45 days ahead: the HS256 window only covers the refresh-token lifetime of the migration',
          });
        }
      }
      // Legacy-секреты подписи (кабинет, WOPI, гостевые пропуска) живут только вместе с
      // окном HS256: после его конца они мертвы и обязаны уйти из окружения — иначе через
      // год никто не вспомнит, что переменная ничего не подписывает.
      const legacyWindowOpen = !!env.KEYS_LEGACY_HS256_UNTIL && new Date(env.KEYS_LEGACY_HS256_UNTIL).getTime() > Date.now();
      for (const key of ['PLATFORM_JWT_SECRET', 'DOCS_TOKEN_SECRET', 'SHARE_LINK_SECRET'] as const) {
        if (env[key] && !legacyWindowOpen) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: 'is a legacy HS256/HMAC secret: it is only read while KEYS_LEGACY_HS256_UNTIL is in the future — remove it (tokens are signed by the keys engine)',
          });
        }
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
  if (isProdEnv() && result.data.CONSENTS_REQUIRED === 'false') {
    // eslint-disable-next-line no-console
    console.warn(
      '⚠️  CONSENTS_REQUIRED=false in production: organizations are created WITHOUT an explicit consent bundle.\n' +
        '    The platform accepts the business terms on behalf of the owner — this is not a proof of consent. Remove the variable.',
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
