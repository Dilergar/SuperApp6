# Документооборот (DocumentsModule, B2B)

> Документы организации: заявления, приказы, справки (внутренний контур) + договоры/АВР с контрагентами (внешний контур — ЭДО). Своего кода мало: сборка .docx — core/templates, решения — core/approvals, маршрут — Процессы, подпись — core/sign, хранение — Диск, хроника — core/chatter, фон — core/jobs (своя очередь `documents`). Правило: **всё, что делает система, стоит нодой на канвасе** (номер — нода «Регистрация», подшивка — нода «Подшить в дело»).

## Модель

- **`DocType`** — ВИД документа (справочник организации): нумерация `{ГГГГ}-{NNN}` (+`DocTypeCounter` `@@unique([docTypeId, year])`, атомарный increment — два одновременных «Зарегистрировать» получают разные номера), `visibility` team|department|managers, `category` hr|general|**external**, `toPersonalFile`, `signatureLevel`, `specialDelivery`. **Архив вида — жизненный цикл справочника, а не отзыв доступа**: «новое не заводим» (каскад архива на БЛАНКИ в одной tx), уже выданное читается как читалось (`visibilityWhere` архивные виды НЕ фильтрует); архив терминален; архивировать можно, только когда в работе ничего нет.
- **`DocTemplate`** — бланк: `kind` `'docx'` (файл core/docs) | `'builder'` (блоки `builderDoc` — конструктор) + `fields` (форма подачи; kind `daterange` — период дат) + `selfService`; draft|published. **Доступность** — гранты `doc_template#requester` (человек/отдел/должность/филиал; с `subjectRelation`!), читаются `grantSetFor` одним условием; личная Группа отвергнута (шаблон живёт в организации).
- **`OrgDocument`** — карточка: status `draft→in_review→signed→registered→active` (+`sent`/`declined_external` у external), `subjectUserId` (сторона-сотрудник), `counterpartyId`/`counterpartyContactId` (сторона-контрагент), documentId/fileId/pdfFileId, `parentDocumentId` (приказ ← заявление), `registryNodeId`/`personalNodeId` (узлы Диска), `hrActionId`, `formFields` (СВОЯ форма у свободного документа; у документа по шаблону PATCH formFields → 400 — двух правд о форме не бывает), `builderDoc` (СНИМОК блоков — правка шаблона не меняет поданное). Ссылки на сущности движков — БЕЗ FK намеренно (карточка = юридическая запись).

## Несущие правила

- **Сторона документа валидируется и на create, И на PATCH** (иначе рендер печатает ИИН любого человека платформы).
- **Поля формы кладутся ПОД группы реестра и режутся по объявленной форме** (`sanitizeFields`): ключ «Организация» не подменяет реквизиты, `_*`-ключи движка процессов отбрасываются; период дат — только строго валидный объект на объявленном daterange-поле.
- **Отправка на маршрут** (`submit`) делает три вещи разом: правка закрывается (`DocsService.systemSetMode('locked')` — податель не разморозит своё заявление), снимается PDF-отпечаток, стартует маршрут по триггеру шаблона. `withdraw` — вернуть в черновик, пока НИКТО не начал решать.
- **Видимость `department`**: «коллега по отделу» — ОДНО определение (`departmentCoworkerIds` через `principalsOf` + обратная проекция), которым пользуются И реестр (одно условие `subjectUserId IN`), И карточка — список и карточка отвечают ОДИНАКОВО.
- **Папка «Документы организации» на Диске — ЗАКРЫТАЯ** (restricted); `visibility='team'` вида выдаёт грант на подпапку вида; «Личные дела» — закрытая папка: manager+ на всю, сотруднику viewer на его дело (адресация по ПРЕДЫДУЩИМ документам, не по имени папки — тёзки).
- **Подшивка — ДВА узла на ОДИН файл** (реестр вида + личное дело; байты не дублируются).
- Предмет решения в маршруте подменяется служебными ключами `_subjectRefType`/`_subjectRefId` (согласующий видит ДОКУМЕНТ, а не «запуск процесса»); санитайзер внешних стартов их отбрасывает.
- Системные пути уважают статус (`DOC_ROUTABLE_STATUSES`); отказ/возврат доезжают до документа (`systemResolve`); отмена/падение процесса гасит заявки (`cancelByOrigin`).
- **Пересборки схлопнуты**: пара стабильных ключей `docGenKey` (`doc:gen:<id>` + `:r`) вместо Date.now()-джобов — два рендера не бегут параллельно; правка во время рендера не теряется (снимок входов `contentSnapshot` + перезаказ хвостом `rerunIfStale`); карточка отдаёт `rebuilding` — веб гасит кнопки отправки и опрашивает. **Новое поле рендера — добавлять в contentSnapshot.**

## Блочный конструктор (builder)

Шаблон `kind='builder'`: BlockNote-редактор (⚠️ XL-пакеты GPL НЕ ставить), блоки paragraph/heading/списки/таблица + смарт-блоки «Реквизиты организации» (лого data:URI — только свои /public-files/), «Номер и дата», «Подпись» (роль + источник имени + М.П.), «Разрыв страницы»; **чип данных атомарен** (path в формате docx-тегов). Файл builder-документа = сам PDF (джоб `documents.generate` ветвится; Gotenberg — [templates_engine.md](templates_engine.md)). Превью: `POST /templates/:id/preview` и `POST /:documentId/preview` — **application/pdf стримом** (несохранённые блоки — override в теле). Свободный документ — `POST /free` (вид обязателен; рядовой — только себя; поля — СВОИ `formFields`, новое объявление ПЕРЕСЕИВАЕТ значения). Панель конструктора — вкладками «Данные · Форма · Блоки». Ловушки BlockNote 0.5x: `insertOrUpdateBlock` переименован в `insertOrUpdateBlockForSlashMenu`; заголовок группы слэш-меню не должен совпадать с title пункта (duplicate React key); переключатель вкладок панели — `flex: 0 0 auto` (в flex-колонке с прокруткой иначе сжимается до ~5px); DnD из палитры = drop → ближайший `[data-id]` → `insertBlocks after`; автосейв — дебаунс 1.2с + дожим на unmount.

