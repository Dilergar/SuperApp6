'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { FinAccountDto, FinDebtDto, FinPersonDto, FinRecurringRuleDto } from '@superapp/shared';
import { api } from '@/lib/api';
import { financeDebtsKey, financeRecurringKey, fetchFinanceDebts, fetchFinanceRecurring } from '@/lib/queries';
import { WEEKDAYS_SHORT, currencySymbol, formatMoney, parseMoneyInput } from './finance-lib';
import { PersonChip } from '../circles/PersonCard';

const errText = (e: unknown): string =>
  (e as { response?: { data?: { message?: string } } }).response?.data?.message ?? 'Что-то пошло не так';

// ============================================================
// Долги «я должен»: рассрочки и кредиты (Ф5)
// ============================================================

export function DebtsPanel({
  accounts,
  categories,
  people,
  onChanged,
  bookId,
  canEdit,
  meId,
  meName,
}: {
  accounts: FinAccountDto[];
  categories: FinAccountDto[];
  people: FinPersonDto[];
  onChanged: () => void;
  bookId: string | null;
  canEdit: boolean;
  meId: string | null;
  meName: string;
}) {
  const { data: debts = [], refetch } = useQuery({ queryKey: financeDebtsKey(bookId), queryFn: () => fetchFinanceDebts(bookId) });
  const [adding, setAdding] = useState(false);
  const [payFor, setPayFor] = useState<string | null>(null);

  const open = debts.filter((d) => !d.closedAt && !d.archived);
  const closed = debts.filter((d) => d.closedAt || d.archived);
  const changed = () => {
    refetch();
    onChanged();
  };

  return (
    <div className="card" style={{ transform: 'rotate(-0.3deg)' }}>
      <div className="flex items-center justify-between" style={{ marginBottom: 'var(--spacing-4)' }}>
        <h2 className="title-md">Долги</h2>
        {canEdit && (
          <button className="btn-secondary" style={{ padding: '0.25rem 0.8rem', fontSize: '0.75rem' }} onClick={() => setAdding((v) => !v)}>
            {adding ? 'Скрыть' : '+ Долг'}
          </button>
        )}
      </div>

      {adding && canEdit && <NewDebtForm accounts={accounts} categories={categories} people={people} bookId={bookId} meId={meId} meName={meName} onDone={() => { setAdding(false); changed(); }} />}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)' }}>
        {open.map((d) => {
          const paidPct = d.total > 0 ? Math.min(100, Math.round(((d.total - d.remaining) / d.total) * 100)) : 0;
          return (
            <div key={d.accountId} style={{ background: 'var(--surface-container-lowest)', borderRadius: 'var(--radius-sketch)', padding: '0.6rem var(--spacing-4)' }}>
              <div className="flex items-center justify-between">
                <span style={{ fontWeight: 600 }}>{d.icon ? `${d.icon} ` : ''}{d.name}</span>
                <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--danger)' }}>
                  {formatMoney(d.remaining, d.currencyCode)}
                </span>
              </div>
              <div style={{ height: 6, background: 'var(--surface-container-high)', borderRadius: 999, overflow: 'hidden', margin: '0.35rem 0' }}>
                <div style={{ height: '100%', width: `${paidPct}%`, background: 'var(--success)', borderRadius: 999 }} />
              </div>
              <div className="flex items-center justify-between">
                <span className="label-sm">
                  {d.paidMonths} из {d.months} · по {formatMoney(d.monthly, d.currencyCode)} · до {d.dueDay}-го
                </span>
                {canEdit && (
                  <button
                    className="btn-secondary"
                    style={{ padding: '0.15rem 0.7rem', fontSize: '0.72rem' }}
                    onClick={() => setPayFor(payFor === d.accountId ? null : d.accountId)}
                  >
                    Оплатить
                  </button>
                )}
              </div>
              {payFor === d.accountId && canEdit && (
                <PayDebtForm debt={d} accounts={accounts} bookId={bookId} onDone={() => { setPayFor(null); changed(); }} />
              )}
            </div>
          );
        })}
        {open.length === 0 && !adding && <p className="label-md">Долгов нет — так держать!</p>}
        {closed.length > 0 && (
          <details>
            <summary className="label-sm" style={{ cursor: 'pointer' }}>Закрытые ({closed.length})</summary>
            {closed.map((d) => (
              <div key={d.accountId} className="flex items-center justify-between" style={{ padding: '0.3rem 0' }}>
                <span className="label-md">{d.icon ? `${d.icon} ` : ''}{d.name}</span>
                <span className="label-sm" style={{ color: 'var(--success)' }}>выплачен ✓</span>
              </div>
            ))}
          </details>
        )}
      </div>
    </div>
  );
}

