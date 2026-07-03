'use client';

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { FinAccountDto, FinBudgetDto, FinMonthReportDto } from '@superapp/shared';
import { api } from '@/lib/api';
import {
  financeMonthReportKey,
  financeTrendKey,
  financePeopleReportKey,
  fetchFinanceMonthReport,
  fetchFinanceTrend,
  fetchFinancePeopleReport,
} from '@/lib/queries';
import { formatMoney, localToday, parseMoneyInput } from './finance-lib';
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-6)' }}>
      {/* Месяц + итоги */}
      <div className="card-elevated" style={{ transform: 'rotate(-0.2deg)' }}>
        <div className="flex items-center justify-between" style={{ marginBottom: 'var(--spacing-4)' }}>
          <button className="btn-secondary" style={{ padding: '0.2rem 0.7rem', fontSize: '0.8rem' }} onClick={() => setPeriod((p) => shiftPeriod(p, -1))}>←</button>
          <div className="flex items-center" style={{ gap: 'var(--spacing-3)' }}>
            <h2 className="title-md">{periodLabel(period)}</h2>
            {bookId && (
              <button
                title="Отправить итоги месяца в чат"
                onClick={() => setShareMonth(true)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1rem' }}
              >
                💬
              </button>
            )}
          </div>
          <button className="btn-secondary" style={{ padding: '0.2rem 0.7rem', fontSize: '0.8rem' }} onClick={() => setPeriod((p) => shiftPeriod(p, 1))}>→</button>
        </div>
        {shareMonth && bookId && (
          <ShareCardModal
            refType="fin_month"
            refId={`${bookId}:${period}`}
            title="Отправить итоги месяца в чат"
            onClose={() => setShareMonth(false)}
          />
        )}
        <div className="grid grid-cols-2 md:grid-cols-3" style={{ gap: 'var(--spacing-4)' }}>
          <SummaryCell label="Расходы" sums={report?.totalExpense ?? []} color="var(--danger)" sign="−" />
          <SummaryCell label="Доходы" sums={report?.totalIncome ?? []} color="var(--success)" sign="+" />
          {(report?.debtPayments?.length ?? 0) > 0 && (
            <SummaryCell label="Платежи по долгам" sums={report?.debtPayments ?? []} color="var(--secondary)" sign="" />
          )}
        </div>
      </div>

      {/* Категории план-факт */}
      <div className="card" style={{ transform: 'rotate(0.2deg)' }}>
        <h3 className="title-md" style={{ marginBottom: 'var(--spacing-4)' }}>Расходы по категориям</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)' }}>
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
              period={period}
              categoriesById={new Map(categories.map((c) => [c.id, c]))}
              onChanged={invalidate}
              queryBookId={queryBookId}
              canEdit={canEdit}
            />
          ))}
          {expenseRoots.length === 0 && <p className="label-md">Нет категорий расходов.</p>}
        </div>
      </div>

      {/* Доходы */}
      <div className="card" style={{ transform: 'rotate(-0.15deg)' }}>
        <h3 className="title-md" style={{ marginBottom: 'var(--spacing-4)' }}>Доходы</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
          {incomeCats
            .map((cat) => ({ cat, sums: incomeSum(cat.id) }))
            .filter((x) => x.sums.length > 0)
            .map(({ cat, sums }) => (
              <div key={cat.id} className="flex items-center justify-between" style={{ padding: '0.35rem 0' }}>
                <span style={{ fontWeight: 600 }}>{cat.icon ? `${cat.icon} ` : ''}{cat.name}</span>
                <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--success)' }}>
                  +{sums.map(([code, amount]) => formatMoney(amount, code)).join(' · ')}
                </span>
              </div>
            ))}
          {(report?.totalIncome?.length ?? 0) === 0 && <p className="label-md">В этом месяце доходов не записано.</p>}
        </div>
      </div>

      {/* По людям */}
      <PeopleReportSection period={period} queryBookId={queryBookId} />

      {/* Тренд */}
      <div className="card" style={{ transform: 'rotate(0.25deg)' }}>
        <h3 className="title-md" style={{ marginBottom: 'var(--spacing-4)' }}>Динамика, 6 месяцев</h3>
        <TrendBars trend={trend ?? []} />
      </div>
    </div>
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
    <div className="card" style={{ transform: 'rotate(-0.25deg)' }}>
      <h3 className="title-md" style={{ marginBottom: 'var(--spacing-1)' }}>По людям</h3>
      <p className="label-sm" style={{ marginBottom: 'var(--spacing-4)' }}>Сколько потратили «на кого» и получили «от кого» — видно только тем, у кого есть доступ к книге.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)' }}>
        {rows.map((r) => (
          <div key={r.userId} className="flex items-center justify-between" style={{ gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
            <PersonChip size="M" userId={r.userId} firstName={r.name} avatar={r.avatar} />
            <div style={{ textAlign: 'right' }}>
              {r.spent.length > 0 && (
                <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--danger)' }}>
                  −{r.spent.map((s) => formatMoney(s.amount, s.currencyCode)).join(' · ')}
                </div>
              )}
              {r.received.length > 0 && (
                <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--success)' }}>
                  +{r.received.map((s) => formatMoney(s.amount, s.currencyCode)).join(' · ')}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SummaryCell({ label, sums, color, sign }: { label: string; sums: Array<{ currencyCode: string; amount: number }>; color: string; sign: string }) {
  return (
    <div>
      <div className="label-sm">{label}</div>
      {sums.length === 0 ? (
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '1.2rem' }}>—</div>
      ) : (
        sums.map((s) => (
          <div key={s.currencyCode} style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '1.2rem', color }}>
            {sign}{formatMoney(s.amount, s.currencyCode)}
          </div>
        ))
      )}
    </div>
  );
}

function CategoryReportRow({
  category,
  sums,
  childrenRows,
  budget,
  childBudgets,
  period,
  categoriesById,
  onChanged,
  queryBookId,
  canEdit,
}: {
  category: FinAccountDto;
  sums: Array<[string, number]>;
  childrenRows: Array<{ cat: FinAccountDto; sums: Array<[string, number]> }>;
  budget?: FinBudgetDto;
  childBudgets: FinBudgetDto[];
  period: string;
  categoriesById: Map<string, FinAccountDto>;
  onChanged: () => void;
  queryBookId: string | null;
  canEdit: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasActivity = sums.length > 0 || !!budget || childBudgets.length > 0;
  if (!hasActivity && category.archived) return null;

  return (
    <div style={{ background: 'var(--surface-container-lowest)', borderRadius: 'var(--radius-sketch)', padding: '0.6rem var(--spacing-4)' }}>
      <div className="flex items-center justify-between" style={{ cursor: childrenRows.length ? 'pointer' : 'default' }} onClick={() => setExpanded((v) => !v)}>
        <span style={{ fontWeight: 600 }}>
          {category.icon ? `${category.icon} ` : ''}{category.name}
          {childrenRows.length > 0 && <span className="label-sm" style={{ marginLeft: '0.4rem' }}>{expanded ? '▾' : '▸'}</span>}
        </span>
        <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700 }}>
          {sums.length === 0 ? '—' : sums.map(([code, amount]) => formatMoney(amount, code)).join(' · ')}
        </span>
      </div>

      <BudgetLine categoryId={category.id} budget={budget} period={period} onChanged={onChanged} queryBookId={queryBookId} canEdit={canEdit} />

      {expanded && childrenRows.length > 0 && (
        <div style={{ marginTop: 'var(--spacing-2)', display: 'flex', flexDirection: 'column', gap: '0.3rem', paddingLeft: 'var(--spacing-6)' }}>
          {childrenRows.map(({ cat, sums: childSums }) => (
            <div key={cat.id}>
              <div className="flex items-center justify-between">
                <span className="label-md">{cat.icon ? `${cat.icon} ` : ''}{cat.name}</span>
                <span className="label-md" style={{ fontWeight: 700 }}>
                  {childSums.map(([code, amount]) => formatMoney(amount, code)).join(' · ')}
                </span>
              </div>
              <BudgetLine
                categoryId={cat.id}
                budget={childBudgets.find((b) => b.categoryAccountId === cat.id)}
                period={period}
                onChanged={onChanged}
                queryBookId={queryBookId}
                canEdit={canEdit}
                small
              />
            </div>
          ))}
        </div>
      )}
      {/* Подкатегории с лимитами, но без трат в этом месяце, всё равно доступны из categoriesById — не рендерим, чтобы не шуметь. */}
      {void categoriesById}
    </div>
  );
}

