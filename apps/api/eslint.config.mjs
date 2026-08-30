import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

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
      'no-restricted-syntax': [
        'error',
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
          selector:
            "VariableDeclarator[init.name=/^(globalThis|global)$/] > ObjectPattern > Property[key.name='fetch']",
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
      ],
      // Обход правила «возьму другой HTTP-клиент» — тоже закрыт. На момент введения
      // (2026-08-30) ни одного такого импорта в apps/api нет: единственный способ
      // ходить наружу — `fetch`. Правило держит это состояние.
      'no-restricted-imports': [
        'error',
        {
          paths: BANNED_MODULES.map((name) => ({ name, message: OUTBOUND_DOOR_HINT })),
        },
      ],
    },
  },
  {
    // Двери наружу. Здесь директив-исключений ровно две — по одной на законный `fetch`
    // внутри каждой двери, — и обе обязаны оставаться ЖИВЫМИ: протухшая директива
    // (правило уже не срабатывает, а разрешение висит) — это тихо расширенное
    // исключение ровно в том месте, ради которого написан весь конфиг.
    files: ['src/shared/http/**/*.ts'],
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
];
