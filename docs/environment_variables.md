# Переменные окружения

> **API** (`apps/api/.env`): валидация — zod при старте, `apps/api/src/shared/config/env.validation.ts` (первый вызов в `bootstrap()`, fail-fast). Правила: (1) КАЖДАЯ переменная, которую читает `apps/api/src`, объявлена в схеме — сверка: `grep -rhoE "process\.env\.[A-Z0-9_]+" apps/api/src | sort -u` против ключей схемы (единственное законное исключение — `DATABASE_URL`, её читает Prisma из `schema.prisma`); (2) пустая строка = «не задано» (скопированный `.env.example` не валит бут); (3) всё, кроме явных `development`/`test` в `NODE_ENV`, считается продом (fail-closed). Дефолты ниже — значение при пустой переменной; они живут в коде потребителя (тот читает сырой `process.env`), схема лишь проверяет форму. «prod: warn» — не ошибка, а громкое предупреждение при старте.

## Ядро

- `DATABASE_URL` — PostgreSQL (обязательна)
- `REDIS_URL` — Redis; в production обязательна (без неё тихий фолбэк на localhost = отказ троттлинга/шины/локов)
- `JWT_SECRET` — устарел: только legacy-окно HS256 (читается как `JWT_SECRET_LEGACY`, если тот пуст). Подпись токенов — Ed25519 движка ключей, см. раздел «Движок ключей» ниже
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
- `DOCS_TOKEN_SECRET` — УСТАРЕЛ: прежний HMAC-ключ WOPI-токенов `v1.…`; читается только для проверки старых токенов на legacy-окне `KEYS_LEGACY_HS256_UNTIL` (пусто → производный от legacy-секрета), новые токены подписывает движок ключей (аудитория `wopi`); после окна задан → бут падает

## Гостевые ссылки / PDF / SMS / Подпись

- `SHARE_LINK_SECRET` — УСТАРЕЛ: прежний HMAC-ключ гостевых пропусков `v1.…`; только проверка старых пропусков на legacy-окне, новые подписывает движок ключей (`share_link`); после окна задан → бут падает. Адрес ссылки — из `WEB_URL` (`/s/<токен>`)
- `GOTENBERG_URL` — PDF-рендер блочного конструктора (пусто → builder-документы не собираются, submit честно блокируется). Dev: профиль pdf → `http://localhost:3030`
- `SMS_DRIVER` — `kazinfoteh` | `mock`/пусто (dev: mock; prod: warn — SMS никуда не уходят, регистрация недоступна). Тот же драйвер — канал `sms` движка уведомлений.

### Движок уведомлений (`core/notifications`) — web push

- `WEB_PUSH_VAPID_PUBLIC_KEY` · `WEB_PUSH_VAPID_PRIVATE_KEY` — пара VAPID (`npx web-push generate-vapid-keys`); пусто → push выключен: тумблер «уведомления в этом браузере» и карточка в панели не показываются, доставки `skipped: driver_not_configured`, регистрация web-устройства отвечает `400 notification.push.notConfigured`.
- `WEB_PUSH_SUBJECT` — контакт для push-служб по спецификации VAPID (`mailto:…` или `https://…`; дефолт `mailto:support@superapp6.kz`).
- `KIT_USERNAME` / `KIT_PASSWORD` / `KIT_ORIGINATOR` — все три обязательны при kazinfoteh (уходят телом POST, не в query) · `KIT_URL` (пусто → боевой шлюз `kazinfoteh.org:9507/api`)
- `CONSENTS_REQUIRED` — движок согласий ([consents_engine.md](consents_engine.md)): обязателен ли ЯВНЫЙ пакет согласий при создании организации. Пусто = secure-by-default (production → да); вне production без поля `consents` сервер принимает действующие версии сам (основание `dev_auto`); `true` — форс в dev; `false` в production → warn. Регистрация человека требует согласий ВСЕГДА — рубильника у неё нет
- `VERIFY_REQUIRED` — пусто = secure-by-default (production → да); `true` форс в dev; `false` — аварийный рубильник в production (warn)
- `VERIFY_TEST_PHONES` — тест-карта `"+7700…:111111,…"` (SMS не шлётся, фикс-код, лимиты скипаются; в production игнорируется) · `VERIFY_TEST_PHONES_ALLOW_PROD` (осознанный прод-смоук)
- `VERIFY_SMS_HOURLY_BUDGET` (дефолт 200 = `VERIFY_LIMITS.globalHourlyBudgetDefault`) · `VERIFY_SMS_ORIGIN_DOMAIN` (origin-bound строка в SMS)
- `PLATFORM_JWT_SECRET` — УСТАРЕЛ: прежний HS256-секрет токена кабинета (`aud: platform`, [platform_console.md](platform_console.md)); читается только для проверки токенов, выданных до движка ключей, на legacy-окне; новые токены кабинета подписывает своя пара Ed25519 (аудитория `platform` ≠ `product`, токены не взаимозаменяемы); после окна задан → бут падает.
- `PLATFORM_CONSOLE_ENABLED` — стоп-кран кабинета: `false` → все `/platform/*` отвечают `404` без деплоя кода; пусто/`true` — включён.

