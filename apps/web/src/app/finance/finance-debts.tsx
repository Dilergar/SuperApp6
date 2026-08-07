'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { FinAccountDto, FinDebtDto, FinPersonDto, FinRecurringRuleDto } from '@superapp/shared';
import { apiDelete, apiErrorMessage, apiPatch, apiPost } from '@/lib/api';
import { financeDebtsKey, financeRecurringKey, fetchFinanceDebts, fetchFinanceRecurring } from '@/lib/queries';
import {
  Alert, BentoGrid, Button, Card, CardHeader, Chip, ConfirmDialog, Divider, EmptyState, Field,
  IconButton, Input, Modal, SegmentedControl, Select, StatTile, TickBar, Toggle, type SelectOption,
} from '@/components/ui';
import { WEEKDAYS_SHORT, currencySymbol, formatMoney, parseMoneyInput } from './finance-lib';
import { FinList, FinRow, Money, MoneyStack } from './finance-ui';
import { PersonChip } from '../circles/PersonCard';
import { toastError } from '@/lib/toast';

/** Обёртка выбора вокруг карточки человека (сама карточка — PersonChip, принцип 2). */
function PersonPick({
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
  const [payFor, setPayFor] = useState<FinDebtDto | null>(null);

  const open = debts.filter((d) => !d.closedAt && !d.archived);
  const closed = debts.filter((d) => d.closedAt || d.archived);
  const changed = () => {
    refetch();
    onChanged();
  };

  // Остаток к выплате и платёж этого месяца — по валютам
  const remainingTotals = useMemo(() => {
    const byCur = new Map<string, number>();
    for (const d of open) byCur.set(d.currencyCode, (byCur.get(d.currencyCode) ?? 0) + d.remaining);
    return [...byCur.entries()].map(([currencyCode, amount]) => ({ currencyCode, amount }));
  }, [open]);
  const monthlyTotals = useMemo(() => {
    const byCur = new Map<string, number>();
    for (const d of open) byCur.set(d.currencyCode, (byCur.get(d.currencyCode) ?? 0) + Math.min(d.monthly, d.remaining));
    return [...byCur.entries()].map(([currencyCode, amount]) => ({ currencyCode, amount }));
  }, [open]);

  return (
    <>
      <BentoGrid>
        <StatTile span={4} label="Осталось выплатить" value={<MoneyStack sums={remainingTotals} tone={remainingTotals.length ? 'danger' : undefined} />} icon="debt" tone={remainingTotals.length ? 'danger' : 'neutral'} />
        <StatTile span={4} label="Платёж в месяц" value={<MoneyStack sums={monthlyTotals} />} icon="calendarCheck" tone="warning" />
        <StatTile span={4} label="Открытых долгов" value={open.length} icon="list" tone={open.length ? 'accent' : 'success'} />

        <Card span={12}>
          <CardHeader
            title="Долги"
            subtitle="Рассрочки и кредиты: «Оплатить» списывает платёж со счёта"
            actions={
              canEdit ? (
                <Button variant="primary" tone="success" size="sm" icon="add" onClick={() => setAdding(true)}>Долг</Button>
              ) : undefined
            }
          />

          {open.length > 0 ? (
            <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
              {open.map((d) => {
                const paidPct = d.total > 0 ? Math.min(100, Math.round(((d.total - d.remaining) / d.total) * 100)) : 0;
                return (
                  <div key={d.accountId}>
                    <FinRow
                      glyph={d.icon ?? 'debt'}
                      glyphTone="danger"
                      title={d.name}
                      subtitle={`${d.paidMonths} из ${d.months} · по ${formatMoney(d.monthly, d.currencyCode)} · до ${d.dueDay}-го`}
                      actions={
                        canEdit ? (
                          <Button variant="primary" tone="success" size="sm" icon="check" onClick={() => setPayFor(d)}>
                            Оплатить
                          </Button>
                        ) : undefined
                      }
                      right={<Money minor={d.remaining} code={d.currencyCode} tone="danger" size="1rem" />}
                    />
                    <div style={{ padding: '0.5rem 0.75rem 0' }}>
                      <TickBar value={paidPct} tone="success" height={8} label="Выплачено" showValue />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState
              icon="checkCircle"
              title="Долгов нет"
              description="Так держать. Рассрочку или кредит можно записать в любой момент."
              action={canEdit ? <Button variant="matte" icon="add" onClick={() => setAdding(true)}>Записать долг</Button> : undefined}
            />
          )}

          {closed.length > 0 && (
            <>
              <Divider />
              <div className="label-caps" style={{ marginBottom: 'var(--spacing-2)' }}>Закрытые · {closed.length}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem' }}>
                {closed.map((d) => (
                  <Chip key={d.accountId} size="sm" tone="success" emoji={d.icon} icon={d.icon ? undefined : 'checkCircle'}>
                    {d.name}
                  </Chip>
                ))}
              </div>
            </>
          )}
        </Card>
      </BentoGrid>

      {adding && canEdit && (
        <NewDebtModal
          accounts={accounts}
          categories={categories}
          people={people}
          bookId={bookId}
          meId={meId}
          meName={meName}
          onClose={() => setAdding(false)}
          onDone={() => { setAdding(false); changed(); }}
        />
      )}
      {payFor && canEdit && (
        <PayDebtModal
          debt={payFor}
          accounts={accounts}
          bookId={bookId}
          onClose={() => setPayFor(null)}
          onDone={() => { setPayFor(null); changed(); }}
        />
      )}
    </>
  );
}

function NewDebtModal({
  accounts,
  categories,
  people,
  bookId,
  meId,
  meName,
  onClose,
  onDone,
}: {
  accounts: FinAccountDto[];
  categories: FinAccountDto[];
  people: FinPersonDto[];
  bookId: string | null;
  meId: string | null;
  meName: string;
  onClose: () => void;
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
  const [error, setError] = useState<string | null>(null);

  const assets = accounts.filter((a) => a.kind === 'asset');
  const expenseCats = categories.filter((c) => c.kind === 'expense' && !c.archived);
  const monthlyMinor = parseMoneyInput(monthly);
  const monthsNum = Number(months) || 0;
  const total = monthlyMinor && monthsNum ? monthlyMinor * monthsNum : null;
  const totalCurrency = type === 'loan'
    ? assets.find((a) => a.id === (creditAccountId || assets[0]?.id))?.currencyCode ?? 'KZT'
    : assets[0]?.currencyCode ?? 'KZT';

  const submit = async () => {
    if (!name.trim() || !monthlyMinor || !monthsNum || busy) {
      setError(!name.trim() ? 'Укажите название' : 'Укажите платёж и число месяцев');
      return;
    }
    const receivedMinor = received.trim() ? parseMoneyInput(received) : null;
    setBusy(true);
    setError(null);
    try {
      await apiPost('/finance/debts', {
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
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Новый долг"
      subtitle="Рассрочка — покупка: расход запишется сразу полной суммой"
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Отмена</Button>
          <Button variant="primary" tone="success" icon="add" onClick={submit} loading={busy}>Создать долг</Button>
        </>
      }
    >
      <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        {error && <Alert tone="danger" onClose={() => setError(null)}>{error}</Alert>}

        <SegmentedControl
          aria-label="Вид долга"
          value={type}
          onChange={setType}
          items={[
            { key: 'installment', label: 'Рассрочка (покупка)', icon: 'shop' },
            { key: 'loan', label: 'Кредит деньгами', icon: 'savings' },
          ]}
        />

        <Input
          label="Название"
          placeholder={type === 'installment' ? 'Посуда в рассрочку' : 'Кредит наличными'}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 'var(--spacing-3)' }}>
          <Input label="Платёж/мес" inputMode="decimal" placeholder="10 000" value={monthly} onChange={(e) => setMonthly(e.target.value)} />
          <Input label="Месяцев" inputMode="numeric" value={months} onChange={(e) => setMonths(e.target.value)} />
          <Input label="День платежа" inputMode="numeric" value={dueDay} onChange={(e) => setDueDay(e.target.value)} />
        </div>

        {total != null && (
          <Alert tone="accent" icon="info">
            Итого долг: <b>{formatMoney(total, totalCurrency)}</b>
          </Alert>
        )}

        {type === 'installment' ? (
          <>
            <Select
              label="Категория покупки"
              hint="Расход запишется сразу полной суммой — месяц покупки увидит его целиком"
              value={categoryId || expenseCats.filter((c) => !c.parentId)[0]?.id || null}
              onChange={setCategoryId}
              options={expenseCats.filter((c) => !c.parentId).map((c) => ({ value: c.id, label: c.name, emoji: c.icon }))}
            />
            {(meId || people.length > 0) && (
              <Field label="На кого">
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
                  {meId && (
                    <PersonPick
                      selected={personUserId === meId}
                      onClick={() => setPersonUserId((cur) => (cur === meId ? null : meId))}
                      title="На себя"
                    >
                      <PersonChip size="S" userId={meId} firstName={meName} role="Я" />
                    </PersonPick>
                  )}
                  {people.filter((p) => p.userId !== meId).map((p) => (
                    <PersonPick
                      key={p.userId}
                      selected={personUserId === p.userId}
                      onClick={() => setPersonUserId((cur) => (cur === p.userId ? null : p.userId))}
                      title={`На ${p.name}`}
                    >
                      <PersonChip size="S" userId={p.userId} firstName={p.name} avatar={p.avatar} />
                    </PersonPick>
                  ))}
                </div>
              </Field>
            )}
          </>
        ) : (
          <>
            <Select
              label="Куда зачислить деньги"
              value={creditAccountId || assets[0]?.id || null}
              onChange={setCreditAccountId}
              options={assets.map((a) => ({ value: a.id, label: a.name, emoji: a.icon, hint: currencySymbol(a.currencyCode) }))}
            />
            <Input
              label="Получено на руки"
              hint="Если меньше итога — разница уйдёт в «Проценты по кредитам»"
              inputMode="decimal"
              placeholder="по умолчанию — весь итог"
              value={received}
              onChange={(e) => setReceived(e.target.value)}
            />
          </>
        )}
      </div>
    </Modal>
  );
}

function PayDebtModal({
  debt,
  accounts,
  bookId,
  onClose,
  onDone,
}: {
  debt: FinDebtDto;
  accounts: FinAccountDto[];
  bookId: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const sameCurrency = accounts.filter((a) => a.kind === 'asset' && a.currencyCode === debt.currencyCode);
  const [fromId, setFromId] = useState(sameCurrency[0]?.id ?? '');
  const defaultPay = Math.min(debt.monthly, debt.remaining);
  const [amount, setAmount] = useState(String(defaultPay / 100));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const minor = parseMoneyInput(amount);
    if (!minor || !fromId || busy) {
      setError(!fromId ? `Нет счёта в ${currencySymbol(debt.currencyCode)}` : 'Укажите сумму');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/finance/debts/${debt.accountId}/pay`, { fromAccountId: fromId, amount: minor }, bookId ? { params: { bookId } } : undefined);
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
      title={`Платёж: ${debt.name}`}
      subtitle={`Осталось ${formatMoney(debt.remaining, debt.currencyCode)}`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Отмена</Button>
          <Button variant="primary" tone="success" icon="check" onClick={submit} loading={busy}>Оплачено</Button>
        </>
      }
    >
      <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        {error && <Alert tone="danger" onClose={() => setError(null)}>{error}</Alert>}
        <Select
          label="Со счёта"
          value={fromId || null}
          onChange={setFromId}
          options={sameCurrency.map((a) => ({ value: a.id, label: a.name, emoji: a.icon, hint: formatMoney(a.balance, a.currencyCode) }))}
          placeholder="Счёт…"
        />
        <Input label={`Сумма · ${currencySymbol(debt.currencyCode)}`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
      </div>
    </Modal>
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
  const [removing, setRemoving] = useState<FinRecurringRuleDto | null>(null);
  const [busy, setBusy] = useState(false);
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
      await apiPatch(`/finance/recurring/${r.id}`, { active: !r.active }, cfg);
      changed();
    } catch (e) {
      toastError(apiErrorMessage(e));
    }
  };
  const recordNow = async (r: FinRecurringRuleDto) => {
    try {
      await apiPost(`/finance/recurring/${r.id}/record-now`, {}, cfg);
      changed();
    } catch (e) {
      toastError(apiErrorMessage(e));
    }
  };
  const remove = async () => {
    if (!removing || busy) return;
    setBusy(true);
    try {
      await apiDelete(`/finance/recurring/${removing.id}`, cfg);
      setRemoving(null);
      changed();
    } catch (e) {
      toastError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const active = rules.filter((r) => r.active);

  return (
    <>
      <BentoGrid>
        <StatTile span={6} label="Активных повторов" value={active.length} icon="refresh" tone={active.length ? 'accent' : 'neutral'} />
        <StatTile span={6} label="Записываются сами" value={active.filter((r) => r.autoRecord).length} icon="bolt" tone="success" />

        <Card span={12}>
          <CardHeader
            title="Повторы"
            subtitle="Аренда, подписки, зарплата — запишутся сами или напомнят"
            actions={
              canEdit ? (
                <Button variant="primary" tone="success" size="sm" icon="add" onClick={() => setAdding(true)}>Повтор</Button>
              ) : undefined
            }
          />

          {rules.length > 0 ? (
            <FinList>
              {rules.map((r) => (
                <FinRow
                  key={r.id}
                  glyph="refresh"
                  glyphTone={r.active ? 'accent' : 'neutral'}
                  title={
                    <>
                      <span style={{ opacity: r.active ? 1 : 0.6 }}>{r.title}</span>
                      {!r.active && <Chip size="sm" tone="neutral">пауза</Chip>}
                      <Chip size="sm" tone={r.autoRecord ? 'success' : 'warning'}>
                        {r.autoRecord ? 'авто' : 'напоминание'}
                      </Chip>
                    </>
                  }
                  subtitle={`${r.interval === 'monthly' ? `каждое ${r.dayOfMonth}-е` : `по ${WEEKDAYS_SHORT[(r.weekday ?? 1) - 1]}`} · ${accountName.get(r.toAccountId) ?? ''}`}
                  actions={
                    canEdit ? (
                      <>
                        {!r.autoRecord && r.active && (
                          <IconButton icon="play" label="Записать сейчас" size={28} onClick={() => recordNow(r)} />
                        )}
                        <IconButton
                          icon={r.active ? 'stop' : 'play'}
                          label={r.active ? 'Поставить на паузу' : 'Включить'}
                          size={28}
                          onClick={() => toggleActive(r)}
                        />
                        <IconButton icon="delete" label="Удалить" size={28} onClick={() => setRemoving(r)} />
                      </>
                    ) : undefined
                  }
                  right={<Money minor={r.amount} code={r.currencyCode} />}
                />
              ))}
            </FinList>
          ) : (
            <EmptyState
              icon="refresh"
              title="Повторов нет"
              description="Подписки и аренда запишутся сами — добавьте первый повтор."
              action={canEdit ? <Button variant="primary" tone="success" icon="add" onClick={() => setAdding(true)}>Добавить повтор</Button> : undefined}
            />
          )}
        </Card>
      </BentoGrid>

      {adding && canEdit && (
        <NewRecurringModal
          accounts={accounts}
          categories={categories}
          bookId={bookId}
          onClose={() => setAdding(false)}
          onDone={() => { setAdding(false); changed(); }}
        />
      )}

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={remove}
        title={removing ? `Удалить «${removing.title}»?` : 'Удалить повтор?'}
        message="Записанные ранее операции останутся — исчезнет только правило."
        confirmLabel="Удалить"
        danger
        loading={busy}
      />
    </>
  );
}

function NewRecurringModal({
  accounts,
  categories,
  bookId,
  onClose,
  onDone,
}: {
  accounts: FinAccountDto[];
  categories: FinAccountDto[];
  bookId: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [kind, setKind] = useState<'expense' | 'income'>('expense');
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [moneyId, setMoneyId] = useState('');
  const [catId, setCatId] = useState('');
  const [interval, setIntervalV] = useState<'monthly' | 'weekly'>('monthly');
  const [day, setDay] = useState('1');
  const [autoRecord, setAutoRecord] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const money = accounts.filter((a) => a.kind === 'asset');
  const cats = categories.filter((c) => c.kind === kind && !c.archived);

  const catOptions: SelectOption[] = cats.map((c) => ({
    value: c.id,
    label: c.name,
    emoji: c.icon,
    hint: c.parentId ? categories.find((p) => p.id === c.parentId)?.name : undefined,
  }));

  const submit = async () => {
    const minor = parseMoneyInput(amount);
    const from = kind === 'expense' ? moneyId || money[0]?.id : catId || cats[0]?.id;
    const to = kind === 'expense' ? catId || cats[0]?.id : moneyId || money[0]?.id;
    if (!title.trim() || !minor || !from || !to || busy) {
      setError(!title.trim() ? 'Укажите название' : !minor ? 'Укажите сумму' : 'Выберите счёт и категорию');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiPost('/finance/recurring', {
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
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Новый повтор"
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Отмена</Button>
          <Button variant="primary" tone="success" icon="add" onClick={submit} loading={busy}>Создать повтор</Button>
        </>
      }
    >
      <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        {error && <Alert tone="danger" onClose={() => setError(null)}>{error}</Alert>}

        <SegmentedControl
          aria-label="Вид повтора"
          value={kind}
          onChange={(k) => { setKind(k); setCatId(''); }}
          items={[
            { key: 'expense', label: 'Расход', icon: 'trendDown' },
            { key: 'income', label: 'Доход', icon: 'trendUp' },
          ]}
        />

        <Input label="Название" placeholder="Аренда, Netflix, зарплата…" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--spacing-3)' }}>
          <Input label="Сумма" inputMode="decimal" placeholder="2 500" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <Select
            label="Счёт"
            value={moneyId || money[0]?.id || null}
            onChange={setMoneyId}
            options={money.map((a) => ({ value: a.id, label: a.name, emoji: a.icon, hint: currencySymbol(a.currencyCode) }))}
          />
          <Select
            label={kind === 'expense' ? 'Категория' : 'Источник'}
            value={catId || cats[0]?.id || null}
            onChange={setCatId}
            options={catOptions}
          />
          <Select
            label="Как часто"
            value={interval}
            onChange={(v) => setIntervalV(v as 'monthly' | 'weekly')}
            options={[
              { value: 'monthly', label: 'Каждый месяц', icon: 'calendar' },
              { value: 'weekly', label: 'Каждую неделю', icon: 'refresh' },
            ]}
          />
          <Input
            label={interval === 'monthly' ? 'День месяца' : 'День недели (1–7)'}
            inputMode="numeric"
            value={day}
            onChange={(e) => setDay(e.target.value)}
          />
        </div>

        <Toggle
          checked={autoRecord}
          onChange={setAutoRecord}
          label="Записывать автоматически"
          description="Выключено — придёт напоминание с кнопкой «Записать сейчас»"
        />
      </div>
    </Modal>
  );
}
