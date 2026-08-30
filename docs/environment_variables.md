# Переменные окружения (apps/api/.env)

> Валидация — zod при старте (`shared/config/env.validation.ts`, fail-fast). Пустая строка = «не задано» (скопированный .env.example не валит бут). Правило: всё, кроме явных `development`/`test` в NODE_ENV, считается продом (fail-closed).

## Ядро

- `DATABASE_URL` — PostgreSQL (обязательна)
- `REDIS_URL` — Redis (в production обязательна; иначе тихий фолбэк на localhost запрещён валидацией)
- `JWT_SECRET` — секрет подписи JWT (обязателен; в production ≥ 32 символов). Мастер-ключ производных секретов — см. [security.md](security.md)
- `JWT_EXPIRES_IN` (15m) / `JWT_REFRESH_EXPIRES_IN` (30d)
- `PORT` (3001) · `NODE_ENV` (whitelist) · `WEB_URL` (база веба для редиректов/ссылок, дефолт http://localhost:3000)
- `TRUST_PROXY` — сколько прокси-хопов доверять при разборе X-Forwarded-For (за одним балансировщиком `1`). Пусто → XFF игнорируется. От него зависят ВСЕ лимиты «по IP»; в production без него — warn
- `APP_TIMEZONE` — пояс детерминированного форматирования дат (сутки предохранителей, «было → стало»)

## Google Calendar

- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` — OAuth (пусто → интеграция инертна). Redirect: `http://localhost:3001/api/integrations/google/callback`
- `GOOGLE_WEBHOOK_URL` — публичный HTTPS для push (пусто → поллинг)

## Файлы (core/files)

- `FILES_DRIVER` — `local` (дефолт; **строго 1 инстанс API** — в production громкий warn, масштабирование только на s3) | `s3`
- `FILES_LOCAL_ROOT` (./storage) · `API_PUBLIC_URL` (база абсолютных файловых ссылок)
- `S3_ENDPOINT` / `S3_REGION` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_BUCKET` — обязательны при s3; `S3_FORCE_PATH_STYLE` (true) · `S3_PUBLIC_BASE_URL` (CDN для public-файлов)
- `CLAMAV_HOST` / `CLAMAV_PORT` — антивирус (пусто → скан выключен, scanStatus='none')

## Голос (core/voice)

- `VOICE_STT_URL` — OpenAI-совместимый STT (пусто → расшифровка выключена); self-host: профиль voice → http://localhost:9000
- `VOICE_STT_API_KEY` (= WHISPER_API_KEY контейнера; dev-дефолт superapp6-voice-dev)
- `VOICE_STT_MODEL` / `VOICE_STT_MODEL_KK` (слот дообученной казахской модели)
- `VOICE_STT_MOCK` — true = mock-драйвер без сети (CI); ПЕРЕКРЫВАЕТ VOICE_STT_URL

## Звонки (core/calls)

- `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` — задан один → обязательны все (пусто → звонки выключены). Dev: профиль calls → http://localhost:7880, ключ devkey, секрет ≥32 символов
- `LIVEKIT_WS_URL` — ws-адрес для браузера (пусто → из LIVEKIT_URL заменой http→ws)
- `LIVEKIT_EGRESS_DIR` — каталог готовых файлов записи (= bind-mount контейнера egress; пусто → запись выключена)
- `LIVEKIT_NODE_IP` — (переменная compose) ICE-IP для браузера: дефолт 127.0.0.1; для второго устройства в Wi-Fi — LAN-IP хоста + firewall 7880-7882

## Документы (core/docs)

- `DOCS_EDITOR_URL` — адрес(а) WOPI-редактора (пусто → документы выключены). Список через запятую = БЕЛЫЙ список, база выбирается по документу (задел шардирования). Из пользовательского ввода не берётся никогда (SSRF)
- `DOCS_WOPI_PUBLIC_URL` — адрес НАШЕГО API, каким его видит КОНТЕЙНЕР редактора (обычно http://host.docker.internal:3001). Пропуск = классическое «WOPI::CheckFileInfo failed»
- `DOCS_TOKEN_SECRET` — ключ WOPI-токенов (пусто → производный от JWT_SECRET)

## Гостевые ссылки / PDF / SMS / Подпись

- `SHARE_LINK_SECRET` — ключ гостевых пропусков (пусто → производный от JWT_SECRET). Адрес ссылки строится из WEB_URL (`/s/<токен>`)
- `GOTENBERG_URL` — PDF-рендер конструктора (пусто → builder-документы не собираются, submit честно блокируется). Dev: профиль pdf → http://localhost:3030
- `SMS_DRIVER` — `kazinfoteh` | `mock`/пусто (dev: код в лог; в production — громкий warn)
- `KIT_USERNAME` / `KIT_PASSWORD` / `KIT_ORIGINATOR` — все три обязательны при kazinfoteh (уходят телом POST, не в query) · `KIT_URL` (пусто → боевой шлюз)
- `VERIFY_REQUIRED` — пусто = secure-by-default (production → да); `true` форс в dev; `false` — аварийный рубильник в production (warn)
- `VERIFY_TEST_PHONES` — тест-карта `"+7700…:111111,…"` (SMS не шлётся, фикс-код, лимиты скипаются; в production игнорируется) · `VERIFY_TEST_PHONES_ALLOW_PROD` (осознанный прод-смоук)
- `VERIFY_SMS_HOURLY_BUDGET` (200) · `VERIFY_SMS_ORIGIN_DOMAIN` (origin-bound строка в SMS)
- `SIGN_VERIFY_DRIVER` / `NCANODE_URL` — верификатор ЭЦП: `ncanode` | `mock`. Пусто → ncanode при заданном NCANODE_URL, иначе mock. **В production с mock ЭЦП ОТВЕРГАЕТСЯ** (fail-closed строже SMS)
- `SIGN_QR_DRIVER` / `SMARTBRIDGE_URL` / `SMARTBRIDGE_CLIENT_ID` / `SMARTBRIDGE_CLIENT_SECRET` — мост eGov Mobile (Smart Bridge). Пусто → mock (QR ведёт на наш одноразовый адрес — разработчик/сьют играют за телефон)

## Docker-профили

`s3` · `scan` · `voice` · `calls` · `docs` · `pdf` · `sign` — команды в [dev_environment.md](dev_environment.md). Все движки инертны без своих env.
