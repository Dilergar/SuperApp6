# Процессы (ProcessesModule, B2B)

> Нодовый движок бизнес-процессов (n8n-модель, построен своим клин-румом: n8n Sustainable Use License не встраивается, Windmill AGPL, Camunda 7 EOL). Документ-канвас — источник правды; публикация компилирует в план; инстанс прикноплен к версии. Дизайн — Serena `project_process_engine`.

## Реестр нод (платформенный)

`ProcessNodeRegistry`: паспорт ноды = декларативный описатель (тип/категория/иконка-ключ/`tier` standard|system/типизированные выходы/`fields`-виджеты/Zod-`configSchema`/`auto`-флаг) — одна регистрация кормит палитру, валидацию и будущие AI/MCP-поверхности. `ProcessNodeOutput.optional`+`fallback` — новый исход к опубликованным нодам без инвалидации маршрутов. `ProcessDefinition.surface` + белый список `SURFACE_NODE_TYPES` (профиль `documents.hr` показывает 13 нод, `documents.general` — 11; веб передаёт surface в `GET /node-types`). system-ноды — только `platform_admin`.

## Версии и компилятор

Модель Salesforce Flow: publish = новая версия, активна одна; правка published авто-открывает черновик v+1; бегущие доживают на своей версии (pin). Мягкая валидация при сохранении; публикация — 0 issues + исполнители-члены; `ProcessValidationIssue.severity` (`error` блокирует; `warning` — публикация с ПОИМЁННЫМ принятием `acceptWarnings`, след — запись `process.published_with_warnings` в хронике организации со списком правил; отсутствие поля = error, fail-closed). Правила ТК РК для кадровых маршрутов — `process-document-rules.ts` (предупреждениями). Недозаполненная нода остаётся в плане с сырым конфигом (чтение страницы не падает; за ней схема достижима); self-loop и рёбра в триггер запрещены.

## Движок — мульти-токенный token-walker

Строками БД: `ProcessInstance` (анкета JSONB, wakeAt, triggerType, runAsUserId) + `ProcessStepRun` (таймстемпы = «секундомер отделов», outcome=порт, taskId, joinArrivals). Status-guarded updateMany (двойное продвижение невозможно), Redis-лок на инстанс, `ProcessesCron` добивает зависшее; стоп-краны ≤500 шагов/инстанс, ≤100 авто-нод/толчок; `activated`-флаг разделяет «side-effect не отработал» от «ждёт человека/времени»; fork спавнит токен на ребро, join ждёт in-degree прибытий (депозит будит), срабатывает один раз. Кэш планов с потолком.

## Ноды (38 паспортов в 7 группах: BUILTIN 15 + SERVICE 1 + AI 5 + KZ 5 + ACTION 6 + DOCUMENT 4 + HR 2)

