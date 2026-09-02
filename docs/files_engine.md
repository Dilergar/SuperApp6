# core/files — движок файлов

> Хранение/загрузка/раздача файлов для ВСЕХ сервисов (модель Salesforce ContentDocumentLink). Метаданные+связи+варианты в БД, байты у сменного драйвера. Доступ к файлу наследуется от привязанной сущности.

## Модель

- **`FileObject`** — владение `ownerType user|workspace` + `ownerId` (НЕ chokepoint); kind/mime/size(BigInt)/sha256/status/visibility/scanStatus/meta.
- **`FileLink`** — полиморфная привязка refType+refId+role (файл живёт там, куда привязан; один FileObject может иметь много мест — файл в чате и на Диске ОДИН).
- **`FileVariant`** — thumb | medium | poster | text | waveform | pdf.
- **`FileQuotaUsage`** — байты на владельца (`FILE_QUOTAS`: user 15 ГБ / workspace 100 ГБ; инкременты в одной tx с complete/delete + ночная сверка).

## Драйверы байтов (`FILES_DRIVER`)

`local` (диск `FILES_LOCAL_ROOT`, шардинг `ab/cd/<uuid>`; **строго 1 инстанс API**; multipart НЕ поддерживает → реальный потолок файла на local = `apiSingleRequestMax` 200 МБ) | `s3` (AWS SDK v3, endpoint из env — SeaweedFS профиля s3 или любое S3-совместимое; таймауты соединения/сокета заданы явно — у SDK своих нет). Свой байт-стор не пишем (решение грилла).

## Загрузка — контракт Slack v2

`POST /files` (intent: профиль из `FILE_PROFILES` — avatar/listing_image/chat_attachment/voice_message/dictaphone/document/drive_file/generic/sign_subject/sign_cms/sign_stamped…; каждый несёт maxSize/whitelist MIME/visibility/makeVariants/waveform) → байты (≤25МБ multipart полем `file`; один запрос ограничен `FILE_LIMITS.apiSingleRequestMax` = 200 МБ; больше — S3 multipart по presigned-частям, части ГОЛЫМ axios без Authorization) → `POST /files/:id/complete` (status-guarded клейм, квота в той же tx, события `file.uploaded/ready`) → медиа-конвейер асинхронно.

Гигиена: blacklist исполняемых и системных расширений, magic-bytes сниф (`file-type@16` — ПИН, v17+ ESM-only), sha256 на потоке, storageKey = uuid (не ввод юзера), `Content-Disposition` + nosniff. Гард Content-Length (`files-content-length.guard.ts`) стоит ДО multer: без заголовка — 411, сверх потолка (`min(profile.maxSize, apiSingleRequestMax)` + 1 МБ) — 413, не дожидаясь приёма тела.

## Выдача

- Приватные: `GET /files/:id/download?variant=` → JSON `{url, expiresAt}`; s3 → presigned (~10 мин), local → HMAC-ссылка `GET /files/raw/:id?exp&sig` (**подпись только по query** — path переписывает алиас /api↔/api/v1; `<img>/<video>` работают без JWT; Range/206).
- Публичный класс (аватарки/лого/фото товаров): вечная ссылка `GET /public-files/:token` (неугадываемый токен, `Cache-Control: immutable`).
- Батч для лент: `buildAttachmentViews` (ссылки серверным обогащением, без N+1); `AttachmentFileView.mediumUrl` для превью.

## Медиа-конвейер (джоб `files.pipeline`, очередь media, cap 3)

Изображения — sharp (rotate → EXIF/GPS срезан; thumb 320 / medium 1024 webp) · видео — ffprobe + постер-кадр ffmpeg (`execFile` с args-массивом; нет бинарников → skip с warn) · аудио — длительность + **волна** по капабилити профиля `waveform: true` (96 RMS-бакетов в `meta.waveform`; кап ≤10 мин fail-closed). Недекодируемое медиа (.heic, битое видео) → терминал без инцидента. События: `file.variant.created`. Семафор `mediaSemaphore` (3 слота, `apps/api/src/shared/utils/semaphore.ts`) — **общий с core/voice**: аренда джоба берётся с запасом на ожидание чужих задач. Ретраи — бэкофф core/jobs; незавершённые файлы подхватывает `onApplicationBootstrap` конвейера. Антивирус — [см. ниже].

## Доступ

Владелец ∥ загрузивший ∥ public ∥ наследование от привязанной сущности через **`FilesRefRegistry.register(refType, resolver, options?)`** (`files-ref.registry.ts`):
- резолвер `{canView, canAttach, canEditContent?, onOrphaned?, blocksDeletion?}`:
  - `canEditContent?` — право ПРАВКИ содержимого от места (для core/docs); резолвер без него откатывается на canAttach;
  - `onOrphaned?` — у файла не осталось настоящих мест (только для владельцев служебных якорей);
  - `blocksDeletion?: true` — привязка ЗАПРЕЩАЕТ удаление файла (403 человеку И тихий пропуск системной уборке — правило обязано стоять в ОБОИХ путях удаления; спрашивается у ВСЕХ привязок защищающих типов, не у первых 100). Потребитель — personal_doc КЭДО;
- опции `{allowedProfiles?, anchorOnly?, scopedPlace?}`:
  - `allowedProfiles` — какие профили можно привязывать к этому refType; enforce в `linkFile`/`linkManyInTx` (приватная задача не примет публичный `listing_image`, чей вечный токен обошёл бы её приватность); `undefined` = любой;
  - `anchorOnly` — служебная связь местом не считается (core/docs пришивает `document` к черновику); не осталось настоящих мест → хук `onOrphaned` владельца якоря;
  - **`scopedPlace` — у места СВОИ правила видимости, и они СИЛЬНЕЕ общего «файл организации виден всей команде»**: есть такая связь → решает место, не владение файлом (иначе закрытая папка Диска или документ «только управляющим» ничего не значат: Стажёр, узнавший fileId, скачал бы файл организации напрямую). Объявляет потребитель (Диск, документы), список — `scopedPlaceTypes()`;
