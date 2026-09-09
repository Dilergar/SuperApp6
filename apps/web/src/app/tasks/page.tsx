'use client';

// ============================================================
// «Обзор» — дашборд сервиса «Задачи» (модель ClickUp Home / Bitrix24
// «Эффективность»): быстрый ввод во Входящие, плитки-счётчики со ссылками
// в разделы, мини-списки «Сегодня» и «На проверке».
// ============================================================

import { useTranslations } from 'next-intl';
import { useTasksService } from './tasks-shell';
import { QuickAdd } from './tasks-ui';
import { TaskListSection } from './TaskListSection';
import { BentoGrid, Button, Card, CardHeader, PageHeader, StatTile, type IconName, type Tone } from '@/components/ui';

/**
 * Плитка называет РАЗДЕЛ, а слово ему даёт каталог: `labelKey` вместо готовой
 * строки — тот же приём, что у пунктов сайдбара (`lib/app-nav.ts`).
 */
const STAT_CARDS: Array<{
  key: 'inbox' | 'today' | 'overdue' | 'onReview' | 'assignedToMe';
  labelKey: string;
  icon: IconName;
  href: string;
  /** Тон загорается только когда есть чем заняться. */
  hotTone?: Tone;
}> = [
  { key: 'inbox', labelKey: 'sections.inbox.title', icon: 'empty', href: '/tasks/inbox', hotTone: 'accent' },
  { key: 'today', labelKey: 'sections.today.title', icon: 'sun', href: '/tasks/today', hotTone: 'accent' },
  { key: 'overdue', labelKey: 'sections.overdue.title', icon: 'overdue', href: '/tasks/overdue', hotTone: 'danger' },
  { key: 'onReview', labelKey: 'sections.review.title', icon: 'eye', href: '/tasks/review', hotTone: 'warning' },
  { key: 'assignedToMe', labelKey: 'sections.assigned.title', icon: 'target', href: '/tasks/assigned', hotTone: 'success' },
];

export default function TasksOverviewPage() {
  const t = useTranslations('tasks');
  const { stats, openCreate } = useTasksService();

  return (
    <>
      <PageHeader
        breadcrumb={t('breadcrumb')}
        title={t('sections.overview.title')}
        description={t('sections.overview.description')}
        actions={
          <Button variant="primary" tone="success" icon="add" onClick={openCreate}>
            {t('create.open')}
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
              label={t(c.labelKey)}
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
          <Button variant="ghost" size="sm" href="/tasks/all" iconRight="caretRight">{t('list.all')}</Button>
        </Card>
      </BentoGrid>

      <BentoGrid>
        <Card span={6}>
          <CardHeader
            title={t('sections.today.title')}
            actions={<Button variant="ghost" size="sm" href="/tasks/today" iconRight="caretRight">{t('list.all')}</Button>}
          />
          <TaskListSection
            filter={{ smartList: 'today' }}
            limit={5}
            enablePagination={false}
            emptyText={t('sections.today.empty')}
            emptyHint={t('sections.today.emptyHintOverview')}
          />
        </Card>

        <Card span={6}>
          <CardHeader
            title={t('sections.review.title')}
            actions={<Button variant="ghost" size="sm" href="/tasks/review" iconRight="caretRight">{t('list.all')}</Button>}
          />
          <TaskListSection
            filter={{ smartList: 'on_review' }}
            limit={5}
            enablePagination={false}
            emptyText={t('sections.review.empty')}
            emptyHint={t('sections.review.emptyHint')}
          />
        </Card>
      </BentoGrid>
    </>
  );
}
