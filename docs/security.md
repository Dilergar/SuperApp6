# Безопасность

> Правила и механизмы защиты платформы. Фундамент подтверждён платформенным security-ревью и SAST: SQL-инъекций нет (параметризованные шаблоны Prisma), инъекций команд нет (`execFile` с массивом аргументов), обход путей закрыт, IDOR-дыр авторизации не найдено.

## Аутентификация и сессии

- **Auth fail-closed на всей платформе**: `JwtAuthGuard` зарегистрирован глобально как APP_GUARD — новая ручка защищена АВТОМАТИЧЕСКИ, открывается только точечным `@Public()`. Payload access-токена несёт system-роль, `sid` (строка сессии) и `epoch` (tokenEpoch).
- **JWT**: access 15 мин + refresh 30 дней, ротация при каждом refresh. Refresh-токены: SHA-256 хэш в БД (детерминированный — ищется по равенству на unique-колонке; bcrypt тут не годится), уникальный `jti` (два логина в одну секунду не коллидируют).
- **`users.tokenEpoch` — поколение токенов**: payload JWT несёт `epoch`, токен прошлого поколения получает 401 на первом же запросе. Поколение инкрементируют: сброс пароля, смена пароля, смена номера, `logout-all` — только так «все сессии отозваны» отзывает и ACCESS-токены. Текущая вкладка переживает бамп прозрачно (single-flight refresh выдаёт токен нового поколения).
- **JWT-guard кэширует «аккаунт жив» в Redis 60с** (`auth:alive:<id>`, в ключе лежит tokenEpoch); Redis недоступен → честный фолбэк в БД; удаление/анонимизация чистят ключ синхронно.
- **`SessionValidatorService`** (`shared/auth/`, @Global) — ЕДИНСТВЕННЫЙ источник правды о живости сессии; паритет HTTP и WebSocket: рукопожатие сокета тоже сверяет tokenEpoch и deletedAt; `auth.sessions.revoked` рвёт живые сокеты (кластерно через Redis-adapter).
- `sid` строки сессии — в payload access-токена (сервер сам считает `isCurrent`); `deviceInfo` (User-Agent) пишется при входе и наследуется через ротацию.
- Пароли: **нативный** `bcrypt` (12 раундов; bcryptjs запрещён — душил event-loop). Минимум 8 символов, заглавная + строчная + цифра + спецсимвол.
- Удаление аккаунта: `DELETE /users/me` (требует пароль) — грейс 30 дней (вход = восстановление), затем `AccountCron` анонимизирует (PII стёрт, номер освобождён, `deletedAt` терминально). Регистрация на номер в грейсе → 409 с подсказкой.

## Fail-closed окружение

- Общий предикат `isDevEnv()`/`isProdEnv()` (`shared/config/env.validation.ts`): всё, кроме явных `development`/`test` — включая НЕЗАДАННУЮ переменную и опечатку — считается продом. Никогда не делать naive writeback дефолта (он бы наоборот открыл Swagger и выключил троттлер).
- Env-валидация zod в bootstrap (fail-fast до запуска Nest): NODE_ENV из whitelist, DATABASE_URL/JWT_SECRET обязательны; в production обязателен REDIS_URL и JWT_SECRET ≥ 32 символов.
- Троттлер и Swagger — secure-by-default (см. [api_conventions.md](api_conventions.md)); `verify.required` = production по умолчанию.
- mock-драйвер SMS не пишет OTP и полный номер в лог вне dev (гейт `isDevEnv` + `maskPhone`).
- `uncaughtException` → drain + exit(1).

## IP и лимиты

- **IP берётся ТОЛЬКО из `req.ip`**; прямое чтение `X-Forwarded-For` запрещено (заголовок пишет кто угодно). Доверие к прокси — env `TRUST_PROXY` (за одним балансировщиком `1`); от него зависят ВСЕ лимиты «по IP» (троттлер + IP-эшелоны core/verify). В production без него — громкий warn.

## Исходящий HTTP — две двери (`src/shared/http/`)

Голый `fetch` и сторонние клиенты (`axios`/`undici`/`node:https`/`got`…) в apps/api **запрещены линтером** (`apps/api/eslint.config.mjs`; ловятся и `globalThis.fetch`, `require('axios')`, `await import('undici')` — пять доп. селекторов). Выбор двери = «кто выбрал строку-адрес?»:

