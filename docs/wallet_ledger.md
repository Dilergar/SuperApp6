# Кошелёк-леджер (WalletModule)

> Банк-грейд денежный реестр (НЕ банк, но корректен под будущие реальные деньги): типизированные счета, двойная запись, двухфазные переводы, обобщённый эскроу. Деньги — ТОЛЬКО синхронно в одной транзакции; на шину не кладутся никогда. НЕ в chokepoint.

## Модель

- **`Account`** — type user|issuance|escrow|fee|external; ownerType user|workspace|system; `balance`+`held` — кэш с блокировкой строки, истина в журнале; user-кошельки `allowNegative=false` (без минусов).
- **`LedgerTransfer`** — неизменяемый журнал двойной записи (kind posted|pending|post_pending|void_pending). Mint = перевод issuance→user (не «из ниоткуда») → **по валюте Σ всех счетов = 0** (сверка `reconcileCurrency`; ночной Σ=0-чек WalletCron — инкрементально по BigInt-id, полный по воскресеньям).
- **Двухфазные переводы**: заморозка = pending → post_pending/void_pending; held = Σ незакрытых pending (не мутируемое число). Партиальный unique на `pending_id WHERE kind IN (post_pending, void_pending)` + перепроверка isResolved ПОСЛЕ row-лока — двойная выплата невозможна.
- **`Currency`** — полиморфный эмитент (user|workspace|platform), одна активная на эмитента (partial unique), `scale` (целые мин. единицы: 0 у коинов, 2 у фиата). Каждый может выпускать ЛИЧНУЮ валюту; лимит эмиссии «на руках» ≤ 10 млн. **`scale` несут САМИ строки провода** (`LedgerEntryDto`, `FinCoinFeedItemDto`) — форматирование по нему.
- **Жизненный цикл личной валюты**: переименование — 1 раз в 3 месяца, действует ретроспективно · `DELETE /wallet/currency` — валюта каскадно СГОРАЕТ у ВСЕХ держателей (задачи живут дальше без награды) · `POST /wallet/burn` — сжечь можно только ЧУЖУЮ валюту со своего баланса (необратимо); свою — нельзя, только удалить целиком · `GET /wallet/currency/holders` — держатели видны только ЭМИТЕНТУ.
- **Эскроу обобщённый**: `EscrowAgreement` («Сделка»: refType task|order + refId) + `EscrowHold` (нога payer→beneficiary поверх двухфазного перевода; `payerType/beneficiaryType` — казна организации может быть стороной). `EscrowService` домен-агностичен: fund/capture/returnToHold/release; идемпотентность — статусы холдов + idempotencyKey переводов.

## Потребители эскроу

Задачи (награды: fund при создании → capture при приёмке → collect-back БЕЗ минуса при возврате → release при отмене) · Заказы магазина (мультивалюта = N ног; краудфандинг = N плательщиков на одну Сделку) · B2B (награды из казны, покупки в казну).

## Карты-реквизиты (PaymentCards)

`UserPaymentCard` — несколько с основной; номер и IBAN **шифруются** (AES-256-GCM, `apps/api/src/shared/crypto/secret-field.ts`); **БЕЗ CVV** (карта = реквизит «куда переводить», не платёжный инструмент); маска «•••• 1234»; Луна-валидация. Основную карту видят управляющие организаций сотрудника (батч `primaryCardsFor`; расшифровка PAN не расползается за сервис карт).

## B2B-кошелёк

В контексте организации (X-Workspace-Id), только owner: компанийная валюта (эмитент=workspace) + казна (воркспейс-счёт), `POST /wallet/company/pay` (казна→сотрудник), выпуск в казну, держатели.

## API (кратко)

`GET /wallet` · `GET /wallet/history` (cursor) · cards CRUD · currency CRUD + mint + holders · `POST /wallet/burn` · company/* (валюта, казна, pay, держатели).

## Правила

- Никогда не UPDATE журнала; только новые записи.
- Все точки входа денег — через LedgerService/EscrowService (свои переводы руками не писать).
- Кошелёк/магазин/финкнига организации НЕ удаляются при purge организации (журнал неизменяем, Σ=0).
- Платёжные рельсы (ввод/вывод/KYC/FX) — позже; архитектура готова.

## Проверка

`verify-wallet.cjs`, `verify-escrow.cjs`, `verify-ledger-invariants.cjs`, `verify-burn.cjs`, `verify-b2b-wallet.cjs`.
