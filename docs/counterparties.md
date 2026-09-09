# Контрагенты (CounterpartiesModule, B2B)

> ЕДИНЫЙ справочник внешних сторон организации (внешняя организация/ИП/физлицо БЕЗ аккаунта). Читают: Документооборот (ЭДО); дальше — Счета, Финансы B2B, ЭСФ, CRM. Свой список никто не заводит.

## Модель

- **`Counterparty`** — kind legal|entrepreneur|individual; **БИН/ИИН с контрольной суммой** + партиальный уникум среди живых (`counterparties_workspace_bin_live`; дубль → 409); вид = орг-формы РК (полное юрнаименование собирается из вида); адреса юр+факт (факт пусто = юр — так и в тегах шаблонов); налоговый режим; НДС-свидетельство; телефон/e-mail; основание подписи списком (номер полем + дата календарём; **на проводе — структура, печатную строку собирает сервер**, см. ниже). **Архив ОБРАТИМ** (`POST /:id/restore` перепроверяет потолок и занятость БИН среди живых → 409); документы `in_review|sent` блокируют архив.
- **`CounterpartyContact`** — контактные лица (SMS-канал + сверка личности подписанта ПЭП/ЭЦП). DELETE = архив (на контакт ссылаются документы без FK — имя обязано читаться в истории).
- **`CounterpartyBankAccount`** — счета с основным (первый — сам; set-primary; удаление основного передаёт роль старейшему).

## Основание подписи: структура и на проводе, и в базе

Печатная строка шапки договора («Приказа № 12-к от 15.01.2026») НЕ хранится: одна и та же
карточка печатается в бумагах РАЗНОГО языка, и застывшая фраза была бы верна ровно для одной.
Поэтому:

- в базе — колонки `sign_basis_kind | number | date | text` (у контрагента и у юрлица одинаково);
- на вход едет та же СТРУКТУРА `{ kind, number?, date?, text? }` (`signBasisInputSchema`);
- фраза собирается НА ВЫХОДЕ одной функцией `composeSignBasis` (`@superapp/shared`): на экране —
  в языке зрителя (`signBasis` в DTO), внутри документа — в языке БЛАНКА (группа полей
  `Counterparty.Ground` / `Organization.Ground`);
- фраза берётся из каталога ЦЕЛИКОМ (`counterparties.signBasisFull.*`), а не склеивается из
  кусков: порядок слов принадлежит языку — по-казахски дата стоит ПЕРЕД названием документа.

## Гейт — РОЛЬЮ (не core/access)

Чтение — команда (trainee+, Подрядчик изолирован); запись — Менеджер+. В core/access тип НЕ заведён намеренно (прецедент Staff). Валидации (`isValidIinOrBin`, IBAN, БИК — shared) — и на POST, и на PATCH.

## Интеграции

- Группа полей шаблонов «Контрагент» (~17–19 полей, fail-closed по организации) — [templates_engine.md](templates_engine.md).
- Поиск-провайдер core/search; хроника `counterparty.*`; rich-card `counterparty` («В чат», без действий); тип `counterparty` в EntitySelector веба.
- Сервисный API потребителям: `assertUsable(workspaceId, id)` / `assertContactUsable(counterpartyId, contactId)` / `litesFor(ids)` / `contactRefsFor(ids)` (батчи DTO).

## API (кратко)

`GET /workspaces/:workspaceId/counterparties/lookup?bin=` (дедуп в форме; статический ДО `:counterpartyId`) · `GET /` (CursorPage, keyset по имени; search/kind/archived — queryBoolean) · `POST /` · `GET/PATCH/DELETE /:counterpartyId` (DELETE = архив) · `POST /:id/restore` · contacts CRUD · accounts CRUD + set-primary.

## Веб

`/workspaces/[id]/counterparties`: список (поиск имя/БИН; «+ Контрагент» у manager+) + карточка `?open=<id>` с вкладками Реквизиты (контакты и счета на ней же) · Хроника; «Документы · N» → реестр с фильтром `?counterparty=`; фильтр «Вид» списка = ТОТ ЖЕ список орг-форм (`counterpartyFormQuery`); чип «В архиве» + возврат; валидация БИН до отправки.

## Проверка

`verify-counterparties.cjs`, `verify-edo.cjs`.
