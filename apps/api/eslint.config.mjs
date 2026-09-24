import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import noCyrillicLiteral from '../../scripts/eslint-rules/no-cyrillic-literal.cjs';
import noViewerTextInPayload from '../../scripts/eslint-rules/no-viewer-text-in-payload.cjs';
import noTranslatedTextInColumn from '../../scripts/eslint-rules/no-translated-text-in-column.cjs';

// ============================================================
// МЕХАНИЧЕСКИЙ СТРАЖ ИСХОДЯЩИХ ЗАПРОСОВ.
//
// Наружу из API ведут ровно ДВЕ двери (`src/shared/http/`), и выбор между ними —
// ответ на один вопрос: кто выбрал эту строку-адрес?
//   • пользователь (конфиг ноды Процессов, настройка организации, ввод) → `safeFetch`:
//     SSRF-щит, DNS-резолв каждого хопа, ручные редиректы, срезание кредов при смене хоста;
//   • оператор (переменная окружения: сидекары платформы) → `trustedFetch`:
//     щита нет НАМЕРЕННО (адреса приватны по построению — localhost:9980,
//     host.docker.internal), зато таймаут обязателен по сигнатуре.
//
// Почему это правило нельзя удержать договорённостью: голый `fetch` короче и
// работает, разница видна только в день атаки. Ровно так `process-ai-client` уехал
// мимо щита — SSRF, найденный security-ревью 2026-07-25. Ту дыру закрыли руками,
// а вывод ревью был записан так: «запретить прямой fetch линтером — иначе следующая
// интеграция снова пройдёт мимо safeFetch». Это он и есть.
//
// Здесь НЕТ стилистики и нет ничего, что ловит компилятор: конфиг знает ровно одно
// правило — «не ходи наружу мимо двери».
//
// Чего правило НЕ касается: вендорские SDK с фиксированной точкой назначения
// (googleapis, @aws-sdk/client-s3, livekit-server-sdk, ioredis, prisma). У них свой
// транспорт и свой адрес из env — подставить туда чужой хост запросом нельзя.
// ============================================================

const OUTBOUND_DOOR_HINT =
  'Наружу — только через дверь из src/shared/http: `safeFetch` (адрес пришёл ИЗ ДАННЫХ: конфиг ноды, настройка организации, ввод человека — нужен SSRF-щит) либо `trustedFetch` (адрес пришёл ИЗ .env: сидекар платформы — щита нет намеренно, но таймаут обязателен). Голый вызов проходит мимо обеих проверок молча.';

/**
 * Модули-транспорты, запрещённые к прямому использованию. Список нужен ТРИЖДЫ и в двух
 * формах, поэтому объявлен один раз: `no-restricted-imports` берёт массив имён, а два
 * селектора `no-restricted-syntax` (require и динамический import) — регекс.
 */
const BANNED_MODULES = [
  'http',
  'https',
  'node:http',
  'node:https',
  'axios',
  'undici',
  'node-fetch',
  'got',
  'superagent',
  'request',
];
const BANNED_MODULES_RE = `/^(${BANNED_MODULES.map((m) => m.replace(':', '\:')).join('|')})$/`;

/**
 * Второй страж: способности КАБИНЕТА ПЛАТФОРМЫ читаются только внутри кабинета.
 *
 * Ревью 2026-09-12 нашло `modules/processes`, который спрашивал право кабинета на
 * ПРОДУКТОВОМ пути: сотрудник платформы получал привилегию своим обычным токеном —
 * без входа в кабинет, без step-up и без строки в журнале кабинета. Правило держит
 * границу: службные действия живут командами `core/platform`, а не проверкой права
 * в фиче. Исключение одно — `core/users`: анонимизация аккаунта СНИМАЕТ человека со
 * штата платформы (`systemSuspendDeletedUser`), это не чтение прав.
 */
const CONSOLE_SCOPE_HINT =
  'Права кабинета платформы (PlatformAccessService / PlatformAuthService) читаются только внутри core/platform: служебное действие оформляется КОМАНДОЙ кабинета (реестр core/platform), иначе привилегия сработает по продуктовому токену — без step-up и без журнала кабинета.';
