// ============================================================
// WALLET — constants (limits, currency / ledger / escrow enums)
// ============================================================

import type {
  IssuerType,
  CurrencyType,
  CurrencyStatus,
  LedgerEntryType,
  EscrowStatus,
} from '../types/wallet';

export const ISSUER_TYPES: readonly IssuerType[] = ['user', 'workspace'];
export const CURRENCY_TYPES: readonly CurrencyType[] = ['CUSTOM_COIN'];
export const CURRENCY_STATUSES: readonly CurrencyStatus[] = ['active', 'deleted'];
export const LEDGER_ENTRY_TYPES: readonly LedgerEntryType[] = [
  'mint',
  'transfer',
  'reversal',
  'burn',
  'currency_deleted',
];
export const ESCROW_STATUSES: readonly EscrowStatus[] = ['active', 'captured', 'released'];

export const WALLET_LIMITS = {
  /** Hard emission ceiling: own coins "in hand" (available + held) may not exceed this. */
  maxInHand: 10_000_000,
  /** Per-transaction sanity bound (mint / burn / reward) — never above the emission cap. */
  maxTxnAmount: 10_000_000,
  maxCurrencyNameLength: 40,
  /** Max length of the icon string (emoji can be a multi-codepoint ZWJ sequence). */
  maxIconLength: 16,
  /** A currency may be renamed at most once per this many days (retroactive change). */
  renameCooldownDays: 90,
  historyPageSize: 30,
} as const;

export const LEDGER_ENTRY_LABELS: Record<LedgerEntryType, string> = {
  mint: 'Выпуск',
  transfer: 'Перевод',
  reversal: 'Возврат',
  burn: 'Сжигание',
  currency_deleted: 'Валюта удалена',
};
