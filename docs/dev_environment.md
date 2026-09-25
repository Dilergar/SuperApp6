# Dev-среда: команды, сборка, сайдкары

> Как поднять и собрать проект, в каком порядке, и какие ловушки среды уже выучены. Полный список переменных окружения — [environment_variables.md](environment_variables.md).

## ВАЖНО (Windows)

- **tsc НЕ работает из Git Bash** — команды сборки запускать через PowerShell: `powershell -Command "cd path; command"`. ExecutionPolicy уже настроен (RemoteSigned).
- **Полный `tsc` на apps/api падает по памяти (OOM)** — проверка сборки API только `nest build`.
- **`nest start --watch` за долгую сессию тоже упирается в кучу**: десятки инкрементальных перекомпиляций за день съедают дефолтные 4 ГБ, API падает с `heap out of memory` (код 134) и роняет весь `turbo dev` — веб гаснет вместе с ним. Поэтому `dev`-скрипт API запускает nest через `node --max-old-space-size=6144`; при 16 ГБ ОЗУ это безопасно.
- `pkill`/юникс-приёмы не убивают процессы Windows — `Stop-Process`/`taskkill`.

## Запуск с нуля

```bash
# 1. Инфраструктура (PostgreSQL 18 + PgBouncer 1.26 + Redis 7.4 ×2 — версии пинованы в docker-compose.yml и CI)
docker compose build pgbouncer   # один раз: пулер собирается из исходников с пином sha256
docker compose up -d

# 2. Зависимости
pnpm install

# 3. Общие пакеты — ПОРЯДОК НЕСУЩИЙ (api-client берёт конверт из shared;
#    api и web не соберутся против старого dist ни того, ни другого)
cd packages/shared && pnpm build
cd ../api-client && pnpm build

# 4. Prisma
cd apps/api && pnpm db:generate && npx prisma migrate deploy
#    Изменил схему в разработке → pnpm db:migrate (создаёт+применяет миграцию).
#    db push НЕ ИСПОЛЬЗОВАТЬ — разойдётся с историей миграций.
#    migrate ходит по DIRECT_URL (мимо PgBouncer). ПОСЛЕ migrate deploy — роли (владельцы журналов
#    ≠ роль приложения, потолки роли, вход пулера) — и в dev тоже (dev-роль приложения = superapp):
#    psql "$ADMIN_DATABASE_URL" -v app_role=<роль приложения> -f apps/api/scripts/db-roles.sql
#    dev: docker exec -i superapp6-db psql -U superapp -d superapp6 -v app_role=superapp -f - < apps/api/scripts/db-roles.sql

# 5. Всё сразу
pnpm dev
```

Отдельно (Windows/PowerShell):
```bash
powershell -Command "cd apps/api; npx nest start --watch"   # API → http://localhost:3001
powershell -Command "cd apps/web; npx next dev"             # Web → http://localhost:3000 (Turbopack)
```

- Swagger (только dev): http://localhost:3001/api/docs
- Prisma Studio: `cd apps/api && pnpm db:studio`
- Прямой SQL: `docker exec -it superapp6-db psql -U superapp -d superapp6` (PostgreSQL MCP удалён — пакет deprecated)
- Веб-dev на Turbopack; запасной путь: `pnpm --filter ./apps/web dev:webpack`

## Слой данных в dev: PgBouncer, два Redis, настройки PostgreSQL

Схема и правила — `docs/data_architecture.md`; здесь — как это живёт в `docker compose`.