function NewDebtForm({
  accounts,
  categories,
  people,
  bookId,
  meId,
  meName,
  onDone,
}: {
  accounts: FinAccountDto[];
  categories: FinAccountDto[];
  people: FinPersonDto[];
  bookId: string | null;
  meId: string | null;
  meName: string;
  onDone: () => void;
}) {
  const [type, setType] = useState<'installment' | 'loan'>('installment');
  const [name, setName] = useState('');
  const [monthly, setMonthly] = useState('');
  const [months, setMonths] = useState('12');
  const [dueDay, setDueDay] = useState('25');
  const [categoryId, setCategoryId] = useState('');
  const [creditAccountId, setCreditAccountId] = useState('');
  const [received, setReceived] = useState('');
  const [personUserId, setPersonUserId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const assets = accounts.filter((a) => a.kind === 'asset');
  const expenseCats = categories.filter((c) => c.kind === 'expense' && !c.archived);
  const monthlyMinor = parseMoneyInput(monthly);
  const monthsNum = Number(months) || 0;
  const total = monthlyMinor && monthsNum ? monthlyMinor * monthsNum : null;

  const submit = async () => {
    if (!name.trim() || !monthlyMinor || !monthsNum || busy) return;
    const receivedMinor = received.trim() ? parseMoneyInput(received) : null;
    setBusy(true);
    try {
      await api.post('/finance/debts', {
        name: name.trim(),
        type,
        monthlyPayment: monthlyMinor,
        months: monthsNum,
        dueDay: Math.min(31, Math.max(1, Number(dueDay) || 25)),
        ...(type === 'installment'
          ? { categoryAccountId: categoryId || expenseCats[0]?.id, ...(personUserId ? { personUserId } : {}) }
          : (() => {
              const acc = assets.find((a) => a.id === (creditAccountId || assets[0]?.id));
              return { creditAccountId: creditAccountId || assets[0]?.id, ...(acc ? { currencyCode: acc.currencyCode } : {}), ...(receivedMinor ? { amountReceived: receivedMinor } : {}) };
            })()),
      }, bookId ? { params: { bookId } } : undefined);
      onDone();
    } catch (e) {
      alert(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wash-primary" style={{ padding: 'var(--spacing-4)', marginBottom: 'var(--spacing-4)' }}>
      <div className="flex" style={{ gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-3)' }}>
        {([['installment', 'Рассрочка (покупка)'], ['loan', 'Кредит деньгами']] as Array<['installment' | 'loan', string]>).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setType(k)}
            style={{
              border: 'none', cursor: 'pointer', padding: '0.25rem 0.8rem', borderRadius: 'var(--radius-sketch)',
              fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: '0.75rem',
              background: type === k ? 'var(--surface-container-lowest)' : 'transparent',
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <input className="input-sketch" placeholder={type === 'installment' ? 'Посуда в рассрочку' : 'Кредит наличными'} value={name} onChange={(e) => setName(e.target.value)} />
      <div className="grid grid-cols-3" style={{ gap: 'var(--spacing-3)', marginTop: 'var(--spacing-3)' }}>
        <div>
          <div className="label-sm">Платёж/мес</div>
          <input className="input-sketch" inputMode="decimal" placeholder="10 000" value={monthly} onChange={(e) => setMonthly(e.target.value)} />
        </div>
        <div>
          <div className="label-sm">Месяцев</div>
          <input className="input-sketch" inputMode="numeric" value={months} onChange={(e) => setMonths(e.target.value)} />
        </div>
        <div>
          <div className="label-sm">День платежа</div>
          <input className="input-sketch" inputMode="numeric" value={dueDay} onChange={(e) => setDueDay(e.target.value)} />
        </div>
      </div>
      {total != null && (
        <p className="label-sm" style={{ marginTop: 'var(--spacing-2)' }}>
          Итого долг: <b>{formatMoney(total, 'KZT')}</b>
        </p>
      )}
      {type === 'installment' ? (
        <>
          <div className="label-sm" style={{ marginTop: 'var(--spacing-3)' }}>Категория покупки (расход сразу полной суммой)</div>
          <select className="input-sketch" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            {expenseCats.filter((c) => !c.parentId).map((c) => <option key={c.id} value={c.id}>{c.icon ? `${c.icon} ` : ''}{c.name}</option>)}
          </select>
          {(meId || people.length > 0) && (
            <div style={{ marginTop: 'var(--spacing-2)', display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-2)', alignItems: 'center' }}>
              <span className="label-sm">На кого:</span>
              {meId && (
                <button
                  onClick={() => setPersonUserId((cur) => (cur === meId ? null : meId))}
                  style={{
                    background: personUserId === meId ? 'var(--secondary-container)' : 'transparent',
                    border: 'none', cursor: 'pointer', borderRadius: 'var(--radius-sketch)', padding: '0.1rem 0.25rem',
                  }}
                  title="На себя"
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
                    border: 'none', cursor: 'pointer', borderRadius: 'var(--radius-sketch)', padding: '0.1rem 0.25rem',
                  }}
                >
                  <PersonChip size="S" userId={p.userId} firstName={p.name} avatar={p.avatar} />
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="label-sm" style={{ marginTop: 'var(--spacing-3)' }}>Куда зачислить деньги</div>
          <select className="input-sketch" value={creditAccountId} onChange={(e) => setCreditAccountId(e.target.value)}>
            {assets.map((a) => <option key={a.id} value={a.id}>{a.icon ? `${a.icon} ` : ''}{a.name} · {currencySymbol(a.currencyCode)}</option>)}
          </select>
          <div className="label-sm" style={{ marginTop: 'var(--spacing-3)' }}>Получено на руки (если меньше итога — разница уйдёт в «Проценты по кредитам»)</div>
          <input className="input-sketch" inputMode="decimal" placeholder="по умолчанию — весь итог" value={received} onChange={(e) => setReceived(e.target.value)} />
        </>
      )}
      <button className="btn-primary" style={{ marginTop: 'var(--spacing-4)', padding: '0.45rem 1.4rem', fontSize: '0.85rem' }} onClick={submit} disabled={busy}>
        Создать долг
      </button>
    </div>
  );
}

function PayDebtForm({ debt, accounts, bookId, onDone }: { debt: FinDebtDto; accounts: FinAccountDto[]; bookId: string | null; onDone: () => void }) {
  const sameCurrency = accounts.filter((a) => a.kind === 'asset' && a.currencyCode === debt.currencyCode);
  const [fromId, setFromId] = useState(sameCurrency[0]?.id ?? '');
  const defaultPay = Math.min(debt.monthly, debt.remaining);
  const [amount, setAmount] = useState(String(defaultPay / 100));
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const minor = parseMoneyInput(amount);
    if (!minor || !fromId || busy) return;
    setBusy(true);
    try {
      await api.post(`/finance/debts/${debt.accountId}/pay`, { fromAccountId: fromId, amount: minor }, bookId ? { params: { bookId } } : undefined);
      onDone();
    } catch (e) {
      alert(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 'var(--spacing-2)', display: 'flex', gap: 'var(--spacing-2)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
      <select className="input-sketch" value={fromId} onChange={(e) => setFromId(e.target.value)} style={{ flex: 1, minWidth: 120 }}>
        {sameCurrency.map((a) => <option key={a.id} value={a.id}>{a.icon ? `${a.icon} ` : ''}{a.name}</option>)}
      </select>
      <input className="input-sketch" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 90 }} />
      <button className="btn-primary" style={{ padding: '0.3rem 1rem', fontSize: '0.78rem' }} onClick={submit} disabled={busy}>
        Оплачено
      </button>
    </div>
  );
}

// ============================================================
// Повторяющиеся операции (Ф5)
// ============================================================

export function RecurringPanel({
  accounts,
  categories,
  onChanged,
  bookId,
  canEdit,
}: {
  accounts: FinAccountDto[];
  categories: FinAccountDto[];
  onChanged: () => void;
  bookId: string | null;
  canEdit: boolean;
}) {
  const { data: rules = [], refetch } = useQuery({ queryKey: financeRecurringKey(bookId), queryFn: () => fetchFinanceRecurring(bookId) });
  const [adding, setAdding] = useState(false);
  const changed = () => {
    refetch();
    onChanged();
  };

  const accountName = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of [...accounts, ...categories]) map.set(a.id, a.name);
    return map;
  }, [accounts, categories]);

  const cfg = bookId ? { params: { bookId } } : undefined;
  const toggleActive = async (r: FinRecurringRuleDto) => {
    try {
      await api.patch(`/finance/recurring/${r.id}`, { active: !r.active }, cfg);
      changed();
    } catch (e) {
      alert(errText(e));
    }
  };
  const recordNow = async (r: FinRecurringRuleDto) => {
    try {
      await api.post(`/finance/recurring/${r.id}/record-now`, {}, cfg);
      changed();
    } catch (e) {
      alert(errText(e));
    }
  };
  const remove = async (r: FinRecurringRuleDto) => {
    if (!window.confirm(`Удалить повтор «${r.title}»?`)) return;
    try {
      await api.delete(`/finance/recurring/${r.id}`, cfg);
      changed();
    } catch (e) {
      alert(errText(e));
    }
  };

  return (
    <div className="card" style={{ transform: 'rotate(0.25deg)' }}>
      <div className="flex items-center justify-between" style={{ marginBottom: 'var(--spacing-4)' }}>
        <h2 className="title-md">Повторы</h2>
        {canEdit && (
          <button className="btn-secondary" style={{ padding: '0.25rem 0.8rem', fontSize: '0.75rem' }} onClick={() => setAdding((v) => !v)}>
            {adding ? 'Скрыть' : '+ Повтор'}
          </button>
        )}
      </div>

      {adding && canEdit && <NewRecurringForm accounts={accounts} categories={categories} bookId={bookId} onDone={() => { setAdding(false); changed(); }} />}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
        {rules.map((r) => (
          <div key={r.id} style={{ background: 'var(--surface-container-lowest)', borderRadius: 'var(--radius-sketch)', padding: '0.5rem var(--spacing-3)', opacity: r.active ? 1 : 0.55 }}>
            <div className="flex items-center justify-between">
              <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>{r.title}</span>
              <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '0.9rem' }}>
                {formatMoney(r.amount, r.currencyCode)}
              </span>
            </div>
            <div className="flex items-center justify-between" style={{ marginTop: '0.15rem' }}>
              <span className="label-sm">
                {r.interval === 'monthly' ? `каждое ${r.dayOfMonth}-е` : `по ${WEEKDAYS_SHORT[(r.weekday ?? 1) - 1]}`} ·{' '}
                {r.autoRecord ? 'авто' : 'напоминание'} · {accountName.get(r.toAccountId) ?? ''}
              </span>
              {canEdit && (
                <span className="flex" style={{ gap: '0.5rem' }}>
                  {!r.autoRecord && r.active && (
                    <button className="label-sm" title="Записать сейчас" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--secondary)' }} onClick={() => recordNow(r)}>▶</button>
                  )}
                  <button className="label-sm" title={r.active ? 'Пауза' : 'Включить'} style={{ background: 'none', border: 'none', cursor: 'pointer' }} onClick={() => toggleActive(r)}>
                    {r.active ? '⏸' : '▶️'}
                  </button>
                  <button className="label-sm" title="Удалить" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', fontWeight: 700 }} onClick={() => remove(r)}>×</button>
                </span>
              )}
            </div>
          </div>
        ))}
        {rules.length === 0 && !adding && <p className="label-md">Подписки и аренда запишутся сами — добавьте первый повтор.</p>}
      </div>
    </div>
  );
}

function NewRecurringForm({ accounts, categories, bookId, onDone }: { accounts: FinAccountDto[]; categories: FinAccountDto[]; bookId: string | null; onDone: () => void }) {
  const [kind, setKind] = useState<'expense' | 'income'>('expense');
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [moneyId, setMoneyId] = useState('');
  const [catId, setCatId] = useState('');
  const [interval, setIntervalV] = useState<'monthly' | 'weekly'>('monthly');
  const [day, setDay] = useState('1');
  const [autoRecord, setAutoRecord] = useState(true);
  const [busy, setBusy] = useState(false);

  const money = accounts.filter((a) => a.kind === 'asset');
  const cats = categories.filter((c) => c.kind === kind && !c.archived);

  const submit = async () => {
    const minor = parseMoneyInput(amount);
    const from = kind === 'expense' ? moneyId || money[0]?.id : catId || cats[0]?.id;
    const to = kind === 'expense' ? catId || cats[0]?.id : moneyId || money[0]?.id;
    if (!title.trim() || !minor || !from || !to || busy) return;
    setBusy(true);
    try {
      await api.post('/finance/recurring', {
        title: title.trim(),
        fromAccountId: from,
        toAccountId: to,
        amount: minor,
        interval,
        ...(interval === 'monthly' ? { dayOfMonth: Math.min(31, Math.max(1, Number(day) || 1)) } : { weekday: Math.min(7, Math.max(1, Number(day) || 1)) }),
        autoRecord,
      }, bookId ? { params: { bookId } } : undefined);
      onDone();
    } catch (e) {
      alert(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wash-secondary" style={{ padding: 'var(--spacing-4)', marginBottom: 'var(--spacing-4)' }}>
      <div className="flex" style={{ gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-3)' }}>
        {([['expense', 'Расход'], ['income', 'Доход']] as Array<['expense' | 'income', string]>).map(([k, label]) => (
          <button key={k} onClick={() => setKind(k)} style={{ border: 'none', cursor: 'pointer', padding: '0.2rem 0.8rem', borderRadius: 'var(--radius-sketch)', fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: '0.75rem', background: kind === k ? 'var(--surface-container-lowest)' : 'transparent' }}>
            {label}
          </button>
        ))}
      </div>
      <input className="input-sketch" placeholder="Аренда, Netflix, зарплата…" value={title} onChange={(e) => setTitle(e.target.value)} />
      <div className="grid grid-cols-2" style={{ gap: 'var(--spacing-3)', marginTop: 'var(--spacing-3)' }}>
        <input className="input-sketch" inputMode="decimal" placeholder="Сумма" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <select className="input-sketch" value={moneyId} onChange={(e) => setMoneyId(e.target.value)}>
          {money.map((a) => <option key={a.id} value={a.id}>{a.icon ? `${a.icon} ` : ''}{a.name}</option>)}
        </select>
        <select className="input-sketch" value={catId} onChange={(e) => setCatId(e.target.value)} style={{ gridColumn: '1 / -1' }}>
          {cats.map((c) => <option key={c.id} value={c.id}>{c.parentId ? '  ' : ''}{c.icon ? `${c.icon} ` : ''}{c.name}</option>)}
        </select>
        <select className="input-sketch" value={interval} onChange={(e) => setIntervalV(e.target.value as 'monthly' | 'weekly')}>
          <option value="monthly">Каждый месяц</option>
          <option value="weekly">Каждую неделю</option>
        </select>
        <input className="input-sketch" inputMode="numeric" placeholder={interval === 'monthly' ? 'День месяца' : 'День недели 1–7'} value={day} onChange={(e) => setDay(e.target.value)} />
      </div>
      <label className="label-sm" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: 'var(--spacing-3)', cursor: 'pointer' }}>
        <input type="checkbox" checked={autoRecord} onChange={(e) => setAutoRecord(e.target.checked)} />
        записывать автоматически (иначе — напоминание с кнопкой)
      </label>
      <button className="btn-primary" style={{ marginTop: 'var(--spacing-4)', padding: '0.45rem 1.4rem', fontSize: '0.85rem' }} onClick={submit} disabled={busy}>
        Создать повтор
      </button>
    </div>
  );
}
