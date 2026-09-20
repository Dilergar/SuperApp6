# core/consents — движок согласий (24-й) + учёт действий с ПДн + журнал инцидентов

> Документы платформы версиями (контент в БД, хэш-цепочка, подпись платформы), записи приёмки как ДОКАЗАТЕЛЬСТВО согласия, шлюз новой версии, учёт передач ПДн и журнал инцидентов. Правовая рамка — [legal_kz.md](legal_kz.md). В РК нет основания «исполнение договора» (ст. 9 ЗоПД): для частного оператора согласие — практически единственное законное основание, и задним числом оно не появляется.

Код: `apps/api/src/core/consents/` (`consents.service.ts` приёмка/отзыв/чтения, `consents.documents.service.ts` версии и целостность, `consents.actions.service.ts` учёт действий, `consents.incidents.service.ts`, `consents.jobs.ts`, `consents.seed.service.ts`, `consents.platform.provider.ts` команды и чтения Кабинета, `consents.controller.ts`, `consents.dev.ts`, `consents.registry.ts` хуки отзыва, `gate/` — ядро шлюза отдельным @Global-модулем). Shared: `packages/shared/src/consents/` (`registry.ts` виды, `bundles.ts` пакеты, `recipients.ts` получатели ПДн, `pd-actions.ts`, `operator.ts`), формы — `types/consents.ts`, Zod — `validation/consents.ts`. Тексты-заготовки — `apps/api/consents-texts/`. Веб — `apps/web/src/components/consents/`.

Движок обслуживает только отношения С ПЛАТФОРМОЙ. Согласие сотрудника работодателю — документ КЭДО ([hr_kedo.md](hr_kedo.md)). Документы организаций для ИХ клиентов (CRM, запись, магазин) — будущее расширение без миграции данных: у вида появится `scope: platform | workspace`, версии и приёмки уже несут всё нужное.

## Реестр (shared)

`CONSENT_KINDS`: `{ subject: user|workspace, audience: user|business_user, required, revocable, mode: opt_in|opt_out|notice, gate: block|soft|none, hasDocument, onDemand? }`.

| Вид | Кто | Режим | Шлюз | Примечание |
|---|---|---|---|---|
| `terms`, `privacy`, `cross_border` | человек | opt_in, обязательные | `block` | отзыв `privacy` = удаление аккаунта |
| `privacy_policy` | человек | `notice`, обязательный | `none` | «ознакомлен» |
| `marketing` | человек | opt_in | — | галочка № 2 регистрации, не блокирует |
| `analytics` | человек | **opt_out** | — | движок — правда, `users.analyticsOptOut` — зеркало |
| `integration_google` | человек | opt_in, `onDemand` | — | в момент подключения Google Calendar |
| `guardian` | человек | — | — | крючок детских профилей, текста нет |
| `business_terms`, `dpa` | организация | opt_in, обязательные | `soft` | принимает владелец |

Пакеты (`CONSENT_BUNDLES`): `registration` = 4 обязательных + необязательный `marketing`; `workspace_creation` = `business_terms` + `dpa`. Клик по галочке пишет ПО ЗАПИСИ НА ДОКУМЕНТ с общим `bundleKey`. `assertConsentRegistry()` — смоук на bootstrap (пакет ссылается на существующие виды, субъекты совпадают, каждый обязательный вид входит в пакет).

Получатели ПДн — `PD_RECIPIENTS` (`kazinfoteh`, `web_push` — трансгранично, базовый; `google_calendar` — по запросу; `webhook_subscriber`, `ncanode`; `email_provider` заявлен заранее, `active: false`). Новый внешний сервис = строка здесь + `record(...)` в месте передачи + новая версия `cross_border`. Реквизиты оператора: БИН/домен/почта — `CONSENT_OPERATOR`; наименование, адрес и должность ответственного лица — каталог `consents.operator.*` (слова зависят от языка).

## Модель

