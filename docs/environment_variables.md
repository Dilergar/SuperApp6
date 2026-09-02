# Переменные окружения

> **API** (`apps/api/.env`): валидация — zod при старте, `apps/api/src/shared/config/env.validation.ts` (первый вызов в `bootstrap()`, fail-fast). Правила: (1) КАЖДАЯ переменная, которую читает `apps/api/src`, объявлена в схеме — сверка: `grep -rhoE "process\.env\.[A-Z0-9_]+" apps/api/src | sort -u` против ключей схемы (единственное законное исключение — `DATABASE_URL`, её читает Prisma из `schema.prisma`); (2) пустая строка = «не задано» (скопированный `.env.example` не валит бут); (3) всё, кроме явных `development`/`test` в `NODE_ENV`, считается продом (fail-closed). Дефолты ниже — значение при пустой переменной; они живут в коде потребителя (тот читает сырой `process.env`), схема лишь проверяет форму. «prod: warn» — не ошибка, а громкое предупреждение при старте.

## Ядро

- `DATABASE_URL` — PostgreSQL (обязательна)
- `REDIS_URL` — Redis; в production обязательна (без неё тихий фолбэк на localhost = отказ троттлинга/шины/локов)
- `JWT_SECRET` — обязателен; ≥ 8 символов в dev, ≥ 32 в production. Мастер-ключ производных секретов — [security.md](security.md)
- `JWT_EXPIRES_IN` (дефолт `15m`) / `JWT_REFRESH_EXPIRES_IN` (дефолт `30d`) — запись jsonwebtoken/ms (`15m`, `30d`, `2 days`); дефолты в `apps/api/src/core/auth/auth.module.ts` и `auth.service.ts`
- `PORT` (3001) · `NODE_ENV` — только `development | test | production`, иначе бут отказан (пусто = production)
- `WEB_URL` (дефолт `http://localhost:3000`) — база веба: редирект после OAuth, PostMessageOrigin редактора документов, гостевые ссылки `/s/<токен>`, `frame-ancestors` на маршрутах выдачи байтов
- `API_PUBLIC_URL` (дефолт `http://localhost:${PORT}`) — база абсолютных адресов НАШЕГО API: файловые ссылки, откат для `DOCS_WOPI_PUBLIC_URL`, QR подписи, ссылки документов
- `TRUST_PROXY` — сколько прокси-хопов доверять при разборе X-Forwarded-For (`1` за одним балансировщиком; можно список подсетей). Пусто → XFF игнорируется, `req.ip` = адрес сокета; от него зависят ВСЕ лимиты «по IP» (троттлер, IP-эшелоны core/verify). prod: warn
- `APP_TIMEZONE` (дефолт `Asia/Almaty`) — пояс детерминированного форматирования дат: штампы и протокол подписи (`core/sign/sign-stamp.service.ts`, `sign-protocol.service.ts`), сутки производственного календаря (`modules/hr/hr-calendar.service.ts`). Должна быть IANA-зоной, известной ICU — иначе бут отказан (неизвестная зона роняла бы `Intl` в момент подписи)

## Google Calendar (modules/google-calendar)

- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` — OAuth; интеграция включена, только когда заданы ВСЕ три (`isConfigured()`); неполный набор = инертна, НЕ ошибка бута (в отличие от LiveKit — календарь без Google полностью работоспособен). Redirect совпадает с консолью Google: `http://localhost:3001/api/v1/integrations/google/callback` (`/api/...` без версии — legacy-алиас, тоже работает)
- `GOOGLE_WEBHOOK_URL` — публичный HTTPS-адрес для push (`events.watch`); пусто → watch не регистрируется, синхронизация поллингом

## Процессы (modules/processes)

- `API_URL` (дефолт `http://localhost:${PORT}`) — база ПУБЛИЧНЫХ адресов вебхуков `…/api/processes/webhook/:token`, которые дёргают внешние системы (`processes.service.ts`). Отдельная от `API_PUBLIC_URL` переменная — в проде задавать обе одинаково

## Файлы (core/files)

