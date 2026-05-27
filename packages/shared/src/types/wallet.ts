// ============================================================
// WALLET — types
// ============================================================
// Each user issues ONE personal currency (a workspace issues a company currency in a later
// phase — hence the polymorphic issuer). Balances are DERIVED from an immutable ledger.
// Amounts are integers (no fractional coins): represented as `number` in DTOs (safe — capped
// well under 2^53) and stored as BigInt in the DB.

export type IssuerType = 'user' | 'workspace';
export type CurrencyType = 'CUSTOM_COIN'; // future: 'KZT' | 'USD' …
export type CurrencyStatus = 'active' | 'deleted';

/**
 * Ledger entry kinds. mint = self-emission; transfer = task payout (the two legs share a
 * transferId); reversal = undo of a transfer; burn = holder destroys foreign coins;
 * currency_deleted = zeroing entry written when an issuer deletes the currency.
 */
export type LedgerEntryType = 'mint' | 'transfer' | 'reversal' | 'burn' | 'currency_deleted';

export type EscrowStatus = 'active' | 'captured' | 'released';

/** A currency as seen by clients. */
export interface Currency {
  id: string;
  issuerType: IssuerType;
  issuerId: string;
  name: string;
  icon: string;
  currencyType: CurrencyType;
  status: CurrencyStatus;
  /** True when the viewer is the issuer (controls mint / rename / delete / holders view). */
  isOwner: boolean;
  /** When the issuer may rename again (ISO); null if eligible now / never renamed. */
  renameAvailableAt: string | null;
  createdAt: string;
}

/** One line of a user's multi-currency wallet. */
export interface WalletEntry {
  currencyId: string;
  name: string;
  icon: string;
  issuerId: string;
  issuerName: string;
  /** Ledger sum. MAY be negative after a post-payout reversal of already-burned coins. */
  balance: number;
  /** Frozen in active escrows — only meaningful for one's own currency. */
  held: number;
  /** balance − held. */
  available: number;
  /** True when this is the viewer's own issued currency. */
  isOwn: boolean;
}

/** A ledger line for the transaction-history view. */
export interface LedgerEntryDto {
  id: string; // bigint serialized as a string for the client
  currencyId: string;
  entryType: LedgerEntryType;
  /** Signed amount from the viewer's perspective (+ received / − sent). */
  amount: number;
  taskId: string | null;
  transferId: string | null;
  memo: string | null;
  createdAt: string;
}

/** A holder of the viewer's currency ("cap table" — visible to the issuer only). */
export interface CurrencyHolder {
  userId: string;
  name: string;
  avatar: string | null;
  balance: number;
}

export interface CreateCurrencyRequest {
  name: string;
  icon: string;
}

export interface UpdateCurrencyRequest {
  name?: string;
  icon?: string;
}

export interface MintRequest {
  amount: number;
}

export interface BurnRequest {
  currencyId: string;
  amount: number;
}
