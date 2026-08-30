# core/files — движок файлов

> Хранение/загрузка/раздача файлов для ВСЕХ сервисов (модель Salesforce ContentDocumentLink). Метаданные+связи+варианты в БД, байты у сменного драйвера. Доступ к файлу наследуется от привязанной сущности.

## Модель

- **`FileObject`** — владение `ownerType user|workspace` + `ownerId` (НЕ chokepoint); kind/mime/size(BigInt)/sha256/status/visibility/scanStatus/meta.
- **`FileLink`** — полиморфная привязка refType+refId+role (файл живёт там, куда привязан; один FileObject может иметь много мест — файл в чате и на Диске ОДИН).
- **`FileVariant`** — thumb | medium | poster | text | waveform | pdf.
- **`FileQuotaUsage`** — байты на владельца (`FILE_QUOTAS`: user 15 ГБ / workspace 100 ГБ; инкременты в одной tx с complete/delete + ночная сверка).

## Драйверы байтов (`FILES_DRIVER`)

`local` (диск, шардинг `ab/cd/<uuid>`; **строго 1 инстанс API**) | `s3` (AWS SDK v3, endpoint из env — SeaweedFS профиля s3 или любое S3-совместимое). Свой байт-стор не пишем (решение грилла). У S3-клиента заданы таймауты соединения/сокета (у SDK своих нет).

## Загрузка — контракт Slack v2

`POST /files` (intent: профиль из `FILE_PROFILES` — avatar/listing_image/chat_attachment/voice_message/dictaphone/document/drive_file/generic…; каждый несёт maxSize/whitelist MIME/visibility/makeVariants/waveform) → байты (≤25МБ multipart полем `file`; один запрос ограничен `FILE_LIMITS.apiSingleRequestMax` = 200 МБ; больше — S3 multipart по presigned-частям, части ГОЛЫМ axios без Authorization) → `POST /files/:id/complete` (status-guarded клейм, квота в той же tx, события `file.uploaded/ready`) → медиа-конвейер асинхронно.

Гигиена: blacklist исполняемых и системных расширений, magic-bytes сниф (`file-type@16` — ПИН, v17+ ESM-only), sha256 на потоке, storageKey = uuid (не ввод юзера), `Content-Disposition` + nosniff.

## Выдача

- Приватные: `GET /files/:id/download?variant=` → JSON `{url, expiresAt}`; s3 → presigned (~10 мин), local → HMAC-ссылка `GET /files/raw/:id?exp&sig` (**подпись только по query** — path переписывает алиас /api↔/api/v1; `<img>/<video>` работают без JWT; Range/206).
- Публичный класс (аватарки/лого/фото товаров): вечная ссылка `GET /public-files/:token` (неугадываемый токен, `Cache-Control: immutable`).
- Батч для лент: `buildAttachmentViews` (ссылки серверным обогащением, без N+1); `AttachmentFileView.mediumUrl` для превью.

## Медиа-конвейер (джоб `files.pipeline`, очередь media, cap 3)

Изображения — sharp (rotate → EXIF/GPS срезан; thumb 320 / medium 1024 webp) · видео — ffprobe + постер-кадр ffmpeg (`execFile` с args-массивом; нет бинарников → skip с warn) · аудио — длительность + **волна** по капабилити профиля `waveform: true` (96 RMS-бакетов в `meta.waveform`; кап ≤10 мин fail-closed). Недекодируемое медиа (.heic, битое видео) → терминал без инцидента. Семафор 3 слота только вокруг CPU-шага. Антивирус — [см. ниже].

## Доступ

