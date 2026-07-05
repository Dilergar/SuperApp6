'use client';

// ============================================================
// «Обзор» — главная Финансов (/finance): картина месяца одним экраном.
// Балансы, доходы/расходы месяца, лимиты, ближайшие платежи, последние
// операции. Собирается из уже существующих запросов — без новых API.
// ============================================================

import Link from 'next/link';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { FinAccountDto } from '@superapp/shared';
import {
  financeMonthReportKey,
  fetchFinanceMonthReport,
  financeDebtsKey,
  fetchFinanceDebts,
  financeRecurringKey,
  fetchFinanceRecurring,
  financeRecentTxKey,
  fetchFinanceTransactions,
} from '@/lib/queries';
import { WEEKDAYS_SHORT, formatDayLabel, formatMoney, localToday } from './finance-lib';
import { txPresentation } from './finance-feed';
import { BudgetBar, budgetProgress } from './finance-ui';
import { useFinanceBook } from './finance-shell';

export default function FinanceOverviewPage() {
  const { bookId, accounts, categories, canEdit, withBook } = useFinanceBook();

  const period = localToday().slice(0, 7);
  const monthName = new Date(`${period}-01T00:00:00`).toLocaleDateString('ru-RU', { month: 'long' });

  const { data: report } = useQuery({
    queryKey: financeMonthReportKey(period, bookId),
    queryFn: () => fetchFinanceMonthReport(period, bookId),
  });
  const { data: debts = [] } = useQuery({
    queryKey: financeDebtsKey(bookId),
    queryFn: () => fetchFinanceDebts(bookId),
  });
  const { data: recurring = [] } = useQuery({
    queryKey: financeRecurringKey(bookId),
    queryFn: () => fetchFinanceRecurring(bookId),
  });
  const { data: recent } = useQuery({
    queryKey: financeRecentTxKey(bookId),
    queryFn: () => fetchFinanceTransactions(bookId ? { bookId } : {}),
  });

  const accountById = useMemo(() => {
    const map = new Map<string, FinAccountDto>();
    for (const a of accounts) map.set(a.id, a);
    for (const c of categories) map.set(c.id, c);
    return map;
  }, [accounts, categories]);

  // «На счетах» — активы по валютам
  const totals = useMemo(() => {
    const byCur = new Map<string, number>();
    for (const a of accounts.filter((x) => x.kind === 'asset')) {
      byCur.set(a.currencyCode, (byCur.get(a.currencyCode) ?? 0) + a.balance);
    }
    return [...byCur.entries()];
  }, [accounts]);

  // Ближайшие платежи: открытые долги (день платежа) + активные повторы
  const upcoming = useMemo(() => {
    const now = new Date();
    const todayDay = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const jsWeekday = ((now.getDay() + 6) % 7) + 1; // 1=пн … 7=вс
    const untilMonthday = (day: number) => (day >= todayDay ? day - todayDay : daysInMonth - todayDay + day);

    const items: Array<{ key: string; icon: string; title: string; when: string; days: number; amount: number; code: string; href: string }> = [];
    for (const d of debts.filter((x) => !x.closedAt && !x.archived)) {
      items.push({
        key: `debt-${d.accountId}`,
        icon: d.icon ?? '💳',
        title: d.name,
        when: `до ${d.dueDay}-го`,
        days: untilMonthday(d.dueDay),
        amount: Math.min(d.monthly, d.remaining),
        code: d.currencyCode,
        href: '/finance/debts',
      });
    }
    for (const r of recurring.filter((x) => x.active)) {
      if (r.interval === 'monthly') {
        const day = r.dayOfMonth ?? 1;
        items.push({
          key: `rec-${r.id}`, icon: '🔁', title: r.title, when: `каждое ${day}-е`,
          days: untilMonthday(day), amount: r.amount, code: r.currencyCode, href: '/finance/recurring',
        });
      } else {
        const wd = r.weekday ?? 1;
        items.push({
          key: `rec-${r.id}`, icon: '🔁', title: r.title, when: `по ${WEEKDAYS_SHORT[wd - 1]}`,
          days: (wd - jsWeekday + 7) % 7, amount: r.amount, code: r.currencyCode, href: '/finance/recurring',
        });
      }
    }
    return items.sort((a, b) => a.days - b.days).slice(0, 6);
  }, [debts, recurring]);

  // Лимиты месяца — топ по «съеденности»
  const budgets = useMemo(() => {
    return (report?.budgets ?? [])
      .map((b) => ({
        ...b,
        name: accountById.get(b.categoryAccountId)?.name ?? 'Категория',
        icon: accountById.get(b.categoryAccountId)?.icon ?? null,
        pct: budgetProgress(b.spent, b.amount).pct,
      }))
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 5);
  }, [report, accountById]);

  const recentTx = (recent?.items ?? []).slice(0, 6);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-6)' }}>
      {/* Итоги: на счетах / расходы / доходы */}
      <div className="grid sm:grid-cols-3" style={{ gap: 'var(--spacing-4)' }}>
        <SummaryCard label="На счетах" rotate="-0.35deg">
          {totals.length === 0 ? (
            <span className="label-md">Счетов пока нет</span>
          ) : (
            totals.map(([code, sum]) => (
              <div key={code} style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '1.45rem', color: sum < 0 ? 'var(--danger)' : 'var(--on-surface)' }}>
                {formatMoney(sum, code)}
              </div>
            ))
          )}
        </SummaryCard>
        <SummaryCard label={`Расходы · ${monthName}`} rotate="0.3deg">
          {(report?.totalExpense?.length ?? 0) === 0 ? (
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '1.45rem' }}>—</span>
          ) : (
            (report?.totalExpense ?? []).map((s) => (
              <div key={s.currencyCode} style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '1.45rem', color: 'var(--danger)' }}>
                −{formatMoney(s.amount, s.currencyCode)}
              </div>
            ))
          )}
        </SummaryCard>
        <SummaryCard label={`Доходы · ${monthName}`} rotate="-0.2deg">
          {(report?.totalIncome?.length ?? 0) === 0 ? (
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '1.45rem' }}>—</span>
          ) : (
            (report?.totalIncome ?? []).map((s) => (
              <div key={s.currencyCode} style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '1.45rem', color: 'var(--success)' }}>
                +{formatMoney(s.amount, s.currencyCode)}
              </div>
            ))
          )}
        </SummaryCard>
      </div>

      <div className="grid lg:grid-cols-2" style={{ gap: 'var(--spacing-6)', alignItems: 'start' }}>
        {/* Ближайшие платежи */}
        <div className="card" style={{ transform: 'rotate(-0.25deg)' }}>
          <div className="flex items-center justify-between" style={{ marginBottom: 'var(--spacing-4)' }}>
            <h2 className="title-md">Ближайшие платежи</h2>
            <Link href={withBook('/finance/debts')} className="label-sm" style={{ color: 'var(--secondary)', textDecoration: 'none' }}>
              Долги →
            </Link>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
            {upcoming.map((u) => (
              <Link
                key={u.key}
                href={withBook(u.href)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--spacing-3)',
                  background: 'var(--surface-container-lowest)',
                  borderRadius: 'var(--radius-sketch)',
                  padding: '0.5rem var(--spacing-4)',
                  textDecoration: 'none',
                  color: 'var(--on-surface)',
                }}
              >
                <span style={{ fontSize: '1.05rem' }}>{u.icon}</span>
                <span style={{ flex: 1, minWidth: 0, fontWeight: 600, fontSize: '0.9rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {u.title}
                </span>
                <span className="label-sm">{u.when}</span>
                <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '0.9rem' }}>
                  {formatMoney(u.amount, u.code)}
                </span>
              </Link>
            ))}
            {upcoming.length === 0 && (
              <p className="label-md">
                Платежей не намечается. Рассрочки и подписки появятся здесь — из{' '}
                <Link href={withBook('/finance/debts')} style={{ color: 'var(--secondary)' }}>Долгов</Link> и{' '}
                <Link href={withBook('/finance/recurring')} style={{ color: 'var(--secondary)' }}>Повторов</Link>.
              </p>
            )}
          </div>
        </div>

        {/* Лимиты месяца */}
        <div className="card" style={{ transform: 'rotate(0.25deg)' }}>
          <div className="flex items-center justify-between" style={{ marginBottom: 'var(--spacing-4)' }}>
            <h2 className="title-md">Лимиты месяца</h2>
            <Link href={withBook('/finance/reports')} className="label-sm" style={{ color: 'var(--secondary)', textDecoration: 'none' }}>
              Отчёты →
            </Link>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)' }}>
            {budgets.map((b) => {
              const { over } = budgetProgress(b.spent, b.amount);
              return (
                <div key={b.categoryAccountId}>
                  <div className="flex items-center justify-between" style={{ marginBottom: '0.2rem' }}>
                    <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>{b.icon ? `${b.icon} ` : ''}{b.name}</span>
                    <span className="label-sm" style={{ color: over ? 'var(--danger)' : undefined, fontWeight: over ? 700 : undefined }}>
                      {formatMoney(b.spent, b.currencyCode)} из {formatMoney(b.amount, b.currencyCode)}
                    </span>
                  </div>
                  <BudgetBar spent={b.spent} amount={b.amount} />
                </div>
              );
            })}
            {budgets.length === 0 && (
              <p className="label-md">
                Лимитов пока нет.{' '}
                {canEdit && (
                  <>Задайте их категориям в{' '}
                    <Link href={withBook('/finance/reports')} style={{ color: 'var(--secondary)' }}>Отчётах</Link>
                    {' '}— предупредим при 80% и 100%.
                  </>
                )}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Последние операции */}
      <div className="card" style={{ transform: 'rotate(-0.15deg)' }}>
        <div className="flex items-center justify-between" style={{ marginBottom: 'var(--spacing-4)' }}>
          <h2 className="title-md">Последние операции</h2>
          <Link href={withBook('/finance/feed')} className="label-sm" style={{ color: 'var(--secondary)', textDecoration: 'none' }}>
            Вся лента →
          </Link>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
          {recentTx.map((tx) => {
            const p = txPresentation(tx, accountById);
            return (
              <div
                key={tx.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--spacing-3)',
                  background: 'var(--surface-container-lowest)',
                  borderRadius: 'var(--radius-sketch)',
                  padding: '0.5rem var(--spacing-4)',
                }}
              >
                <span style={{ fontSize: '1.05rem' }}>{p.icon}</span>
                <span style={{ flex: 1, minWidth: 0, fontWeight: 600, fontSize: '0.9rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.title}
                </span>
                <span className="label-sm">{formatDayLabel(tx.occurredOn)}</span>
                <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '0.9rem', color: p.color }}>
                  {p.sign}{formatMoney(tx.amount, tx.currencyCode)}
                </span>
              </div>
            );
          })}
          {recentTx.length === 0 && (
            <p className="label-md">
              Пока пусто — запишите первую трату в{' '}
              <Link href={withBook('/finance/feed')} style={{ color: 'var(--secondary)' }}>Ленте</Link>.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ label, rotate, children }: { label: string; rotate: string; children: React.ReactNode }) {
  return (
    <div className="card-elevated" style={{ transform: `rotate(${rotate})`, padding: 'var(--spacing-4) var(--spacing-6)' }}>
      <div className="label-sm" style={{ marginBottom: '0.3rem' }}>{label}</div>
      {children}
    </div>
  );
}