### Продуктовая аналитика (`core/analytics`)

- `ANALYTICS_ENABLED` — стоп-кран движка: `false` → приём отвечает `202` без записи, `track()` молчит; пусто/`true` — включён.
- `ANALYTICS_CONSUMER_ENABLED` — консьюмер stream'а и outbox на этом инстансе (выключают на инстансах только-HTTP); пусто/`true` — включён.
- `ANALYTICS_RAW_RETENTION_DAYS` — ретенция сырья и роллапа «субъект × день», дней (пусто → 400 ≈ 13 месяцев); остальные роллапы вечны. Старые месячные партиции сбрасываются целиком.
- `ANALYTICS_STREAM_MAXLEN` — приблизительный потолок stream'а приёма (пусто → 2 000 000); сброс `telemetry` с 80 %, `product` с 95 %.
- `ANALYTICS_K_ANON` — порог k-анонимности разбиений (пусто → 20).
- `ANALYTICS_INTERNAL_PHONE_PREFIXES` — префиксы номеров внутренних и тестовых аккаунтов через запятую (события помечаются `is_internal`; вместе с активными сотрудниками платформы исключаются из отчётов по умолчанию).
- `ANALYTICS_READ_DATABASE_URL` — реплика или роль только на чтение для отчётов Кабинета (пусто → основной пул).
- `ANALYTICS_QUERY_TIMEOUT_MS` — `statement_timeout` запросов по сырью, мс (пусто → 5000).
- `SIGN_VERIFY_DRIVER` — `ncanode` | `mock`; пусто → ncanode при заданном `NCANODE_URL`, иначе mock. `ncanode` без адреса — ошибка бута. **В production с mock ЭЦП ОТВЕРГАЕТСЯ** (warn при старте; ПЭП по SMS работает)
- `NCANODE_URL` — адрес верификатора; только из env (SSRF). Dev: профиль sign → `http://localhost:14579`
- `SIGN_QR_DRIVER` — `smartbridge` | `mock`/пусто (QR ведёт на наш одноразовый адрес — разработчик/сьют играют за телефон). При `smartbridge` обязательны все три: `SMARTBRIDGE_URL` / `SMARTBRIDGE_CLIENT_ID` / `SMARTBRIDGE_CLIENT_SECRET` (мост eGov Mobile, сервис NITEC-S-5096)

## Движок ключей (`core/keys`) и вебхуки (`core/webhooks`) — [keys_engine.md](keys_engine.md)

