# Ревью движка «Процессы» — рабочий документ для сессии-исполнителя

> Создан 2026-06-14 из многоагентного ревью (10 ревьюеров: архитектура/логика, n8n, Salesforce Flow, «всё как ноды», производительность + адверсариальная проверка). **96 находок** (4 critical · 29 high · 26 medium · 30 low · 7 info).

## Как работать с этим документом (важно для нового чистого контекста)
1. **Это AI-ревью.** Verifier'ы отклонили 0 из 96 — то есть были мягкими. Считай находки **сильным черновиком**, а не приговором: **перед каждым фиксом сверь находку с реальным кодом** по указанным `файлам:строкам`. Не применяй вслепую.
2. **Порядок:** сначала весь блок **P0** (раздел 7) — это единственное, что молча ломается на валидных документах у клиента. Потом P1, потом P2.
3. **После каждого фикса** прогоняй `apps/api/scripts/verify-processes.cjs` + релевантные регрессии (`verify-tasks-access.cjs` и т.д.). Обновляй verify-скрипт под новое поведение.
4. **Windows:** сборки через PowerShell; API — `npx nest build` (НЕ полный `tsc --noEmit` — OOM); web — `npx tsc --noEmit`. Перезапуск API после сборки: убить процесс на 3001, `node dist/main.js`.
5. **Код движка:** `apps/api/src/modules/processes/*` (engine, compiler, node.types, service, triggers, cron, builtin/ai/service/kz-nodes, webhook.controller). Модели — `apps/api/prisma/schema.prisma` (Process*). Фронт — `apps/web/src/app/workspaces/[id]/processes/*`.
6. **Спрашивай пользователя** по спорным продуктовым решениям (напр. как должен вести себя «Конец» в параллельной ветке; нужен ли поток данных по токену — это большая работа).
7. Связанная память: Serena `project_process_engine`; auto-memory `project_processes_review.md`, `feedback_processes_triggers_as_nodes.md`.

---

