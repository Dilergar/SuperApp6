// ============================================================
// ФИНАНСЫ — constants (limits, kinds, seed chart of accounts)
// ============================================================

import type { FinAccountKind, FinAssetSubtype, FinDebtSubtype, FinTransactionSource } from '../types/finance';

export const FIN_ACCOUNT_KINDS: readonly FinAccountKind[] = ['asset', 'liability', 'expense', 'income', 'equity'];
export const FIN_ASSET_SUBTYPES: readonly FinAssetSubtype[] = ['cash', 'card', 'savings', 'other'];
export const FIN_DEBT_SUBTYPES: readonly FinDebtSubtype[] = ['installment', 'loan'];
export const FIN_TX_SOURCES: readonly FinTransactionSource[] = ['manual', 'recurring', 'process', 'service', 'import'];

export const FIN_DEFAULT_CURRENCY = 'KZT';

export const FIN_LIMITS = {
  maxAccounts: 50,
  maxCategories: 300,
  /** Category tree depth: parent → child, no grandchildren. */
  maxCategoryDepth: 2,
  maxNameLength: 60,
  maxIconLength: 16,
  maxNoteLength: 500,
  /** Per-transaction bound in minor units (= 10 млрд ₸ in tiyn) — sanity cap, not a business rule. */
  maxAmount: 1_000_000_000_000,
  transactionsPageSize: 50,
  /** «Близкие» — the curated quick-pick list inside Финансы. */
  maxPeople: 100,
} as const;

export const FIN_ASSET_SUBTYPE_LABELS: Record<FinAssetSubtype, string> = {
  cash: 'Наличные',
  card: 'Карта',
  savings: 'Депозит',
  other: 'Другое',
};

/** Seed asset accounts for a fresh book (PRD: базовые кошельки при старте). */
export const FIN_SEED_ACCOUNTS: ReadonlyArray<{ name: string; subtype: FinAssetSubtype; icon: string }> = [
  { name: 'Наличные', subtype: 'cash', icon: '💵' },
  { name: 'Карта', subtype: 'card', icon: '💳' },
];

export interface FinSeedCategory {
  name: string;
  icon: string;
  children?: ReadonlyArray<{ name: string; icon: string }>;
}

/** Seed category tree (expense) — Kaspi-familiar names, editable afterwards. */
export const FIN_SEED_EXPENSE_CATEGORIES: readonly FinSeedCategory[] = [
  {
    name: 'Еда',
    icon: '🍽️',
    children: [
      { name: 'Продукты', icon: '🛒' },
      { name: 'Кафе и рестораны', icon: '☕' },
      { name: 'Доставка', icon: '🛵' },
    ],
  },
  { name: 'Транспорт', icon: '🚌' },
  {
    name: 'Дом',
    icon: '🏠',
    children: [
      { name: 'Аренда', icon: '🔑' },
      { name: 'Коммуналка', icon: '💡' },
    ],
  },
  { name: 'Связь', icon: '📱' },
  { name: 'Здоровье', icon: '💊' },
  { name: 'Одежда', icon: '👕' },
  { name: 'Развлечения', icon: '🎬' },
  { name: 'Образование', icon: '📚' },
  { name: 'Подарки', icon: '🎁' },
  { name: 'Прочее', icon: '📦' },
];

/** Seed category list (income). */
export const FIN_SEED_INCOME_CATEGORIES: readonly FinSeedCategory[] = [
  { name: 'Зарплата', icon: '💼' },
  { name: 'Подработка', icon: '🧰' },
  { name: 'Подарки', icon: '🎁' },
  { name: 'Прочее', icon: '📦' },
];