- `registerLinkObserver(key, {onLinked})` — глобальный наблюдатель привязок (зовётся в транзакции привязки, чтобы поставить свой джоб тем же коммитом; потребитель — авто-разложение на Диск). Ошибка наблюдателя привязку не роняет, но сбой ЗАПРОСА внутри чужой tx её отравит — наблюдатель не делает в tx ничего, что может упасть.

## Несущие правила

- **`linkFile` требует СВОЕГО файла** (иначе знание чужого fileId давало право прицепить его к своей сущности и получить правку). Флаг `system:true` — только для клейма записи звонка. `getOwnedReadyFiles` — предвалидация attach.
- **Методы `system*`/служебные прав НЕ проверяют** — по контракту это делает вызывающий (первое, что смотрит ревью нового потребителя): `linkSystemInTx`, `linkManyInTx`, `countLinkedInTx`, `unlinkSystem`, `unlinkAllForRef`/`unlinkAllForRefs`, `systemDeleteFile`, `ingestLocalFile` (headless-инжест), `replaceContent`, `copyFile`, `putDerivedVariant`, `buildSystemDownloadUrl(fileId, variantKind?)`, `openKeyStream`, `openRawStream`, `localPathFor`, `listLinked` («доступ гейтит вызывающий»), `getLinkedFileIds`, `listLinksOfFile`, `getUsageFor`, `sweepOrphanReady`. Проверяют права: `getMeta(viewerId, …)`, `canViewFile`, `canEditContentVia`, `unlinkAndReap(actorId, …)` и все HTTP-ручки.
- **`replaceContent`** (правка живого файла на месте — core/docs): sha256/size в одной tx с подменой ключа; scanStatus сброс + скан тут же; дельта квоты в той же tx; производные варианты умирают; документом может стать только `visibility='private'`.
- **Профили доказательств подписи `sign_subject`/`sign_cms` (`EVIDENCE_FILE_PROFILES`) не удаляет НИКТО** — вне квоты, вне реапа сирот, вне soft-delete и физической зачистки; через HTTP эти профили закрыты. `sign_stamped` (штампованная копия) доказательством НЕ является.
- Жизненный цикл `FilesCron` (`files.cron.ts`): брошенные `uploading` > 24ч (`7 * * * *`) · физическое удаление soft-deleted > 7д (`10 4 * * *`) · **сироты `ready` без настоящих мест** (`23 * * * *`, `sweepOrphanReady`, грейс 24ч, только приватные — публичные живут без FileLink) · сверка квот (`40 4 * * *`). `unlinkAndReap` реапит только когда связь реально снята. События: `file.deleted`.

## Антивирус (ClamAV, джоб `files.scan`, СВОЯ очередь scan, cap 3)

Включается `CLAMAV_HOST` (+ `CLAMAV_PORT`, по умолчанию 3310; иначе no-op, scanStatus='none'). Политика `shouldScanFile` (shared): «по умолчанию проверяем, исключения явные» — НЕ проверяются картинки/аудио/видео/обычный офис; проверяются архивы, PDF, текст, макро-офис (.docm и т.п.), всё неопознанное; статус `skipped` честный. clamd INSTREAM (TCP, сокет-таймаут 120с — аренда джоба ОБЯЗАНА быть больше); infected → блок выдачи + уведомление загрузившему; пустой ответ clamd — транзиент; метка pending ставится в транзакции постановки; висящие `pending` подхватываются на старте. `uniqueKey` джоба — `fs:<fileId>`.

## Ловушки

- FileLink каскадится за FileObject — сырые deleteMany уносят вложения из чатов/задач молча (запрещены; см. [testing_verify_suite.md](testing_verify_suite.md)).
- Файл под правкой не уезжает в полный скан на каждое автосохранение (главный тормоз до правила shouldScanFile).
- `file-type` — пин v16; multer — прямая зависимость (pnpm строгий).
- На `PUT /files/:id/content` стоит гард раннего 413 ДО multer — отказ по размеру не должен ждать приёма всего тела.
- Загрузочный оркестратор веба ставит `timeout: 0` (у axios-инстанса глобальные 10с).
- Новый refType без `scopedPlace` для сущности с собственной видимостью = дыра: файл организации виден всей команде, что бы ни говорила сущность.

## API (кратко)

`POST /files` · `PUT /files/:id/content` · `POST /files/:id/parts|complete|abort` · `GET /files/:id` · `GET /files/:id/download` · `GET /files/raw/:id` (@Public HMAC) · `GET /public-files/:token` (@Public) · `DELETE /files/:id` (soft) · `GET /files/usage` (статика ДО `:id`).

Веб-кит: `apps/web/src/lib/files-api.ts` (uploadFile), хуки `apps/web/src/lib/hooks/` (`useFileUpload` / `useFileUrl` / `useFileDisplayUrl` — кэш подписанных ссылок до истечения подписи, свой кэш ссылок не изобретать), `apps/web/src/components/files/` (FileDropzone/FileChip/FileCard/ImageLightbox/VideoPlayer/AudioPlayer/UploadProgressList/AttachmentsSection/AvatarUploadBlock, `files-ui.ts`); дев-полигон `/dev/files`.

## Проверка

`verify-files.cjs`, `verify-files-consumers.cjs`, `verify-files-scan.cjs` (EICAR; SKIP без контейнера), `verify-files-review-fixes.cjs`.
