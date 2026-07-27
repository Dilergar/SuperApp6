'use client';

// ============================================================
// Счета: управление (создание, корректировка остатка) — раздел «Счета».
// Вынесено из page.tsx при переходе на сайдбар-разделы.
// ============================================================

import { useMemo, useState } from 'react';
import type { FinAccountDto } from '@superapp/shared';
import { api, apiErrorMessage } from '@/lib/api';
import {
  Alert, BentoGrid, Button, Card, CardHeader, EmptyState, IconButton, Input, Modal, Select, StatTile,
} from '@/components/ui';
import { bookParams, currencySymbol, parseMoneyInput, parseSignedMoneyInput } from './finance-lib';
import { FinList, FinRow, Money, MoneyStack } from './finance-ui';

export const CURRENCIES = ['KZT', 'USD', 'EUR', 'RUB'];
export const SUBTYPES: Array<{ value: string; label: string }> = [
  { value: 'cash', label: 'Наличные' },
  { value: 'card', label: 'Карта' },
  { value: 'savings', label: 'Депозит' },
  { value: 'other', label: 'Другое' },
];

/** Иконка кита по типу счёта — интерфейсный фолбэк, когда человек не выбрал эмодзи. */
const SUBTYPE_ICON: Record<string, 'coins' | 'card' | 'savings' | 'database' | 'debt' | 'shop'> = {
  cash: 'coins',
  card: 'card',
  savings: 'savings',
  other: 'database',
  installment: 'shop',
  loan: 'debt',
};

/**
 * Подпись типа счёта. Долговые подтипы заводит раздел «Долги», в списке выбора
 * их нет — но в подписи они нужны, иначе в интерфейс утекает `installment`.
 */
const SUBTYPE_LABEL: Record<string, string> = {
  ...Object.fromEntries(SUBTYPES.map((s) => [s.value, s.label])),
  installment: 'Рассрочка',
  loan: 'Кредит',
};

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
  const [balanceFor, setBalanceFor] = useState<FinAccountDto | null>(null);

  const totals = useMemo(() => {
    const byCur = new Map<string, number>();
    for (const a of accounts.filter((x) => x.kind === 'asset')) {
      byCur.set(a.currencyCode, (byCur.get(a.currencyCode) ?? 0) + a.balance);
    }
    return [...byCur.entries()].map(([currencyCode, amount]) => ({ currencyCode, amount }));
  }, [accounts]);

  const assets = accounts.filter((a) => a.kind === 'asset');
  const liabilities = accounts.filter((a) => a.kind === 'liability');

  const row = (a: FinAccountDto) => (
    <FinRow
      key={a.id}
      glyph={a.icon ?? SUBTYPE_ICON[a.subtype ?? 'other'] ?? 'card'}
      glyphTone={a.kind === 'liability' ? 'danger' : 'accent'}
      title={a.name}
      subtitle={SUBTYPE_LABEL[a.subtype ?? ''] ?? a.subtype}
      actions={
        <>
          {onOpenFeed && (
            <IconButton icon="receipt" label={`Операции: ${a.name}`} size={28} onClick={() => onOpenFeed(a.id)} />
          )}
          {canEdit && a.kind === 'asset' && (
            <IconButton icon="scales" label={`Изменить остаток: ${a.name}`} size={28} onClick={() => setBalanceFor(a)} />
          )}
        </>
      }
      right={<Money minor={a.balance} code={a.currencyCode} tone={a.balance < 0 ? 'danger' : undefined} size="1rem" />}
    />
  );

  return (
    <>
      <BentoGrid>
        <StatTile
          span={6}
          label="На счетах"
          value={<MoneyStack sums={totals} />}
          icon="savings"
          tone="accent"
        />
        <StatTile
          span={6}
          label="Счетов"
          value={accounts.length}
          icon="card"
          tone="neutral"
        />

        <Card span={liabilities.length > 0 ? 7 : 12}>
          <CardHeader
            title="Счета"
            subtitle="Наличные, карты, депозиты — то, чем вы платите"
            actions={
              canEdit ? (
                <Button variant="primary" tone="success" size="sm" icon="add" onClick={() => setAdding(true)}>
                  Счёт
                </Button>
              ) : undefined
            }
          />
          {assets.length > 0 ? (
            <FinList>{assets.map(row)}</FinList>
          ) : (
            <EmptyState
              icon="card"
              title="Счетов пока нет"
              description="Добавьте первый — и можно записывать траты."
              action={canEdit ? <Button variant="primary" tone="success" icon="add" onClick={() => setAdding(true)}>Добавить счёт</Button> : undefined}
            />
          )}
        </Card>

        {liabilities.length > 0 && (
          <Card span={5}>
            <CardHeader title="Долговые счета" subtitle="Рассрочки и кредиты — раздел «Долги»" />
            <FinList>{liabilities.map(row)}</FinList>
          </Card>
        )}
      </BentoGrid>

      {adding && canEdit && (
        <NewAccountModal bookId={bookId} onClose={() => setAdding(false)} onDone={() => { setAdding(false); onChanged(); }} />
      )}
      {balanceFor && canEdit && (
        <SetBalanceModal
          account={balanceFor}
          bookId={bookId}
          onClose={() => setBalanceFor(null)}
          onDone={() => { setBalanceFor(null); onChanged(); }}
        />
      )}
    </>
  );
}

