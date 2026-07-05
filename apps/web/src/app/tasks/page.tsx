'use client';

// ============================================================
// «Обзор» — дашборд сервиса «Задачи» (модель ClickUp Home / Bitrix24
// «Эффективность», образец вёрстки — finance/page.tsx): быстрый ввод во
// Входящие, счётчик-карточки со ссылками в разделы, мини-списки «Сегодня»
// и «На проверке».
// ============================================================

import Link from 'next/link';
import { useTasksService } from './tasks-shell';
import { QuickAdd, SectionTitle } from './tasks-ui';
import { TaskListSection } from './TaskListSection';

const STAT_CARDS: Array<{ key: 'inbox' | 'today' | 'overdue' | 'onReview' | 'assignedToMe'; label: string; icon: string; href: string; accent?: boolean }> = [
  { key: 'inbox', label: 'Входящие', icon: '📥', href: '/tasks/inbox' },
  { key: 'today', label: 'Сегодня', icon: '☀️', href: '/tasks/today' },
  { key: 'overdue', label: 'Просроченные', icon: '⏰', href: '/tasks/overdue', accent: true },
  { key: 'onReview', label: 'На проверке', icon: '🔍', href: '/tasks/review' },
  { key: 'assignedToMe', label: 'Мне поставили', icon: '🎯', href: '/tasks/assigned' },
];

export default function TasksOverviewPage() {
  const { stats } = useTasksService();

  return (
    <div style={{ maxWidth: 1080 }}>
      <SectionTitle title="Задачи" subtitle="Ставьте задачи себе и людям из окружения" />

      {/* Быстрый ввод (headerSlot скрыт в свёрнутом рейле — дубль здесь обязателен) */}
      <div className="card" style={{ padding: 'var(--spacing-4) var(--spacing-5)', marginBottom: 'var(--spacing-6)' }}>
        <QuickAdd />
      </div>

      {/* Счётчик-карточки */}
      <div className="grid md:grid-cols-5 grid-cols-2" style={{ gap: 'var(--spacing-3)', marginBottom: 'var(--spacing-6)' }}>
        {STAT_CARDS.map((c, i) => {
          const value = stats ? stats[c.key] : undefined;
          const hot = c.accent && (value ?? 0) > 0;
          return (
            <Link
              key={c.key}
              href={c.href}
              className="card"
              style={{
                padding: 'var(--spacing-4)',
                textDecoration: 'none',
                color: 'inherit',
                transform: `rotate(${i % 2 === 0 ? '-0.4' : '0.35'}deg)`,
                background: hot ? 'var(--surface-container-lowest)' : undefined,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)' }}>
                <span aria-hidden style={{ fontSize: '1.05rem' }}>{c.icon}</span>
                <span className="label-sm">{c.label}</span>
              </div>
              <div className="display-md" style={{ fontSize: '1.7rem', marginTop: 'var(--spacing-1)', color: hot ? 'var(--primary)' : 'var(--on-surface)' }}>
                {value ?? '…'}
              </div>
            </Link>
          );
        })}
      </div>

      {/* Мини-списки */}
      <div className="grid lg:grid-cols-2" style={{ gap: 'var(--spacing-5)', alignItems: 'start' }}>
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 'var(--spacing-3)' }}>
            <h2 className="title-md">☀️ Сегодня</h2>
            <Link href="/tasks/today" className="label-sm" style={{ color: 'var(--secondary)', fontWeight: 600 }}>Все →</Link>
          </div>
          <TaskListSection
            filter={{ smartList: 'today' }}
            limit={5}
            enablePagination={false}
            emptyText="На сегодня задач нет"
            emptyHint="Запланируйте что-нибудь — задачи со сроком на сегодня появятся здесь"
          />
        </div>
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 'var(--spacing-3)' }}>
            <h2 className="title-md">🔍 На проверке</h2>
            <Link href="/tasks/review" className="label-sm" style={{ color: 'var(--secondary)', fontWeight: 600 }}>Все →</Link>
          </div>
          <TaskListSection
            filter={{ smartList: 'on_review' }}
            limit={5}
            enablePagination={false}
            emptyText="Никто не ждёт вашей приёмки"
            emptyHint="Когда исполнитель сдаст работу по вашей задаче — она появится здесь"
          />
        </div>
      </div>
    </div>
  );
}
