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
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Task } from '@superapp/shared';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { useMentionsUnread } from '@/lib/hooks/useMentionsUnread';
import {
  fetchTaskStats, taskStatsKey,
  fetchTasks, tasksListKey,
  fetchIncomingInvitations, incomingInvitationsKey,
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

function greeting(): string {
  const h = new Date().getHours();
  if (h < 6) return 'Доброй ночи';
  if (h < 12) return 'Доброе утро';
  if (h < 18) return 'Добрый день';
  return 'Добрый вечер';
}

/** Текущий месяц в формате периода отчёта финансов (YYYY-MM). */
function currentPeriod(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export default function DashboardPage() {
  const { isReady, user: profile } = useRequireAuth();
  const period = useMemo(currentPeriod, []);

  const { data: stats } = useQuery({ queryKey: taskStatsKey, queryFn: fetchTaskStats, enabled: isReady });
  const mentionsUnread = useMentionsUnread(isReady);

  const { data: todayTasks } = useQuery({
    queryKey: tasksListKey({ smartList: 'today', limit: 5 }),
    queryFn: () => fetchTasks({ smartList: 'today', limit: 5 }),
    enabled: isReady,
  });

  const { data: chats = [] } = useQuery({ queryKey: messengerChatsKey, queryFn: listChats, enabled: isReady });
  const unreadChats = chats.filter((c) => c.unreadCount > 0);
  const unreadTotal = unreadChats.reduce((s, c) => s + c.unreadCount, 0);

  const { data: invites = [] } = useQuery({
    queryKey: incomingInvitationsKey,
    queryFn: fetchIncomingInvitations,
    enabled: isReady,
  });

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
            {new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })}
          </div>
          <h1 className="title-lg" style={{ margin: 0 }}>
            {greeting()}, {profile.firstName}
          </h1>
        </div>

        {/* Тариф — в шапке справа: это статус аккаунта, а не рабочий показатель.
            Клик уводит в раздел подписки профиля. */}
        <Link href="/profile/subscription" style={{ display: 'inline-flex' }} aria-label="Подписка">
          {profile.activeSubscription ? (
            <Chip
              tone={profile.activeSubscription.status === 'trial' ? 'warning' : 'success'}
              icon="crown"
            >
              {profile.activeSubscription.plan}
              {profile.activeSubscription.status === 'trial' ? ' · пробный' : ''}
            </Chip>
          ) : (
            <Chip tone="neutral" icon="crown">Тариф не подключён</Chip>
          )}
        </Link>
      </div>

      <BentoGrid>
        {/* ---------- Ряд показателей ---------- */}
        {/* Ноль — это тоже ответ («на сегодня чисто»), поэтому показываем число,
            а прочерк оставляем только на время загрузки. */}
        <StatTile span={3} label="Задачи сегодня" value={stats?.today ?? '—'} icon="sun" tone="accent" href="/tasks/today" />
        <StatTile span={3} label="Просрочено" value={stats?.overdue ?? '—'} icon="overdue" tone={stats?.overdue ? 'danger' : 'neutral'} href="/tasks/overdue" />
        <StatTile span={3} label="Непрочитанных" value={unreadTotal} icon="messenger" tone={unreadTotal ? 'success' : 'neutral'} href="/messenger" />
        <StatTile span={3} label="Упоминания" value={mentionsUnread} icon="mentions" tone={mentionsUnread ? 'warning' : 'neutral'} href="/mentions" />

        {/* ---------- Сегодня ---------- */}
        <Card span={8}>
          <CardHeader
            title="Сегодня"
            subtitle={stats?.onReview ? `${stats.onReview} на проверке у вас` : undefined}
            actions={<Button variant="ghost" size="sm" href="/tasks/today" iconRight="caretRight">Все задачи</Button>}
          />
          {todayTasks?.items?.length ? (
            <div style={{ display: 'grid', gap: '0.375rem' }}>
              {todayTasks.items.slice(0, 5).map((t: Task) => (
                <Link
                  key={t.id}
                  href={`/tasks/${t.id}`}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '0.625rem',
                    padding: '0.625rem 0.75rem', borderRadius: 'var(--radius-md)',
                    color: 'var(--on-surface)', border: '1px solid var(--divider)',
                  }}
                >
                  <Icon name={t.status === 'done' ? 'checkCircle' : 'tasks'} size={17} style={{ color: 'var(--muted)' }} />
                  <span className="title-sm" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.title}
                  </span>
                  {t.priority === 'urgent' && <Chip size="sm" tone="danger">Срочно</Chip>}
                  {t.priority === 'high' && <Chip size="sm" tone="warning">Высокий</Chip>}
                </Link>
              ))}
            </div>
          ) : (
            <EmptyState
              icon="sun"
              title="На сегодня задач нет"
              description="Свободный день — или всё уже сделано."
              action={<Button variant="primary" tone="success" icon="add" href="/tasks/inbox">Новая задача</Button>}
            />
          )}
        </Card>

        {/* ---------- Деньги ---------- */}
        <Card span={4}>
          <CardHeader
            title="Месяц"
            actions={<Button variant="ghost" size="sm" href="/finance" iconRight="caretRight">Финансы</Button>}
          />
          {expense || income ? (
            <>
              <div className="label-caps">Расходы</div>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.75rem', fontWeight: 800, letterSpacing: '-0.02em' }}>
                {expense ? formatMoney(expense.amount, expense.currencyCode) : '—'}
              </div>
              {income && (
                <div className="body-sm" style={{ marginTop: '0.25rem' }}>
                  Доходы: {formatMoney(income.amount, income.currencyCode)}
                </div>
              )}
              {burn !== null && (
                <div style={{ marginTop: 'var(--spacing-4)' }}>
                  <TickBar
                    label="Израсходовано от дохода"
                    value={burn}
                    showValue
                    tone={burn > 90 ? 'danger' : burn > 70 ? 'warning' : 'success'}
                  />
                </div>
              )}
            </>
          ) : (
            <EmptyState icon="finance" title="Пока нет записей" description="Заведите первую операцию — и месяц появится здесь." />
          )}
        </Card>

        {/* ---------- Непрочитанное ---------- */}
        {unreadChats.length > 0 && (
          <Card span={6}>
            <CardHeader title="Непрочитанные" actions={<Button variant="ghost" size="sm" href="/messenger" iconRight="caretRight">Мессенджер</Button>} />
            <div style={{ display: 'grid', gap: '0.375rem' }}>
              {unreadChats.slice(0, 4).map((c) => (
                <Link
                  key={c.id}
                  href={`/messenger?chat=${c.id}`}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-md)', color: 'var(--on-surface)', border: '1px solid var(--divider)' }}
                >
                  <Icon name="messenger" size={17} style={{ color: 'var(--muted)' }} />
                  <span className="title-sm" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.title || 'Диалог'}
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
              title="Приглашения"
              subtitle="Люди хотят добавить вас в своё окружение"
              actions={<Button variant="ghost" size="sm" href="/circles" iconRight="caretRight">Окружение</Button>}
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
            <span className="label-caps">Роли</span>
            {profile.roles.slice(0, 4).map((r, i) => (
              <Chip key={i} size="sm" tone="neutral">{r.role}</Chip>
            ))}
            {profile.roles.length > 4 && <Chip size="sm" tone="neutral">+{profile.roles.length - 4}</Chip>}
            {profile.roles.length === 0 && <Chip size="sm" tone="neutral">нет</Chip>}
            <Icon name="caretRight" size={14} style={{ marginLeft: 'auto', color: 'var(--label)' }} />
          </Link>
          <Divider style={{ margin: 'var(--spacing-3) 0' }} />
          <div style={{ display: 'flex', gap: 'var(--spacing-6)', flexWrap: 'wrap' }} className="meta">
            <span>В окружении: {profile.circlesCount ?? 0}</span>
            <span>Организаций: {profile.workspacesCount ?? 0}</span>
          </div>
        </Card>
      </BentoGrid>
    </>
  );
}
