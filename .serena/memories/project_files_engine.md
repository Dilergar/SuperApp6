# Files Engine (core/files) — 6-й платформенный движок + потребители

ДВИЖОК BUILT 2026-07-04 (verify-files 47/0). ПОТРЕБИТЕЛИ подключены волной 2026-07-05 (verify-files-consumers ALL PASS: Ф1 11 + Ф2 15 + Ф3 12 + Ф4 8; регрессии messenger/shop/tasks зелёные; браузер ок).

## Решения движка (грилл + 2 раунда ресёрча)
- **Свой байт-стор НЕ пишем**: Salesforce на Hyperforce хранит в commodity AWS S3. Строим свой ДВИЖОК (модель Salesforce ContentDocument/Version/DocumentLink) + драйверный байт-стор.
- **MinIO CE МЁРТВ** (репо заархивирован 25.04.2026). Прод self-host = **SeaweedFS** (Apache 2.0, docker-compose профиль `s3`, chrislusf/seaweedfs:4.37). Код только под S3-протокол (AWS SDK v3, endpoint из env).
- **2 драйвера**: `local` (диск, шардинг ab/cd/<uuid>, dev-дефолт) | `s3`. Приватная выдача: presigned GET (s3) / HMAC-ссылка `GET /files/raw/:id?variant&exp&sig` (local; подпись ТОЛЬКО по query — path переписывает алиас /api↔/api/v1). Публичный класс: вечная `GET /public-files/:token` (immutable, ?variant=thumb).
- Загрузка Slack v2: POST /files → байты (≤25МБ API / >25МБ S3 multipart голым axios) → POST /files/:id/complete.
- Доступ: владелец ∥ загрузивший ∥ public ∥ наследование через **FilesRefRegistry** (register(refType,{canView,canAttach}) в onModuleInit). Tuple-проекции НЕТ, тип file НЕ в ACCESS_SCHEMA (родитель = источник истины).

## Схема (migration 20260704165344_files_engine)
FileObject (ownerType user|workspace+ownerId явное владение; profile, kind, name, mime, size BigInt, sha256, status, visibility, publicToken @unique, scanStatus, storageDriver, storageKey, uploadId, meta Json, error) · FileLink (fileId,refType,refId,role,createdById; @@unique 4-полей) · FileVariant (fileId+kind unique) · FileQuotaUsage (ownerType+ownerId unique).

## Файлы движка
- api core/files/: files.module (@Global, фабрика 'FILES_STORAGE_DRIVER'), files.service, files.controller, public-files.controller, files-pipeline.service (sharp thumb320/medium1024 webp + EXIF-strip; ffmpeg постер), files.cron (stale/purge/quota-reconcile/variant-retry + **scan-retry**), files-url.service (HMAC от JWT_SECRET), files-ref.registry, **files-scan.hook (ClamAV INSTREAM)**, files-content-length.guard, files-http.util, storage/ (interface+local+s3).
- **Новые методы движка (для потребителей)**: `linkManyInTx(tx,...)` (линковка в чужой транзакции — сущность ещё не закоммичена), `listLinked(refType,refIds[],role)` (батч-чтение без N+1), `getOwnedReadyFiles(userId,fileIds)` (предвалидация ready+uploader).
- shared: types/file, validation/file, constants/files (FILE_PROFILES avatar/listing_image/chat_attachment/voice_message/document/generic; FILE_QUOTAS; FILE_LIMITS).
- web: lib/files-api (uploadFile), hooks useFileUpload + useFileUrl (useFileDisplayUrl + **useFileMeta**), components/files/ (FileDropzone, FileChip, FileCard, ImageLightbox, VideoPlayer, AudioPlayer, UploadProgressList, **AvatarUploadBlock**, **AttachmentsSection**), app/dev/files полигон.

