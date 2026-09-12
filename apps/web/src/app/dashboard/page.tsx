'use client';

// ============================================================
// Главная — бенто из ЖИВЫХ данных.
//
// Раньше это была витрина сервисов, то есть второе меню: теперь меню живёт в
// сайдбаре, и дублировать его целым экраном незачем. Главная отвечает на один
// вопрос — «что требует меня прямо сейчас».
//
// Новых ручек API не заводим: всё собирается из уже существующих загрузчиков
// (lib/queries, messenger-api), поэтому запросы делятся кэшем со страницами
// сервисов и не удваивают трафик.
// ============================================================

import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import type { Task } from '@superapp/shared';
import { useFormatters } from '@/lib/format';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { useNotificationCounts } from '@/lib/hooks/useNotificationCounts';
import { useApprovalsCount } from '@/lib/hooks/useApprovalsCount';
import { useEntitlements } from '@/lib/hooks/useEntitlements';
import { PlanStatusChip } from '@/components/entitlements';

// Стопка решений — лениво: она нужна только по клику по плитке.
const DecisionStack = dynamic(
  () => import('@/components/approvals/DecisionStack').then((m) => m.DecisionStack),
  { ssr: false },
);
import {
  fetchTaskStats, taskStatsKey,
  fetchTasks, tasksListKey,
  incomingInvitationsInfinite,
  fetchFinanceMonthReport, financeMonthReportKey,
  messengerChatsKey,
} from '@/lib/queries';
import { listChats } from '@/lib/messenger-api';
import { formatMoney } from '../finance/finance-lib';
import { PersonChip } from '../circles/PersonCard';
import { WorkspacesPanel } from './WorkspacesPanel';
import {
  BentoGrid, Button, Card, CardHeader, Chip, Divider, EmptyState,
  Icon, LoadingBlock, StatTile, TickBar,
} from '@/components/ui';

/** Личная Главная спрашивает движок решений только про личное (см. ApprovalScope) */
const PERSONAL_SCOPE = { personal: true } as const;

/** Время суток → КЛЮЧ приветствия; слово подставляет каталог. */
function greetingKey(): string {
  const h = new Date().getHours();
  if (h < 6) return 'greeting.night';
  if (h < 12) return 'greeting.morning';
  if (h < 18) return 'greeting.day';
  return 'greeting.evening';
}

