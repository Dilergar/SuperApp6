'use client';

// ============================================================
// «Обзор» — главная Финансов (/finance): картина месяца одним экраном.
// Балансы, доходы/расходы месяца, лимиты, ближайшие платежи, последние
// операции. Собирается из уже существующих запросов — без новых API.
// ============================================================

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
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
import {
  BentoGrid, Button, Card, CardHeader, EmptyState, PageHeader, StatTile,
} from '@/components/ui';
import { weekdaysShortIso, useDayLabel, formatMoney, localToday } from './finance-lib';
import { txPresentation } from './finance-feed';
import { BudgetBar, FinList, FinRow, Money, MoneyStack, budgetProgress } from './finance-ui';
import { useFinanceBook } from './finance-shell';
import { useFormatters } from '@/lib/format';

export default function FinanceOverviewPage() {
  const { bookId, accounts, categories, canEdit, withBook } = useFinanceBook();
  const t = useTranslations('finance');
  const f = useFormatters();
  const dayLabel = useDayLabel();

  const period = localToday().slice(0, 7);
  const monthName = f.month(`${period}-01`);
  const weekdays = useMemo(() => weekdaysShortIso(f), [f]);

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
    return [...byCur.entries()].map(([currencyCode, amount]) => ({ currencyCode, amount }));
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
        icon: d.icon ?? 'card',
        title: d.name,
        when: t('overview.byDay', { day: d.dueDay }),
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
          key: `rec-${r.id}`, icon: 'refresh', title: r.title, when: t('recurring.everyMonthDay', { day }),
          days: untilMonthday(day), amount: r.amount, code: r.currencyCode, href: '/finance/recurring',
        });
      } else {
        const wd = r.weekday ?? 1;
        items.push({
          key: `rec-${r.id}`, icon: 'refresh', title: r.title, when: t('recurring.everyWeekday', { weekday: weekdays[wd - 1] }),
          days: (wd - jsWeekday + 7) % 7, amount: r.amount, code: r.currencyCode, href: '/finance/recurring',
        });
      }
    }
    return items.sort((a, b) => a.days - b.days).slice(0, 6);
  }, [debts, recurring, t, weekdays]);

  // Лимиты месяца — топ по «съеденности»
  const budgets = useMemo(() => {
    return (report?.budgets ?? [])
      .map((b) => ({
        ...b,
        name: accountById.get(b.categoryAccountId)?.name ?? t('card.category'),
        icon: accountById.get(b.categoryAccountId)?.icon ?? null,
        pct: budgetProgress(b.spent, b.amount).pct,
      }))
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 5);
  }, [report, accountById, t]);

  const recentTx = (recent?.items ?? []).slice(0, 6);
  const expense = report?.totalExpense ?? [];
  const income = report?.totalIncome ?? [];

  return (
    <>
      <PageHeader
        breadcrumb={t('breadcrumb')}
        title={t('overview.title')}
        description={t('overview.description')}
        actions={
          canEdit ? (
            <Button variant="primary" tone="success" icon="add" href={withBook('/finance/feed')}>
              {t('feed.recordTitle')}
            </Button>
          ) : undefined
        }
      />

      <BentoGrid>
        {/* ---------- Ряд показателей ---------- */}
        <StatTile
          span={4}
          label={t('accounts.totalLabel')}
          value={<MoneyStack sums={totals} />}
          icon="savings"
          tone="accent"
          href={withBook('/finance/accounts')}
        />
        <StatTile
          span={4}
          label={`${t('categories.expense')} · ${monthName}`}
          value={<MoneyStack sums={expense} sign="−" tone="danger" />}
          icon="trendDown"
          tone={expense.length ? 'danger' : 'neutral'}
          href={withBook('/finance/reports')}
        />
        <StatTile
          span={4}
          label={`${t('categories.income')} · ${monthName}`}
          value={<MoneyStack sums={income} sign="+" tone="success" />}
          icon="trendUp"
          tone={income.length ? 'success' : 'neutral'}
          href={withBook('/finance/reports')}
        />

        {/* ---------- Ближайшие платежи ---------- */}
        <Card span={6}>
          <CardHeader
            title={t('overview.upcoming')}
            actions={
              <Button variant="ghost" size="sm" href={withBook('/finance/debts')} iconRight="caretRight">
                {t('debts.title')}
              </Button>
            }
          />
          {upcoming.length > 0 ? (
            <FinList>
              {upcoming.map((u) => (
                <FinRow
                  key={u.key}
                  glyph={u.icon}
                  glyphFallback="card"
                  title={u.title}
                  subtitle={u.when}
                  right={<Money minor={u.amount} code={u.code} />}
                  href={withBook(u.href)}
                />
              ))}
            </FinList>
          ) : (
            <EmptyState
              icon="calendarCheck"
              title={t('overview.noUpcoming')}
              description={t('overview.noUpcomingHint')}
              action={
                canEdit ? (
                  <Button variant="matte" size="sm" icon="debt" href={withBook('/finance/debts')}>
                    {t('debts.add')}
                  </Button>
                ) : undefined
              }
            />
          )}
        </Card>

        {/* ---------- Лимиты месяца ---------- */}
        <Card span={6}>
          <CardHeader
            title={t('overview.budgets')}
            actions={
              <Button variant="ghost" size="sm" href={withBook('/finance/reports')} iconRight="caretRight">
                {t('reports.title')}
              </Button>
            }
          />
          {budgets.length > 0 ? (
            <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
              {budgets.map((b) => {
                const { over } = budgetProgress(b.spent, b.amount);
                return (
                  <div key={b.categoryAccountId}>
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '0.5rem', marginBottom: '0.375rem' }}>
                      <span className="title-sm">{b.name}</span>
                      <span className="label-sm" style={{ color: over ? 'var(--danger)' : undefined, fontWeight: over ? 700 : undefined }}>
                        {t('report.spentOf', {
                          spent: formatMoney(b.spent, b.currencyCode),
                          limit: formatMoney(b.amount, b.currencyCode),
                        })}
                      </span>
                    </div>
                    <BudgetBar spent={b.spent} amount={b.amount} />
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState
              icon="target"
              title={t('overview.noBudgets')}
              description={t(canEdit ? 'overview.noBudgetsHint' : 'overview.noBudgetsViewer')}
              action={
                canEdit ? (
                  <Button variant="matte" size="sm" icon="chart" href={withBook('/finance/reports')}>
                    {t('overview.openReports')}
                  </Button>
                ) : undefined
              }
            />
          )}
        </Card>

        {/* ---------- Последние операции ---------- */}
        <Card span={12}>
          <CardHeader
            title={t('overview.recent')}
            actions={
              <Button variant="ghost" size="sm" href={withBook('/finance/feed')} iconRight="caretRight">
                {t('overview.wholeFeed')}
              </Button>
            }
          />
          {recentTx.length > 0 ? (
            <div className="density-compact">
              <FinList>
                {recentTx.map((tx) => {
                  const p = txPresentation(tx, accountById, t);
                  return (
                    <FinRow
                      key={tx.id}
                      glyph={p.icon}
                      glyphTone={p.tone}
                      glyphFallback="receipt"
                      title={p.title}
                      subtitle={dayLabel(tx.occurredOn)}
                      right={<Money minor={tx.amount} code={tx.currencyCode} sign={p.sign} tone={p.tone === 'danger' ? 'danger' : p.tone === 'success' ? 'success' : undefined} />}
                      href={withBook('/finance/feed')}
                    />
                  );
                })}
              </FinList>
            </div>
          ) : (
            <EmptyState
              icon="receipt"
              title={t('coins.feedEmptyTitle')}
              description={t('overview.emptyFeedHint')}
              action={
                canEdit ? (
                  <Button variant="primary" tone="success" icon="add" href={withBook('/finance/feed')}>
                    {t('feed.recordTitle')}
                  </Button>
                ) : undefined
              }
            />
          )}
        </Card>
      </BentoGrid>
    </>
  );
}