const CONSOLE_ACCESS_PATTERNS = [
  {
    group: ['**/platform/platform-access.service', '**/platform/platform-auth.service'],
    message: CONSOLE_SCOPE_HINT,
  },
];
const OUTBOUND_IMPORT_PATHS = BANNED_MODULES.map((name) => ({ name, message: OUTBOUND_DOOR_HINT }));

/**
 * Третий страж: мастер-секрет прошлой эпохи читается ТОЛЬКО внутри движка ключей.
 *
 * До core/keys `JWT_SECRET` был ключом девяти потребителей (подпись, HMAC OTP, AES
 * сейфов, производные секреты) — ротация была невозможна. Теперь подпись, HMAC и
 * шифрование живут в keystore, а `JWT_SECRET`/`JWT_SECRET_LEGACY` нужен ровно одному
 * месту — legacy-верификатору HS256 на окне миграции (`src/core/keys`). Любое новое
 * чтение вне движка — снова «производный секрет», который никогда не ротируется.
 */
const KEYS_SECRET_HINT =
  'process.env.JWT_SECRET / JWT_SECRET_LEGACY читается только внутри src/core/keys (legacy-верификатор HS256). Подпись — KeysSigningService, HMAC — KeysMacService, шифрование поля — KeysEnvelopeService: у них ротация и kid, у производного секрета — нет.';
const KEYS_SECRET_SELECTORS = [
  {
    selector: "MemberExpression[object.object.name='process'][object.property.name='env'][property.name=/^JWT_SECRET(_LEGACY)?$/]",
    message: KEYS_SECRET_HINT,
  },
  {
    selector: "MemberExpression[computed=true][object.object.name='process'][object.property.name='env'][property.value=/^JWT_SECRET(_LEGACY)?$/]",
    message: KEYS_SECRET_HINT,
  },
];

/**
 * Четвёртый страж: секреты не попадают в логи. `req.headers.authorization` (Bearer-токен
 * или ключ `sa6_…`), `cookie` и `x-api-key` внутри аргументов logger.<метод>/console.<метод> — ошибка.
 * Тело и заголовки запроса логируются только через `redactSecrets` (shared/utils/redact).
 */
const SECRET_LOG_HINT =
  'Заголовки authorization / cookie / x-api-key в лог не пишутся: там Bearer-токен или ключ sa6_…. Нужен контекст запроса в логе — пропусти строку через redactSecrets() (shared/utils/redact.ts) и не передавай заголовок целиком.';
const LOG_CALL = "CallExpression[callee.property.name=/^(log|warn|error|debug|verbose|fatal|info|trace)$/]";
const SECRET_LOG_SELECTORS = [
  {
    selector: `${LOG_CALL} MemberExpression[property.name=/^(authorization|cookie|x-api-key)$/i]`,
    message: SECRET_LOG_HINT,
  },
  {
    // `req.headers['authorization']` — вычисляемое свойство
    selector: `${LOG_CALL} MemberExpression[computed=true][property.value=/^(authorization|cookie|x-api-key)$/i]`,
    message: SECRET_LOG_HINT,
  },
];

/**
 * Пятый страж: криптография — только через движок ключей (src/core/keys). Библиотеки JWT
 * (`jsonwebtoken`, `jose`, `@nestjs/jwt`, `passport-jwt`) и примитивы шифрования/ключей
 * `node:crypto` вне движка запрещены: свой AES без AAD и без `kid` не ротируется, свой JWT
 * не знает JWKS. Хеши, HMAC, randomUUID/randomBytes и timingSafeEqual остаются доступны.
 */
const KEYS_CRYPTO_HINT =
  'Криптография живёт в src/core/keys: подпись — KeysSigningService (Ed25519 + kid + JWKS), HMAC — KeysMacService, шифрование поля — KeysEnvelopeService (+ KeysFieldRegistry). Свой JWT/AES/ключевая пара вне движка не ротируется и не попадает в реестр ключей.';