## Внешний контур (ЭДО, category=external)

Документ с КОНТРАГЕНТОМ (шаблон/конструктор/загруженный готовый PDF+DOCX — `POST /upload`; PDF = отпечаток сразу, DOCX оживляется в core/docs). Маршрутов Процессов у external НЕТ (v1).

- **Номер ДО отправки** (`assign-number` — тот же атомарный счётчик; отправка без номера — предупреждение, не блок).
- **`send-external`** `{counterpartyContactId, internalSignerUserIds (≥1), expiresAt? (дефолт 30 дней), sendSms?}`: статус-клейм draft|rejected→sent + `locked` + заявка core/sign (`suppressOutcomeNotify` + **акт-ожидание гостя** — держит заявку открытой до подписи второй стороны) + автоссылка share-links на `sign_request` + SMS best-effort (`SmsOutboundService`). Повторная отправка = НОВАЯ заявка с новой заморозкой. Модалка привязывает контрагента ПРИ ВЫБОРЕ (не первой строкой отправки — иначе send упирался в собственный джоб пересборки).
- Хуки реестра двигают статусы: `onActFinished` (все подписали → signed; отказ гостя → `declined_external`; сверка БИН/ИИН сертификата гостя с карточкой контрагента — `checkGuestCert`), `onRequestExpired` (авто-истечение → draft). `revoke-external` (отзыв: cancelRequest + ссылка гаснет + разморозка) · `return-to-draft` (после отказа).
- **Штампованная копия** (джоб `sign.stamp`) подшивается в реестр Диска (`DOCUMENTS_FILE_JOB` ждёт готовности ретраями с фолбэком на отпечаток); гость скачивает штамп и экспортный ZIP по своей ссылке.
- DTO карточки несёт блок `external` (заявка, ссылка+счётчик открытий, акты сторон, `guestAct.matchesContact`, stamped) и `can.*` — кнопки рисуются по `can`, который считает СЕРВЕР.

## Ноды маршрута (`process-document-nodes.ts`, surfaces documents.hr|general)

`trigger.document` (связь «шаблон → маршрут» в `ProcessTrigger.config.templateId`; **два опубликованных маршрута на шаблон → error**) · `doc.generate` (приказ из заявления; дальше предметом становится приказ) · `doc.register` (номер) · `doc.file` (подшивка). Кнопка «Маршрут» в конструкторе заводит процесс с готовой схемой; повторное нажатие ОТКРЫВАЕТ существующий (ищется по конфигу триггера, включая черновики).

## Кампании ознакомления (`doc-campaigns`)

`DocCampaign`/`DocCampaignTarget` — аудитория человек/должность/отдел/филиал/вся организация (потолок 5000, честный отказ; материализация пачками джобом); `fixMode` **click** (вечный след: acknowledgedAt+sha256) | **sms** (акты ПЭП на ОДНОЙ заявке sign с одной заморозкой: `neverExpires`+`noInitialActs`+`systemEnsureActs`; `sms_failed` — исход руками менеджера); `mode` one_off (завершается сам — общий `maybeCompleteOneOff`) | standing (ДОГОНЯЕТ принятых позже: ежедневный крон + «Догнать сейчас» джобом). Задания — источник стопки `hr_campaign`; повторный клик идемпотентен РАНЬШЕ проверки статуса; кампания — только по ИЗДАННЫМ документам (не черновикам); уволенный снимается с незакрытых заданий (`InboxSource.releaseUser`). ⚠️ База пути СВОЯ (`/doc-campaigns`), не `documents/campaigns` (catch-all съел бы слово).

## API (кратко)

doc-types CRUD · templates CRUD + publish + grants · `GET /available-templates` · `GET /` (реестр: вид/статус/сотрудник/category/counterpartyId/период/поиск; фильтр по человеку — ВИДИМЫЙ чип) · `POST /` · `POST /upload` · `GET/PATCH /:documentId` · submit/withdraw/cancel/pdf · external: assign-number/send-external/revoke-external/return-to-draft/external/sms · `POST /free` · превью · дев-полигон `documents/dev/*` (development). ⚠️ Статические пути ДО `:documentId`.

## Веб

`/workspaces/[id]/documents` — одна страница с вкладками (Реестр · С контрагентами · Мои документы · Шаблоны и Виды у Менеджер+); «Создать» (Свободный | Загрузить готовый) + «Подать заявление» (шаблон → форма); карточка `[documentId]` (кнопки по `can`, ExternalStageBlock, SendToCounterpartyModal, «Присвоить номер», «В чат», хроника); конструктор `templates/[templateId]` (панель «Что подставить» — клик копирует тег в буфер; вставка Action_Paste отвергнута — буфер работает при любой сборке редактора).

## Проверка

`verify-documents.cjs`, `verify-edo.cjs`, `verify-doc-builder.cjs`, `verify-hr-campaigns.cjs`.