- **`ConsentVersion`** — версия = комплект kk+ru+en: `bodies`, `summaries` («Коротко о главном»), `changeSummary` («Что изменилось»), `hashes` (sha256 показанного текста по языкам), `manifestHash` + `prevManifestHash` (цепочка), `material`, `effectiveFrom`, `urgentReason?`, `signature`/`signatureKid`/`signedAt`, `signatureHistory`, `attestationFileId?`/`attestationSignRequestId?`. `@@unique([documentKey, version])`; частичный уникум «один черновик на документ».
- **`ConsentAcceptance`** — субъект, версия (FK Restrict), `locale` и `contentHash` ПОКАЗАННОГО текста, кто принял (`actorUserId`, `actorRole self|guardian|org_owner`, `actorBasis`), `channel`, `ipEnc`/`userAgentEnc`, `verifyChallengeId?`, `bundleKey?`, `revokedAt?`/`revokedReason?`. Частичный уникум «одна живая приёмка на (субъект, версия)» — «маркетинг вкл → выкл → вкл» даёт три строки. FK на users нет: строка переживает удаление аккаунта (ЦК ст. 41 п. 4).
- **`PdActionRecord`** — учёт действий (Правила № 179/НҚ п. 9 пп. 5): `transfer | cross_border | publication | consent_term`; `fields` — КОДЫ полей, никогда значения. Месячные партиции по `occurred_at` (`MonthlyPartitions`), ретеншн не применяется.
- **`PdIncident`** + **`PdIncidentEvent`** (append-only).
- `VerifyChallenge.context` — что человек принял ДО отправки SMS; `User.consentEpoch`.

**Неизменяемость — на уровне базы** (миграция `core_consents`): триггер `consent_versions_guard` (у не-черновика меняются только статус, подпись, заверение, отметка активации; DELETE — только черновик; **статус ходит только вперёд**: `published → superseded | withdrawn`, оба конечны, а `withdrawn` доступен лишь не вступившей версии — подпись статус не покрывает, и без лестницы одна правка колонки «оживляла» бы заменённый или отозванный текст, а отзыв вступившей существенной версии уменьшал бы G), `consent_acceptances_guard` (DELETE запрещён, UPDATE — только однократный отзыв и перешивка шифротекста), append-only у учёта действий и событий инцидентов. IP и User-Agent приёмки шифруются ПЛАТФОРМЕННЫМ ключом `core/keys`, не KEK человека: крипто-шреддинг аккаунта не должен уничтожать доказательство.

## Контракт потребителя

```ts
const out = await consents.accept(tx, { subject, actorUserId, actorRole, versionIds, locale, channel,
  bundleKey?, requireBundle?, evidence: { ip, userAgent, verifyChallengeId? }, acceptedAt?, notify? });
// …commit…
await out.afterCommit();                       // кэши шлюза — ПОСЛЕ коммита
await consents.revoke(tx, { subject, documentKey, actorUserId, reason, system? });
const all = await consents.revokeAllForSubject(tx, subject, 'account_deleted' | 'workspace_purged', actorId);
// …commit…  await all.afterCommit();      // кэши шлюза + внешние эффекты хуков отзыва
await consents.hasLive(subject, documentKey);  // основание передачи (интеграция, рассылка)
await actions.record(tx | null, { subjectId, recipient | actionType, purpose, fields?, … });
revokeRegistry.register(documentKey, { onRevoked(tx, subject, reason) });  // владелец данных гасит их в той же tx;
                                                                            // внешний эффект — ВОЗВРАЩАЕТ функцией (после коммита)
```

- **Приёмка — только в транзакции вызывающего.** Типы этого не ловят (корневой клиент совместим с транзакционным), поэтому стоит рантайм-страж `assertInTransaction`: вызов с корневым клиентом — `Error`. Принять можно действующую версию либо опубликованную на будущее; заменённую — `409 consents.versionMismatch`. Текст версии сверяется с подписью ПЕРЕД записью. Прошлая живая приёмка документа закрывается причиной `superseded`.
- Права движок не проверяет (кроме «от имени организации — только `org_owner`»): кто субъект и вправе ли актор — знает вызывающий.
- **Хук отзыва: в транзакции — только база.** Сетевой вызов (отзыв токена у Google) хук возвращает функцией — движок выполняет её в `afterCommit()` best-effort. Вызов внутри транзакции держал бы её открытой до чужого таймаута (5 секунд Prisma → откат отзыва), а при откате оставлял бы эффект снаружи без эффекта в базе.
- Эпоха человека при приёмке: G читается ДО проверки «всё ли принято» (версия, вступившая между двумя чтениями, иначе попала бы в эпоху без приёмки).
- Отзыв opt-out вида без живой приёмки записывает ОТКАЗ строкой «принято и сразу отозвано». Отзыв блокирующего документа сбрасывает `consentEpoch` в 0.
- `record(null, …)` — best-effort для мест без транзакции (канал уже отправил сообщение); с `tx` — атомарно. Партицию внутри чужой транзакции не создаём — она гарантирована заранее; поэтому `occurredAt` в транзакции всегда «сейчас».