- **`safeFetch` / `fetchJson`** — адрес пришёл ИЗ ДАННЫХ (конфиг ноды Процессов, ввод человека): SSRF-щит с DNS-резолвом каждого хопа, ручные редиректы, срезание `authorization`/`cookie`/`x-api-key` при кросс-хост редиректе.
- **`trustedFetch(url, init, {timeoutMs, origin: 'env'|'self'})`** — адрес из .env (сидекар, выбранный оператором): щита НЕТ намеренно (адреса сидекаров приватны — `localhost:9980` и т.п., щит отверг бы их), но таймаут обязателен по сигнатуре.
- `assertPublicUrlShallow` — только дешёвый предварительный отказ ПЕРЕД `safeFetch` (не резолвит DNS — домен с A-записью на `169.254.169.254` проходит её насквозь); связка «она + trustedFetch» защитой НЕ является.
- Законных `fetch` ровно два — по одному внутри каждой двери, разрешены директивами на конкретной строке; в `src/shared/http/**` включён `reportUnusedDisableDirectives: 'error'` (протухшая директива роняет линтер). ⚠️ Глобально эта проверка ВЫКЛЮЧЕНА намеренно, а `@typescript-eslint` подключён с выключенными правилами: в API живут декоративные `eslint-disable` из эпохи без ESLint, и ESLint 9 считает ошибкой директиву к неизвестному правилу — «включить правила как надо» уронит линтер.
- Запуск стража: `pnpm lint:guard` из корня (гоняет ОБА стража — API и веб; отдельный от `lint`, потому что полный tsc API падает по памяти).
- Вендорские SDK с фиксированной точкой назначения (googleapis, AWS S3, LiveKit, ioredis) — вне правила.

## Заголовки и браузерные политики

- `helmet` на API: CSP выключен (API не рендерит HTML), **`crossOriginResourcePolicy: 'cross-origin'` ОБЯЗАТЕЛЕН** — дефолтный same-origin убил бы медиа-выдачу с :3001 на :3000.
- Глобальный `X-Frame-Options` НЕ снимать; на маршрутах выдачи байтов (`/api/files/raw`, `/api/public-files`) грубый XFO заменён адресным `frame-ancestors` со списком origin'ов веба (иначе iframe гостевой страницы с PDF получает `net::ERR_BLOCKED_BY_RESPONSE` — 200 в сети, пустая рамка на экране).
- Веб (`next.config.ts` headers): `frame-ancestors 'none'`/XFO боевыми, полный CSP пока Report-Only; `frame-src` включает origin API и `blob:` (PDF-превью).

## Секреты

- Шифрование чувствительных полей — AES-256-GCM, общий хелпер `apps/api/src/shared/crypto/secret-field.ts` (контекст-строка на класс полей). Потребители: сейф кредов Процессов, платёжные карты (PAN/IBAN).
- `JWT_SECRET` — мастер-ключ 7 подсистем (производные: DOCS_TOKEN_SECRET, SHARE_LINK_SECRET и др. при их пустоте). Известное ограничение: ротация секрета убьёт креды сейфа — отдельный «движок ключей» в бэклоге ([roadmap.md](roadmap.md)).
- Google-токены лежат в БД открытым текстом (TODO в схеме) — тоже ждёт движка ключей.

## Вебхуки

- Подпись проверяется по **сырому телу** (LiveKit WebhookReceiver; точечный `express.raw` ДО body-parser, покрыты оба префикса /api и /api/v1).
- Внешние данные вебхуков/Telegram санитайзятся (`sanitizeExternalVariables`: служебные `_*` ключи движка отбрасываются на любой глубине).

## Принятые риски (не дыры; решения зафиксированы)

- Токены в localStorage веба (XSS-путей в вебе нет: `dangerouslySetInnerHTML`/eval отсутствуют; refresh в httpOnly-куку — осознанно не делали).
- Энумерация номеров на `/verify/start` (существует и на /auth/register; закрыта лимитами и нейтральными ответами сброса).
- SAST в CI (semgrep/gitleaks/dependabot) — осознанно отложен.

## Прод-хвост (отдельные будущие ТЗ)

Движок ключей (разделение JWT_SECRET + ротация + шифрование Google-токенов) · аудит безопасности · анти-абьюз (CAPTCHA-слот в core/verify готов) · 2FA на вход. Плюс прод-минимум: CORS из env (сейчас захардкожен localhost в main.ts), `/health`, Dockerfile API, verification-токен Google-вебхука — [roadmap.md](roadmap.md).

## Связанные доки

[verify_engine.md](verify_engine.md) (OTP, step-up) · [api_conventions.md](api_conventions.md) · [identity_roles.md](identity_roles.md) · [environment_variables.md](environment_variables.md).
