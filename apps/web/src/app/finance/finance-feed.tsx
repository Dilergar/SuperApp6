'use client';

// ============================================================
// Лента операций: быстрый ввод (создание/правка) + фид по дням.
// Вынесено из page.tsx при переходе на сайдбар-разделы (раздел «Лента»).
// ============================================================

import { useEffect, useMemo, useState } from 'react';
import type { FinAccountDto, FinPersonDto, FinTransactionDto } from '@superapp/shared';
import { api } from '@/lib/api';
import { EntitySelector } from '@/components/EntitySelector';
import { PersonChip } from '../circles/PersonCard';
import { bookParams, currencySymbol, formatDayLabel, formatMoney, localToday, parseMoneyInput } from './finance-lib';

type EntryTab = 'expense' | 'income' | 'transfer';

/** Иконка/заголовок/знак операции — общая презентация для ленты и «Обзора». */
export function txPresentation(
  tx: FinTransactionDto,
  accountById: Map<string, FinAccountDto>,
): { icon: string; title: string; sign: '+' | '−' | ''; color: string } {
  const from = accountById.get(tx.fromAccountId);
  const to = accountById.get(tx.toAccountId);

  let icon = '🔁';
  let title = '';
  let sign: '+' | '−' | '' = '';
  let color = 'var(--on-surface)';
  switch (tx.type) {
    case 'expense':
      icon = to?.icon ?? '🧾';
      title = to?.name ?? 'Расход';
      sign = '−';
      color = 'var(--danger)';
      break;
    case 'income':
      icon = from?.icon ?? '💰';
      title = from?.name ?? 'Доход';
      sign = '+';
      color = 'var(--success)';
      break;
    case 'transfer':
      icon = '🔁';
      title = `${from?.name ?? '—'} → ${to?.name ?? '—'}`;
      break;
    case 'debt_payment':
      icon = '📉';
      title = `Платёж: ${to?.name ?? 'долг'}`;
      break;
    case 'debt_draw':
      icon = '🏦';
      title = `Кредит: ${from?.name ?? 'долг'}`;
      sign = '+';
      color = 'var(--success)';
      break;
    case 'opening':
      icon = '⚖️';
      title = 'Корректировка остатка';
      break;
  }
  return { icon, title, sign, color };
}

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
}) {
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
    setAmount(''); setAmountTo(''); setNote(''); setDate(localToday()); setPersonUserId(null); setPersonPickerOpen(false);
  };

  const submit = async () => {
    const minor = parseMoneyInput(amount);
    if (!minor || !fromId || !toId || busy) return;
    const minorTo = needsAmountTo ? parseMoneyInput(amountTo) : null;
    if (needsAmountTo && !minorTo) { alert('Укажите сумму зачисления во второй валюте'); return; }
    setBusy(true);
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
      if (editingTx) await api.patch(`/finance/transactions/${editingTx.id}`, payload, bookParams(bookId));
      else await api.post('/finance/transactions', payload, bookParams(bookId));
      reset();
      onSaved();
    } catch (e) {
      alert((e as { response?: { data?: { message?: string } } }).response?.data?.message ?? 'Не удалось сохранить операцию');
    } finally {
      setBusy(false);
    }
  };

  const catOptions = (cats: FinAccountDto[]) => {
    const roots = cats.filter((c) => !c.parentId);
    return roots.map((root) => {
      const children = cats.filter((c) => c.parentId === root.id);
      if (children.length === 0) {
        return <option key={root.id} value={root.id}>{root.icon ? `${root.icon} ` : ''}{root.name}</option>;
      }
      return (
        <optgroup key={root.id} label={`${root.icon ? `${root.icon} ` : ''}${root.name}`}>
          <option value={root.id}>{root.name} (в целом)</option>
          {children.map((c) => <option key={c.id} value={c.id}>{c.icon ? `${c.icon} ` : ''}{c.name}</option>)}
        </optgroup>
      );
    });
  };
  const moneyOptions = money.map((m) => (
    <option key={m.id} value={m.id}>{m.icon ? `${m.icon} ` : ''}{m.name} · {currencySymbol(m.currencyCode)}</option>
  ));

  return (
    <div className="card-elevated" style={{ transform: 'rotate(0.25deg)' }}>
      <div className="flex items-center justify-between" style={{ marginBottom: 'var(--spacing-4)' }}>
        <h2 className="title-md">{editingTx ? 'Исправить операцию' : 'Записать'}</h2>
        {editingTx && (
          <button className="label-sm" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--secondary)' }} onClick={() => { reset(); onCancelEdit(); }}>
            отменить правку
          </button>
        )}
      </div>

      <div className="flex" style={{ gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-6)' }}>
        {([['expense', 'Расход'], ['income', 'Доход'], ['transfer', 'Перевод']] as Array<[EntryTab, string]>).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            style={{
              border: 'none',
              cursor: 'pointer',
              padding: '0.4rem 1.2rem',
              borderRadius: 'var(--radius-sketch)',
              fontFamily: 'var(--font-display)',
              fontWeight: 600,
              fontSize: '0.9rem',
              background: tab === key
                ? key === 'expense' ? 'var(--primary-container)' : key === 'income' ? 'rgba(45,122,58,0.2)' : 'var(--secondary-container)'
                : 'transparent',
              color: 'var(--on-surface)',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-4) var(--spacing-6)' }}>
        <div>
          <div className="label-sm" style={{ marginBottom: '0.2rem' }}>Сумма{fromAcc && tab !== 'income' ? ` (${currencySymbol(fromAcc.currencyCode)})` : ''}</div>
          <input className="input-sketch" inputMode="decimal" placeholder="2 500" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ fontSize: '1.4rem', fontFamily: 'var(--font-display)', fontWeight: 700 }} />
        </div>
        <div>
          <div className="label-sm" style={{ marginBottom: '0.2rem' }}>Дата</div>
          <input type="date" className="input-sketch" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>

        {tab === 'expense' && (
          <>
            <div>
              <div className="label-sm" style={{ marginBottom: '0.2rem' }}>Со счёта</div>
              <select className="input-sketch" value={fromId} onChange={(e) => setFromId(e.target.value)}>{moneyOptions}</select>
            </div>
            <div>
              <div className="label-sm" style={{ marginBottom: '0.2rem' }}>Категория</div>
              <select className="input-sketch" value={toId} onChange={(e) => setToId(e.target.value)}>{catOptions(expenseCats)}</select>
            </div>
          </>
        )}
        {tab === 'income' && (
          <>
            <div>
              <div className="label-sm" style={{ marginBottom: '0.2rem' }}>Источник</div>
              <select className="input-sketch" value={fromId} onChange={(e) => setFromId(e.target.value)}>{catOptions(incomeCats)}</select>
            </div>
            <div>
              <div className="label-sm" style={{ marginBottom: '0.2rem' }}>На счёт</div>
              <select className="input-sketch" value={toId} onChange={(e) => setToId(e.target.value)}>{moneyOptions}</select>
            </div>
          </>
        )}
        {tab === 'transfer' && (
          <>
            <div>
              <div className="label-sm" style={{ marginBottom: '0.2rem' }}>Со счёта</div>
              <select className="input-sketch" value={fromId} onChange={(e) => setFromId(e.target.value)}>{moneyOptions}</select>
            </div>
            <div>
              <div className="label-sm" style={{ marginBottom: '0.2rem' }}>На счёт</div>
              <select className="input-sketch" value={toId} onChange={(e) => setToId(e.target.value)}>{moneyOptions}</select>
            </div>
            {needsAmountTo && (
              <div>
                <div className="label-sm" style={{ marginBottom: '0.2rem' }}>Зачислено ({toAcc ? currencySymbol(toAcc.currencyCode) : ''})</div>
                <input className="input-sketch" inputMode="decimal" placeholder="100" value={amountTo} onChange={(e) => setAmountTo(e.target.value)} />
              </div>
            )}
          </>
        )}

        <div style={{ gridColumn: '1 / -1' }}>
          <div className="label-sm" style={{ marginBottom: '0.2rem' }}>Заметка</div>
          <input className="input-sketch" placeholder="Magnum, подарок…" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>

        {(tab === 'expense' || tab === 'income') && (
          <div style={{ gridColumn: '1 / -1' }}>
            <div className="label-sm" style={{ marginBottom: '0.3rem' }}>
              {tab === 'expense' ? 'На кого (не обязательно)' : 'От кого (не обязательно)'}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--spacing-2)' }}>
              {/* «Я» — всегда первый: потратил/получил на себя (моя карточка). */}
              {meId && (
                <button
                  onClick={() => setPersonUserId((cur) => (cur === meId ? null : meId))}
                  style={{
                    background: personUserId === meId ? 'var(--secondary-container)' : 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    borderRadius: 'var(--radius-sketch)',
                    padding: '0.15rem 0.3rem',
                  }}
                  title={personUserId === meId ? 'Убрать' : tab === 'income' ? 'От себя' : 'На себя'}
                >
                  <PersonChip size="S" userId={meId} firstName={meName} role="Я" />
                </button>
              )}
              {people.filter((p) => p.userId !== meId).map((p) => (
                <button
                  key={p.userId}
                  onClick={() => setPersonUserId((cur) => (cur === p.userId ? null : p.userId))}
                  style={{
                    background: personUserId === p.userId ? 'var(--secondary-container)' : 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    borderRadius: 'var(--radius-sketch)',
                    padding: '0.15rem 0.3rem',
                  }}
                  title={personUserId === p.userId ? 'Убрать' : `На ${p.name}`}
                >
                  <PersonChip size="S" userId={p.userId} firstName={p.name} avatar={p.avatar} />
                </button>
              ))}
              <button
                className="label-sm"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--secondary)' }}
                onClick={() => setPersonPickerOpen((v) => !v)}
              >
                {personPickerOpen ? 'скрыть' : 'из окружения…'}
              </button>
              {personUserId && personUserId !== meId && !people.some((p) => p.userId === personUserId) && (
                <span className="wash-secondary label-sm" style={{ padding: '0.2rem 0.6rem' }}>
                  выбран человек
                  <button onClick={() => setPersonUserId(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', fontWeight: 700, marginLeft: '0.3rem' }}>×</button>
                </span>
              )}
            </div>
            {personPickerOpen && (
              <div style={{ marginTop: 'var(--spacing-2)' }}>
                <EntitySelector
                  value={personUserId ? [{ type: 'user', id: personUserId }] : []}
                  onChange={(next) => setPersonUserId(next[0]?.id ?? null)}
                  types={['user']}
                  multi={false}
                  placeholder="Найти человека…"
                />
              </div>
            )}
          </div>
        )}
      </div>

      <button className="btn-primary" style={{ marginTop: 'var(--spacing-6)' }} onClick={submit} disabled={busy}>
        {editingTx ? 'Сохранить правку' : 'Записать'}
      </button>
    </div>
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
}) {
  const groups = useMemo(() => {
    const byDay = new Map<string, FinTransactionDto[]>();
    for (const t of transactions) {
      const list = byDay.get(t.occurredOn) ?? [];
      list.push(t);
      byDay.set(t.occurredOn, list);
    }
    return [...byDay.entries()];
  }, [transactions]);

  const remove = async (tx: FinTransactionDto) => {
    if (!window.confirm('Удалить операцию? Удаление останется в аудите книги.')) return;
    try {
      await api.delete(`/finance/transactions/${tx.id}`, bookParams(bookId));
      onDeleted();
    } catch (e) {
      alert((e as { response?: { data?: { message?: string } } }).response?.data?.message ?? 'Не удалось удалить');
    }
  };

  return (
    <div className="card" style={{ transform: 'rotate(-0.2deg)' }}>
      <div className="flex items-center justify-between" style={{ marginBottom: 'var(--spacing-4)' }}>
        <h2 className="title-md">Операции</h2>
        {filterLabel && (
          <button className="wash-secondary label-sm" style={{ border: 'none', cursor: 'pointer', padding: '0.25rem 0.8rem' }} onClick={onClearFilter}>
            {filterLabel} ×
          </button>
        )}
      </div>

      {groups.length === 0 && (
        <p className="label-md" style={{ padding: 'var(--spacing-4) 0' }}>
          Пока пусто. Задайте остаток счёта в «Счетах» и запишите первую трату.
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
        {groups.map(([day, items]) => {
          const dayExpense = items
            .filter((t) => t.type === 'expense')
            .reduce((acc, t) => {
              acc.set(t.currencyCode, (acc.get(t.currencyCode) ?? 0) + t.amount);
              return acc;
            }, new Map<string, number>());
          return (
            <div key={day}>
              <div className="flex items-center justify-between" style={{ marginBottom: 'var(--spacing-2)' }}>
                <span className="label-md" style={{ fontWeight: 700 }}>{formatDayLabel(day)}</span>
                {dayExpense.size > 0 && (
                  <span className="label-sm">
                    −{[...dayExpense.entries()].map(([code, sum]) => formatMoney(sum, code)).join(' · ')}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
                {items.map((t) => (
                  <TransactionRow key={t.id} tx={t} accountById={accountById} canEdit={canEdit} meId={meId} onEdit={() => onEdit(t)} onShare={() => onShare(t)} onRemove={() => remove(t)} />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {hasMore && (
        <div style={{ textAlign: 'center', marginTop: 'var(--spacing-6)' }}>
          <button className="btn-secondary" style={{ padding: '0.4rem 1.4rem', fontSize: '0.85rem' }} onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? 'Загружаю…' : 'Показать ещё'}
          </button>
        </div>
      )}
    </div>
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
  const [hover, setHover] = useState(false);
  const from = accountById.get(tx.fromAccountId);
  const to = accountById.get(tx.toAccountId);
  const { icon, title, sign, color } = txPresentation(tx, accountById);

  const editable = tx.type !== 'opening';

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--spacing-3)',
        background: 'var(--surface-container-lowest)',
        borderRadius: 'var(--radius-sketch)',
        padding: '0.55rem var(--spacing-4)',
      }}
    >
      <span style={{ fontSize: '1.15rem' }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
          <span>{title}</span>
          {tx.personName && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
              <span className="label-sm">{tx.type === 'income' ? 'от' : 'на'}</span>
              <PersonChip size="S" userId={tx.personUserId} firstName={tx.personName} />
            </span>
          )}
          {tx.createdByName && meId && tx.createdById !== meId && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
              <span className="label-sm">внёс(ла)</span>
              <PersonChip size="S" userId={tx.createdById} firstName={tx.createdByName} />
            </span>
          )}
        </div>
        {(tx.note || tx.type === 'expense') && (
          <div className="label-sm" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {tx.note ?? (tx.type === 'expense' ? `со счёта: ${from?.name ?? '—'}` : '')}
          </div>
        )}
      </div>
      {hover && (
        <div className="flex" style={{ gap: 'var(--spacing-2)' }}>
          <button onClick={onShare} title="Отправить в чат" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.9rem' }}>💬</button>
          {editable && canEdit && (
            <button onClick={onEdit} title="Исправить" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.9rem' }}>✎</button>
          )}
          {canEdit && (
            <button onClick={onRemove} title="Удалить" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', fontWeight: 700 }}>×</button>
          )}
        </div>
      )}
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color }}>
          {sign}{formatMoney(tx.amount, tx.currencyCode)}
        </div>
        {tx.amountTo != null && to && (
          <div className="label-sm">→ {formatMoney(tx.amountTo, to.currencyCode)}</div>
        )}
      </div>
    </div>
  );
}
