'use client';

// ============================================================
// Универсальный список задач — один компонент кормит все разделы сервиса
// (Входящие/Сегодня/Просроченные/…/Все/Выполненные). Смарт-лист или статусы
// задаются пропом filter; сверху опционально включаются:
//  • поиск по ключевому слову (GET /tasks?search= — тот же запрос, что и
//    фильтры; UX-паттерн поиска мессенджера: debounce 300мс, «ничего не найдено»)
//  • чипы фильтров статус/приоритет/роль (CSV-параметры API)
//  • пагинация по meta.totalPages
// ============================================================

import { Alert, EmptyState, LoadingBlock, Pagination, SearchField } from '@/components/ui';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { fetchTasks, tasksListKey } from '@/lib/queries';
import { Chip, TaskRow } from './tasks-ui';
import {
  TASK_PRIORITY_META,
  TASK_STATUS_META,
  TASK_LIMITS,
  VIEWER_TASK_ROLES,
  type Task,
  type TaskFilter,
  type TaskPriority,
  type TaskStatus,
  type ViewerTaskRole,
} from '@superapp/shared';

const PRIORITY_CHIP_TONE = { low: 'neutral', medium: 'accent', high: 'warning', urgent: 'danger' } as const;

export function TaskListSection({
  filter,
  emptyText,
  emptyHint,
  enableSearch = false,
  enableFilters = false,
  enablePagination = true,
  limit = TASK_LIMITS.listPageSize,
  renderRow,
}: {
  /** Базовый фильтр раздела: smartList и/или статусы. Чипы накладываются сверху. */
  filter: Partial<TaskFilter>;
  emptyText?: string;
  emptyHint?: string;
  enableSearch?: boolean;
  enableFilters?: boolean;
  enablePagination?: boolean;
  limit?: number;
  /** Кастомная строка (Входящие рисуют свою — с действиями «уточнить»). */
  renderRow?: (task: Task) => React.ReactNode;
}) {
  const t = useTranslations('tasks');
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const [statusSel, setStatusSel] = useState<TaskStatus[]>([]);
  const [prioritySel, setPrioritySel] = useState<TaskPriority[]>([]);
  const [roleSel, setRoleSel] = useState<ViewerTaskRole | null>(null);
  const [page, setPage] = useState(1);

  // Debounce поиска (паттерн GlobalSearch мессенджера)
  useEffect(() => {
    const t = window.setTimeout(() => {
      setSearch(searchText.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(t);
  }, [searchText]);

  const effective = useMemo<Partial<TaskFilter>>(
    () => ({
      ...filter,
      ...(statusSel.length ? { status: statusSel } : {}),
      ...(prioritySel.length ? { priority: prioritySel } : {}),
      ...(roleSel ? { role: roleSel } : {}),
      ...(search ? { search } : {}),
      page,
      limit,
    }),
    [filter, statusSel, prioritySel, roleSel, search, page, limit],
  );

  const q = useQuery({
    queryKey: tasksListKey(effective as Record<string, unknown>),
    queryFn: () => fetchTasks(effective),
    placeholderData: keepPreviousData,
  });

  const items = q.data?.items ?? [];
  const meta = q.data?.meta;
  const totalPages = meta?.totalPages ?? 1;
  const hasActiveFilters = statusSel.length > 0 || prioritySel.length > 0 || !!roleSel || !!search;

  const toggleStatus = (s: TaskStatus) => {
    setStatusSel((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
    setPage(1);
  };
  const togglePriority = (p: TaskPriority) => {
    setPrioritySel((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));
    setPage(1);
  };
  const toggleRole = (r: ViewerTaskRole) => {
    setRoleSel((cur) => (cur === r ? null : r));
    setPage(1);
  };

  return (
    <div>
      {enableSearch && (
        <div style={{ marginBottom: 'var(--spacing-3)' }}>
          <SearchField
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            onClear={() => setSearchText('')}
            placeholder={t('list.searchPlaceholder')}
            aria-label={t('list.searchAria')}
            width="100%"
          />
        </div>
      )}

      {enableFilters && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-4)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
            <span className="label-sm" style={{ minWidth: 74 }}>{t('list.filterStatus')}</span>
            {(Object.keys(TASK_STATUS_META) as TaskStatus[]).map((s) => (
              <Chip key={s} active={statusSel.includes(s)} onClick={() => toggleStatus(s)}>
                {t(`status.${s}`)}
              </Chip>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
            <span className="label-sm" style={{ minWidth: 74 }}>{t('list.filterPriority')}</span>
            {(Object.keys(TASK_PRIORITY_META) as TaskPriority[]).map((p) => (
              <Chip key={p} active={prioritySel.includes(p)} tone={PRIORITY_CHIP_TONE[p]} onClick={() => togglePriority(p)}>
                {t(`priority.${p}`)}
              </Chip>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
            <span className="label-sm" style={{ minWidth: 74 }}>{t('list.filterRole')}</span>
            {VIEWER_TASK_ROLES.map((r) => (
              <Chip key={r} active={roleSel === r} onClick={() => toggleRole(r)}>
                {t(`role.${r}`)}
              </Chip>
            ))}
          </div>
        </div>
      )}

      {q.isLoading ? (
        <LoadingBlock />
      ) : q.isError ? (
        <Alert tone="danger">{t('list.loadFailed')}</Alert>
      ) : items.length === 0 ? (
        <EmptyState
          icon={hasActiveFilters ? 'search' : 'tasks'}
          title={hasActiveFilters ? t('list.nothingFound') : emptyText ?? t('list.empty')}
          description={hasActiveFilters ? t('list.nothingFoundHint') : emptyHint}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)', opacity: q.isFetching ? 0.75 : 1, transition: 'opacity 0.15s ease' }}>
          {items.map((t) => (renderRow ? <Fragment key={t.id}>{renderRow(t)}</Fragment> : <TaskRow key={t.id} task={t} />))}
        </div>
      )}

      {enablePagination && meta && totalPages > 1 && (
        <div style={{ marginTop: 'var(--spacing-5)' }}>
          <Pagination page={meta.page} pageCount={totalPages} onChange={setPage} />
        </div>
      )}
    </div>
  );
}