## Потребители (волна 2026-07-05)
- **Ф1 аватарки+лого** (web-only, API не менялся): AvatarUploadBlock в /profile/form (аватар user) и /workspaces/:id/profile/anketa (лого, ownerWorkspaceId). Аватар едет в ~20 DTO → PersonChip/PersonAvatar (publicUrl обычный URL). Старые внешние URL работают.
- **Ф2 мессенджер вложения** (тип 'attachment'): payload {kind:'attachments',files[]}, ПОДПИСЬ В content (К-1 — правки/упоминания/поиск как text). sendAttachmentMessage + persistAndFanout (linkManyInTx refType='chat_message' в транзакции). Резолвер chat_message (canView=chat.view, canAttach=автор+chat.post). deleteMessage: снять связи + осиротевшие файлы автора softDelete (Telegram, К-5). editMessage разрешён для attachment (правит caption). Поиск-калитка ['text','attachment']. Веб: FileAttachmentModal + AttachmentContent (фото/видео сеткой→lightbox/VideoPlayer, доки FileChip, аудио AudioPlayer), кнопка 📎(файлы) отдельно от 🏷️(rich-card); handleSendAttachments БЕЗ temp-пузыря (реконсиляция temp по content — ловушка). Conversation переиспользуется на детальке задачи — прокинуто в ОБА page.tsx.
- **Ф3 фото лотов** (профиль listing_image, публичный): GET/POST/DELETE /shop/listings/:id/images, резолвер listing (canView=showcase.view/manage, canAttach=showcase.manage), обложка=coverUrl (первое фото, thumb, батч listLinked) в ListingCard/rich-card imageUrl/Order.listingCoverUrl (живые без снапшота). Веб ListingPhotosSection в форме (режим редактирования). Лимит SHOP_LIMITS.maxListingImages=10.
- **Ф4 вложения задач**: GET/POST/DELETE /tasks/:id/attachments + createTaskSchema.attachmentFileIds (линковка linkManyInTx в createTask транзакции). Резолвер task (view/attach=создатель∥участник; canView зеркалит assertCanView). Веб AttachmentsSection (переиспольз.) в детальке + дропзона в TaskCreateModal (незакреплённые чистятся deleteFile при отмене — committedRef).
- **Ф5 ClamAV**: FilesScanHook реальный (enabled=CLAMAV_HOST задан, иначе no-op none). Контейнер clamav docker-compose профиль `scan` (CLAMD_CONF_StreamMaxLength 200M). Скан clamd INSTREAM TCP (zINSTREAM + 4-байт BE-префикс чанков + нулевой терминатор). file.ready→enqueue→pending→clean|infected. infected → блок выдачи (files.service 327/362/390 scanStatus) + notify files.scan.infected. Крон scan-retry pending>10мин (НЕ 'none' — pre-ClamAV файлы не ретраим). NOTIFICATION_REGISTRY + NotificationType 'files.scan.infected'.

