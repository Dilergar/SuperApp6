# Шифрование ПДн (`core/keys/pii`)

Часть движка ключей ([keys_engine.md](keys_engine.md)): персональные данные (телефон, e-mail, ИИН, дата рождения, документы, реквизиты, контакты контрагентов, подписанты) хранятся envelope-шифротекстом под KEK владельца (человека или организации) и ищутся по слепому индексу. Прозрачно для сервисов: Prisma-расширение шифрует на записи и расшифровывает на чтении, код сервисов пишет и читает открытые поля как раньше.

## Модель

- У каждой ПДн-колонки — пара: `<field>_enc` (`sa6e:`) и, где ищут по равенству, `<field>_bi` (`sa6b:`, нормализованное значение: телефон E.164, e-mail lower-case, ИИН цифры). Реестр — `PII_MODELS` (`core/keys/pii/keys.pii.registry.ts`): `User` (phone, email, iin, dateOfBirth, residentialAddress, idDoc*), `ContactInvitation`, `WorkspaceInvitation`, `VerifyChallenge` (phone), `ShareLinkGuest` (составные уникумы), `WorkspaceBankAccount`, `CounterpartyBankAccount`, `Counterparty`, `CounterpartyContact`, `SignAct` (ИИН подписанта). Скоуп KEK колонки — из строки (`userId` / `workspaceId`) либо платформенный (челленджи регистрации до появления человека).
- **`piiExtension()`** (`shared/database/pii-extension.ts`, ставится в `DatabaseService` ДО `workspaceScope`): на всех операциях записи (включая вложенные `create/connectOrCreate` по DMMF) — dual-write открытого поля и `_enc/_bi`; на чтении — `ensureSelect` (докладывает `_enc` в `select`), расшифровка результата рекурсивно по связям, лог чувствительных чтений в `pii_access_log` (кто, какую сущность/поле, контекст запроса; слив батчем; месячные партиции, ретеншн 365 дней сбросом партиции — [keys_engine.md](keys_engine.md), «Журнал и наблюдаемость»).
- **Режим чтения `KEYS_PII_READ_MODE`**: `legacy` (по умолчанию) — читаем открытые колонки, пишем обе; `encrypted` — читаем `_enc`, `where` по ПДн-полям переписывается в `_bi` (уникальные операции — строго по `_bi`; неуникальные — гибридно `OR` с открытым полем, пока `PII_PLAINTEXT_PRESENT = true`, чтобы строки, вставленные мимо расширения (сырой SQL, старые сиды), находились). Переключение — env на один деплой; дев-полигон `POST /keys/dev/pii/mode`.
- **Backfill**: `POST /keys/dev/pii/backfill` и ежечасный крон `KeysPiiService` — строки с открытым значением и пустым `_enc/_bi` дошифровываются сырым SQL по реестру (батчи, идемпотентно).

## Дроп открытых колонок (отдельная миграция, после прода в `encrypted`)

Предусловия: `KEYS_PII_READ_MODE=encrypted` отработал ≥ 1 релиз без `pii` ошибок; `GET /keys/dev/pii/status` показывает `missing = 0` по всем колонкам реестра; сьюты `verify-keys-pii.cjs` и весь регресс зелёные в `encrypted`; бэкап БД снят. Затем: (1) `PII_PLAINTEXT_PRESENT = false` в реестре (гибридный `OR` выключается — поиск только по `_bi`); (2) миграция `ALTER TABLE … DROP COLUMN <field>` для каждой открытой колонки реестра, уникальные индексы переносятся на `_bi` (пример: `users.phone` → `users.phone_bi UNIQUE`); (3) поля в `schema.prisma` становятся вычисляемыми через расширение (DTO не меняется). До этого шага открытые колонки — источник для отката: `KEYS_PII_READ_MODE=legacy` возвращает прежнее чтение мгновенно.

## Правила для сервисов

- Писать и читать ПДн — обычными Prisma-вызовами через `DatabaseService`; **сырой SQL по ПДн-колонкам запрещён** (`$queryRaw` минует расширение: ни шифрования, ни `_bi`, ни лога). Нужен массовый поиск — `KeysEnvelopeService.blindIndexCandidates(value)` и `WHERE phone_bi IN (…)`.
- Сьют, который сеет ПДн сырым Prisma/SQL (`prisma.user.create` в скрипте), обязан после посева позвать `POST /keys/dev/pii/backfill` — иначе в `encrypted` строка не найдётся по номеру.
- Новая ПДн-колонка = миграция с `_enc` (+ `_bi` и индекс, если по ней ищут) + строка в `PII_MODELS`; нормализация значения — там же.
- Чувствительное чтение (ИИН, документы, дата рождения, адрес) логируется в `pii_access_log`; выгрузка списков с такими полями — только через сервис с бюджетом (кабинет — `platform.pii.reveal`).

## Ловушки

- **`_bi` есть только у строк, прошедших через расширение**: посев сырым SQL в `encrypted` = «пользователь не найден» при входе. Крон backfill догоняет за час, сьют — руками.
- **`workspaceScope` стоит ПОСЛЕ `piiExtension`**: порядок `$extends` несущий — иначе `where` chokepoint'а переписывался бы до перезаписи в `_bi`.
- **Составные уникумы** (`ShareLinkGuest`) в `encrypted` переписываются целиком на `_bi`-пару — без `compoundUniques` в реестре `findUnique` падает Prisma-ошибкой валидации.
- Заморозка KEK человека (`freezeScope('user:<id>')`) делает его ПДн нечитаемыми во всех сервисах сразу (`403 keys.key_unavailable`) — это ожидаемое поведение kill-switch, не баг.

## Связанные доки

[keys_engine.md](keys_engine.md) · [security.md](security.md) · [testing_verify_suite.md](testing_verify_suite.md) · [platform_console.md](platform_console.md)
