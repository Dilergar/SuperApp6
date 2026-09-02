# Dev-среда: команды, сборка, сайдкары

> Как поднять и собрать проект, в каком порядке, и какие ловушки среды уже выучены. Полный список переменных окружения — [environment_variables.md](environment_variables.md).

## ВАЖНО (Windows)

- **tsc НЕ работает из Git Bash** — команды сборки запускать через PowerShell: `powershell -Command "cd path; command"`. ExecutionPolicy уже настроен (RemoteSigned).
- **Полный `tsc` на apps/api падает по памяти (OOM)** — проверка сборки API только `nest build`.
- `pkill`/юникс-приёмы не убивают процессы Windows — `Stop-Process`/`taskkill`.

## Запуск с нуля

```bash
# 1. Инфраструктура (PostgreSQL 16 + Redis 7)
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

## Линтеры и стражи

```bash
pnpm lint:guard   # из КОРНЯ: оба стража (~7с) — граница API↔клиенты (веб) + исходящий HTTP (API)
pnpm check:docs   # страж документации (~2с): пути, индекс, env, рёбра модулей — см. testing_verify_suite.md
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
- Порядок пересборки после правки shared: shared → api-client → api/web (иначе сборка против старого dist).
- Тестовые аккаунты и их разделение — [testing_verify_suite.md](testing_verify_suite.md); файл `acc.txt` в корне — локальная шпаргалка (не в git).

## Git-процесс

- Репозиторий: GitHub `Dilergar/SuperApp6`.
- Ветка main; коммиты по завершении логического блока работы (пользователь просит — коммитим).
- После клона один раз: `graphify hook install` — ставит post-commit хук, который в фоне обновляет `graphify-out/` после каждого коммита (код + изменённые md; ~40 с, коммит не ждёт). Хук живёт в `.git/hooks/`, в репозиторий не попадает. `graphify update .` — ТОЛЬКО из корня: из подпапки он молча строит второй граф внутри неё.
- CI на каждый push — см. [testing_verify_suite.md](testing_verify_suite.md).
