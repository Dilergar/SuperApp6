'use client';

// ============================================================
// Счета: управление (создание, корректировка остатка) — раздел «Счета».
// Вынесено из page.tsx при переходе на сайдбар-разделы.
// ============================================================

import { useMemo, useState } from 'react';
import type { FinAccountDto } from '@superapp/shared';
import { api } from '@/lib/api';
import { bookParams, currencySymbol, formatMoney, parseMoneyInput, parseSignedMoneyInput } from './finance-lib';

export const CURRENCIES = ['KZT', 'USD', 'EUR', 'RUB'];
export const SUBTYPES: Array<{ value: string; label: string }> = [
  { value: 'cash', label: 'Наличные' },
  { value: 'card', label: 'Карта' },
  { value: 'savings', label: 'Депозит' },
  { value: 'other', label: 'Другое' },
];

export function AccountsPanel({
  accounts,
  onChanged,
  bookId,
  canEdit,
  onOpenFeed,
}: {
  accounts: FinAccountDto[];
  onChanged: () => void;
  bookId: string | null;
  canEdit: boolean;
  /** «операции →» у счёта: открыть Ленту с фильтром по нему. */
  onOpenFeed?: (accountId: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [balanceFor, setBalanceFor] = useState<string | null>(null);

  const totals = useMemo(() => {
    const byCur = new Map<string, number>();
    for (const a of accounts.filter((x) => x.kind === 'asset')) {
      byCur.set(a.currencyCode, (byCur.get(a.currencyCode) ?? 0) + a.balance);
    }
    return [...byCur.entries()];
  }, [accounts]);

  return (
    <div className="card" style={{ transform: 'rotate(-0.4deg)' }}>
      <div className="flex items-center justify-between" style={{ marginBottom: 'var(--spacing-4)' }}>
        <h2 className="title-md">Счета</h2>
        {canEdit && (
          <button className="btn-secondary" style={{ padding: '0.25rem 0.8rem', fontSize: '0.75rem' }} onClick={() => setAdding((v) => !v)}>
            {adding ? 'Скрыть' : '+ Счёт'}
          </button>
        )}
      </div>

      {totals.length > 0 && (
        <div className="label-sm" style={{ marginBottom: 'var(--spacing-4)' }}>
          Всего:{' '}
          <span style={{ fontWeight: 700, color: 'var(--on-surface)' }}>
            {totals.map(([code, sum]) => formatMoney(sum, code)).join(' · ')}
          </span>
        </div>
      )}

      {adding && canEdit && <NewAccountForm bookId={bookId} onDone={() => { setAdding(false); onChanged(); }} />}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)' }}>
        {accounts.map((a) => (
          <div
            key={a.id}
            style={{
              background: 'var(--surface-container-lowest)',
              borderRadius: 'var(--radius-sketch)',
              padding: 'var(--spacing-3) var(--spacing-4)',
              boxShadow: '0 3px 14px rgba(56,57,45,0.05)',
            }}
          >
            <div className="flex items-center justify-between">
              <span style={{ fontWeight: 600 }}>
                <span style={{ marginRight: '0.45rem' }}>{a.icon ?? '💼'}</span>
                {a.name}
              </span>
              <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: a.balance < 0 ? 'var(--danger)' : 'var(--on-surface)' }}>
                {formatMoney(a.balance, a.currencyCode)}
              </span>
            </div>
            <div className="flex items-center justify-between" style={{ marginTop: '0.2rem' }}>
              <span className="label-sm">{SUBTYPES.find((s) => s.value === a.subtype)?.label ?? a.subtype}</span>
              <span className="flex items-center" style={{ gap: 'var(--spacing-3)' }}>
                {onOpenFeed && (
                  <button
                    className="label-sm"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--secondary)' }}
                    onClick={() => onOpenFeed(a.id)}
                  >
                    операции →
                  </button>
                )}
                {canEdit && a.kind === 'asset' && (
                  <button
                    className="label-sm"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--secondary)' }}
                    onClick={() => setBalanceFor(balanceFor === a.id ? null : a.id)}
                  >
                    остаток…
                  </button>
                )}
              </span>
            </div>
            {balanceFor === a.id && canEdit && (
              <SetBalanceForm
                account={a}
                bookId={bookId}
                onDone={() => {
                  setBalanceFor(null);
                  onChanged();
                }}
              />
            )}
          </div>
        ))}
        {accounts.length === 0 && <p className="label-md">Счетов пока нет — добавьте первый.</p>}
      </div>
    </div>
  );
}

function NewAccountForm({ bookId, onDone }: { bookId: string | null; onDone: () => void }) {
  const [name, setName] = useState('');
  const [subtype, setSubtype] = useState('card');
  const [currency, setCurrency] = useState('KZT');
  const [opening, setOpening] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim() || busy) return;
    const openingMinor = opening.trim() ? parseMoneyInput(opening) : null;
    setBusy(true);
    try {
      await api.post('/finance/accounts', {
        name: name.trim(),
        subtype,
        currencyCode: currency,
        ...(openingMinor ? { openingBalance: openingMinor } : {}),
      }, bookParams(bookId));
      onDone();
    } catch (e) {
      alert((e as { response?: { data?: { message?: string } } }).response?.data?.message ?? 'Не удалось создать счёт');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wash-secondary" style={{ padding: 'var(--spacing-4)', marginBottom: 'var(--spacing-4)' }}>
      <input className="input-sketch" placeholder="Название (Kaspi Gold…)" value={name} onChange={(e) => setName(e.target.value)} />
      <div className="grid grid-cols-2" style={{ gap: 'var(--spacing-3)', marginTop: 'var(--spacing-3)' }}>
        <select className="input-sketch" value={subtype} onChange={(e) => setSubtype(e.target.value)}>
          {SUBTYPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <select className="input-sketch" value={currency} onChange={(e) => setCurrency(e.target.value)}>
          {CURRENCIES.map((c) => <option key={c} value={c}>{c} {currencySymbol(c)}</option>)}
        </select>
      </div>
      <input
        className="input-sketch"
        placeholder="Сейчас на счёте (необязательно)"
        inputMode="decimal"
        value={opening}
        onChange={(e) => setOpening(e.target.value)}
        style={{ marginTop: 'var(--spacing-3)' }}
      />
      <button className="btn-primary" style={{ marginTop: 'var(--spacing-4)', padding: '0.45rem 1.4rem', fontSize: '0.85rem' }} onClick={submit} disabled={busy}>
        Создать
      </button>
    </div>
  );
}

function SetBalanceForm({ account, bookId, onDone }: { account: FinAccountDto; bookId: string | null; onDone: () => void }) {
  const [value, setValue] = useState(String(account.balance / 100));
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const minor = parseSignedMoneyInput(value);
    if (minor === null || busy) return;
    setBusy(true);
    try {
      await api.post(`/finance/accounts/${account.id}/set-balance`, { balance: minor }, bookParams(bookId));
      onDone();
    } catch (e) {
      alert((e as { response?: { data?: { message?: string } } }).response?.data?.message ?? 'Не удалось изменить остаток');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center" style={{ gap: 'var(--spacing-2)', marginTop: 'var(--spacing-2)' }} onClick={(e) => e.stopPropagation()}>
      <input className="input-sketch" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} style={{ fontSize: '0.85rem' }} />
      <button className="btn-secondary" style={{ padding: '0.25rem 0.8rem', fontSize: '0.75rem' }} onClick={submit} disabled={busy}>
        OK
      </button>
    </div>
  );
}