function NewAccountModal({ bookId, onClose, onDone }: { bookId: string | null; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [subtype, setSubtype] = useState('card');
  const [currency, setCurrency] = useState('KZT');
  const [opening, setOpening] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim() || busy) { setError('Укажите название счёта'); return; }
    const openingMinor = opening.trim() ? parseMoneyInput(opening) : null;
    setBusy(true);
    setError(null);
    try {
      await api.post('/finance/accounts', {
        name: name.trim(),
        subtype,
        currencyCode: currency,
        ...(openingMinor ? { openingBalance: openingMinor } : {}),
      }, bookParams(bookId));
      onDone();
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Новый счёт"
      subtitle="Остаток можно указать сразу — он запишется корректировкой"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Отмена</Button>
          <Button variant="primary" tone="success" icon="add" onClick={submit} loading={busy}>Создать</Button>
        </>
      }
    >
      <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        {error && <Alert tone="danger" onClose={() => setError(null)}>{error}</Alert>}
        <Input label="Название" placeholder="Kaspi Gold…" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <Select
          label="Тип"
          value={subtype}
          onChange={setSubtype}
          options={SUBTYPES.map((s) => ({ value: s.value, label: s.label, icon: SUBTYPE_ICON[s.value] }))}
        />
        <Select
          label="Валюта"
          value={currency}
          onChange={setCurrency}
          options={CURRENCIES.map((c) => ({ value: c, label: c, hint: currencySymbol(c) }))}
        />
        <Input
          label="Сейчас на счёте"
          hint="Не обязательно — можно задать позже"
          inputMode="decimal"
          placeholder="0"
          value={opening}
          onChange={(e) => setOpening(e.target.value)}
        />
      </div>
    </Modal>
  );
}

function SetBalanceModal({
  account,
  bookId,
  onClose,
  onDone,
}: {
  account: FinAccountDto;
  bookId: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [value, setValue] = useState(String(account.balance / 100));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const minor = parseSignedMoneyInput(value);
    if (minor === null || busy) { setError('Укажите сумму'); return; }
    setBusy(true);
    setError(null);
    try {
      await api.post(`/finance/accounts/${account.id}/set-balance`, { balance: minor }, bookParams(bookId));
      onDone();
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Остаток: ${account.name}`}
      subtitle="Разница уйдёт корректировкой — история операций не переписывается"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Отмена</Button>
          <Button variant="primary" tone="success" icon="save" onClick={submit} loading={busy}>Сохранить</Button>
        </>
      }
    >
      <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        {error && <Alert tone="danger" onClose={() => setError(null)}>{error}</Alert>}
        <Input
          label={`Сейчас на счёте · ${currencySymbol(account.currencyCode)}`}
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
        />
      </div>
    </Modal>
  );
}
