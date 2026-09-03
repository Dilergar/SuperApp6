# Диск — OmniDrive (DriveModule, B2C+B2B)

> Слой ИМЁН И ДЕРЕВА поверх core/files, а не второе хранилище: файл в чате и на Диске — ОДИН FileObject с двумя FileLink (байты не копируются, квота не удваивается, правка через core/docs видна везде). На Диске стоит документная вертикаль.

Код: `apps/api/src/modules/drive/`; веб — `apps/web/src/app/drive/`.

## Модель

- **`DriveSpace`** (personal|workspace, лениво) + **`DriveNode`** (folder|file|shortcut-задел; **материализованные `ancestorIds`** + depth ≤32 + sortRank 0=папка; `nameKey` NFC+lower под частичный unique «одно имя в папке»; `subtreeBytes` с СЕНТИНЕЛОМ null = «пересчитать»; `takenAtLocal`) + `DriveNodeVersion`/`DriveStar`/`DriveRecent`/`DrivePhotoBucket`.
- **Права — разделение обязанностей**: core/access ХРАНИТ прямые гранты (`drive_node#viewer|editor|manager@…`), наследование по дереву считает Диск **одним условием в SQL** (`владелец OR id = ANY(granted) OR ancestor_ids && granted`) через `grantSetFor` — второй читающий путь движка прав. `check()` для типов Диска НЕ используется (пустой EPOCH_FANOUT). Роли: viewer ⊂ editor ⊂ manager (управляет доступом). Корень диска организации — `editor@workspace#member` + `manager@workspace#manager`.
- **Строгость org-диска**: если у файла есть узел Диска, ветка «член организации видит любой её файл» ВЫКЛЮЧАЕТСЯ (`scopedPlace` — место со своими правилами сильнее; папку «Зарплаты» рядовой не откроет и по прямой ссылке).
- **Закрытая папка `DriveNode.restricted`** (модель SharePoint «stop inheriting»): доступ считается от самой глубокой закрытой папки на пути и ниже; пространственный доступ не-владельца внутрь не проходит. Системная папка объявляет закрытость сама (`DRIVE_SYSTEM_FOLDERS.personal_files.restricted`); список закрытых приезжает в `DriveGrants.restricted` — действует на ВСЕХ путях проверки прав разом. Потребитель — «Личные дела» Документооборота.
- **Файлы из переписки приезжают сами** (модель Teams): наблюдатель привязок движка → джоб `drive.ingest` в ТОЙ ЖЕ транзакции; только СВОИ загрузки; из DM — на личный диск, из сущностей организации — на её («Файлы из переписки»); voice_message/avatar/listing_image не попадают. Роутинг решает модуль-владелец: `DriveRoutingRegistry.register(refType, {resolvePlacement})`.
- **Корзина 30 дней** (вложение в чате работает всё это время; ссылки наружу ПРИОСТАНОВЛЕНЫ) → окончательное удаление гасит файл ВЕЗДЕ (`systemDeleteFile`) + отзывает share-links поддерева. Удаление навсегда в организации — manager+ (корзина — у editor).
- **Перенос между пространствами = «Копировать»** (у движка нет смены владельца; байты копирует драйвер).
- **Версии** — ретеншн по БЮДЖЕТУ места (200 МБ, 2–10); у офисных — свои вехи в core/docs. Restore: байты читаются ДО снимка + protectVersionId.
- **Лента «Фото»**: EXIF+thumbhash считает конвейер files; джоб `drive.photo.index` ведёт `takenAtLocal` и бакеты по месяцам; `GET /drive/photos` — КОЛОНОЧНЫЙ ответ (id[]/ratio[]/thumbhash[]/url[]) со ссылками, подписанными батчем.

## Несущие правила (из ревью)

- **`placeFile` проверяет право на ФАЙЛ**: свой → связь; чужой видимый → КОПИЯ на свою квоту; невидимый → 404 (дедуп «тот же файл» — в пределах ПАПКИ, не пространства).
- **`share()` валидирует ЛЮБОЙ принципал** (`assertPrincipalAllowed`): личный диск = человек из окружения и СВОЯ Группа; диск организации = её сотрудник и её оси. + `PersonalGraphRegistry.register('drive')`. Подписи получателей (`principalName`) — `AudiencesService.labelMany` ([audiences_engine.md](audiences_engine.md)); относительные виды (`grantable:false`) в шеринг не попадают.
- NULL-сентинел `subtreeBytes` не кодировать в курсор нулём (NULLS LAST + двухфазный keyset); курсор корзины — с тай-брейком по id.
- move/copy переиндексируют поиск; месяц ленты — sargable-фильтр; счётчики месяцев — по правам зрителя.
- `DriveNodeDto.shareLinks` — число активных гостевых ссылок объекта (`countActiveForRefs`): значок «доступно по ссылке наружу» в листинге.

## API (кратко)

`GET /drive` (пространство + «Доступно мне» + место) · `GET /drive/nodes?parentId&sort&cursor&foldersOnly` (queryBoolean!) · `POST /drive/folders|nodes` · `PATCH /drive/nodes/:id` · move/copy (advisory-лок пространства, цикл-чек ВНУТРИ лока; copy — в т.ч. на другой диск) · trash/restore/DELETE · shares CRUD (люди/Группы/отделы/должности/филиалы) · versions (+restore) · star/starred/recent · photos/buckets. Гостевые — [share_links_engine.md](share_links_engine.md). Байты Диск не принимает — загрузка обычным путём движка файлов, сюда приезжает готовый fileId.

## Веб

`/drive` (разделы в глобальном сайдбаре; диск организации — `/workspaces/[id]/drive` с вкладками): Мой диск (перетаскивание ПАПОК — `readEntries` В ЦИКЛЕ, иначе ровно 100 файлов; виртуализированная таблица CSS-grid+ARIA) · Фото (justified, скруббер) · Доступно мне · Избранное · Недавние · Корзина · `n/[id]` прямая ссылка.

## Проверка

`verify-drive.cjs`.
