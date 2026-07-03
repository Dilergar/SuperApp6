// ============================================================
// ФИНАНСЫ — types (B2C managerial accounting book)
// Editable bookkeeping with a double-entry STRUCTURE (Firefly III
// model: "everything is an account", every transaction moves value
// from one account to another). NOT the immutable wallet ledger.
// ============================================================

/** Account kinds. asset/liability = real money sides; expense/income = categories (tree); equity = opening balances (system). */
export type FinAccountKind = 'asset' | 'liability' | 'expense' | 'income' | 'equity';

export type FinAssetSubtype = 'cash' | 'card' | 'savings' | 'other';

/** Debt flavours: installment = покупка в рассрочку (expense at purchase), loan = кредит деньгами (money to an asset). */
export type FinDebtSubtype = 'installment' | 'loan';

/** Where a transaction row came from (manual entry is the default; the rest are automation). */
export type FinTransactionSource = 'manual' | 'recurring' | 'process' | 'service' | 'import';

/** Derived from the from→to account-kind pair; never stored, always recomputed. */
export type FinTransactionType =
  | 'expense' // asset|liability → expense
  | 'income' // income → asset
  | 'transfer' // asset → asset (cross-currency = обмен, amountTo)
  | 'debt_payment' // asset → liability (погашение долга)
  | 'debt_draw' // liability → asset (кредит деньгами)
  | 'opening'; // equity ↔ asset (начальный остаток)

export type FinBookRole = 'owner' | 'editor' | 'viewer';

export interface FinAccountDto {
  id: string;
  kind: FinAccountKind;
  subtype: string | null;
  parentId: string | null;
  name: string;
  icon: string | null;
  currencyCode: string;
  archived: boolean;
  isSystem: boolean;
  sortOrder: number;
  /** Signed balance in minor units (asset: positive normal; liability: negative = remaining debt). Categories/equity → 0 in overview. */
  balance: number;
  // Debt passport (kind = liability only)
  debtTotal?: number | null;
  debtMonthly?: number | null;
  debtMonths?: number | null;
  debtDueDay?: number | null;
}

export interface FinTransactionDto {
  id: string;
  bookId: string;
  type: FinTransactionType;
  fromAccountId: string;
  toAccountId: string;
  /** Minor units in `currencyCode` (the money-side currency). */
  amount: number;
  /** Only for cross-currency money→money moves: amount in the destination account currency. */
  amountTo: number | null;
  currencyCode: string;
  /** Date-only, YYYY-MM-DD (no timezone drama for day-level bookkeeping). */
  occurredOn: string;
  note: string | null;
  /** «На кого / от кого» — link to a person from Circle (analytics dimension; the person never knows). */
  personUserId: string | null;
  personName: string | null;
  createdById: string;
  /** Имя автора записи (заполняется в списке — для общих книг «кто внёс»). */
  createdByName?: string | null;
  source: FinTransactionSource;
  createdAt: string;
  updatedAt: string;
}

export interface FinBookDto {
  id: string;
  ownerType: 'user' | 'workspace';
  ownerId: string;
  name: string;
  myRole: FinBookRole;
}

export interface FinBookOverviewDto {
  book: FinBookDto;
  /** Money accounts: asset + liability (with balances). */
  accounts: FinAccountDto[];
  /** Category accounts: expense + income (flat list; UI builds the tree by parentId). */
  categories: FinAccountDto[];
}

export interface FinListTransactionsResult {
  items: FinTransactionDto[];
  nextCursor: string | null;
}

// ---------- План-факт (Phase 2) ----------

export interface FinMoneySumDto {
  currencyCode: string;
  amount: number;
}

export interface FinCategorySpendDto {
  categoryId: string;
  currencyCode: string;
  amount: number;
}

export interface FinBudgetDto {
  id: string;
  categoryAccountId: string;
  period: string; // 'YYYY-MM'
  amount: number;
  currencyCode: string;
  /** Fact for the period: the category + its subcategories, same currency. */
  spent: number;
}

