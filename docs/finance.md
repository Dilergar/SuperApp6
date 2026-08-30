# Финансы (FinancesModule, B2C)

> Управленческая учётная книга: РЕДАКТИРУЕМАЯ bookkeeping-книга со структурой двойной записи (модель Firefly III/QuickBooks: «всё — счёт», операция = пара from→to) — записи о ВНЕШНИХ деньгах. Строго отделена от кошелька-леджера коинов (тот immutable; здесь правки с soft-delete + `FinAuditLog`). Дизайн — Serena `project_finance_module_design`.

## Модель

- **`FinBook`** — одна на владельца (ownerType user|workspace — B2B-ready), лениво, владение навсегда.
- **`FinAccount.kind`**: asset (Наличные/Карта)| liability (долги) | expense/income (=КАТЕГОРИИ, дерево 2 ур.) | equity («Начальный остаток», скрыт).
- **Операции**: расход asset→expense · доход income→asset · перевод asset→asset · обмен (amount+amountTo, без курсов) · рассрочка-покупка liability→expense ПОЛНОЙ суммой в месяц покупки · кредит liability→asset (received<total → разница = «Проценты по кредитам») · платёж asset→liability (секция «Платежи по долгам», НЕ расход). Валюта на счёт (ISO, дефолт KZT), суммы BigInt в тиынах; отчёты/лимиты раздельно по валютам.
- **«На кого/от кого»** — человек из окружения (`personUserId`+снимок имени; человек НЕ узнаёт) + список «Близкие» (`FinPerson`) + отчёт по людям.
- **План-факт**: `FinBudget` (лимит/категория/месяц; родитель считает детей; уведомления 80%/100%).
- **Долги**: рассрочка/кредит (monthly×months=total, dueDay), «Оплачено» в 1 тап (кэп остатком, авто-закрытие), напоминание в день платежа.
- **Повторы**: `FinRecurringRule` (autoRecord | напоминание + «Записать сейчас»); FinancesCron (клейм сдвигом nextRunAt).
- **Шеринг**: вся книга целиком через core/access тип `finbook` (viewer ⊂ editor — правит ВСЁ, автор виден чипом); принципалы user + circle (живой); только владелец управляет. Разрыв связи → СИНХРОННЫЙ отзыв грантов из Contacts (+шина и ночной свип — ремни 2 и 3).
- **Чат**: rich cards `fin_transaction`/`fin_month` — модель-СНИМОК (payload фиксируется при шаринге, Splitwise-стиль); quick action «finance.add-expense».
- **Коины**: вкладка-лента = read-only проекция wallet-леджера с контекстом (дип-линки; refType эскроу → task/order; НЕ шерится). `scale` валюты несут строки провода.
- **Календарь**: слой `finance` (платежи по долгам + повторы; сводка Payday View). **Процессы**: нода `finance.record` (книга организации; категория по имени лениво) + событие `finance.transaction.created` (триггер «при расходе > X»).

## API (кратко)

`GET /finance?bookId=` (лениво создаёт+сид) · accounts CRUD + set-balance · categories CRUD (2 уровня; с историей → архив) · transactions CRUD (фильтры, cursor; правки в аудит) · `PUT /budgets` · reports month/trend/people · people CRUD · debts (+pay) · recurring (+record-now) · shares CRUD + shared-with-me · `GET /finance/coins`.

## Веб

`/finance` на сайдбар-каркасе: контекст книги `?book=` + переключатель книг; разделы: Обзор · Лента (ввод + чипы-фильтр) · Отчёты · Коины · Счета · Категории (карточка-бенто на категорию) · Люди · Долги · Повторы.

## Не в v1

Импорт выписки Kaspi (следующая killer-фича, первый потребитель импорт-движка) · «мне должны» · FX-пересчёт · поиск-провайдер.

## Проверка

`verify-finance.cjs`.
