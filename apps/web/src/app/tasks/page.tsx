'use client';

// ============================================================
// «Обзор» — дашборд сервиса «Задачи» (модель ClickUp Home / Bitrix24
// «Эффективность»): быстрый ввод во Входящие, плитки-счётчики со ссылками
// в разделы, мини-списки «Сегодня» и «На проверке».
// ============================================================

import { useTasksService } from './tasks-shell';
import { QuickAdd } from './tasks-ui';
import { TaskListSection } from './TaskListSection';
import { BentoGrid, Button, Card, CardHeader, PageHeader, StatTile, type IconName, type Tone } from '@/components/ui';

const STAT_CARDS: Array<{
  key: 'inbox' | 'today' | 'overdue' | 'onReview' | 'assignedToMe';
  label: string;
  icon: IconName;
  href: string;
  /** Тон загорается только когда есть чем заняться. */
  hotTone?: Tone;
}> = [
  { key: 'inbox', label: 'Входящие', icon: 'empty', href: '/tasks/inbox', hotTone: 'accent' },
  { key: 'today', label: 'Сегодня', icon: 'sun', href: '/tasks/today', hotTone: 'accent' },
  { key: 'overdue', label: 'Просроченные', icon: 'overdue', href: '/tasks/overdue', hotTone: 'danger' },
  { key: 'onReview', label: 'На проверке', icon: 'eye', href: '/tasks/review', hotTone: 'warning' },
  { key: 'assignedToMe', label: 'Мне поставили', icon: 'target', href: '/tasks/assigned', hotTone: 'success' },
];

export default function TasksOverviewPage() {
  const { stats, openCreate } = useTasksService();

  return (
    <>
      <PageHeader
        breadcrumb="Задачи"
        title="Обзор"
        description="Ставьте задачи себе и людям из окружения"
        actions={
          <Button variant="primary" tone="success" icon="add" onClick={openCreate}>
            Новая задача
          </Button>
        }
      />

      {/* Быстрый ввод: попадает во «Входящие» одной строкой, без формы */}
      <Card small style={{ marginBottom: 'var(--gap-grid)' }}>
        <QuickAdd />
      </Card>

      <BentoGrid style={{ marginBottom: 'var(--gap-grid)' }}>
        {STAT_CARDS.map((c) => {
          const value = stats ? stats[c.key] : undefined;
          const hot = (value ?? 0) > 0;
          return (
            <StatTile
              key={c.key}
              span={2}
              label={c.label}
              value={value ?? '…'}
              icon={c.icon}
              tone={hot ? (c.hotTone ?? 'accent') : 'neutral'}
              href={c.href}
            />
          );
        })}
        {/* 5 плиток по 2 колонки + пустые 2: сетка 12 не делится на 5 нацело,
            остаток отдаём кнопке «Все задачи», чтобы ряд не разъезжался */}
        <Card small span={2} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Button variant="ghost" size="sm" href="/tasks/all" iconRight="caretRight">Все</Button>
        </Card>
      </BentoGrid>

      <BentoGrid>
        <Card span={6}>
          <CardHeader
            title="Сегодня"
            actions={<Button variant="ghost" size="sm" href="/tasks/today" iconRight="caretRight">Все</Button>}
          />
          <TaskListSection
            filter={{ smartList: 'today' }}
            limit={5}
            enablePagination={false}
            emptyText="На сегодня задач нет"
            emptyHint="Запланируйте что-нибудь — задачи со сроком на сегодня появятся здесь"
          />
        </Card>

        <Card span={6}>
          <CardHeader
            title="На проверке"
            actions={<Button variant="ghost" size="sm" href="/tasks/review" iconRight="caretRight">Все</Button>}
          />
          <TaskListSection
            filter={{ smartList: 'on_review' }}
            limit={5}
            enablePagination={false}
            emptyText="Никто не ждёт вашей приёмки"
            emptyHint="Когда исполнитель сдаст работу по вашей задаче — она появится здесь"
          />
        </Card>
      </BentoGrid>
    </>
  );
}