export interface FinMonthReportDto {
  period: string;
  /** As recorded (leaf-level); the UI rolls children up into parents. */
  expenseByCategory: FinCategorySpendDto[];
  incomeByCategory: FinCategorySpendDto[];
  /** Погашения долгов — отдельная секция месяца, НЕ расход (bookkeeping-honest). */
  debtPayments: FinMoneySumDto[];
  totalExpense: FinMoneySumDto[];
  totalIncome: FinMoneySumDto[];
  budgets: FinBudgetDto[];
}

export interface FinTrendPointDto {
  period: string; // 'YYYY-MM'
  expense: FinMoneySumDto[];
  income: FinMoneySumDto[];
}

// ---------- Люди (Phase 3) ----------

/** «Близкие» — the curated quick-pick list for «на кого» (names/avatars are live user data). */
export interface FinPersonDto {
  userId: string;
  name: string;
  avatar: string | null;
}

export interface FinPeopleReportRowDto {
  userId: string;
  name: string;
  avatar: string | null;
  /** Потратил «на человека» за период (по валютам). */
  spent: FinMoneySumDto[];
  /** Получил «от человека» за период (по валютам). */
  received: FinMoneySumDto[];
}

// ---------- Долги + повторы (Phase 5) ----------

/**
 * Долг «я должен» поверх liability-счёта: рассрочка-покупка (installment — расход полной
 * суммой в момент покупки) или кредит деньгами (loan — зачисление на счёт; разница
 * total−received уходит расходом в «Проценты по кредитам»).
 */
export interface FinDebtDto {
  accountId: string;
  name: string;
  icon: string | null;
  subtype: string; // installment | loan
  currencyCode: string;
  total: number;
  monthly: number;
  months: number;
  dueDay: number;
  /** Сколько осталось выплатить (minor units). */
  remaining: number;
  /** Оплачено платежей (целых, по monthly). */
  paidMonths: number;
  closedAt: string | null;
  archived: boolean;
}

// ---------- Коины: авто-лента экосистемы (Phase 7) ----------

/**
 * Read-only проекция кошелька-леджера с «финансовым лицом»: каждое реальное движение
 * коинов (награды задач, покупки в Shop, вклады, казна B2B) показывается с контекстом
 * источника и контрагентом. НИЧЕГО не хранится второй раз.
 */
export interface FinCoinFeedItemDto {
  id: string;
  direction: 'in' | 'out';
  amount: number;
  currencyName: string;
  currencyIcon: string;
  /** «Награда за задачу „Купить хлеб"», «Покупка: Букет», «Выпуск монет»… */
  title: string;
  kind: 'task' | 'order' | 'mint' | 'burn' | 'other';
  counterpartyUserId: string | null;
  counterpartyName: string | null;
  /** Дип-линк на сущность-источник. */
  href: string | null;
  createdAt: string;
}

// ---------- Шеринг книги (Phase 6) ----------

export type FinSharePrincipalType = 'user' | 'circle';
export type FinShareRole = 'viewer' | 'editor';

export interface FinShareDto {
  principalType: FinSharePrincipalType;
  principalId: string;
  role: FinShareRole;
  /** Имя человека / название Группы (для отображения). */
  name: string | null;
  avatar: string | null;
}

/** Книга, которой со мной поделились. */
export interface FinSharedBookDto {
  bookId: string;
  name: string;
  ownerUserId: string;
  ownerName: string;
  ownerAvatar: string | null;
  myRole: FinShareRole;
}

export interface FinRecurringRuleDto {
  id: string;
  title: string;
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  /** Валюта денежной ноги правила (для корректного отображения не-KZT повторов). */
  currencyCode: string;
  note: string | null;
  personUserId: string | null;
  personName: string | null;
  interval: 'monthly' | 'weekly';
  dayOfMonth: number | null;
  weekday: number | null;
  /** true → крон записывает сам; false → крон напоминает, юзер жмёт «Записать сейчас». */
  autoRecord: boolean;
  active: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
}