- **PgBouncer** (`superapp6-pgbouncer`, `:6432`, режим транзакций) — `DATABASE_URL` приложения. Конфиги: `infra/pgbouncer/pgbouncer.common.ini` (общие ключи БЕЗ заголовка секции — повторный `[pgbouncer]` после `%include` сбрасывает прочитанное), `pgbouncer.ini` (прод: `auth_query`, TLS), `pgbouncer.dev.ini` (dev: пароль в `userlist.dev.txt`, без TLS). Миграции, онлайн-DDL и сьюты с сессионным `SET` (`verify-partitions.cjs`) — по `DIRECT_URL` (`:5432`).
- **Redis-состояние** (`superapp6-redis`, `:6379`, `infra/redis/state.conf`: noeviction + AOF) и **Redis-кэш** (`superapp6-redis-cache`, `:6380`, `cache.conf`: allkeys-lfu без персистентности). ACL — `infra/redis/users.dev.acl`: приложение входит `sa6_app` с прод-ограничениями (KEYS/CONFIG/DEBUG/RESTORE закрыты — dev ловит закрытую команду до деплоя), `default` без пароля оставлен сторонним dev-компонентам (LiveKit). `protected-mode no` — только флагом compose (dev-`default` без пароля); прод-конфиг держит `yes`. Формат ACL-файла комментариев не допускает — пояснения в `state.conf`.
- **Переход с одного Redis на два**: включить AOF на ЖИВОМ инстансе ДО рестарта с конфигом (`docker exec superapp6-redis redis-cli CONFIG SET appendonly yes`, дождаться `aof_rewrite_in_progress:0`) — иначе старт с `appendonly yes` поднимет пустой AOF и потеряет данные; затем `docker compose up -d redis redis-cache` и уборка кэш-ключей из инстанса состояния `node apps/api/scripts/redis-split-roles.cjs --apply` (без флага — сухой прогон).
- **Настройки PostgreSQL** — `infra/postgres/superapp6.conf` (UTC, `max_locks_per_transaction 256`, lz4/zstd, `pg_stat_statements` + `auto_explain`, логи без значений параметров, autovacuum). Новый том подключает init-скрипт; готовый — одной строкой и рестартом: `docker exec superapp6-db sh -c "echo \"include_if_exists = '/etc/postgresql/superapp6.conf'\" >> \$PGDATA/postgresql.conf" && docker restart superapp6-db`. Архив WAL (`infra/pgbackrest/postgresql.archive.conf`) в dev НЕ подключать — WAL копился бы без конца.
- **Пробы и метрики**: `GET /health/live`, `GET /health/ready` (у корня, вне `/api`; разбивка проверок — держателю `METRICS_TOKEN`, в dev без токена открыта), `GET /metrics`. Сторожевой опрос БД раз в 5 минут; сразу — `POST /api/lifecycle/dev/db-watch`. Сьют — `verify-health.cjs`.
- **Учение восстановления в dev**: `node apps/api/scripts/lifecycle-restore-drill.cjs --dev-clone --report` — логическая копия в `superapp6_drill` того же контейнера, сверки (строки, Σ=0 леджера, дайджесты журнала безопасности, журнал стираний) и отчёт в дашборд «Данные»; `--keep` оставляет копию (проверка сверок на срабатывание — порча копии и прогон с `DRILL_RESTORED_URL`).
- **Смоук S3-кандидата**: `node apps/api/scripts/s3-conformance.cjs [--require-versioning --require-object-lock]`. Dev-SeaweedFS (`--profile s3`) работает без аутентификации — проверки подписей на нём честно падают: это смоук кандидата-провайдера, не dev-хранилища.

## Ключи (`core/keys`) — корень и учение

- Корневой ключ: dev создаёт `apps/api/.keys/root.key` сам (в `.gitignore`); production — церемония `node apps/api/scripts/keys-init-root.cjs <путь>` (32 байта CSPRNG, права 0600, печатает отпечаток SHA-256 для кабинета; существующий файл не перезаписывает), две офлайн-копии у двух людей. Учение восстановления — `node apps/api/scripts/keys-verify-root.cjs <копия>` (поднимает провайдер копией и распаковывает primary-версии; exit 1 = копия не та). Без корня API не стартует; версия, обёрнутая чужим корнем, роняет бут — [keys_engine.md](keys_engine.md).
- Дев-полигон `/keys/dev/*` (только development/test): ротации, заморозка, roundtrip, режим ПДн, backfill, слив last-used, аудит вебхуков. Вебхуки на 127.0.0.1 — `WEBHOOKS_DEV_LOOPBACK=true` в `apps/api/.env`.

## Линтеры и стражи

```bash
pnpm lint:guard   # из КОРНЯ: оба стража (~7с) — граница API↔клиенты (веб) + исходящий HTTP (API)
pnpm check:docs   # страж документации (~2с): пути, индекс, env, рёбра модулей — см. testing_verify_suite.md
pnpm check:audit  # страж реестра журнала безопасности (~1с): каталоги, запрещённые слова деталей, живые ключи пишутся
```
Страж отдельный от `lint`, потому что `lint` API = полный tsc, который падает по памяти. В CI — отдельные шаги.

## Verify-сьют

`node apps/api/scripts/verify-<name>.cjs` при запущенном API — правила в [testing_verify_suite.md](testing_verify_suite.md).