/** Текущий месяц в формате периода отчёта финансов (YYYY-MM). */
function currentPeriod(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export default function DashboardPage() {
  const t = useTranslations('dashboard');
  const ta = useTranslations('approvals');
  const f = useFormatters();
  // Чип тарифа в шапке — из снимка core/entitlements (профиль подписку больше не несёт)
  const entitlements = useEntitlements();
  const { isReady, user: profile } = useRequireAuth();
  const period = useMemo(currentPeriod, []);

  const { data: stats } = useQuery({ queryKey: taskStatsKey, queryFn: fetchTaskStats, enabled: isReady });
  const notifCounts = useNotificationCounts(isReady);
  // Главная — витрина ЛИЧНОГО контекста, поэтому и решения здесь только личные:
  // у человека с несколькими компаниями иначе на личной странице копятся чужие
  // заявления и приказы. Сквозной вид живёт в топбаре — галочка видна отсюда же.
  const approvalsCount = useApprovalsCount(isReady, PERSONAL_SCOPE);
  const [stackOpen, setStackOpen] = useState(false);

  const { data: todayTasks } = useQuery({
    queryKey: tasksListKey({ smartList: 'today', limit: 5 }),
    queryFn: () => fetchTasks({ smartList: 'today', limit: 5 }),
    enabled: isReady,
  });

  const { data: chats = [] } = useQuery({ queryKey: messengerChatsKey, queryFn: listChats, enabled: isReady });
  const unreadChats = chats.filter((c) => c.unreadCount > 0);
  const unreadTotal = unreadChats.reduce((s, c) => s + c.unreadCount, 0);

  // Панель показывает ПЕРВУЮ страницу ТОЙ ЖЕ ленты, что «Моё окружение»:
  // описание запроса одно (incomingInvitationsInfinite), поэтому ключ и форма
  // кэша разъехаться не могут. Обычный useQuery на этом ключе писал плоскую
  // страницу и ронял /circles при клиентском переходе с Главной.
  const { data: invitesData } = useInfiniteQuery({
    ...incomingInvitationsInfinite(),
    enabled: isReady,
  });
  const invites = invitesData?.pages[0]?.items ?? [];

  // Финансы: книга создаётся лениво, поэтому у нового человека отчёта может не
  // быть вовсе — тихо показываем прочерк, а не ошибку на главной.
  const { data: month } = useQuery({
    queryKey: financeMonthReportKey(period),
    queryFn: () => fetchFinanceMonthReport(period),
    enabled: isReady,
    retry: false,
  });

  if (!isReady || !profile) return <LoadingBlock />;

  const expense = month?.totalExpense?.[0];
  const income = month?.totalIncome?.[0];
  // Доля израсходованного от дохода — грубый, но честный «пульс» месяца
  const burn = expense && income && income.amount > 0
    ? Math.min(100, Math.round((expense.amount / income.amount) * 100))
    : null;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 'var(--spacing-4)', flexWrap: 'wrap', marginBottom: 'var(--spacing-6)' }}>
        <div>
          <div className="label-caps" style={{ marginBottom: '0.375rem' }}>
            {f.date(new Date(), 'weekday')}
          </div>
          <h1 className="title-lg" style={{ margin: 0 }}>
            {t('greeting.line', { greeting: t(greetingKey()), name: profile.firstName })}
          </h1>
        </div>

        {/* Тариф — в шапке справа: это статус аккаунта, а не рабочий показатель.
            Клик уводит в раздел подписки профиля. */}
        <Link href="/profile/subscription" style={{ display: 'inline-flex' }} aria-label={t('subscription.aria')}>
          {entitlements.data ? <PlanStatusChip snapshot={entitlements.data} /> : <Chip tone="neutral" icon="crown">{t('subscription.none')}</Chip>}
        </Link>
      </div>

      <BentoGrid>
        {/* ---------- Ряд показателей ---------- */}
        {/* Ноль — это тоже ответ («на сегодня чисто»), поэтому показываем число,
            а прочерк оставляем только на время загрузки. */}
        <StatTile span={3} label={t('tiles.tasksToday')} value={stats?.today ?? '—'} icon="sun" tone="accent" href="/tasks/today" />
        <StatTile span={3} label={t('tiles.overdue')} value={stats?.overdue ?? '—'} icon="overdue" tone={stats?.overdue ? 'danger' : 'neutral'} href="/tasks/overdue" />
        {/* Плитка решений занимает место «Непрочитанных», только когда что-то
            действительно ждёт: пустая строка «0» на Главной — это шум, а Главная
            отвечает ровно на один вопрос — «что требует меня прямо сейчас». */}
        {approvalsCount > 0 ? (
          <StatTile
            span={3}
            label={ta('inboxTitle')}
            value={approvalsCount}
            icon="checkCircle"
            tone="accent"
            // Не ссылка: стопка разбирается модалкой, не уходя с Главной.
            onClick={() => setStackOpen(true)}
          />
        ) : (
          <StatTile span={3} label={t('tiles.unread')} value={unreadTotal} icon="messenger" tone={unreadTotal ? 'success' : 'neutral'} href="/messenger" />
        )}
        <StatTile span={3} label={t('tiles.notifications')} value={notifCounts.unseen} icon="bell" tone={notifCounts.unseen ? 'accent' : 'neutral'} href="/notifications" />

        {/* ---------- Сегодня ---------- */}
        <Card span={8}>
          <CardHeader
            title={t('today.title')}
            subtitle={stats?.onReview ? t('today.onReview', { n: stats.onReview }) : undefined}
            actions={<Button variant="ghost" size="sm" href="/tasks/today" iconRight="caretRight">{t('today.allTasks')}</Button>}
          />
          {todayTasks?.items?.length ? (
            <div className="ui-stack" style={{ gap: '0.375rem' }}>
              {todayTasks.items.slice(0, 5).map((task: Task) => (
                <Link
                  key={task.id}
                  href={`/tasks/${task.id}`}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '0.625rem',
                    padding: '0.625rem 0.75rem', borderRadius: 'var(--radius-md)',
                    color: 'var(--on-surface)', border: '1px solid var(--divider)',
                  }}
                >
                  <Icon name={task.status === 'done' ? 'checkCircle' : 'tasks'} size={17} style={{ color: 'var(--muted)' }} />
                  <span className="title-sm" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {task.title}
                  </span>
                  {task.priority === 'urgent' && <Chip size="sm" tone="danger">{t('today.urgent')}</Chip>}
                  {task.priority === 'high' && <Chip size="sm" tone="warning">{t('today.high')}</Chip>}
                </Link>
              ))}
            </div>
          ) : (
            <EmptyState
              icon="sun"
              title={t('today.empty')}
              description={t('today.emptyHint')}
              action={<Button variant="primary" tone="success" icon="add" href="/tasks/inbox">{t('today.newTask')}</Button>}
            />
          )}
        </Card>

        {/* ---------- Деньги ---------- */}
        <Card span={4}>
          <CardHeader
            title={t('month.title')}
            actions={<Button variant="ghost" size="sm" href="/finance" iconRight="caretRight">{t('month.finance')}</Button>}
          />
          {expense || income ? (
            <>
              <div className="label-caps">{t('month.expenses')}</div>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.75rem', fontWeight: 800, letterSpacing: '-0.02em' }}>
                {expense ? formatMoney(expense.amount, expense.currencyCode) : '—'}
              </div>
              {income && (
                <div className="body-sm" style={{ marginTop: '0.25rem' }}>
                  {t('month.income', { amount: formatMoney(income.amount, income.currencyCode) })}
                </div>
              )}
              {burn !== null && (
                <div style={{ marginTop: 'var(--spacing-4)' }}>
                  <TickBar
                    label={t('month.burn')}
                    value={burn}
                    showValue
                    tone={burn > 90 ? 'danger' : burn > 70 ? 'warning' : 'success'}
                  />
                </div>
              )}
            </>
          ) : (
            <EmptyState icon="finance" title={t('month.empty')} description={t('month.emptyHint')} />
          )}
        </Card>

        {/* ---------- Непрочитанное ---------- */}
        {unreadChats.length > 0 && (
          <Card span={6}>
            <CardHeader title={t('unread.title')} actions={<Button variant="ghost" size="sm" href="/messenger" iconRight="caretRight">{t('unread.messenger')}</Button>} />
            <div className="ui-stack" style={{ gap: '0.375rem' }}>
              {unreadChats.slice(0, 4).map((c) => (
                <Link
                  key={c.id}
                  href={`/messenger?chat=${c.id}`}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-md)', color: 'var(--on-surface)', border: '1px solid var(--divider)' }}
                >
                  <Icon name="messenger" size={17} style={{ color: 'var(--muted)' }} />
                  <span className="title-sm" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.title || t('unread.dialog')}
                  </span>
                  <Chip size="sm" tone="accent">{c.unreadCount}</Chip>
                </Link>
              ))}
            </div>
          </Card>
        )}

        {/* ---------- Приглашения в окружение ---------- */}
        {invites.length > 0 && (
          <Card span={unreadChats.length > 0 ? 6 : 12}>
            <CardHeader
              title={t('invites.title')}
              subtitle={t('invites.subtitle')}
              actions={<Button variant="ghost" size="sm" href="/circles" iconRight="caretRight">{t('invites.circle')}</Button>}
            />
            {/* Принцип 2: человек — всегда карточкой, не голым текстом
                (от этого зависит видимость платных скинов) */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
              {invites.slice(0, 6).map((i) => (
                <PersonChip
                  key={i.id}
                  size="M"
                  userId={i.from.id}
                  firstName={i.from.firstName}
                  lastName={i.from.lastName}
                  avatar={i.from.avatar}
                  role={i.proposedRoleForRecipient ?? undefined}
                />
              ))}
            </div>
          </Card>
        )}

        {/* ---------- Организации ---------- */}
        <Card span={12}>
          <WorkspacesPanel />
        </Card>

        {/* ---------- Информационная полоска: роли и счётчики ----------
             Справка, а не рабочий инструмент: сжато и по клику уводит в профиль.
             Тариф отсюда переехал в шапку экрана. */}
        <Card span={12} small>
          <Link href="/profile/roles" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', color: 'inherit' }}>
            <span className="label-caps">{t('roles.title')}</span>
            {profile.roles.slice(0, 4).map((r, i) => (
              <Chip key={i} size="sm" tone="neutral">{r.role}</Chip>
            ))}
            {profile.roles.length > 4 && <Chip size="sm" tone="neutral">+{profile.roles.length - 4}</Chip>}
            {profile.roles.length === 0 && <Chip size="sm" tone="neutral">{t('roles.none')}</Chip>}
            <Icon name="caretRight" size={14} style={{ marginLeft: 'auto', color: 'var(--label)' }} />
          </Link>
          <Divider style={{ margin: 'var(--spacing-3) 0' }} />
          <div style={{ display: 'flex', gap: 'var(--spacing-6)', flexWrap: 'wrap' }} className="meta">
            {/* Именно contactsCount: circlesCount — это число ГРУПП, а подпись
                обещает людей (в «Моём окружении» их считают иначе). */}
            <span>{t('counters.circle', { n: profile.contactsCount ?? 0 })}</span>
            <span>{t('counters.workspaces', { n: profile.workspacesCount ?? 0 })}</span>
          </div>
        </Card>
      </BentoGrid>

      {stackOpen && <DecisionStack open onClose={() => setStackOpen(false)} scope={PERSONAL_SCOPE} />}
    </>
  );
}
