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
  /** Значок: имя иконки каталога или кодпоинты эмодзи с пометкой набора
   *  ('ph:car', 'fl:1f469-200d-1f4bb') — самые длинные связки не влезали в 16. */
  maxIconLength: 64,
  maxNoteLength: 500,
  /** Per-transaction bound in minor units (= 10 млрд ₸ in tiyn) — sanity cap, not a business rule. */
  maxAmount: 1_000_000_000_000,
  transactionsPageSize: 50,
  /** «Близкие» — the curated quick-pick list inside Финансы. */
  maxPeople: 100,
} as const;

// Засев книги пишет ИМЕНА в базу: человек их потом переименовывает, значит слово
// обязано родиться на его языке. Поэтому здесь — ключи каталога, а слово даёт
// `I18nService` в момент создания книги (язык запроса).

/** Seed asset accounts for a fresh book (PRD: базовые кошельки при старте). */
export const FIN_SEED_ACCOUNTS: ReadonlyArray<{ nameKey: string; subtype: FinAssetSubtype; icon: string }> = [
  { nameKey: 'finance.seed.cash', subtype: 'cash', icon: '💵' },
  { nameKey: 'finance.seed.card', subtype: 'card', icon: '💳' },
];

/** Hidden equity peg every book gets — the counter-account of an opening balance. */
export const FIN_SEED_EQUITY_KEY = 'finance.seed.openingBalance';

export interface FinSeedCategory {
  nameKey: string;
  icon: string;
  children?: ReadonlyArray<{ nameKey: string; icon: string }>;
}

/** Seed category tree (expense) — Kaspi-familiar names, editable afterwards. */
export const FIN_SEED_EXPENSE_CATEGORIES: readonly FinSeedCategory[] = [
  {
    nameKey: 'finance.seed.food',
    icon: '🍽️',
    children: [
      { nameKey: 'finance.seed.groceries', icon: '🛒' },
      { nameKey: 'finance.seed.cafes', icon: '☕' },
      { nameKey: 'finance.seed.delivery', icon: '🛵' },
    ],
  },
  { nameKey: 'finance.seed.transport', icon: '🚌' },
  {
    nameKey: 'finance.seed.home',
    icon: '🏠',
    children: [
      { nameKey: 'finance.seed.rent', icon: '🔑' },
      { nameKey: 'finance.seed.utilities', icon: '💡' },
    ],
  },
  { nameKey: 'finance.seed.communication', icon: '📱' },
  { nameKey: 'finance.seed.health', icon: '💊' },
  { nameKey: 'finance.seed.clothing', icon: '👕' },
  { nameKey: 'finance.seed.entertainment', icon: '🎬' },
  { nameKey: 'finance.seed.education', icon: '📚' },
  { nameKey: 'finance.seed.gifts', icon: '🎁' },
  { nameKey: 'finance.seed.other', icon: '📦' },
];

/** Seed category list (income). */
export const FIN_SEED_INCOME_CATEGORIES: readonly FinSeedCategory[] = [
  { nameKey: 'finance.seed.salary', icon: '💼' },
  { nameKey: 'finance.seed.sideJob', icon: '🧰' },
  { nameKey: 'finance.seed.gifts', icon: '🎁' },
  { nameKey: 'finance.seed.other', icon: '📦' },
];