Владелец ∥ загрузивший ∥ public ∥ наследование от привязанной сущности через **`FilesRefRegistry.register(refType, {canView, canAttach, canEditContent?, anchorOnly?, onOrphaned?, blocksDeletion?})`**:
- `canEditContent?` — право ПРАВКИ содержимого от места (для core/docs); резолвер без него откатывается на canAttach;
- `anchorOnly` — служебная связь местом не считается; не осталось настоящих мест → хук `onOrphaned` владельца якоря;
- `blocksDeletion: true` — привязка ЗАПРЕЩАЕТ удаление файла (403 человеку И тихий пропуск системной уборке — правило обязано стоять в ОБОИХ путях удаления; спрашивается у ВСЕХ привязок защищающих типов, не у первых 100). Потребитель — personal_doc КЭДО;
- `registerLinkObserver(key, {onLinked})` — глобальный наблюдатель привязок (зовётся в транзакции привязки; потребитель — авто-разложение на Диск).

## Несущие правила

- **`linkFile` требует СВОЕГО файла** (иначе знание чужого fileId давало право прицепить его к своей сущности и получить правку). Флаг `system:true` — только для клейма записи звонка.
- **Методы `system*` прав НЕ проверяют** — по контракту это делает вызывающий: `linkSystemInTx`, `systemDeleteFile`, `ingestLocalFile` (headless-инжест), `replaceContent`, `buildSystemDownloadUrl(fileId, variantKind?)`, `copyFile`, `getUsageFor`, `countLinkedInTx`, `linkManyInTx`. Первое, что смотрит ревью нового потребителя.
- **`replaceContent`** (правка живого файла на месте — core/docs): sha256/size в одной tx с подменой ключа; scanStatus сброс + скан тут же; дельта квоты в той же tx; производные варианты умирают; документом может стать только `visibility='private'`.
- **Профили доказательств подписи `sign_subject`/`sign_cms` (`EVIDENCE_FILE_PROFILES`) не удаляет НИКТО** — вне квоты, вне реапа сирот, вне soft-delete и физической зачистки; через HTTP эти профили закрыты.
- Жизненный цикл `FilesCron`: брошенные uploading>24ч; физическое удаление soft-deleted>7д; сверка квот; ретрай конвейера.

## Антивирус (ClamAV, джоб `files.scan`, СВОЯ очередь scan)

Включается `CLAMAV_HOST` (иначе no-op scanStatus='none'). Политика `shouldScanFile` (shared): «по умолчанию проверяем, исключения явные» — НЕ проверяются картинки/аудио/видео/обычный офис; проверяются архивы, PDF, текст, макро-офис (.docm и т.п.), всё неопознанное; статус `skipped` честный. clamd INSTREAM (TCP); infected → блок выдачи + уведомление загрузившему; пустой ответ clamd — транзиент; метка pending ставится в транзакции постановки.

## Ловушки

- FileLink каскадится за FileObject — сырые deleteMany уносят вложения из чатов/задач молча (запрещены; см. testing_verify_suite.md).
- Файл под правкой не уезжает в полный скан на каждое автосохранение (главный тормоз до правила shouldScanFile).
- `file-type` — пин v16; multer — прямая зависимость (pnpm строгий).
- На `PUT /files/:id/content` стоит гард раннего 413 ДО multer — отказ по размеру не должен ждать приёма всего тела.
- Загрузочный оркестратор веба ставит `timeout: 0` (у axios-инстанса глобальные 10с).

## API (кратко)

`POST /files` · `PUT /files/:id/content` · `POST /files/:id/parts|complete|abort` · `GET /files/:id` · `GET /files/:id/download` · `GET /files/raw/:id` (@Public HMAC) · `GET /public-files/:token` (@Public) · `DELETE /files/:id` (soft) · `GET /files/usage`.

Веб-кит: `lib/files-api.ts` (uploadFile), `useFileUpload` / `useFileUrl` / `useFileDisplayUrl` (кэш подписанных ссылок до истечения подписи — свой кэш ссылок не изобретать), `components/files/` (FileDropzone/FileChip/FileCard/ImageLightbox/VideoPlayer/AudioPlayer/UploadProgressList); дев-полигон `/dev/files`.

## Проверка

`verify-files.cjs`, `verify-files-consumers.cjs`, `verify-files-scan.cjs` (EICAR; SKIP без контейнера), `verify-files-review-fixes.cjs`.