- `FILES_DRIVER` — `local` (дефолт; **строго 1 инстанс API** — prod: warn, масштабирование только на s3) | `s3`
- `FILES_LOCAL_ROOT` (дефолт `./storage`, относительно cwd процесса) — читают и core/docs, core/drive, files.controller
- `S3_ENDPOINT` / `S3_REGION` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_BUCKET` — все пять обязательны при `s3` (dev: профиль s3 → SeaweedFS `http://localhost:8333`)
- `S3_FORCE_PATH_STYLE` (`true|false`; дефолт true — path-style везде, кроме явного `false`) · `S3_PUBLIC_BASE_URL` (CDN-база для public-файлов; пусто → выдача через API)
- `CLAMAV_HOST` / `CLAMAV_PORT` (дефолт 3310) — антивирус; пусто → скан выключен (scanStatus='none'). Dev: профиль scan → `localhost`

## Голос (core/voice)

- `VOICE_STT_URL` — OpenAI-совместимый STT (пусто → расшифровка выключена); self-host: профиль voice → `http://localhost:9000`
- `VOICE_STT_API_KEY` — = `WHISPER_API_KEY` контейнера (dev-дефолт `superapp6-voice-dev`)
- `VOICE_STT_MODEL` / `VOICE_STT_MODEL_KK` (слот дообученной казахской модели; whisper-server игнорирует — берёт `WHISPER_MODEL`)
- `VOICE_STT_MOCK` — `true` = mock-драйвер без сети (CI); ПЕРЕКРЫВАЕТ `VOICE_STT_URL`

## Звонки (core/calls)

- `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` — задан один → обязательны все три (пусто → звонки выключены). Секрет ≥ 32 символов (требование самого LiveKit). Dev: профиль calls → `http://localhost:7880`, ключ `devkey`, секрет = `LIVEKIT_DEV_SECRET`
- `LIVEKIT_WS_URL` — ws-адрес для браузера (пусто → из `LIVEKIT_URL` заменой http→ws); веб получает его от API в рантайме
- `LIVEKIT_EGRESS_DIR` — хост-каталог готовых файлов записи (= bind-mount контейнера egress; пусто → запись выключена, кнопка ⏺ скрыта). Валидатор отвергает без включённого LiveKit; prod: warn — каталог обязан быть общим томом ВСЕХ инстансов (вебхук `egress_ended` приходит на произвольный)

## Документы (core/docs)

- `DOCS_EDITOR_URL` — адрес(а) WOPI-редактора (пусто → документы выключены). Список через запятую = БЕЛЫЙ список, база выбирается по документу (задел шардирования). Из пользовательского ввода не берётся никогда (SSRF). Dev: профиль docs → `http://localhost:9980`
- `DOCS_WOPI_PUBLIC_URL` — адрес НАШЕГО API, каким его видит КОНТЕЙНЕР редактора (обычно `http://host.docker.internal:3001`). Обязателен только при заданном `DOCS_EDITOR_URL` и пустом `API_PUBLIC_URL` (иначе откат на него). Пропуск = классическое «WOPI::CheckFileInfo failed»
- `DOCS_TOKEN_SECRET` — ключ WOPI-токенов, ≥ 32 символов если задан (пусто → производный от `JWT_SECRET`)

## Гостевые ссылки / PDF / SMS / Подпись

- `SHARE_LINK_SECRET` — ключ гостевых пропусков, ≥ 32 символов если задан (пусто → производный от `JWT_SECRET`). Адрес ссылки — из `WEB_URL` (`/s/<токен>`)
- `GOTENBERG_URL` — PDF-рендер блочного конструктора (пусто → builder-документы не собираются, submit честно блокируется). Dev: профиль pdf → `http://localhost:3030`
- `SMS_DRIVER` — `kazinfoteh` | `mock`/пусто (dev: mock; prod: warn — SMS никуда не уходят, регистрация недоступна)
- `KIT_USERNAME` / `KIT_PASSWORD` / `KIT_ORIGINATOR` — все три обязательны при kazinfoteh (уходят телом POST, не в query) · `KIT_URL` (пусто → боевой шлюз `kazinfoteh.org:9507/api`)
- `VERIFY_REQUIRED` — пусто = secure-by-default (production → да); `true` форс в dev; `false` — аварийный рубильник в production (warn)
- `VERIFY_TEST_PHONES` — тест-карта `"+7700…:111111,…"` (SMS не шлётся, фикс-код, лимиты скипаются; в production игнорируется) · `VERIFY_TEST_PHONES_ALLOW_PROD` (осознанный прод-смоук)
- `VERIFY_SMS_HOURLY_BUDGET` (дефолт 200 = `VERIFY_LIMITS.globalHourlyBudgetDefault`) · `VERIFY_SMS_ORIGIN_DOMAIN` (origin-bound строка в SMS)
- `SIGN_VERIFY_DRIVER` — `ncanode` | `mock`; пусто → ncanode при заданном `NCANODE_URL`, иначе mock. `ncanode` без адреса — ошибка бута. **В production с mock ЭЦП ОТВЕРГАЕТСЯ** (warn при старте; ПЭП по SMS работает)
- `NCANODE_URL` — адрес верификатора; только из env (SSRF). Dev: профиль sign → `http://localhost:14579`
- `SIGN_QR_DRIVER` — `smartbridge` | `mock`/пусто (QR ведёт на наш одноразовый адрес — разработчик/сьют играют за телефон). При `smartbridge` обязательны все три: `SMARTBRIDGE_URL` / `SMARTBRIDGE_CLIENT_ID` / `SMARTBRIDGE_CLIENT_SECRET` (мост eGov Mobile, сервис NITEC-S-5096)