const BANNED_JWT_LIBS = ['jsonwebtoken', 'jose', 'node-jose', '@nestjs/jwt', 'passport-jwt', 'jwks-rsa'];
const CRYPTO_PRIMITIVES_RE =
  '/^(createCipheriv|createDecipheriv|createCipher|createDecipher|generateKeyPair|generateKeyPairSync|createPrivateKey|createSecretKey|privateEncrypt|privateDecrypt|publicEncrypt|publicDecrypt|scrypt|scryptSync|pbkdf2|pbkdf2Sync|hkdf|hkdfSync|createSign|createVerify|diffieHellman|createECDH|createDiffieHellman)$/';
const KEYS_CRYPTO_SELECTORS = [
  {
    selector: `ImportDeclaration[source.value=/^(node:)?crypto$/] ImportSpecifier[imported.name=${CRYPTO_PRIMITIVES_RE}]`,
    message: KEYS_CRYPTO_HINT,
  },
  {
    // `import * as crypto from 'crypto'; crypto.createCipheriv(...)`
    selector: `MemberExpression[object.name=/^(crypto|nodeCrypto)$/][property.name=${CRYPTO_PRIMITIVES_RE}]`,
    message: KEYS_CRYPTO_HINT,
  },
];
const JWT_IMPORT_PATHS = BANNED_JWT_LIBS.map((name) => ({ name, message: KEYS_CRYPTO_HINT }));

/**
 * Шестой страж: правила видимости (core/visibility). Маркер `{ $v: 'masked' | 'hidden' }`
 * строит только движок (`shape`), маски — только общие функции shared (одна маска на вид
 * данных на всех поверхностях: две разные маски одного значения складываются в оригинал —
 * урок Airbnb 2018 и Directus, где маску считал payload-слой в обход прав).
 */
const VISIBILITY_HINT_MARKER =
  'Маркер видимости (`$v`) строит только core/visibility (`VisibilityService.shape/forExternal`). Сервис отдаёт значения в shape(), а не собирает маску сам — иначе маска живёт отдельно от прав (Directus: 10 CVE).';
const VISIBILITY_HINT_MASK =
  'Маски — только из @superapp/shared (visibility/masks.ts): maskPhone, maskEmail, maskIdLast4… Своя маска рядом с общей выдаёт оригинал по сочетанию.';
const VISIBILITY_SELECTORS = [
  { selector: "Property[key.name='$v'], Property[key.value='$v']", message: VISIBILITY_HINT_MARKER },
  { selector: 'FunctionDeclaration[id.name=/^mask[A-Z]/], VariableDeclarator[id.name=/^mask[A-Z]/]', message: VISIBILITY_HINT_MASK },
];

/**
 * Седьмой страж: временные файлы — только каталоги платформы (`src/shared/fs/temp-file.util.ts`).
 * Голый `os.tmpdir()` и `diskStorage` multer без `destination` (его умолчание — тот же общий
 * /tmp) кладут байты туда, где их не видит уборка по сроку (шаг `files.upload-tmp` раннера
 * core/lifecycle) и где нет прав 0700: брошенная загрузка живёт вечно (multer CVE-2026-88932).
 */
const TEMP_DIR_HINT =
  'Временный файл — только appTmpDir()/appTmpPath()/withTempFile() или storageTmpDir() (src/shared/fs/temp-file.util.ts), у multer diskStorage — явный destination: общий /tmp не убирается по сроку и не закрыт правами 0700.';
const TEMP_DIR_SELECTORS = [
  { selector: "CallExpression[callee.property.name='tmpdir']", message: TEMP_DIR_HINT },
  { selector: "ImportDeclaration[source.value=/^(node:)?os$/] ImportSpecifier[imported.name='tmpdir']", message: TEMP_DIR_HINT },
  { selector: "VariableDeclarator > ObjectPattern > Property[key.name='tmpdir']", message: TEMP_DIR_HINT },
  { selector: "CallExpression[callee.name='diskStorage']:not(:has(Property[key.name='destination']))", message: TEMP_DIR_HINT },
];