Где пишется учёт: SMS-код (`core/verify`; у регистрации — в транзакции создания аккаунта), SMS и push уведомлений (`notifications.delivery`), служебная SMS об удалении аккаунта, синхронизация Google Calendar, доставка вебхука (субъект — организация), ссылка наружу (`share-links.create`), смена видимости карточки, приёмка и отзыв согласия.

## Публикация и целостность

Черновик (единственный на документ) → `publish`: реквизиты подставляются в текст → хэши по языкам → манифест с `prevManifestHash` → подпись платформы аудиторией `consents` над `sa6-consents-v1|<manifestHash>|<signedAt>` (момент подписи входит в подписанное) → джобы активации и уведомлений. Первая версия вступает сразу; следующие — не раньше `defaultEffectiveInDays` (10; условия для организаций — `workspaceNoticeDays`, 30). Раньше — только `urgent` с причиной ≥ 20 символов. Ещё не вступившая версия того же документа ОТЗЫВАЕТСЯ новой публикацией (статус `withdrawn`): срочная правка не ждёт плановую, и двух очередей «на будущее» у документа не бывает; отозванная версия не участвует ни в шлюзе, ни в витрине, но остаётся читаемой по id (её могли принять заранее) и сохраняет место в хэш-цепочке. «Что изменилось» обязательно у каждой версии, кроме первой.

**Чтение — fail-closed**: текст отдаётся только после пересчёта хэшей, манифеста и **архивной** проверки подписи (`KeysSigningService.verifyArchival` — [keys_engine.md](keys_engine.md)); расхождение → `503 consents.integrity`. Результат кэшируется на минуту в процессе. Компрометация ключа: `keys.signing.compromise` → `consents.versions.reattest` — текст сверяется с независимыми якорями (хэшами в записях приёмки людей), версия переподписывается, старая подпись уходит в `signatureHistory`. Необязательное заверение ЭЦП руководителя — `consents.document.attest`: PDF-отпечаток трёх языков с хэшами → заявка `core/sign` (право отправить подтверждает только команда Кабинета).

Засев: `ConsentsSeedService` заводит черновик v1 из `apps/api/consents-texts/<документ>.<язык>.md` (секции `<!-- summary -->` / `<!-- body -->`), только если у документа нет ни одной версии. development/test — v1 публикуется сразу; **production — черновик ждёт вычитки юристом и публикации из Кабинета, а до публикации обязательных документов пакета регистрация и создание организаций закрыты** (`503 consents.notPublished`). Тексты — заготовки «под вычитку юристом».

## Шлюз

Правда шлюза — ДАТЫ, а не джоб: версия действует, когда `effectiveFrom <= now`. Глобальная эпоха G = число существенных вступивших версий блокирующих документов (монотонна; считается из таблицы версий с микрокэшем 2 с — Redis может быть сброшен, джоб активации — опоздать). `users.consent_epoch` = G, до которой у человека принято всё; значение едет в кэше «аккаунт жив» рядом с `tokenEpoch` (формат `<tokenEpoch>:<consentEpoch>`, [security.md](security.md)).