**Триггеры** (вход = нода; можно несколько; публикация требует ≥1; авто-триггеры зеркалятся в `ProcessTrigger` при публикации, стабильный webhook-токен). ⚠️ Триггером ноду делает **ФЛАГ `trigger` в паспорте, а не категория `trigger`** (категория — только для палитры; нода без флага «не считается триггером», и маршрут решает, что триггера нет — прецедент trigger.document): Запуск вручную (анкета) · По расписанию · Веб-хук · Событие в SuperApp · Telegram-входящее · trigger.document (связь «шаблон→маршрут»; два опубликованных маршрута на шаблон → error).
**Человеческие**: Задача человеку (создаёт НАСТОЯЩУЮ задачу; исполнитель сотрудник|отдел(очередь+claim, модель Camunda candidate-group)|инициатор|**руководитель инициатора** (`initiator_manager` — первый из `manager_of` по оргструктуре, вершина → владелец); dueInHours→SLA+эскалация) · Решение человека (`human.approval` → движок core/approvals: kind согласование|подпись|ознакомление, адресат человек/должность/отдел/объект/**руководитель инициатора**/**руководитель стороны документа**/**руководитель объекта инициатора** (относительные адресаты core/audiences, считаются в момент активации шага), rule any|all, исход «На доработку»; возврат токена — хук ApprovalOriginRegistry → `resumeApproval`; причина отказа обязательна В ДВИЖКЕ).
**Логика**: Если · Развилка/Слияние (`parallel.split`/`parallel.join`) · Пауза · `loop.each` (цикл по списку) · `data.set` (установить данные) · Конец.
**Действия**: Уведомить · `service.message` (сообщение в чат) · `action.richcard` · `staff.assign` · `workspaces.role` · `process.start` (запуск под-процесса; защита от рекурсии `_subprocessDepth`) · HTTP-запрос (внешний REST; подстановки, креды из сейфа, SSRF-защита safeFetch) · finance.record · doc.generate/doc.register/doc.file (документы) · hr.apply/hr.esutd (КЭДО).
**AI-кластер** (n8n cluster-модель): AI (простой LLM-шаг) · AI-Агент (типизированные порты: Модель обязательна, Память опц., Инструменты = САМИ ноды действий через выход `astool`; под-агенты рекурсией ≤3) · под-ноды Модель/Память (Redis-сессии) · `ai.parser`. Ключи — bearer-креды сейфа; ошибка AI → ветка error.
**KZ-коннекторы**: Telegram · WhatsApp · SMS (Mobizon) · Kaspi Магазин (опрос по расписанию) · 1С OData. Все — подстановки + кред из сейфа + выходы success/error; сток Telegram экранирует HTML.

Подстановки `{{form.x}}`/`{{initiator.name}}`/`{{steps.<node>.output…}}` — path-lookup без eval, own-property; внешние старты санитайзятся (`_*`-ключи отбрасываются).

## Гейты

Читает/запускает команда (trainee+; Подрядчик изолирован); правка/публикация/архив/журнал — manager+; `visibility='admins'` скрывает от не-админов (enforced на edit/publish/validate/archive/журнал). Инстансы: manager+ все; рядовой — свои запуски + где исполнитель. Отмена (инициатор|manager+) каскадно отменяет задачи; архив с бегущими → 409. Runtime-проверка членства в нодах (уволенный не получит задачу). **runAs — не выше своего ранга** (`publisherRank` в конфиге триггера + runAsAllowed на всех точках срабатывания); `webhookUrl` не отдаётся стажёру; креды скоуплены workspaceId.

## Сейф кредов

`ProcessCredential` — AES-256-GCM (ключ производный от JWT_SECRET); типы header|bearer|basic; секрет наружу не отдаётся; manager+.

## API (кратко)

`GET /workspaces/:id/processes` · `GET /node-types?surface=` · `GET/PATCH /:defId` · `PUT /:defId/document` · `POST /:defId/publish|validate` · `DELETE /:defId` · `POST /:defId/start` · `GET /:defId/report` (секундомер отделов) · `GET /inbox` (очереди отделов; решения — в общей стопке approvals) · instances (list/:id/cancel) · steps claim/decide/reassign · credentials CRUD · вебхуки `POST /processes/webhook/:token` и `/webhook/telegram/:token` (@Public).

## Веб

Список+Журнал+Аналитика → полноэкранный канвас-редактор @xyflow/react (**flow-state = источник правды во время правки**, документ собирается при сохранении; жесты n8n: drag из палитры, провод-в-пустоту → пикер, даблклик → NDV; Ctrl+S; авто-раскладка) → карточка инстанса (read-only канвас со статусами, лента шагов, отмена). Полотно, порты, контролы, миникарта — общий `components/canvas/FlowCanvas.tsx` + `canvas.css` (красит `.react-flow__*` через корневой `.sa-canvas`); `ProcessCanvas.tsx` держит только свои ноды, их стили (`process-canvas.css`, алиас `.pcanvas`) и правила совместимости портов; `autoLayout` — свой, не общий. Дизайн канваса — на общей системе; иконки паспортов — ключи реестра. ⚠️ Скрытая панель (`document.hidden`) — React Flow не рисует рёбра.

## Отложено

Ф5 RAG (pgvector) — решением пользователя после Ф6 · Kanban-«Доски» поверх (two-tier) · сервис-нода calendar · Halyk ePay/Email SMTP · polling-триггер Kaspi.

## Проверка

`verify-processes.cjs`.