- `KEYS_PROVIDER` — `software` (по умолчанию) | `pkcs11` (заглушка под HSM/СКЗИ; интерфейс `KeyProvider`)
- `KEYS_ROOT_KEY_FILE` — файл корневого ключа (32 байта hex/base64/raw; dev-дефолт `./.keys/root.key` создаётся сам только в development). Production: обязателен, файл существует, права 0600; церемония — `node apps/api/scripts/keys-init-root.cjs`, учение — `keys-verify-root.cjs`
- `KEYS_ROOT_KEY_FILE_NEXT` — файл СЛЕДУЮЩЕГО корня на окне ротации (создан церемонией, никогда не генерируется сам; те же требования к правам). Пока задан, инстанс держит оба корня, а `keys.root.rotate` перешивает версии порциями; после завершения — становится `KEYS_ROOT_KEY_FILE`, переменная убирается ([keys_engine.md](keys_engine.md))
- `JWT_SECRET_LEGACY` — секрет прошлой эпохи (HS256-токены, производные HMAC) на окно миграции; пусто → берётся `JWT_SECRET`
- `KEYS_LEGACY_HS256_UNTIL` — ISO-дата конца legacy-окна; production при заданном legacy-секрете требует дату в будущем и не дальше 45 дней вперёд (окно = срок refresh-токена), после неё секрет удаляется из окружения (бут падает)
- `KEYS_PII_READ_MODE` — `legacy` (по умолчанию: читаем открытые ПДн-колонки, пишем обе) | `encrypted` (читаем `_enc`, ищем по `_bi`) — [keys_pii.md](keys_pii.md)
- `KEYS_PKCS11_MODULE`, `KEYS_PKCS11_SLOT`, `KEYS_PKCS11_PIN`, `KEYS_PKCS11_KEY_LABEL` — параметры провайдера `pkcs11` (только при `KEYS_PROVIDER=pkcs11`)
- `WEBHOOKS_DEV_LOOPBACK` — `true` разрешает доставку вебхуков на `http://127.0.0.1` (приёмник сьюта `verify-webhooks.cjs`); только development/test, в production бут падает — [webhooks_engine.md](webhooks_engine.md)
- `NODE_OPTIONS` — читается только стражем бута (`main.ts`): в production флаги `--inspect*`, `--heapsnapshot-*`, `--report-on-*`, `--cpu-prof`/`--heap-prof` в нём или в `execArgv` роняют старт (память процесса содержит распакованные ключи) — [security.md](security.md), «Секреты»
- `METRICS_TOKEN` — токен скрейпера метрик `GET /metrics` (`shared/metrics`, ≥ 16 символов): задан → `Authorization: Bearer` обязателен; пусто → в production маршрут отвечает 404, в development открыт — [keys_engine.md](keys_engine.md), «Журнал и наблюдаемость»

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

Ошибки бута: `FILES_DRIVER=s3` → пять `S3_*` (кроме `S3_FORCE_PATH_STYLE`/`S3_PUBLIC_BASE_URL`) · любой `LIVEKIT_*` → все три · `LIVEKIT_EGRESS_DIR` → включённый LiveKit · `DOCS_EDITOR_URL` при пустом `API_PUBLIC_URL` → `DOCS_WOPI_PUBLIC_URL` · `SIGN_VERIFY_DRIVER=ncanode` → `NCANODE_URL` · `SIGN_QR_DRIVER=smartbridge` → три `SMARTBRIDGE_*` · `SMS_DRIVER=kazinfoteh` → три `KIT_*` · production → `REDIS_URL`, `KEYS_ROOT_KEY_FILE` существует, legacy-секрет только с датой `KEYS_LEGACY_HS256_UNTIL` в будущем, `WEBHOOKS_DEV_LOOPBACK` ≠ true, флаги `--inspect*`/`--heapsnapshot-*` запрещены · `PLATFORM_JWT_SECRET`/`DOCS_TOKEN_SECRET`/`SHARE_LINK_SECRET` заданы после конца legacy-окна → ошибка · URL-поля обязаны быть URL, `APP_TIMEZONE` — IANA-зоной.

Только warn в production: `FILES_DRIVER=local` · пустой `TRUST_PROXY` · `VERIFY_REQUIRED=false` · `CONSENTS_REQUIRED=false` · `SMS_DRIVER≠kazinfoteh` · нет верификатора ЭЦП · задан `LIVEKIT_EGRESS_DIR`.