- `ConsentGateGuard` (APP_GUARD после `KeyScopeGuard`): быстрый путь — сравнение двух чисел без ввода-вывода; отставший проверяется по базе (результат кэшируется коротко, чистый человек догоняет эпоху). Отказ — `403 consents.pending`. Белый список — `@SkipConsentGate()`: `/auth/*`, `/verify/*`, `/consents/*`, `GET /users/me`, `GET /users/me/deletion-blockers`, `DELETE /users/me`, `POST /analytics/collect`, выход владельца организации (см. ниже). **Вне шлюза:** `@Public`, `/platform/*` (иначе не опубликовать исправление), боты (`kind: 'bot'`). Личный ключ API — под шлюзом.
- Сокет: рукопожатие идёт тем же валидатором с `enforceConsents` — человек за блокирующим экраном сокет не открывает (уже открытые сокеты живут до разрыва).
- Несущественная версия шлюз не поднимает («пол» документа — последняя СУЩЕСТВЕННАЯ вступившая версия).
- Обязательный документ-уведомление (`privacy_policy`: `required`, `gate: none`) новой версией не блокирует, но блокирует, пока у человека нет НИ ОДНОЙ живой его приёмки: аккаунт, вернувшийся из грейса (все согласия отозваны), и аккаунт старше движка принимают весь обязательный пакет.
- **Выход из-за шлюза обязан существовать.** Не принимающий условия человек удаляет аккаунт, а единственное владение организацией удаление блокирует — поэтому вне шлюза ещё и `GET /workspaces/:id/members`, `POST /workspaces/:id/transfer`, `DELETE /workspaces/:id`; мастер `/account/delete` даёт эти действия прямо в карточке блокера (страницы организации за блокирующим экраном закрыты).
- **Мягкий шлюз организаций** — в `WorkspaceContextInterceptor`: непринятые вступившие `business_terms`/`dpa` закрывают ВЛАДЕЛЬЦУ только управленческие мутации (`gate/workspace-management.ts`: настройки, реквизиты, состав, приглашения, штат, структура, ключи, вебхуки, юрлица, политика уведомлений, тариф) → `403 consents.workspacePending`. Архив, передача владения и выход остаются. **Работа сотрудников и самого владельца в сервисах не останавливается никогда.**

## Первый запуск платформы

На чистой боевой базе круг замкнут: регистрация закрыта, пока обязательные документы не опубликованы (fail-closed) → живого аккаунта нет → владельца Кабинета нет → публиковать некому. Круг разрывается ДВУМЯ ручными шагами, и оба нужны ровно один раз:

1. `node apps/api/scripts/consents-publish-initial.cjs` — план; `--publish` — публикация. Поднимает контекст Nest (без HTTP), засевает черновики версии 1 из `apps/api/consents-texts/<документ>.<язык>.md` и публикует те документы, у которых НЕТ ни одной опубликованной версии. Печатает по документу версию, дату вступления, `manifestHash`, kid подписи и sha256 каждого языка — вывод сохраняется как экземпляр доказательства целостности. **Скрипт запирает сам себя:** есть хотя бы один живой человек — отказ («публикуйте из Кабинета»), поэтому живой документ он не тронет никогда, а новая версия всегда идёт через `consents.document.publish` с датой вступления, уведомлениями и «четырьмя глазами». Пакет, у чьего обязательного документа нет ни версии, ни черновика, роняет скрипт до публикации — платформа не запускается наполовину.
2. Обычная регистрация своего аккаунта (с галочками — основатель такой же субъект) → `node apps/api/scripts/platform-bootstrap-owner.cjs +7XXXXXXXXXX` → вход в Кабинет.

Правки юриста обязаны лежать в файлах `consents-texts/` ДО шага 1: черновик создаётся из них, и публикуется ровно то, что в них написано. После публикации единственный источник текста — база. Работающему API рестарт не нужен — микрокэш версий живёт 2 секунды. Заверение ЭЦП руководителя (`consents.document.attest`) необязательно и делается позже из Кабинета.

Скрипт ходит в базу движком, а не сырым SQL, поэтому ему нужен собранный `dist` (`npx nest build`) и он сам переходит в `apps/api`: путь корневого ключа `core/keys` по умолчанию ОТНОСИТЕЛЬНЫЙ, и запуск из корня репозитория подхватил бы другой `.keys/` — бут падает на «key versions are wrapped by another root».

## Регистрация, организация, удаление

- **Регистрация**: галочки на шаге 1, ДО SMS. `POST /verify/start` цели `register` без `consents` → `400 consents.required`, SMS не уходит; принятое кладётся в `VerifyChallenge.context`. `AuthService.register`: `dateOfBirth` обязателен, возраст ≥ 16 (иначе `403 auth.minorNotAllowed`; «сегодня» — в поясе платформы); записи приёмки строятся ИЗ КОНТЕКСТА SMS-цепочки (тело шага 3 не читается), в той же транзакции, что `verify.consume` и создание аккаунта. Без SMS-цепочки (development/test) — из тела запроса.
- **Организация**: пакет `workspace_creation` в транзакции создания. `CONSENTS_REQUIRED` (пусто = production да): вне production без поля `consents` сервер принимает действующие версии сам с основанием `dev_auto`. Окончательное удаление организации отзывает её согласия (`workspace_purged`).
- **Возраст и деньги**: `LedgerService.mint` платформенной валюты требует `funding: real_money | system`; `real_money` → `assertAdultForPayment` (`403 payments.minorNotAllowed`). Рельс не может обойти проверку — без поля чеканка падает. Дата рождения не стирается и не опускается ниже 16.
- **Удаление аккаунта** = отзыв `privacy` ([users_profile.md](users_profile.md)): блокеры → пароль → SMS `account_delete` → одна транзакция (отметка, отзыв всех согласий, учёт, уведомление) → SMS владельцу. Возврат в грейс = согласия принимаются заново.