## Ревью-хардненинг (2026-07-05, verify-files-review-fixes.cjs 5 секций ALL PASS)
Ревью из 8 finder-агентов → верификация → фиксы. Центральная тема — **жизненный цикл файла после загрузки** (утечки квоты + потеря данных):
- **Уборка сирот централизована в движке** (была размазана по потребителям с дрейфом): `unlinkFile` теперь возвращает bool; `unlinkAndReap(actor,file,refType,refId,role)` — снять связь и soft-delete файла, если снялась ПОСЛЕДНЯЯ (реап только когда связь реально снята → чужой/непривязанный fileId больше НЕ убивает непричастный файл; системный `systemSoftDelete` без owner-check → удаляющий ≠ загрузивший больше не роняет уборку `.catch`); `unlinkAllForRef(s)(refType,refIds,role?)` при удалении сущности. Потребители: tasks.removeAttachment/shop.removeListingImage → unlinkAndReap; deleteTask/deleteListing → unlinkAllForRef; messenger.deleteMessage → unlinkAllForRef; deleteGroup/deleteTaskChat/deleteOrderChat/deleteEventChat → reapChatAttachments (полиморфный FileLink НЕ каскадится с cascade-delete сообщений).
- **Крон `sweepOrphanReady`** (FilesCron @Cron('23 * * * *'), FILE_LIMITS.orphanReadyGraceHours=24) — safety net: приватные zero-link ready старше грейса → soft-delete (окна краша, забытые загрузки, модалка-cap). Публичные НЕ трогает (аватар/лого/фото живут ССЫЛКОЙ).
- **Аватар/лого = ССЫЛКА, не FileLink** → `FilesService.reapReplacedPublicFile(ownerType,ownerId,oldUrl,newUrl)` в users.updateProfile + workspaces.updateWorkspace: старый publicToken из URL → soft-delete прежнего (тот же URL = no-op; внешние URL без токена = no-op). Инжект FilesService в UsersService/WorkspacesService (FilesModule @Global, цикла нет).
- **complete**: перепроверяет квоту по ФАКТ-размеру (`overQuota`) — раньше только по заявленному в init (обход: size=1→залить 200МБ); режет 0-байт (иначе range 0>=0→416, неотдаваем).
- **abort**: клеймит статус updateMany ДО driver.delete (TOCTOU с complete → «ready» без байтов).
- **linkManyInTx** ре-валидирует файлы (ready+uploader+профиль) ПОД транзакцией — гонка soft-delete в окне между getOwnedReadyFiles и tx.
- **allowedProfiles** в FilesRefRegistry.register(refType,resolver,{allowedProfiles}) — движок не даёт прикрепить публичный listing_image в приватную задачу/чат (chat_message/task=приватные профили, listing=['listing_image']).
- **Конвейер**: терминальный `meta.pipeline='exhausted'` при исчерпании ретраев (было 'failed' → навсегда занимал окно retryPending take:20, новые pending голодали).
- **ClamAV**: backpressure в INSTREAM-пампе (socket.write false → stream.pause/drain, иначе 200МБ в RSS); отказ clamd/лимит попыток → терминальный `scanStatus='error'` (не блокирует выдачу, крон не пересканирует вечно). FileScanStatus += 'error'.
- **Драйвер `publicObjectUrl(key)`** вместо `driver.name==='s3'` в resolvePublic (S3_PUBLIC_BASE_URL в s3-драйвере) — третий драйвер получит редирект бесплатно.
- **Дедуп**: `targetForVariant`/`pickVariant` (3 копии резолва варианта), `serveStream` в files-http.util (2 контроллера), shared `publicVariantUrl` (5 копий `?variant=thumb`), TEAM_WORKSPACE_ROLES вместо `not:'contractor'`, web fileIcon→fileKindFromMime, AvatarUploadBlock accept=IMAGE_MIME+hasVariant, ImageLightbox тень тёплая (DESIGN.md).
- **Веб**: video без poster-варианта НЕ рендерится в `<img>` (useFileDisplayUrl opts.fallbackToOriginal=false → плейсхолдер, не тянет весь ролик); TaskCreateModal committedRef только при успехе onCreate (иначе файлы утекали при 400); FileAttachmentModal — room учитывает in-flight + удаляет сброшенные сверх лимита + уборка неотправленных при закрытии.
- **Отложено (perf/cleanup, не корректность)**: N+1 гидрация метаданных вложений чата (mitigated RQ-кэшем), дедуп context-chat-tx (риск — только что чинили cold-start 403), post-send-tail, параллельный multipart (deliberate v1), shop/page.tsx gallery→RQ (documented debt).

## Отложено отдельными движками/проектами (решения пользователя)
- **Голосовые сообщения** — запись+качество+транскрибация = отдельный «голосовой движок» (профиль voice_message + AudioPlayer готовы). Аудио-ФАЙЛЫ в чате играются уже сейчас (Ф2).
- RAG-ингест (события file.* + слот FileVariant kind='text' готовы), OnlyOffice-редактирование, кроп аватара, дедуп (sha256 уже считается), CDN.

## Гочи
- **file-type ЗАПИНЕН 16.5.4** (CJS; ≥17 ESM-only).
- **sharp 0.35 dual-package** → require('sharp') + узкий локальный интерфейс.
- **multer нужен ПРЯМОЙ зависимостью** apps/api (pnpm-изоляция).
- axios web timeout 10с → загрузки с per-request timeout:0; multipart-части голым axios без Authorization.
- ffmpeg/ffprobe-static отсутствие бинарников НЕ валит (skip+warn).
- MediaRecorder audio=video/webm → validateMagicBytes принимает AUDIO_CONTAINER_MIME.
- **FilesCron конструктор**: (db, redis, pipeline, **scanHook**, driver, **files**) — verify-files.cjs строит вручную позиционно; `files` (FilesService, для sweepOrphanReady) намеренно ПОСЛЕДНИЙ, чтобы старые 5-арг вызовы не ломались (handleOrphanReady в скрипте не зовётся). Новые зависимости крона добавлять только в хвост.
- **verify-files-consumers.cjs УБИРАЕТ за собой Ф3-витрину** (отменить заказ→удалить лот→удалить витрину) — иначе точные ассерты видимости verify-shop ловят лишнюю витрину.
- Свежезагруженный thumb появляется на следующем рендере (варианты async после complete).
