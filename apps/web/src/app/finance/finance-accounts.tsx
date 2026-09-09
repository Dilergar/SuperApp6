'use client';

// ============================================================
// Счета: управление (создание, корректировка остатка) — раздел «Счета».
// Вынесено из page.tsx при переходе на сайдбар-разделы.
// ============================================================

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { FinAccountDto } from '@superapp/shared';
import { apiErrorMessage, apiPost } from '@/lib/api';
import {
  Alert, BentoGrid, Button, Card, CardHeader, EmptyState, GlyphField, IconButton, Input, Modal, Select, StatTile,
} from '@/components/ui';
import { bookParams, currencySymbol, parseMoneyInput, parseSignedMoneyInput } from './finance-lib';
import { FinList, FinRow, Money, MoneyStack } from './finance-ui';

export const CURRENCIES = ['KZT', 'USD', 'EUR', 'RUB'];

/** Подтипы денежного счёта. Слово даёт каталог по ЗНАЧЕНИЮ (`finance.subtype.<value>`). */
export const SUBTYPES = ['cash', 'card', 'savings', 'other'] as const;

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
 * Подпись типа счёта. Долговые подтипы (`installment`, `loan`) заводит раздел
 * «Долги»: в списке выбора их нет, но в подписи они нужны — иначе в интерфейс
 * утекает машинное имя. Своего словаря слов здесь НЕТ: ключ собирается от
 * значения, а незнакомое значение остаётся как есть.
 */
const SUBTYPE_KEYS = new Set(['cash', 'card', 'savings', 'other', 'installment', 'loan']);

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
  const t = useTranslations('finance');
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
      subtitle={a.subtype && SUBTYPE_KEYS.has(a.subtype) ? t(`subtype.${a.subtype}`) : a.subtype}
      actions={
        <>
          {onOpenFeed && (
            <IconButton
              icon="receipt"
              label={t('accounts.feedFor', { name: a.name })}
              size={28}
              onClick={() => onOpenFeed(a.id)}
            />
          )}
          {canEdit && a.kind === 'asset' && (
            <IconButton
              icon="scales"
              label={t('accounts.setBalanceFor', { name: a.name })}
              size={28}
              onClick={() => setBalanceFor(a)}
            />
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
          label={t('accounts.totalLabel')}
          value={<MoneyStack sums={totals} />}
          icon="savings"
          tone="accent"
        />
        <StatTile
          span={6}
          label={t('accounts.countLabel')}
          value={accounts.length}
          icon="card"
          tone="neutral"
        />

        <Card span={liabilities.length > 0 ? 7 : 12}>
          <CardHeader
            title={t('accounts.title')}
            subtitle={t('accounts.subtitle')}
            actions={
              canEdit ? (
                <Button variant="primary" tone="success" size="sm" icon="add" onClick={() => setAdding(true)}>
                  {t('accounts.addShort')}
                </Button>
              ) : undefined
            }
          />
          {assets.length > 0 ? (
            <FinList>{assets.map(row)}</FinList>
          ) : (
            <EmptyState
              icon="card"
              title={t('accounts.emptyTitle')}
              description={t('accounts.emptyDescription')}
              action={
                canEdit ? (
                  <Button variant="primary" tone="success" icon="add" onClick={() => setAdding(true)}>
                    {t('accounts.add')}
                  </Button>
                ) : undefined
              }
            />
          )}
        </Card>

        {liabilities.length > 0 && (
          <Card span={5}>
            <CardHeader title={t('accounts.debtTitle')} subtitle={t('accounts.debtSubtitle')} />
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
  const t = useTranslations('finance');
  const common = useTranslations('common');
  const [name, setName] = useState('');
  const [icon, setIcon] = useState<string | null>(null);
  const [subtype, setSubtype] = useState('card');
  const [currency, setCurrency] = useState('KZT');
  const [opening, setOpening] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim() || busy) { setError(t('accounts.nameRequired')); return; }
    const openingMinor = opening.trim() ? parseMoneyInput(opening) : null;
    setBusy(true);
    setError(null);
    try {
      await apiPost('/finance/accounts', {
        name: name.trim(),
        subtype,
        currencyCode: currency,
        ...(icon ? { icon } : {}),
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
      title={t('accounts.newTitle')}
      subtitle={t('accounts.newSubtitle')}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{common('actions.cancel')}</Button>
          <Button variant="primary" tone="success" icon="add" onClick={submit} loading={busy}>
            {common('actions.create')}
          </Button>
        </>
      }
    >
      <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        {error && <Alert tone="danger" onClose={() => setError(null)}>{error}</Alert>}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 'var(--spacing-3)', alignItems: 'start' }}>
          <Input
            label={common('labels.name')}
            placeholder="Kaspi Gold…"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <GlyphField value={icon} onChange={setIcon} suggest={name} />
        </div>
        <Select
          label={common('labels.type')}
          value={subtype}
          onChange={setSubtype}
          options={SUBTYPES.map((s) => ({ value: s, label: t(`subtype.${s}`), icon: SUBTYPE_ICON[s] }))}
        />
        <Select
          label={t('accounts.currency')}
          value={currency}
          onChange={setCurrency}
          options={CURRENCIES.map((c) => ({ value: c, label: c, hint: currencySymbol(c) }))}
        />
        <Input
          label={t('accounts.currentBalance')}
          hint={t('accounts.currentBalanceHint')}
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
  const t = useTranslations('finance');
  const common = useTranslations('common');
  const [value, setValue] = useState(String(account.balance / 100));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const minor = parseSignedMoneyInput(value);
    if (minor === null || busy) { setError(t('accounts.amountRequired')); return; }
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/finance/accounts/${account.id}/set-balance`, { balance: minor }, bookParams(bookId));
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
      title={t('accounts.balanceOf', { name: account.name })}
      subtitle={t('accounts.balanceSubtitle')}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{common('actions.cancel')}</Button>
          <Button variant="primary" tone="success" icon="save" onClick={submit} loading={busy}>
            {common('actions.save')}
          </Button>
        </>
      }
    >
      <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        {error && <Alert tone="danger" onClose={() => setError(null)}>{error}</Alert>}
        <Input
          label={`${t('accounts.currentBalance')} · ${currencySymbol(account.currencyCode)}`}
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
        />
      </div>
    </Modal>
  );
}
