'use client';

// ============================================================
// Лента операций: быстрый ввод (создание/правка) + фид по дням.
// Вынесено из page.tsx при переходе на сайдбар-разделы (раздел «Лента»).
// ============================================================

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { FinAccountDto, FinPersonDto, FinTransactionDto } from '@superapp/shared';
import { apiDelete, apiErrorMessage, apiPatch, apiPost } from '@/lib/api';
import { EntitySelector } from '@/components/EntitySelector';
import {
  Alert, Button, Card, CardHeader, ConfirmDialog, DatePicker, EmptyState, Field, IconButton,
  Input, SegmentedControl, Select, type SelectOption, type Tone,
} from '@/components/ui';
import { PersonChip } from '../circles/PersonCard';
import {
  bookParams, currencySymbol, dateToYmd, useDayLabel, formatMoney, localToday,
  parseMoneyInput, ymdToDate,
} from './finance-lib';
import { FinList, FinRow, Money } from './finance-ui';
import { toastError } from '@/lib/toast';

type EntryTab = 'expense' | 'income' | 'transfer';

/**
 * Иконка/заголовок/знак операции — общая презентация для ленты и «Обзора».
 *
 * `icon` — либо имя иконки кита (интерфейсный смысл операции), либо эмодзи
 * категории/счёта из БД (выбор человека). Рисует его только `FinGlyph`.
 */
export function txPresentation(
  tx: FinTransactionDto,
  accountById: Map<string, FinAccountDto>,
  t: (key: string, values?: Record<string, string | number>) => string,
): { icon: string; title: string; sign: '+' | '−' | ''; tone: Tone } {
  const from = accountById.get(tx.fromAccountId);
  const to = accountById.get(tx.toAccountId);

  let icon = 'refresh';
  let title = '';
  let sign: '+' | '−' | '' = '';
  let tone: Tone = 'neutral';
  switch (tx.type) {
    case 'expense':
      icon = to?.icon ?? 'receipt';
      title = to?.name ?? t('txType.expense');
      sign = '−';
      tone = 'danger';
      break;
    case 'income':
      icon = from?.icon ?? 'coins';
      title = from?.name ?? t('txType.income');
      sign = '+';
      tone = 'success';
      break;
    case 'transfer':
      icon = 'refresh';
      title = `${from?.name ?? '—'} → ${to?.name ?? '—'}`;
      break;
    case 'debt_payment':
      icon = 'debt';
      title = t('feed.debtPaymentTitle', { name: to?.name ?? t('feed.debtWord') });
      tone = 'accent';
      break;
    case 'debt_draw':
      icon = 'savings';
      title = t('feed.debtDrawTitle', { name: from?.name ?? t('feed.debtWord') });
      sign = '+';
      tone = 'success';
      break;
    case 'opening':
      icon = 'scales';
      title = t('txType.opening');
      break;
  }
  return { icon, title, sign, tone };
}

/** Плоский список опций из дерева категорий: подкатегория несёт подпись родителя. */
function categoryOptions(cats: FinAccountDto[], wholeHint: string): SelectOption[] {
  const roots = cats.filter((c) => !c.parentId);
  const out: SelectOption[] = [];
  for (const root of roots) {
    const children = cats.filter((c) => c.parentId === root.id);
    out.push({ value: root.id, label: root.name, emoji: root.icon, hint: children.length ? wholeHint : undefined });
    for (const child of children) {
      out.push({ value: child.id, label: child.name, emoji: child.icon, hint: root.name });
    }
  }
  return out;
}

const moneyOptions = (money: FinAccountDto[]): SelectOption[] =>
  money.map((m) => ({ value: m.id, label: m.name, emoji: m.icon, hint: currencySymbol(m.currencyCode) }));

// ============================================================
// Быстрый ввод (создание + правка)
// ============================================================