## Docker-профили (опциональные сайдкары)

```bash
docker compose --profile s3 up -d      # SeaweedFS (S3-хранилище файлов), :8333
docker compose --profile scan up -d    # ClamAV (антивирус файлов), :3310
docker compose --profile voice up -d   # whisper-server (STT), :9000
docker compose --profile calls up -d   # LiveKit SFU + egress (звонки/запись), :7880-7882
docker compose --profile docs up -d    # Collabora (WOPI-редактор документов), :9980
docker compose --profile pdf up -d     # Gotenberg (PDF-рендер конструктора), :3030
docker compose --profile sign up -d    # NCANode (верификатор ЭЦП), :14579
```
Все движки инертны без своих env — платформа живёт и без сайдкаров (соответствующие фичи выключены честно).

## Свои сборки образов

**Редактор документов** (`infra/docs-editor/`, рунбук README.md):
```bash
.\infra\docs-editor\build.ps1 -Stage brand    # правка бренда — секунды
.\infra\docs-editor\build.ps1 -Stage base     # смена версии — долго
```
⚠️ **После ЛЮБОЙ пересборки обязателен сброс кэша discovery** (`-FlushDiscovery`): в адресе редактора зашит хэш сборки, кэш Redis живёт час — без сброса iframe молча уходит в 404 при нуле ошибок на сервере.

**Пак значков** (`infra/glyph-pack/`): сборка каталогов Glyph (Fluent → webp, предметные Phosphor, русские названия эмодзи, сабсеты Noto) → результат в `apps/web/public/glyphs/`; пины версий — `pins.env`, каталог иконок курируется руками (`icons.catalog.json`). Пересборка нужна только при расширении каталога.

**Верификатор ЭЦП** (`infra/sign-verifier/`, рунбук README.md; образ ПРИВАТНЫЙ — лицензия НУЦ РК запрещает перераспространение, SDK и корни не коммитятся):
```bash
.\infra\sign-verifier\build.ps1 -Check   # SDK и корни на месте?
.\infra\sign-verifier\build.ps1          # собрать образ
```
Без него ЭЦП проверяется mock: в development принимается, в production ОТВЕРГАЕТСЯ. ПЭП (SMS) работает всегда.

## Ловушки среды (выучены на крови)

- **Стейл-процесс на :3001**: старый `node dist/main.js` держит порт со старым кодом в памяти — новый параметр отвечает 400 при правильном коде. Перед отладкой «не работает» проверить, ЧЕЙ процесс слушает порт.
- **`nest start --watch` держит Prisma DLL** → `EPERM` на `prisma generate`. Остановить watch, сгенерить, запустить снова.
- **Write-инструменты, эмитящие литеральный NUL** в исходник, делают файл невидимым для ripgrep — чинить PowerShell'ом.
- HMR-ошибки веба проверять в НОВОЙ вкладке (старая может держать битый бандл).
- Порядок пересборки после правки shared: **shared → i18n → api-client → api/web** (иначе сборка против старого dist). Правка каталогов сообщений — `pnpm i18n:gen` перед сборкой `@superapp/i18n` (его `prebuild` делает это сам).
- Тестовые аккаунты и их разделение — [testing_verify_suite.md](testing_verify_suite.md); файл `acc.txt` в корне — локальная шпаргалка (не в git).
- **`.claude/launch.json` — только ПРИСОЕДИНЕНИЕ** (`url` + `port`, без команды): стек поднимает человек одной `pnpm dev` из корня, а порты 3000/3001 несущие (CORS API и редиректы завязаны на `localhost:3000`, `autoPort` там запрещён). Предпросмотр агента поэтому не запускает вторую копию поверх работающей — и не поднимает сервер сам, если `pnpm dev` не запущен.

## Git-процесс

- Репозиторий: GitHub `Dilergar/SuperApp6`.
- Ветка main; коммиты по завершении логического блока работы (пользователь просит — коммитим).
- После клона один раз: `graphify hook install` — ставит post-commit хук, который в фоне обновляет `graphify-out/` после каждого коммита (код + изменённые md; ~40 с, коммит не ждёт). Хук живёт в `.git/hooks/`, в репозиторий не попадает. `graphify update .` — ТОЛЬКО из корня: из подпапки он молча строит второй граф внутри неё.
- CI на каждый push — см. [testing_verify_suite.md](testing_verify_suite.md).