## 1. Резюме
Фундамент крепкий (token-движок строками БД, версии-pinning, денежный инвариант в одной транзакции, AI-кластер). Для линейных/человеческих БП работает. Три класса проблем: (1) **параллелизм содержит 3 воспроизводимых дедлока** на валидных документах (P0); (2) как «конструктор интеграций» упирается в отсутствие потока данных по токену (n8n#1) и в один deps-блокер для «всё как ноды»; (3) hot-path и recovery-крон деградируют квадратично под нагрузкой.

## 2. Архитектура и логика

### HIGH
- **A1 — Join вечно зависает, если параллельная ветка легитимно не дошла.** `joinExpected`=статичный in-degree; ветка могла уйти в обход (condition/error-ветка/свой `end`) → `arrivals<expected` навсегда, крон бесконечно перекикивает, инстанс висит `running` без сигнала. Файлы: `process-engine.service.ts:276-294`, `process-builtin-nodes.ts:597-617`, `process-compiler.ts:208-212`. Рек.: expected через reachability ветвей / срабатывать при отсутствии живых upstream-токенов / stall-детектор в кроне → `error`.
- **A2 — `end` в параллельной ветке завершает ВЕСЬ инстанс и осиротит задачи соседних веток** (не гасит их `taskId`, в отличие от `cancelInstance`). Файлы: `process-engine.service.ts:250-260`. Рек.: терминал потребляет только свою ветку; или компилятор запрещает `end` ниже fork без join + каскад отмены задач.
- **A3 — Гонка создания join-строки расщепляет прибытия на 2 ряда** (нет unique `(instanceId,nodeId)`, депозиты вне kick-лока). Файлы: `process-engine.service.ts:276-294`, `schema.prisma` (ProcessStepRun). Рек.: partial-unique индекс на join-шаги / upsert / сериализация под инстанс-локом (A7).
- **A7 — Внешние хуки двигают токен вне per-instance kick-лока** (`onTaskCompleted`/`decideApproval`/`claimQueueStep`/таймер зовут `completeStepAndAdvance` до взятия лока). Корень A3. Файлы: `process-engine.service.ts:308-324, 386-399, 421-440, 100-141`. Рек.: advance-фазу хуков — под тот же инстанс-лок.

### MEDIUM
- **A6 — Циклы суб-агентов не ловятся компилятором** (только runtime depth≤3) → экспоненциальные дубли LLM; кластер пересобирается на каждый kick. `process-engine.service.ts:634-705`, `process-compiler.ts:215-243`. Рек.: детект циклов `ai_tool` + мемоизация.
- **A8 — Recovery-крон не разрешает застрявший join** (бесконечный benign busy без сигнала). `processes.cron.ts:24-94`. Рек.: stall-детектор → `error` (парно с A1).
- **A12 — SSRF обходима + `http_get` доступен LLM** (regex по хосту + `redirect:follow`; обходы: DNS-rebinding, 302→metadata, octal/hex IPv4, IPv6-mapped; LLM выбирает URL, prompt-injectable). `process-service-nodes.ts:50-63, 102-117, 153-159`. Рек.: валидировать резолвленный IP до соединения; ручной follow с реперепроверкой хопов; numeric-парсинг IP; allowlist для агента.

### LOW
- **A5** — `maxStepsPerInstance` считает done/cancelled → ложный обрыв долгого процесса. `process-engine.service.ts:268-272`.
- **A9** — `buildContext` «последний выигрывает» затирает итерации цикла; +N запросов. `process-engine.service.ts:712-748`.
- **A10** — plan-cache доверяет `compiled` без stamp схемы (опасен дефолт `joinExpected=1`). `process-engine.service.ts:607-623`.
- **A11** — schedule не догоняет пропуски; unpublished молча прокручивает `nextRunAt`; нет anchored-времени. `process-triggers.service.ts:62-84`.

## 3. Сравнение с n8n
- **n8n#1 (critical)** — нет потока данных по рёбрам (токен без payload, только `{{steps.x}}` «последний выигрывает»). Рек.: payload на токене (минимум JSON, в идеале `items[]`) — разблокирует всё ниже. «Взять заказы Kaspi → на каждый создать задачу» сейчас невыразимо.
- **n8n#2 (high)** — нет итерации по элементам / Loop Over Items.
- **n8n#3 (high)** — нет Retry On Fail (в коде 0). Рек.: `retryOnFail{maxTries,waitMs}` в паспорте ноды; хранить `attempt`.
- **n8n#4 (high)** — нет настраиваемого Continue/On-Error (зашито). Рек.: `onError: stop|continueMain|errorOutput`.
- **n8n#5 (high)** — нет языка выражений (только path-lookup; condition = поле анкеты vs константа). Рек.: безопасный мини-язык (AST, без eval) или нода «Set».
- **n8n#6 (high)** — нет partial execution / pinned data (отладка только боевым запуском). Рек.: dev-«прогнать ноду».
- **n8n#7 (medium)** — процессы не вызывают процессы. n8n#8 (medium) — нет resume-by-webhook на бегущем инстансе. n8n#9 (medium) — нет error-workflow. n8n#10 (medium) — join теряет данные веток.
- **n8n#11/#12 (low)** — анкета только на старте; один HTTP-таймаут/лимит.

## 4. Сравнение с Salesforce Flow
- **sfflow#1 (medium)** — триггеры без entry-conditions (фильтр только по eventType). Рек.: `{field,op,value}` поверх payload до старта (переиспользовать `evalCondition`).
- **sfflow#2 (medium)** — нет bulkification (per-event запрос + синхронный старт = «DML в цикле»). Рек.: развести приём и исполнение; batch-resolve; kick фоном.
- **sfflow#3 (medium)** — fault-path не первоклассна (human/notify/триггеры валят инстанс). Рек.: системный fault-порт; `notify` не валит.
- **sfflow#4 (medium)** — алерт об отказе только инициатору (служебный runAs). Рек.: уведомлять ответственных за def + дамп variables.
- **sfflow#7 (medium)** — расписание без anchored-времени/scheduled paths.
- **sfflow#5/6/8/9/10/11/12 (low)** — нет Loop-элемента; крон не подхватывает свежий maxAutoChain-шаг; runaway только по общему числу; нет ретенции версий (planCache FIFO не LRU); нет dry-run; AI/MCP-инструменты не через invocable-реестр (Ф3.5); нет subflow.
- Уже корректно по SF: версионирование (одна published, pinning), fault-порт у сервис/AI/KZ-нод, runaway-кран.

## 5. «Всё как ноды» — покрытие

**Корневой блокер (`critical`):** `NodeRunDeps = {tasks, notifications, db}` (`process-node.types.ts:55-59`, сборка `process-engine.service.ts:746`). Решение: **ModuleRef-резолвер** `deps.getService(token)` (циклы Shop/Messenger/Calendar↔Tasks — через токены, как уже `'ShopService'`/`'ProcessesService'`). `db` уже в deps → read-ноды через core/access реализуемы уже сейчас. Соглашение: **действия — через `richcard.execute`/capability, чтения — через core/access**; НЕ лазить в чужие таблицы через `ctx.deps.db` (обходит права и денежные инварианты — нарушает Принцип 4).

| Сервис | Можно нодой | Нельзя/частично (причина) | Что переделать |
|---|---|---|---|
| Staff | ✅ assignPosition/certify/remove, CRUD | — | + `staff` в deps |
| Workspaces | ✅ updateMember/invite/remove | accept/reject интерактивны → триггеры | + `workspaces` в deps |
| core/roles | ✅ почти (hire/fire/assign) | лестница ролей в WorkspacesService | + `roles`; `changeRoleTrusted` |
| Resources | ✅ confirm/reject; бронь=calendar.createEvent | нет отдельного createBooking | + `resources`+`calendar` |
| Wallet/Currency | ✅ payEmployee/mintToTreasury | **owner-check только в контроллере** — нода обойдёт | поднять owner-check в сервис |
| Wallet/Escrow | частично (берут `tx`) | standalone = strand/double-capture | reward через Tasks; process-native `refType='process'` в одной транзакции |
| Wallet/Ledger | ❌ | внутренности chart-of-accounts | не экспонировать |
| Messenger | ✅ sendMessage | таргетинг chatId; `getOrCreateTaskChat` private | + `messenger` (ModuleRef); нода `message.send` |
| Shop | ✅ confirmOrder/buy/contribute | DI-цикл | ModuleRef `'ShopService'`; order.confirm/buy |
| Calendar | ✅ createEvent/smartMatch | не в deps; нет skip-флага | + `calendar` + skip-флаг |
| Processes | ✅ startInstanceProgrammatic | нужен guard рекурсии + same-workspace | нода `process.start` (sub) |
| core/access | ✅ check/resolveLevel/listObjects | не в deps | + `access` (@Global) |
| core/rich-cards | ✅ execute (~13 действий) | не в deps | адаптер `richcard.execute` |
| core/search | ✅ read-tool | нет `search(viewerId)` метода | + `search`; astool |
| core/users | частично (findByPhone) | профиль/сессии/anonymize — НЕ ноды (PII) | лёгкий `findByPhone` |
| Notifications | ✅ через notifyNode | Contacts/Circles — read-снапшоты | snapshot участников группы |
| CardSkins/GoogleCal/Presence/Mentions/Projection/Engine internals | ❌/низкая ценность | B2C/per-user OAuth/read-only/служебное/сам рантайм | исключить |

**Новые ноды по приоритету:** P0 = ModuleRef-резолвер deps. P1 = `richcard.execute`(~13), `roles.changeRole/fire`, `staff.assignPosition/certify`, `wallet.payEmployee`, `message.send`, `shop.order.confirm/buy`, `process.start`, `access.check/list_objects`, `workspaces.inviteMember`, `resources.book`. P2 = `quickaction.run`; search/presence/balance/findByPhone как astool; `messenger.createGroup`; staff-справочники.

**Новые триггеры:** (сейчас `PROCESS_EVENT_TYPES`=5 в `constants/process.ts:50-56`, `resolveWorkspace` знает только workspace.*/task.*). High: `shop.order.placed/funded/confirmed`, `messenger.message.created`/`mention.created` (message.created уже на шине; mention.created надо эмитить). Medium: `workspace.member.fired` (**fireUser НЕ эмитит событие**), `calendar.event.created`, входящий WhatsApp (Meta webhook). Архитектура: `resolveWorkspace` → реестр `eventPrefix→резолвер`.

## 6. Производительность и нагрузка

### HIGH
- **P1 — `buildContext`: 3 запроса на ноду + перечитывание всех done-шагов (O(N²)).** ~300 запросов на kick; doneSteps растёт ~k строк на шаг k; buildAgentCluster ×4-10. `process-engine.service.ts:707-748, 104-138, 634-705`. Рек.: кэшировать имена 1× на kick; doneSteps — только нужные nodeId или in-memory аккумулятор.
- **P2 — Recovery-крон: 5 сканов + 500-id IN под глобальным локом с потолками** → работа за потолком дропается при 1000+ инстансах; один нод делает всё. `processes.cron.ts:24-94`. Рек.: claim-based батчи до опустошения; разнести заботы; троттлить waiting-sweep; шардинг по hash(workspaceId).
- **P3 — kick-лок (200с) поверх внешних HTTP/LLM** → агент >TTL → повтор дорогих вызовов; потерянный сигнал дропается; нет cap на конкурентные внешние вызовы. `process-engine.service.ts:100-141`. Рек.: не держать лок поверх I/O; bounded global concurrency; потерянный сигнал — enqueue, не дроп.

### MEDIUM
- **P4** — event-trigger: JSONB-path фильтр без индекса + per-event task-resolve. Рек.: `eventType` в колонку + индекс; in-memory Set воркспейсов с триггерами; workspaceId в payload.
- **P5** — `getReport` до 10k шагов, агрегаты в JS, join без индекса. Рек.: SQL-агрегаты; денормализовать `definitionId` на шаге + индекс.
- **P6** — inbox тянет все отделы юзера глобально; нет композитного индекса. Рек.: partial-индекс `WHERE status='active' AND task_id IS NULL`; скоуп на воркспейс; Redis-кэш отделов.
- **P7** — listInstances/getInstance парсят полный canvas ради меток; getInstance тянет все шаги с output-блобами (рефреш 4с). Рек.: снапшотить `label` на шаге; тонкий getInstance; дешёвый status-эндпоинт.
- **P8** — `completeStepAndAdvance` делает `COUNT(*)` на каждом переходе (O(M²)). `process-engine.service.ts:268-272`. Рек.: монотонный счётчик на инстансе (= решение A5).

### LOW
- **P9** — таймер-крон N+1 (re-load инстанса+плана на строку). **P10** — planCache FIFO@100 не LRU. **P11** — Telegram webhook синхронный до 200-OK → ретраи/двойной fire → async ACK. **P12** — AI-память Redis JSON read-modify-write (lost updates) → Redis LIST (RPUSH/LTRIM).

## 7. Приоритизированный план

### P0 (чинить первым — ломается само)
- **A7+A3** — advance-фаза хуков под инстанс-локом + partial-unique на join-шаги.
- **A1+A8** — корректное завершение join + stall-детектор → `error`.
- **A2** — `end` в ветке не валит инстанс/не осиротит задачи.
- **A12** — SSRF: резолвленный IP + реперепроверка редиректов + allowlist агента.
- **A4** — анти-runaway триггеров: маркер `source='process'` + пропуск self-событий + throttle + бюджет инстансов на воркспейс.
- **P8/A5** — монотонный счётчик шагов.
- **P3** — kick-лок не поверх внешнего I/O.
- **NodeRunDeps-резолвер (ModuleRef)** — разблокировщик «всё как ноды».

### P1 (нагрузка + ценные ноды/триггеры)
- Перф: P1, P2, P4, P5, P6, P7.
- Ноды: richcard.execute, roles.changeRole/fire, staff.assignPosition/certify, wallet.payEmployee, message.send, shop.order.confirm, process.start, access.check/list_objects.
- Триггеры: shop.order.*, messenger.message/mention, workspace.member.fired, calendar.event.created; реестр резолверов.
- n8n#1 (payload на токене) — начать проектирование. n8n#3/#4 + sfflow#1/#3 — retry/onError/entry-conditions/fault-port.

### P2 (удобство, потом)
partial-execution/dry-run/pinned-data; subflow; resume-by-webhook; error-workflow + алерт ответственным; anchored-расписание; детект циклов суб-агентов; schemaVersion в плане; LRU+Redis planCache; async webhook-ACK; Redis LIST для памяти; ретенция версий; read-tools агента.