export function QuickEntry({
  accounts,
  categories,
  people,
  editingTx,
  onCancelEdit,
  onSaved,
  bookId,
  meId,
  meName,
  span,
}: {
  accounts: FinAccountDto[];
  categories: FinAccountDto[];
  people: FinPersonDto[];
  editingTx: FinTransactionDto | null;
  onCancelEdit: () => void;
  onSaved: () => void;
  bookId: string | null;
  meId: string | null;
  meName: string;
  /** Колонок бенто-сетки (страница решает, как широко стоит форма). */
  span?: number;
}) {
  const t = useTranslations('finance');
  const common = useTranslations('common');
  const [tab, setTab] = useState<EntryTab>('expense');
  const [amount, setAmount] = useState('');
  const [amountTo, setAmountTo] = useState('');
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [date, setDate] = useState(localToday());
  const [note, setNote] = useState('');
  const [personUserId, setPersonUserId] = useState<string | null>(null);
  const [personPickerOpen, setPersonPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const money = accounts.filter((a) => a.kind === 'asset' || a.kind === 'liability');
  const expenseCats = categories.filter((c) => c.kind === 'expense' && !c.archived);
  const incomeCats = categories.filter((c) => c.kind === 'income' && !c.archived);

  // Сигнатуры по id (не по .length): archive-одного + add-другого не меняет длину, но
  // меняет набор — иначе fromId залипал бы на архивном счёте и submit писал бы не туда.
  const accountIds = accounts.map((a) => a.id).join(',');
  const categoryIds = categories.map((c) => c.id).join(',');

  // Дефолты по вкладке
  useEffect(() => {
    if (editingTx) return;
    if (tab === 'expense') {
      setFromId((cur) => (money.some((m) => m.id === cur) ? cur : money[0]?.id ?? ''));
      setToId((cur) => (expenseCats.some((c) => c.id === cur) ? cur : expenseCats[0]?.id ?? ''));
    } else if (tab === 'income') {
      setFromId((cur) => (incomeCats.some((c) => c.id === cur) ? cur : incomeCats[0]?.id ?? ''));
      setToId((cur) => (money.some((m) => m.id === cur) ? cur : money[0]?.id ?? ''));
    } else {
      setFromId((cur) => (money.some((m) => m.id === cur) ? cur : money[0]?.id ?? ''));
      setToId((cur) => {
        const second = money.find((m) => m.id !== (money[0]?.id ?? ''));
        return money.some((m) => m.id === cur) && cur !== fromId ? cur : second?.id ?? '';
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, accountIds, categoryIds, editingTx]);

  // Режим правки: заполняем форму из операции
  useEffect(() => {
    if (!editingTx) return;
    const t = editingTx.type === 'debt_payment' || editingTx.type === 'debt_draw' ? 'transfer' : editingTx.type;
    if (t === 'expense' || t === 'income' || t === 'transfer') setTab(t);
    setAmount(String(editingTx.amount / 100));
    setAmountTo(editingTx.amountTo != null ? String(editingTx.amountTo / 100) : '');
    setFromId(editingTx.fromAccountId);
    setToId(editingTx.toAccountId);
    setDate(editingTx.occurredOn);
    setNote(editingTx.note ?? '');
    setPersonUserId(editingTx.personUserId);
  }, [editingTx]);

  const fromAcc = money.find((m) => m.id === fromId);
  const toAcc = money.find((m) => m.id === toId);
  const needsAmountTo = tab === 'transfer' && fromAcc && toAcc && fromAcc.currencyCode !== toAcc.currencyCode;

  const reset = () => {
    setAmount(''); setAmountTo(''); setNote(''); setDate(localToday()); setPersonUserId(null); setPersonPickerOpen(false); setError(null);
  };

  const submit = async () => {
    const minor = parseMoneyInput(amount);
    if (!minor || !fromId || !toId || busy) {
      setError(t(minor ? 'recurring.pickAccountAndCategory' : 'accounts.amountRequired'));
      return;
    }
    const minorTo = needsAmountTo ? parseMoneyInput(amountTo) : null;
    if (needsAmountTo && !minorTo) { setError(t('feed.amountToRequired')); return; }
    setBusy(true);
    setError(null);
    try {
      const personAllowed = tab === 'expense' || tab === 'income';
      const payload = {
        fromAccountId: fromId,
        toAccountId: toId,
        amount: minor,
        ...(needsAmountTo ? { amountTo: minorTo } : {}),
        occurredOn: date,
        ...(note.trim() ? { note: note.trim() } : editingTx ? { note: null } : {}),
        ...(personAllowed && personUserId ? { personUserId } : editingTx ? { personUserId: null } : {}),
      };
      if (editingTx) await apiPatch(`/finance/transactions/${editingTx.id}`, payload, bookParams(bookId));
      else await apiPost('/finance/transactions', payload, bookParams(bookId));
      reset();
      onSaved();
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const personLabel = t(tab === 'expense' ? 'feed.personForWhom' : 'feed.personFromWhom');

  return (
    <Card span={span}>
      <CardHeader
        title={t(editingTx ? 'feed.editTitle' : 'feed.recordTitle')}
        actions={
          editingTx ? (
            <Button variant="ghost" size="sm" onClick={() => { reset(); onCancelEdit(); }}>
              {t('feed.cancelEdit')}
            </Button>
          ) : undefined
        }
      />

      <SegmentedControl
        aria-label={t('feed.txTypeLabel')}
        value={tab}
        onChange={setTab}
        items={[
          { key: 'expense', label: t('txType.expense'), icon: 'trendDown' },
          { key: 'income', label: t('txType.income'), icon: 'trendUp' },
          { key: 'transfer', label: t('txType.transfer'), icon: 'refresh' },
        ]}
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: 'var(--spacing-4)',
          marginTop: 'var(--spacing-5)',
        }}
      >
        <Input
          label={`${t('debts.amountField')}${fromAcc && tab !== 'income' ? ` · ${currencySymbol(fromAcc.currencyCode)}` : ''}`}
          inputMode="decimal"
          placeholder="2 500"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          style={{ fontSize: '1.25rem', fontFamily: 'var(--font-display)', fontWeight: 700 }}
        />
        <DatePicker label={t('card.date')} value={ymdToDate(date)} onChange={(d) => setDate(dateToYmd(d) ?? localToday())} />

        {tab === 'expense' && (
          <>
            <Select label={t('debts.fromAccount')} value={fromId || null} onChange={setFromId} options={moneyOptions(money)} placeholder={t('debts.accountPlaceholder')} />
            <Select label={t('recurring.category')} value={toId || null} onChange={setToId} options={categoryOptions(expenseCats, t('feed.wholeCategory'))} placeholder={t('feed.categoryPlaceholder')} />
          </>
        )}
        {tab === 'income' && (
          <>
            <Select label={t('recurring.source')} value={fromId || null} onChange={setFromId} options={categoryOptions(incomeCats, t('feed.wholeCategory'))} placeholder={t('feed.sourcePlaceholder')} />
            <Select label={t('card.toAccount')} value={toId || null} onChange={setToId} options={moneyOptions(money)} placeholder={t('debts.accountPlaceholder')} />
          </>
        )}
        {tab === 'transfer' && (
          <>
            <Select label={t('debts.fromAccount')} value={fromId || null} onChange={setFromId} options={moneyOptions(money)} placeholder={t('debts.accountPlaceholder')} />
            <Select label={t('card.toAccount')} value={toId || null} onChange={setToId} options={moneyOptions(money)} placeholder={t('debts.accountPlaceholder')} />
            {needsAmountTo && (
              <Input
                label={`${t('card.credited')} · ${toAcc ? currencySymbol(toAcc.currencyCode) : ''}`}
                inputMode="decimal"
                placeholder="100"
                value={amountTo}
                onChange={(e) => setAmountTo(e.target.value)}
              />
            )}
          </>
        )}

        <div style={{ gridColumn: '1 / -1' }}>
          <Input
            label={t('feed.note')}
            placeholder={t('feed.notePlaceholder')}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>

        {(tab === 'expense' || tab === 'income') && (
          <div style={{ gridColumn: '1 / -1' }}>
            <Field label={personLabel}>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--spacing-2)' }}>
                {/* «Я» — всегда первый: потратил/получил на себя (моя карточка). */}
                {meId && (
                  <PersonPickChip
                    selected={personUserId === meId}
                    onClick={() => setPersonUserId((cur) => (cur === meId ? null : meId))}
                    title={
                      personUserId === meId
                        ? common('actions.remove')
                        : t(tab === 'income' ? 'feed.fromMyself' : 'debts.forMyself')
                    }
                  >
                    <PersonChip size="S" userId={meId} firstName={meName} role={t('book.me')} />
                  </PersonPickChip>
                )}
                {people.filter((p) => p.userId !== meId).map((p) => (
                  <PersonPickChip
                    key={p.userId}
                    selected={personUserId === p.userId}
                    onClick={() => setPersonUserId((cur) => (cur === p.userId ? null : p.userId))}
                    title={personUserId === p.userId ? common('actions.remove') : t('debts.forPerson', { name: p.name })}
                  >
                    <PersonChip size="S" userId={p.userId} firstName={p.name} avatar={p.avatar} />
                  </PersonPickChip>
                ))}
                <Button variant="ghost" size="sm" onClick={() => setPersonPickerOpen((v) => !v)}>
                  {personPickerOpen ? common('actions.hide') : t('feed.fromCircle')}
                </Button>
                {personUserId && personUserId !== meId && !people.some((p) => p.userId === personUserId) && (
                  <Button variant="matte" tone="accent" size="sm" icon="close" onClick={() => setPersonUserId(null)}>
                    {t('feed.personPicked')}
                  </Button>
                )}
              </div>
            </Field>
            {personPickerOpen && (
              <div style={{ marginTop: 'var(--spacing-2)' }}>
                <EntitySelector
                  value={personUserId ? [{ type: 'user', id: personUserId }] : []}
                  onChange={(next) => setPersonUserId(next[0]?.id ?? null)}
                  types={['user']}
                  multi={false}
                  placeholder={t('feed.findPerson')}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {error && (
        <div style={{ marginTop: 'var(--spacing-4)' }}>
          <Alert tone="danger" onClose={() => setError(null)}>{error}</Alert>
        </div>
      )}

      <div style={{ marginTop: 'var(--spacing-5)' }}>
        <Button variant="primary" tone="success" icon={editingTx ? 'save' : 'add'} onClick={submit} loading={busy}>
          {t(editingTx ? 'feed.saveEdit' : 'feed.recordTitle')}
        </Button>
      </div>
    </Card>
  );
}

/** Обёртка выбора вокруг карточки человека (сама карточка — PersonChip, принцип 2). */
function PersonPickChip({
  selected,
  onClick,
  title,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={selected}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '0.1875rem 0.3125rem',
        borderRadius: 'var(--radius-pill)',
        cursor: 'pointer',
        background: selected ? 'var(--secondary-container)' : 'transparent',
        border: `1px solid ${selected ? 'var(--primary)' : 'var(--border)'}`,
      }}
    >
      {children}
    </button>
  );
}

// ============================================================
// Лента операций
// ============================================================

export function TransactionFeed({
  transactions,
  accountById,
  filterLabel,
  onClearFilter,
  onEdit,
  onShare,
  onDeleted,
  hasMore,
  loadingMore,
  onLoadMore,
  canEdit,
  bookId,
  meId,
  span,
}: {
  transactions: FinTransactionDto[];
  accountById: Map<string, FinAccountDto>;
  filterLabel: string | null;
  onClearFilter: () => void;
  onEdit: (tx: FinTransactionDto) => void;
  onShare: (tx: FinTransactionDto) => void;
  onDeleted: () => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  canEdit: boolean;
  bookId: string | null;
  meId: string | null;
  span?: number;
}) {
  const t = useTranslations('finance');
  const common = useTranslations('common');
  const [removing, setRemoving] = useState<FinTransactionDto | null>(null);
  const [busy, setBusy] = useState(false);
  const dayLabel = useDayLabel();

  const groups = useMemo(() => {
    const byDay = new Map<string, FinTransactionDto[]>();
    for (const t of transactions) {
      const list = byDay.get(t.occurredOn) ?? [];
      list.push(t);
      byDay.set(t.occurredOn, list);
    }
    return [...byDay.entries()];
  }, [transactions]);

  const remove = async () => {
    if (!removing || busy) return;
    setBusy(true);
    try {
      await apiDelete(`/finance/transactions/${removing.id}`, bookParams(bookId));
      setRemoving(null);
      onDeleted();
    } catch (e) {
      toastError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card span={span}>
      <CardHeader
        title={t('feed.listTitle')}
        actions={
          filterLabel ? (
            <Button variant="matte" tone="accent" size="sm" icon="close" onClick={onClearFilter}>
              {filterLabel}
            </Button>
          ) : undefined
        }
      />

      {groups.length === 0 ? (
        <EmptyState
          icon="receipt"
          title={t('coins.feedEmptyTitle')}
          description={t('feed.emptyDescription')}
        />
      ) : (
        <div className="density-compact ui-stack" style={{ gap: 'var(--spacing-5)' }}>
          {groups.map(([day, items]) => {
            const dayExpense = items
              .filter((t) => t.type === 'expense')
              .reduce((acc, t) => {
                acc.set(t.currencyCode, (acc.get(t.currencyCode) ?? 0) + t.amount);
                return acc;
              }, new Map<string, number>());
            return (
              <div key={day}>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '0.5rem', marginBottom: 'var(--spacing-2)' }}>
                  <span className="label-caps">{dayLabel(day)}</span>
                  {dayExpense.size > 0 && (
                    <span className="label-sm">
                      −{[...dayExpense.entries()].map(([code, sum]) => formatMoney(sum, code)).join(' · ')}
                    </span>
                  )}
                </div>
                <FinList>
                  {items.map((t) => (
                    <TransactionRow
                      key={t.id}
                      tx={t}
                      accountById={accountById}
                      canEdit={canEdit}
                      meId={meId}
                      onEdit={() => onEdit(t)}
                      onShare={() => onShare(t)}
                      onRemove={() => setRemoving(t)}
                    />
                  ))}
                </FinList>
              </div>
            );
          })}
        </div>
      )}

      {hasMore && (
        <div style={{ textAlign: 'center', marginTop: 'var(--spacing-5)' }}>
          <Button variant="matte" size="sm" onClick={onLoadMore} loading={loadingMore}>{t('coins.loadMore')}</Button>
        </div>
      )}

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={remove}
        title={t('feed.confirmDelete')}
        message={t('feed.confirmDeleteMessage')}
        confirmLabel={common('actions.delete')}
        danger
        loading={busy}
      />
    </Card>
  );
}

function TransactionRow({
  tx,
  accountById,
  canEdit,
  meId,
  onEdit,
  onShare,
  onRemove,
}: {
  tx: FinTransactionDto;
  accountById: Map<string, FinAccountDto>;
  canEdit: boolean;
  meId: string | null;
  onEdit: () => void;
  onShare: () => void;
  onRemove: () => void;
}) {
  const t = useTranslations('finance');
  const common = useTranslations('common');
  const from = accountById.get(tx.fromAccountId);
  const to = accountById.get(tx.toAccountId);
  const { icon, title, sign, tone } = txPresentation(tx, accountById, t);
  const editable = tx.type !== 'opening';

  return (
    <FinRow
      glyph={icon}
      glyphTone={tone}
      glyphFallback="receipt"
      title={
        <>
          <span>{title}</span>
          {tx.personName && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
              <span className="label-sm">{t(tx.type === 'income' ? 'feed.fromPrefix' : 'feed.toPrefix')}</span>
              <PersonChip size="S" userId={tx.personUserId} firstName={tx.personName} />
            </span>
          )}
          {tx.createdByName && meId && tx.createdById !== meId && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
              <span className="label-sm">{t('feed.recordedBy')}</span>
              <PersonChip size="S" userId={tx.createdById} firstName={tx.createdByName} />
            </span>
          )}
        </>
      }
      subtitle={tx.note ?? (tx.type === 'expense' ? t('feed.fromAccountLine', { name: from?.name ?? '—' }) : undefined)}
      actions={
        <>
          <IconButton icon="messenger" label={t('feed.shareToChat')} size={28} onClick={onShare} />
          {editable && canEdit && <IconButton icon="edit" label={t('feed.fix')} size={28} onClick={onEdit} />}
          {canEdit && <IconButton icon="delete" label={common('actions.delete')} size={28} onClick={onRemove} />}
        </>
      }
      right={
        <>
          <Money minor={tx.amount} code={tx.currencyCode} sign={sign} tone={tone === 'danger' ? 'danger' : tone === 'success' ? 'success' : undefined} />
          {tx.amountTo != null && to && (
            <div className="label-sm">→ {formatMoney(tx.amountTo, to.currencyCode)}</div>
          )}
        </>
      }
    />
  );
}
