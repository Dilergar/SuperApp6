# core/docs — движок офисных документов (WOPI-хост)

> Работа с офисными документами БЕЗ потери верности формата: файл всегда в родном формате, редактор — внешний WOPI-клиент (**своя обезличенная сборка Collabora Online** из исходников, `infra/docs-editor/`; сменная деталь — контракт WOPI при замене не меняется). Права перерешиваются на КАЖДОМ запросе редактора — отзыв мгновенный. Инертен без `DOCS_EDITOR_URL`.

## Несущее решение модели

**Живой черновик МУТИРУЕТ исходный `FileObject` на месте** (модель Google Drive: стабильный id, ревизии отдельными блобами). Id вложения не меняется → чат/задача/Диск отдают актуальное содержимое сами. Цена мутации закрыта в `FilesService.replaceContent` (sha/size/квота/скан в одной tx; производные умирают). Перевешивание FileLink на новый файл не годится (снимок вложения в payload сообщения + реап осиротевшего файла).

## Модель

- **`Document`** — `fileId @unique` (живой черновик); ownerType/ownerId от файла; **владелец документа = владелец ФАЙЛА** (`file.uploaderId`), не тот, кто нажал «Редактировать»; `mode` edit|readonly|**locked** (заморозка внешней системой — не снимает даже владелец; используют Документооборот/подпись); `editorBaseUrl` (липкий узел из env-белого списка); `tokenEpoch` (рубильник токенов); lastVersionNo/lastSavedAt/lastEditorId.
- **`DocumentVersion`** — вехи-снимки (pending→ready|skipped|failed; отдельный FileObject; `reason` session_end|manual|pre_sign; `signed` не удаляется никогда). Ретеншн — **бюджет места** (`historyBudgetBytes` 200 МБ, минимум 2, максимум 10 версий), не «N копий».
- **`DocumentSession`** — ОДНА блокировка на документ (в COOL все соредакторы за одним брокером; партиальный unique руками).

## Права — `resolveMode(userId, doc, ctx?)`

Архив/удалён → нет доступа; `readonly` → потолок view всем, кроме владельца; `locked` → view всем; гранты движка (тип `document` в core/access: owner/editor/viewer; работают и на Группу); иначе наследование ОТ МЕСТА — **несущая асимметрия**: ПРАВКА считается только по привязке, через которую человек пришёл (`ctx.refType/refId` из кнопки), ПРОСМОТР — объединением по всем привязкам. Право правки от места — предикат `canEditContent?` в FileRefResolver потребителя.

## WOPI-хост (`/api/wopi/files/:id`, @Public + @SkipThrottle)

CheckFileInfo (`BaseFileName` ОБЯЗАН нести расширение — по нему выбирается Writer/Calc/Impress; `PostMessageOrigin` обязателен) · GetFile (заражённый режется) · PutFile (тело — БАЙТЫ: `wopi-raw-body.middleware` потоком на диск ДО body-parser + `req._body=true`; потолок — абсолютный `hardMaxSize`, точный лимит считает replaceContent; **подпись токена проверяется ДО чтения тела**) · Lock/Unlock/RefreshLock/UnlockAndRelock/GetLock. Несовпадение блокировки → 409 + `X-WOPI-Lock`; внеполосное изменение → 409 + `{"COOLStatusCode": 1010}` (LastModifiedTime двигает ТОЛЬКО сохранение содержимого); протухший токен на RefreshLock → **401 один раз** (403 загоняет COOL в бесконечный цикл ретраев).

**Токены — свои подписанные** (`v1.<payload>.<hmac>`, DOCS_TOKEN_SECRET; привязка «пользователь+документ+режим+место», TTL 10ч, гасятся бампом tokenEpoch; `authorizeWopi` перерешивает resolveMode на КАЖДОМ запросе). Уходят **form POST'ом в iframe** (не в URL — история/Referer). **Режим НЕ в WOPISrc** (разные WOPISrc = два брокера на один файл = потерянные правки).

## Вехи и производные

Вехи режутся **на Unlock, не на PutFile** (заголовки `X-COOL-WOPI-Is*` — подсказки): pending-строка + джоб `docs.milestone` в транзакции закрытия сессии; совпал sha — `skipped`. Три ремня закрытия сессии: Unlock → IsExitSave → крон-жнец */5. Ленивая конвертация `docs.rendition|text`: PDF-отпечаток + текст (`FileVariant kind='pdf'|'text'`) по требованию с контентным ключом; производные умирают вместе с правкой.

## Правила и ловушки

- Оживление файла в документ — ЯВНЫЙ акт человека (`POST /docs/from-file`, идемпотентно; право: правка через место ИЛИ владение файлом) + запись в хронику места (раздача права правки не тихая).
- Потолок на ОТКРЫТИЕ (не на скачивание): ≤40 МБ молча, 40–70 с предупреждением, >70 отказ.
- Сеть: `WOPISrc` резолвится ИЗНУТРИ контейнера, iframe грузит браузер — в dev это РАЗНЫЕ адреса → `DOCS_WOPI_PUBLIC_URL` (пропуск = «WOPI::CheckFileInfo failed»). Адрес редактора — только env-белый список (SSRF).
- Dev-контейнер: `--o:ssl.enable=false` + `--o:ssl.termination=false` ОБА явно (иначе discovery раздаёт https-адреса в http-порт).
- ⚠️ После КАЖДОЙ пересборки образа — сброс Redis-кэша `docs:discovery:*` (`build.ps1 -FlushDiscovery`): хэш сборки в адресе, кэш час, протухший уводит iframe в 404 без ошибок на сервере.
- Обезличивание — свой `branding.js` в оверлее сборки.
- `Document.mime` — канонический (клиенты шлют octet-stream; у снимка вехи профиль ИСХОДНИКА).
- Возврат вехи: текущее содержимое уходит в историю ПЕРЕД подменой; под открытым редактором → 409 (веб гасит редактор и переоткрывает).
- ⚠️ В ответе `POST /docs/:id/open` поле `accessTokenTtl` — **МЕТКА ВРЕМЕНИ истечения, не длительность** (так его трактует WOPI-клиент; перепутать = мгновенно протухший пропуск).
- Хвост жизни: файл потерял ВСЕ настоящие места → `onOrphaned` → документ закрывается сам, байты/квота возвращаются.

## API (кратко)

`GET /docs/status` · `POST /docs/from-file` · `GET /docs/:id?refType=&refId=` · `PATCH /docs/:id` (title/mode; владелец) · `DELETE /docs/:id` (архив) · `POST /docs/:id/open` (form POST в iframe; refreshAt — молчаливый перепост свежего токена) · `GET|POST /docs/:id/versions` + `restore` (место передавать обязательно тому, чьё право от места) · `POST /docs/:id/rendition` · `DocsService.systemSetMode` (правка закрывается системно — подателя нельзя пускать размораживать своё заявление).

Веб: `/docs/[id]` (dynamic ssr:false; мост postMessage `Host_PostmessageReady`); кнопка «Редактировать» — в `FileChip` при `docPlace={refType, refId}`.

## Проверка

`verify-docs.cjs` (на СВОЕЙ сборке редактора).