## Web (`apps/web`)

Три `NEXT_PUBLIC_*` (пример — `apps/web/.env.example`). Инлайнятся Next'ом на СБОРКЕ — смена значения = пересборка. Валидации нет: у каждой один-два читателя с дефолтом в коде.

- `NEXT_PUBLIC_API_URL` (дефолт `http://localhost:3001/api/v1`) — база API С версией; читают `apps/web/src/lib/api.ts`, `src/lib/public-api.ts`, `src/lib/hooks/useMessengerSocket.ts` (socket.io — origin без пути), `src/app/messenger/CallOverlay.tsx`; `apps/web/next.config.ts` выводит из неё http/ws-origin для CSP
- `NEXT_PUBLIC_LIVEKIT_WS_URL` (дефолт `ws: wss:`) — ТОЛЬКО сужение `connect-src` в CSP; сам адрес LiveKit веб получает от API в рантайме
- `NEXT_PUBLIC_DOCS_EDITOR_URL` (дефолт `http: https:`) — ТОЛЬКО сужение `frame-src`/`form-action` в CSP; адрес редактора тоже приходит от API

CSP пока `Content-Security-Policy-Report-Only` (`next.config.ts`); когда станет боевым — два последних значения обязаны быть узкими.

## Docker Compose (`docker-compose.yml`)

Переменные самого compose (`${X:-дефолт}`; задаются в корневом `.env` или окружении шелла, API их не видит):

- `WHISPER_MODEL` (дефолт `small`; для качества ru/kk — `large-v3-turbo`) · `WHISPER_API_KEY` (дефолт `superapp6-voice-dev`) = `VOICE_STT_API_KEY` API — профиль voice
- `LIVEKIT_DEV_SECRET` (дефолт `superapp6-calls-dev-secret-0123456789ab`) = `LIVEKIT_API_SECRET` API; ключ всегда `devkey` — профили calls (сервер и egress). Смени в проде
- `LIVEKIT_NODE_IP` (дефолт `127.0.0.1`) — ICE-IP, который LiveKit рекламирует браузеру; второе устройство в Wi-Fi → LAN-IP хоста + firewall 7880-7882
- `NCANODE_PKI_ENV` (`test` — дефолт, контур test.pki.gov.kz | `production`) — верификатор ЭЦП, профиль sign

Профили: `s3` · `scan` · `voice` · `calls` · `docs` · `pdf` · `sign` — команды в [dev_environment.md](dev_environment.md). Все движки инертны без своих env.

## Сводка валидатора: условные обязательности и предупреждения

Ошибки бута: `FILES_DRIVER=s3` → пять `S3_*` (кроме `S3_FORCE_PATH_STYLE`/`S3_PUBLIC_BASE_URL`) · любой `LIVEKIT_*` → все три · `LIVEKIT_EGRESS_DIR` → включённый LiveKit · `DOCS_EDITOR_URL` при пустом `API_PUBLIC_URL` → `DOCS_WOPI_PUBLIC_URL` · `SIGN_VERIFY_DRIVER=ncanode` → `NCANODE_URL` · `SIGN_QR_DRIVER=smartbridge` → три `SMARTBRIDGE_*` · `SMS_DRIVER=kazinfoteh` → три `KIT_*` · production → `REDIS_URL` и `JWT_SECRET` ≥ 32 · URL-поля обязаны быть URL, `APP_TIMEZONE` — IANA-зоной.

Только warn в production: `FILES_DRIVER=local` · пустой `TRUST_PROXY` · `VERIFY_REQUIRED=false` · `SMS_DRIVER≠kazinfoteh` · нет верификатора ЭЦП · задан `LIVEKIT_EGRESS_DIR`.