## API

`GET /consents/bundles/:key` · `GET /consents/documents/:key` · `…/versions` · `…/v/:version` · `GET /consents/versions/:versionId` — **@Public** (любой клиент рисует одинаково, архив открыт). `GET /consents/pending` · `/state` · `/history` · `/receipt/:id` (лист согласия: 8 реквизитов ст. 8 п. 4) · `/my-data/transfers` · `POST /consents/accept` · `POST /consents/revoke`. Кабинет: `GET /platform/consents/documents|incidents`. Дев-полигон `/consents/dev/*` (только development/test).

Команды Кабинета: `consents.document.draft.save` (medium) · `consents.document.publish` (critical, dualControl, step-up, причина) · `consents.document.attest` (high) · `consents.versions.reattest` (critical, dualControl) · `pd.incident.open|notify_authority|notify_subjects|close` (critical, step-up). Панель `user.consents`. Способности `consents.read|write|approve`, `pd.incidents.read|write`.

Уведомления: `consents.newVersion` (фанаут джобом порциями), `consents.workspace.newVersion` (владелец и админы), `consents.accepted` (квитанция), `account.deletionScheduled`. Аналитика: `consents.registration.shown`, `consents.document.accepted|revoked`, `consents.gate.shown|declined`.

## Инциденты

`open` считает `notifyDeadlineAt = detectedAt + 1 рабочий день` (`addBusinessDays`: пн–пт в поясе платформы, праздники НЕ учитываются намеренно — срок выходит раньше настоящего) и ставит джоб тревоги за 4 часа до срока; тревога владельцам Кабинета уходит и при открытии. Лестница статусов строго вперёд, переходы status-guarded; клейм тревоги ставится ПОСЛЕ отправки.

## Веб

`shell.consents.*` — слова шлюза, баннера, галочек, просмотра и названия документов (шлюз живёт в каркасе поверх ЛЮБОЙ страницы, а туда доезжают только `common` и `shell`); `consents.*` — «Мои данные», лист согласия, `/legal`, мастер удаления, раздел Кабинета. **Юридический текст в каталог не кладётся никогда** — страж `check:i18n` № 13.

`ConsentGate` (в `Providers`): блокирующий экран («Что изменилось» → текст → «Принимаю» / «Не принимаю, удалить аккаунт»; кнопки «вывести средства» нет — платёжных рельсов не существует) и баннер «принять заранее»; сигнал сервера `403 consents.pending` перехватчик транспорта превращает в событие окна. `ConsentBundleField` + `useConsentBundle` — галочки пакета (ссылка в подписи не переключает галочку, документ открывается поверх формы, ошибка — строкой под галочкой). `LegalMarkdown` — свой разбор markdown в React-элементы, без `dangerouslySetInnerHTML`. Страницы: `/legal/[doc]`, `/legal/[doc]/v/[version]` (публичные), `/profile/my-data`, `/account/delete` (вне профиля: работает и за шлюзом), `/platform/consents`.

## Ловушки

- Вложенный `ServiceMessages` заменяет словарь — глобальному слою доступны только `common` и `shell`.
- Heredoc ест обратный слэш — патчи с регулярками писать файлом.
- Сьют публикует существенные версии и поднимает шлюз ВСЕМ аккаунтам базы разработки: в конце он принимает новое за suite1–3 и tester1–3; после ручной dev-публикации — `node apps/api/scripts/seed-test-accounts.cjs`.
- Подключения Google прошлой эпохи без согласия не синхронизируются, пока человек его не даст (`status.consentRequired`).

## Проверка

`node apps/api/scripts/verify-consents.cjs` (помощник сьютов — `apps/api/scripts/_consents.cjs`).
