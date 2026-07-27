'use client';

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { FinAccountDto, FinBudgetDto, FinMonthReportDto } from '@superapp/shared';
import { api, apiErrorMessage } from '@/lib/api';
import {
  financeMonthReportKey,
  financeTrendKey,
  financePeopleReportKey,
  fetchFinanceMonthReport,
  fetchFinanceTrend,
  fetchFinancePeopleReport,
} from '@/lib/queries';
import {
  Alert, BentoGrid, Button, Card, CardHeader, Divider, EmptyState, IconButton, Input,
  Modal, StatTile, TickBar,
} from '@/components/ui';
import { formatMoney, localToday, parseMoneyInput } from './finance-lib';
import { BudgetBar, FinGlyph, FinList, FinRow, Money, MoneyStack, budgetProgress } from './finance-ui';
import { PersonChip } from '../circles/PersonCard';
import { ShareCardModal } from '../messenger/ShareCardModal';

const shiftPeriod = (period: string, delta: number): string => {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
};

const periodLabel = (period: string): string => {
  const label = new Date(`${period}-01T00:00:00`).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
  return label.charAt(0).toUpperCase() + label.slice(1);
};

/** Вкладка «Отчёт»: план-факт месяца + доходы + платежи по долгам + тренд. */
export function ReportView({
  categories,
  bookId,
  queryBookId,
  canEdit,
}: {
  categories: FinAccountDto[];
  /** id книги (для ссылки карточки «Итоги месяца»). */
  bookId: string | null;
  /** параметр bookId для запросов (null = моя книга). */
  queryBookId: string | null;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const [period, setPeriod] = useState(localToday().slice(0, 7));
  const [shareMonth, setShareMonth] = useState(false);
  const [budgetFor, setBudgetFor] = useState<{ category: FinAccountDto; budget?: FinBudgetDto } | null>(null);

  const { data: report } = useQuery({
    queryKey: financeMonthReportKey(period, queryBookId),
    queryFn: () => fetchFinanceMonthReport(period, queryBookId),
  });
  const { data: trend } = useQuery({
    queryKey: financeTrendKey(6, queryBookId),
    queryFn: () => fetchFinanceTrend(6, queryBookId),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['finance'] });

  const expenseRoots = useMemo(() => categories.filter((c) => c.kind === 'expense' && !c.parentId), [categories]);
  const incomeCats = useMemo(() => categories.filter((c) => c.kind === 'income'), [categories]);
  const childrenOf = useMemo(() => {
    const map = new Map<string, FinAccountDto[]>();
    for (const c of categories) {
      if (!c.parentId) continue;
      map.set(c.parentId, [...(map.get(c.parentId) ?? []), c]);
    }
    return map;
  }, [categories]);

  const spendMap = useMemo(() => {
    const map = new Map<string, Map<string, number>>(); // categoryId → currency → amount
    for (const row of report?.expenseByCategory ?? []) {
      const cur = map.get(row.categoryId) ?? new Map<string, number>();
      cur.set(row.currencyCode, (cur.get(row.currencyCode) ?? 0) + row.amount);
      map.set(row.categoryId, cur);
    }
    return map;
  }, [report]);

  /** own + children per currency */
  const rolledUp = (rootId: string): Array<[string, number]> => {
    const totals = new Map<string, number>();
    const ids = [rootId, ...(childrenOf.get(rootId) ?? []).map((c) => c.id)];
    for (const id of ids) {
      for (const [code, amount] of spendMap.get(id) ?? []) {
        totals.set(code, (totals.get(code) ?? 0) + amount);
      }
    }
    return [...totals.entries()];
  };

  const budgetsByCat = useMemo(() => {
    const map = new Map<string, FinBudgetDto>();
    for (const b of report?.budgets ?? []) map.set(b.categoryAccountId, b);
    return map;
  }, [report]);

  const incomeSum = (catId: string): Array<[string, number]> =>
    (report?.incomeByCategory ?? [])
      .filter((r) => r.categoryId === catId)
      .map((r) => [r.currencyCode, r.amount] as [string, number]);

  const incomeRows = incomeCats
    .map((cat) => ({ cat, sums: incomeSum(cat.id) }))
    .filter((x) => x.sums.length > 0);

  const debtPayments = report?.debtPayments ?? [];

  return (
    <>
      {/* ---------- Переключатель месяца ---------- */}
      <Card small style={{ marginBottom: 'var(--gap-grid)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--spacing-3)' }}>
          <IconButton icon="caretLeft" label="Предыдущий месяц" onClick={() => setPeriod((p) => shiftPeriod(p, -1))} />
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 }}>
            <span className="title-md">{periodLabel(period)}</span>
            {bookId && (
              <IconButton
                icon="messenger"
                label="Отправить итоги месяца в чат"
                size={30}
                onClick={() => setShareMonth(true)}
              />
            )}
          </div>
          <IconButton icon="caretRight" label="Следующий месяц" onClick={() => setPeriod((p) => shiftPeriod(p, 1))} />
        </div>
      </Card>

      {shareMonth && bookId && (
        <ShareCardModal
          refType="fin_month"
          refId={`${bookId}:${period}`}
          title="Отправить итоги месяца в чат"
          onClose={() => setShareMonth(false)}
        />
      )}

      <BentoGrid>
        {/* ---------- Итоги месяца ---------- */}
        <StatTile
          span={debtPayments.length > 0 ? 4 : 6}
          label="Расходы"
          value={<MoneyStack sums={report?.totalExpense ?? []} sign="−" tone="danger" />}
          icon="trendDown"
          tone={(report?.totalExpense?.length ?? 0) > 0 ? 'danger' : 'neutral'}
        />
        <StatTile
          span={debtPayments.length > 0 ? 4 : 6}
          label="Доходы"
          value={<MoneyStack sums={report?.totalIncome ?? []} sign="+" tone="success" />}
          icon="trendUp"
          tone={(report?.totalIncome?.length ?? 0) > 0 ? 'success' : 'neutral'}
        />
        {debtPayments.length > 0 && (
          <StatTile
            span={4}
            label="Платежи по долгам"
            value={<MoneyStack sums={debtPayments} />}
            icon="debt"
            tone="accent"
          />
        )}

        {/* ---------- Расходы по категориям ---------- */}
        <Card span={7}>
          <CardHeader title="Расходы по категориям" subtitle="Лимит родителя считает и подкатегории" />
          {expenseRoots.length > 0 ? (
            <div style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
              {expenseRoots.map((root) => (
                <CategoryReportRow
                  key={root.id}
                  category={root}
                  sums={rolledUp(root.id)}
                  childrenRows={(childrenOf.get(root.id) ?? [])
                    .map((child) => ({ cat: child, sums: [...(spendMap.get(child.id) ?? [])] as Array<[string, number]> }))
                    .filter((c) => c.sums.length > 0)}
                  budget={budgetsByCat.get(root.id)}
                  childBudgets={(childrenOf.get(root.id) ?? []).map((c) => budgetsByCat.get(c.id)).filter(Boolean) as FinBudgetDto[]}
                  canEdit={canEdit}
                  onEditBudget={(category, budget) => setBudgetFor({ category, budget })}
                />
              ))}
            </div>
          ) : (
            <EmptyState icon="receipt" title="Нет категорий расходов" description="Дерево категорий живёт в разделе «Категории»." />
          )}
        </Card>

        {/* ---------- Доходы ---------- */}
        <Card span={5}>
          <CardHeader title="Доходы" />
          {incomeRows.length > 0 ? (
            <FinList>
              {incomeRows.map(({ cat, sums }) => (
                <FinRow
                  key={cat.id}
                  glyph={cat.icon ?? 'coins'}
                  glyphTone="success"
                  glyphFallback="coins"
                  title={cat.name}
                  right={
                    <span style={{ display: 'grid' }}>
                      {sums.map(([code, amount]) => (
                        <Money key={code} minor={amount} code={code} sign="+" tone="success" />
                      ))}
                    </span>
                  }
                />
              ))}
            </FinList>
          ) : (
            <EmptyState icon="coins" title="Доходов не записано" description="В этом месяце поступлений нет." />
          )}
        </Card>

        {/* ---------- По людям ---------- */}
        <PeopleReportSection period={period} queryBookId={queryBookId} />

        {/* ---------- Тренд ---------- */}
        <Card span={12}>
          <CardHeader title="Динамика, 6 месяцев" subtitle="Длина штриховой шкалы сравнима внутри одной валюты" />
          <TrendBars trend={trend ?? []} />
        </Card>
      </BentoGrid>

      {budgetFor && canEdit && (
        <BudgetModal
          category={budgetFor.category}
          budget={budgetFor.budget}
          period={period}
          queryBookId={queryBookId}
          onClose={() => setBudgetFor(null)}
          onDone={() => { setBudgetFor(null); invalidate(); }}
        />
      )}
    </>
  );
}