function BudgetLine({
  categoryId,
  budget,
  period,
  onChanged,
  queryBookId,
  canEdit,
  small,
}: {
  categoryId: string;
  budget?: FinBudgetDto;
  period: string;
  onChanged: () => void;
  queryBookId: string | null;
  canEdit: boolean;
  small?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(budget ? String(budget.amount / 100) : '');
  const [busy, setBusy] = useState(false);

  const save = async (amount: number | null) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.put('/finance/budgets', { period, categoryAccountId: categoryId, amount }, queryBookId ? { params: { bookId: queryBookId } } : undefined);
      setEditing(false);
      onChanged();
    } catch (e) {
      alert((e as { response?: { data?: { message?: string } } }).response?.data?.message ?? 'Не удалось сохранить лимит');
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <div className="flex items-center" style={{ gap: 'var(--spacing-2)', marginTop: '0.25rem' }} onClick={(e) => e.stopPropagation()}>
        <input className="input-sketch" inputMode="decimal" placeholder="Лимит на месяц" value={value} onChange={(e) => setValue(e.target.value)} style={{ fontSize: '0.85rem' }} />
        <button className="btn-secondary" style={{ padding: '0.2rem 0.7rem', fontSize: '0.75rem' }} onClick={() => save(parseMoneyInput(value))} disabled={busy}>OK</button>
        {budget && (
          <button className="label-sm" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)' }} onClick={() => save(null)}>убрать</button>
        )}
      </div>
    );
  }

  if (!budget) {
    if (!canEdit) return null;
    return (
      <button
        className="label-sm"
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--secondary)', padding: 0, marginTop: '0.15rem' }}
        onClick={(e) => { e.stopPropagation(); setEditing(true); }}
      >
        задать лимит…
      </button>
    );
  }

  const percent = budget.amount > 0 ? Math.min(150, Math.round((budget.spent / budget.amount) * 100)) : 0;
  const over = budget.spent > budget.amount;
  const warn = !over && budget.spent >= budget.amount * 0.8;
  const barColor = over ? 'var(--danger)' : warn ? 'var(--warning)' : 'var(--success)';

  return (
    <div style={{ marginTop: '0.3rem' }} onClick={(e) => e.stopPropagation()}>
      <div style={{ height: small ? 5 : 7, background: 'var(--surface-container-high)', borderRadius: 999, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${Math.min(100, percent)}%`, background: barColor, borderRadius: 999, transition: 'width 0.3s ease' }} />
      </div>
      <div className="flex items-center justify-between" style={{ marginTop: '0.15rem' }}>
        <span className="label-sm" style={{ color: over ? 'var(--danger)' : undefined, fontWeight: over ? 700 : undefined }}>
          {formatMoney(budget.spent, budget.currencyCode)} из {formatMoney(budget.amount, budget.currencyCode)} · {percent}%
        </span>
        {canEdit && (
          <button
            className="label-sm"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--secondary)' }}
            onClick={() => { setValue(String(budget.amount / 100)); setEditing(true); }}
          >
            изменить
          </button>
        )}
      </div>
    </div>
  );
}

function TrendBars({ trend }: { trend: Array<{ period: string; expense: Array<{ currencyCode: string; amount: number }>; income: Array<{ currencyCode: string; amount: number }> }> }) {
  const currencies = useMemo(() => {
    const set = new Set<string>();
    for (const p of trend) {
      for (const e of p.expense) set.add(e.currencyCode);
      for (const i of p.income) set.add(i.currencyCode);
    }
    return [...set];
  }, [trend]);

  if (currencies.length === 0) return <p className="label-md">Пока нет данных для динамики.</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-6)' }}>
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
            {currencies.length > 1 && <div className="label-sm" style={{ marginBottom: 'var(--spacing-2)' }}>{code}</div>}
            <div className="flex items-end" style={{ gap: 'var(--spacing-3)', height: 120 }}>
              {trend.map((p) => {
                const exp = p.expense.find((e) => e.currencyCode === code)?.amount ?? 0;
                const inc = p.income.find((i) => i.currencyCode === code)?.amount ?? 0;
                return (
                  <div key={p.period} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.25rem', height: '100%', justifyContent: 'flex-end' }}>
                    <div className="flex items-end" style={{ gap: 3, height: '100%' }} title={`−${formatMoney(exp, code)} / +${formatMoney(inc, code)}`}>
                      <div style={{ width: 14, height: `${Math.max(2, (exp / max) * 100)}%`, background: 'var(--primary-container)', borderRadius: '4px 4px 0 0' }} />
                      <div style={{ width: 14, height: `${Math.max(2, (inc / max) * 100)}%`, background: 'rgba(45,122,58,0.35)', borderRadius: '4px 4px 0 0' }} />
                    </div>
                    <span className="label-sm" style={{ fontSize: '0.65rem' }}>
                      {new Date(`${p.period}-01T00:00:00`).toLocaleDateString('ru-RU', { month: 'short' })}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      <div className="label-sm">розовый — расходы · зелёный — доходы</div>
    </div>
  );
}

export type { FinMonthReportDto };