/** Селекторы стража исходящих — общие для основного блока и для блока движка ключей (там без стража секрета). */
const OUTBOUND_SYNTAX_SELECTORS = [
  {
    selector: "MemberExpression[object.name=/^(globalThis|global)$/][property.name='fetch']",
    message: OUTBOUND_DOOR_HINT,
  },
  {
    // `globalThis['fetch']` — тот же доступ, но через вычисляемое свойство.
    selector: "MemberExpression[computed=true][object.name=/^(globalThis|global)$/][property.value='fetch']",
    message: OUTBOUND_DOOR_HINT,
  },
  {
    // `const { fetch } = globalThis` — деструктуризация не MemberExpression,
    // предыдущие два селектора её не видят. Проверено пробой: проходила молча.
    selector: "VariableDeclarator[init.name=/^(globalThis|global)$/] > ObjectPattern > Property[key.name='fetch']",
    message: OUTBOUND_DOOR_HINT,
  },
  {
    // `require('node:https')` — `no-restricted-imports` работает ТОЛЬКО по ESM-import
    // и CommonJS не видит вовсе. В apps/api `require()` — живая идиома (sharp,
    // exif-reader, thumbhash, ffmpeg-static), поэтому обход был бы естественным
    // повторением местного стиля, а не изощрением. Проверено пробой: проходил молча.
    selector: `CallExpression[callee.name='require'][arguments.0.value=${BANNED_MODULES_RE}]`,
    message: OUTBOUND_DOOR_HINT,
  },
  {
    // `await import('axios')` — динамический импорт `no-restricted-imports` тоже
    // пропускает. Проверено пробой.
    selector: `ImportExpression[source.value=${BANNED_MODULES_RE}]`,
    message: OUTBOUND_DOOR_HINT,
  },
];

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'prisma/**', 'scripts/**', 'test/**'],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    // Плагин подключён ТОЛЬКО чтобы имена правил разрешались: в коде есть
    // `eslint-disable-next-line @typescript-eslint/no-var-requires` и `…/no-explicit-any`,
    // написанные в эпоху, когда ESLint в API не было вовсе (они декоративные), а
    // ESLint 9 считает ошибкой директиву к неизвестному правилу. Сами правила
    // выключены — здесь живёт только страж исходящих.
    plugins: { '@typescript-eslint': tsPlugin },
    // Те же декоративные директивы (`no-console`, `@typescript-eslint/*`) числились бы
    // «неиспользованными»: правил, к которым они обращаются, мы не включаем. Вычищать
    // их — работа не этой задачи, поэтому глобально проверка выключена; для файлов
    // самих дверей она ниже включена обратно.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      // Ловит и вызов `fetch(...)`, и передачу его дальше (`const f = fetch`).
      // Исключений по файлам НЕТ: внутренности самих дверей разрешены точечными
      // `eslint-disable-next-line` на конкретной СТРОКЕ — так второй голый fetch,
      // дописанный в тот же файл, всё равно упрётся в правило.
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: OUTBOUND_DOOR_HINT },
      ],
      // `no-restricted-globals` работает по ссылкам на ГЛОБАЛЬНОЕ имя и не видит
      // `globalThis.fetch(...)` — это уже обращение к свойству объекта. Проверено:
      // без этого селектора такая запись проходила линтер молча.
      // Селекторы живут в OUTBOUND_SYNTAX_SELECTORS (их же переиспользует блок движка
      // ключей); здесь к ним добавлен страж мастер-секрета (KEYS_SECRET_SELECTORS).
      'no-restricted-syntax': ['error', ...OUTBOUND_SYNTAX_SELECTORS, ...KEYS_SECRET_SELECTORS, ...SECRET_LOG_SELECTORS, ...KEYS_CRYPTO_SELECTORS, ...VISIBILITY_SELECTORS, ...TEMP_DIR_SELECTORS],
      // Обход правила «возьму другой HTTP-клиент» — тоже закрыт. На момент введения
      // (2026-08-30) ни одного такого импорта в apps/api нет: единственный способ
      // ходить наружу — `fetch`. Правило держит это состояние. Сюда же — библиотеки
      // JWT (страж криптографии): подпись токенов только через движок ключей.
      'no-restricted-imports': [
        'error',
        {
          paths: [...OUTBOUND_IMPORT_PATHS, ...JWT_IMPORT_PATHS],
          patterns: CONSOLE_ACCESS_PATTERNS,
        },
      ],
    },
  },
  {
    // Кабинет платформы — внутри себя. И `core/users`, где анонимизация аккаунта снимает
    // человека со штата: там правило снято ровно на импорт кабинета, дверь наружу остаётся.
    files: ['src/core/platform/**/*.ts', 'src/core/users/users.service.ts', 'src/core/users/users.module.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [...OUTBOUND_IMPORT_PATHS, ...JWT_IMPORT_PATHS] }],
    },
  },
  {
    // Движок ключей — единственное место, где legacy-верификатор читает JWT_SECRET(_LEGACY)
    // и где живут примитивы node:crypto: стражи секрета и криптографии сняты, страж
    // исходящих и страж логов остаются целиком.
    files: ['src/core/keys/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...OUTBOUND_SYNTAX_SELECTORS, ...SECRET_LOG_SELECTORS, ...VISIBILITY_SELECTORS, ...TEMP_DIR_SELECTORS],
    },
  },
  {
    // Движок видимости — единственное место, где строится маркер `$v`: страж маркера снят,
    // страж масок (свои маски запрещены и здесь — только shared) и остальные остаются.
    files: ['src/core/visibility/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...OUTBOUND_SYNTAX_SELECTORS, ...KEYS_SECRET_SELECTORS, ...SECRET_LOG_SELECTORS, ...KEYS_CRYPTO_SELECTORS, VISIBILITY_SELECTORS[1], ...TEMP_DIR_SELECTORS],
    },
  },
  {
    // Двери наружу. Здесь директив-исключений ровно три — по одной на законный `fetch`
    // внутри каждой двери плюс импорт `Agent` из undici в двери №1 (пин соединения к
    // проверенному адресу, закрывает DNS-rebinding), — и все обязаны оставаться ЖИВЫМИ: протухшая директива
    // (правило уже не срабатывает, а разрешение висит) — это тихо расширенное
    // исключение ровно в том месте, ради которого написан весь конфиг.
    files: ['src/shared/http/**/*.ts'],
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  {
    // Дверь временных файлов: одна живая директива на единственный законный os.tmpdir().
    files: ['src/shared/fs/temp-file.util.ts'],
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  // ============================================================
  // СТРАЖ МУЛЬТИЯЗЫЧНОСТИ: текст для человека API тоже отдаёт из каталога
  // (@superapp/i18n через I18nService), а не литералом.
  // ============================================================
  {
    files: ['src/**/*.ts'],
    plugins: {
      i18n: {
        rules: {
          'no-cyrillic-literal': noCyrillicLiteral,
          'no-viewer-text-in-payload': noViewerTextInPayload,
          'no-translated-text-in-column': noTranslatedTextInColumn,
        },
      },
    },
    rules: {
      // Вечная запись (хроника, уведомление, джоб) хранит СТРУКТУРУ: текст в языке
      // зрителя, положенный в payload, застывает в языке нажавшего кнопку навсегда.
      // Литерала в коде при этом нет — страж кириллицы такое не видит.
      'i18n/no-viewer-text-in-payload': 'error',
      // Третья дверь: слово, записанное прямо в колонку-имя, живёт как данные и
      // читается всеми в языке того, кто его записал. Требуем пометку автоимени.
      'i18n/no-translated-text-in-column': 'error',
      'i18n/no-cyrillic-literal': [
        'error',
        {
          allowFiles: [
            // Числительные языка для «прописью» в бланке: это СЛОВАРЬ и грамматика
            // (род единиц, формы разряда), а не подписи экрана. Ключ каталога
            // отдаёт фразу, а здесь работает алгоритм — разложить его по ключам
            // нельзя. По файлу на язык, каждый — контент этого языка.
            'src/core/templates/words/ru.ts',
            'src/core/templates/words/kk.ts',
          ],
        },
      ],
    },
  },
];