function PeopleReportSection({ period, queryBookId }: { period: string; queryBookId: string | null }) {
  const [y, m] = period.split('-').map(Number);
  const from = `${period}-01`;
  const to = `${period}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
  const { data: rows = [] } = useQuery({
    queryKey: financePeopleReportKey(from, to, queryBookId),
    queryFn: () => fetchFinancePeopleReport(from, to, queryBookId),
  });
  if (rows.length === 0) return null;
  return (
    <Card span={12}>
      <CardHeader
        title="По людям"
        subtitle="Сколько потратили «на кого» и получили «от кого» — видно только тем, у кого есть доступ к книге"
      />
      <FinList>
        {rows.map((r) => (
          <FinRow
            key={r.userId}
            title={<PersonChip size="M" userId={r.userId} firstName={r.name} avatar={r.avatar} />}
            right={
              <span style={{ display: 'grid' }}>
                {r.spent.length > 0 && (
                  <MoneyLine sums={r.spent} sign="−" tone="danger" />
                )}
                {r.received.length > 0 && (
                  <MoneyLine sums={r.received} sign="+" tone="success" />
                )}
              </span>
            }
          />
        ))}
      </FinList>
    </Card>
  );
}

function MoneyLine({
  sums,
  sign,
  tone,
}: {
  sums: Array<{ currencyCode: string; amount: number }>;
  sign: '+' | '−';
  tone: 'success' | 'danger';
}) {
  return (
    <span>
      {sums.map((s) => (
        <Money key={s.currencyCode} minor={s.amount} code={s.currencyCode} sign={sign} tone={tone} />
      ))}
    </span>
  );
}

function CategoryReportRow({
  category,
  sums,
  childrenRows,
  budget,
  childBudgets,
  canEdit,
  onEditBudget,
}: {
  category: FinAccountDto;
  sums: Array<[string, number]>;
  childrenRows: Array<{ cat: FinAccountDto; sums: Array<[string, number]> }>;
  budget?: FinBudgetDto;
  childBudgets: FinBudgetDto[];
  canEdit: boolean;
  onEditBudget: (category: FinAccountDto, budget?: FinBudgetDto) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasActivity = sums.length > 0 || !!budget || childBudgets.length > 0;
  if (!hasActivity && category.archived) return null;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
        <FinGlyph glyph={category.icon} fallback="receipt" size={30} />
        {childrenRows.length > 0 ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="title-sm"
            style={{
              flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: '0.25rem',
              background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--on-surface)', textAlign: 'left',
            }}
          >
            {category.name}
            <span className="label-sm">· {childrenRows.length}</span>
          </button>
        ) : (
          <span className="title-sm" style={{ flex: 1, minWidth: 0 }}>{category.name}</span>
        )}
        <span style={{ flex: 'none' }}>
          {sums.length === 0 ? (
            <span className="label-sm">—</span>
          ) : (
            sums.map(([code, amount]) => <Money key={code} minor={amount} code={code} />)
          )}
        </span>
      </div>

      <BudgetLine
        category={category}
        budget={budget}
        canEdit={canEdit}
        onEdit={onEditBudget}
      />

      {expanded && childrenRows.length > 0 && (
        <div style={{ marginTop: 'var(--spacing-3)', display: 'grid', gap: 'var(--spacing-3)', paddingLeft: '2.375rem' }}>
          {childrenRows.map(({ cat, sums: childSums }) => (
            <div key={cat.id}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '0.5rem' }}>
                <span className="body-sm" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                  {cat.icon && <span aria-hidden>{cat.icon}</span>}
                  {cat.name}
                </span>
                <span>
                  {childSums.map(([code, amount]) => <Money key={code} minor={amount} code={code} size="0.8125rem" />)}
                </span>
              </div>
              <BudgetLine
                category={cat}
                budget={childBudgets.find((b) => b.categoryAccountId === cat.id)}
                canEdit={canEdit}
                onEdit={onEditBudget}
                small
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BudgetLine({
  category,
  budget,
  canEdit,
  onEdit,
  small,
}: {
  category: FinAccountDto;
  budget?: FinBudgetDto;
  canEdit: boolean;
  onEdit: (category: FinAccountDto, budget?: FinBudgetDto) => void;
  small?: boolean;
}) {
  if (!budget) {
    if (!canEdit) return null;
    return (
      <div style={{ marginTop: '0.25rem' }}>
        <Button variant="ghost" size="sm" icon="target" onClick={() => onEdit(category)}>Задать лимит</Button>
      </div>
    );
  }

  const { pct, over } = budgetProgress(budget.spent, budget.amount);

  return (
    <div style={{ marginTop: '0.375rem' }}>
      <BudgetBar spent={budget.spent} amount={budget.amount} small={small} />
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '0.5rem', marginTop: '0.25rem' }}>
        <span className="label-sm" style={{ color: over ? 'var(--danger)' : undefined, fontWeight: over ? 700 : undefined }}>
          {formatMoney(budget.spent, budget.currencyCode)} из {formatMoney(budget.amount, budget.currencyCode)} · {Math.min(150, pct)}%
        </span>
        {canEdit && (
          <Button variant="ghost" size="sm" icon="edit" onClick={() => onEdit(category, budget)}>Изменить</Button>
        )}
      </div>
    </div>
  );
}

function BudgetModal({
  category,
  budget,
  period,
  queryBookId,
  onClose,
  onDone,
}: {
  category: FinAccountDto;
  budget?: FinBudgetDto;
  period: string;
  queryBookId: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [value, setValue] = useState(budget ? String(budget.amount / 100) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (amount: number | null) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.put(
        '/finance/budgets',
        { period, categoryAccountId: category.id, amount },
        queryBookId ? { params: { bookId: queryBookId } } : undefined,
      );
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
      title={`Лимит: ${category.name}`}
      subtitle="Предупредим при 80% и 100% от лимита"
      size="sm"
      footer={
        <>
          {budget && (
            <Button variant="primary" tone="danger" icon="delete" onClick={() => save(null)} loading={busy}>Убрать</Button>
          )}
          <Button variant="ghost" onClick={onClose}>Отмена</Button>
          <Button variant="primary" tone="success" icon="save" onClick={() => save(parseMoneyInput(value))} loading={busy}>
            Сохранить
          </Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
        {error && <Alert tone="danger" onClose={() => setError(null)}>{error}</Alert>}
        <Input
          label="Лимит на месяц"
          inputMode="decimal"
          placeholder="150 000"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
        />
        {budget && (
          <div className="label-sm">
            Уже израсходовано: {formatMoney(budget.spent, budget.currencyCode)}
          </div>
        )}
      </div>
    </Modal>
  );
}

function TrendBars({
  trend,
}: {
  trend: Array<{ period: string; expense: Array<{ currencyCode: string; amount: number }>; income: Array<{ currencyCode: string; amount: number }> }>;
}) {
  const currencies = useMemo(() => {
    const set = new Set<string>();
    for (const p of trend) {
      for (const e of p.expense) set.add(e.currencyCode);
      for (const i of p.income) set.add(i.currencyCode);
    }
    return [...set];
  }, [trend]);

  if (currencies.length === 0) {
    return <EmptyState icon="chart" title="Пока нет данных" description="Динамика появится со вторым месяцем записей." />;
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--spacing-6)' }}>
      {currencies.map((code) => {
        const max = Math.max(
          1,
          ...trend.flatMap((p) => [
            p.expense.find((e) => e.currencyCode === code)?.amount ?? 0,
            p.income.find((i) => i.currencyCode === code)?.amount ?? 0,
          ]),
        );
        return (
          <div key={code}>
            {currencies.length > 1 && <div className="label-caps" style={{ marginBottom: 'var(--spacing-3)' }}>{code}</div>}
            <div style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
              {trend.map((p) => {
                const exp = p.expense.find((e) => e.currencyCode === code)?.amount ?? 0;
                const inc = p.income.find((i) => i.currencyCode === code)?.amount ?? 0;
                const month = new Date(`${p.period}-01T00:00:00`).toLocaleDateString('ru-RU', { month: 'long' });
                return (
                  <div key={p.period} style={{ display: 'grid', gridTemplateColumns: '5.5rem 1fr', gap: 'var(--spacing-3)', alignItems: 'center' }}>
                    <span className="label-sm" style={{ textTransform: 'capitalize' }}>{month}</span>
                    {exp === 0 && inc === 0 ? (
                      /* Пустой месяц: две шкалы по нулям читались бы как «данные есть» */
                      <span className="label-sm" style={{ color: 'var(--muted)' }}>записей нет</span>
                    ) : (
                      <div style={{ display: 'grid', gap: '0.375rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)' }}>
                          <TickBar
                            value={(exp / max) * 100}
                            tone="danger"
                            height={9}
                            style={{ flex: 1 }}
                            aria-label={`Расходы за ${month}`}
                          />
                          <Money minor={exp} code={code} sign="−" tone="danger" size="0.75rem" bold={600} />
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)' }}>
                          <TickBar
                            value={(inc / max) * 100}
                            tone="success"
                            height={9}
                            style={{ flex: 1 }}
                            aria-label={`Доходы за ${month}`}
                          />
                          <Money minor={inc} code={code} sign="+" tone="success" size="0.75rem" bold={600} />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      <Divider style={{ margin: 0 }} />
      <div className="meta">Красные штрихи — расходы, зелёные — доходы</div>
    </div>
  );
}

export type { FinMonthReportDto };
