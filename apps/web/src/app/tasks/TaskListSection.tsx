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

import { Fragment, useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { fetchTasks, tasksListKey } from '@/lib/queries';
import { Chip, TaskRow } from './tasks-ui';
import {
  TASK_CREATOR_LABEL,
  TASK_PRIORITY_META,
  TASK_ROLE_LABELS,
  TASK_STATUS_META,
  TASK_LIMITS,
  type Task,
  type TaskFilter,
  type TaskPriority,
  type TaskStatus,
  type ViewerTaskRole,
} from '@superapp/shared';

const ROLE_OPTIONS: Array<{ key: ViewerTaskRole; label: string }> = [
  { key: 'creator', label: TASK_CREATOR_LABEL },
  { key: 'executor', label: TASK_ROLE_LABELS.executor },
  { key: 'co_executor', label: TASK_ROLE_LABELS.co_executor },
  { key: 'observer', label: TASK_ROLE_LABELS.observer },
];

export function TaskListSection({
  filter,
  emptyText = 'Здесь пусто',
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
        <div style={{ position: 'relative', marginBottom: 'var(--spacing-3)' }}>
          <input
            type="search"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="Поиск по названию и описанию…"
            className="input-sketch"
            style={{ paddingLeft: '2.1rem' }}
            aria-label="Поиск задач"
          />
          <span aria-hidden style={{ position: 'absolute', left: '0.7rem', top: '50%', transform: 'translateY(-50%)', opacity: 0.55 }}>🔍</span>
          {q.isFetching && search && (
            <span className="label-sm" style={{ position: 'absolute', right: '0.8rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--on-surface-variant)' }}>
              ищем…
            </span>
          )}
        </div>
      )}

      {enableFilters && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-4)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
            <span className="label-sm" style={{ minWidth: 74 }}>Статус</span>
            {(Object.keys(TASK_STATUS_META) as TaskStatus[]).map((s) => (
              <Chip key={s} active={statusSel.includes(s)} onClick={() => toggleStatus(s)}>
                {TASK_STATUS_META[s].icon} {TASK_STATUS_META[s].label}
              </Chip>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
            <span className="label-sm" style={{ minWidth: 74 }}>Приоритет</span>
            {(Object.keys(TASK_PRIORITY_META) as TaskPriority[]).map((p) => (
              <Chip key={p} active={prioritySel.includes(p)} color={TASK_PRIORITY_META[p].color} onClick={() => togglePriority(p)}>
                {TASK_PRIORITY_META[p].label}
              </Chip>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
            <span className="label-sm" style={{ minWidth: 74 }}>Моя роль</span>
            {ROLE_OPTIONS.map((r) => (
              <Chip key={r.key} active={roleSel === r.key} onClick={() => toggleRole(r.key)}>
                {r.label}
              </Chip>
            ))}
          </div>
        </div>
      )}

      {q.isLoading ? (
        <p className="label-md" style={{ padding: 'var(--spacing-6) 0', textAlign: 'center' }}>Загрузка…</p>
      ) : q.isError ? (
        <div className="wash-primary" style={{ padding: 'var(--spacing-3) var(--spacing-4)', color: 'var(--primary)', fontSize: '0.875rem' }}>
          Не удалось загрузить задачи
        </div>
      ) : items.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 'var(--spacing-10)', color: 'var(--on-surface-variant)' }}>
          <p className="label-md">{hasActiveFilters ? 'Ничего не найдено' : emptyText}</p>
          {(hasActiveFilters ? 'Попробуйте изменить запрос или фильтры' : emptyHint) && (
            <p className="label-sm" style={{ marginTop: 'var(--spacing-2)' }}>
              {hasActiveFilters ? 'Попробуйте изменить запрос или фильтры' : emptyHint}
            </p>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)', opacity: q.isFetching ? 0.75 : 1, transition: 'opacity 0.15s ease' }}>
          {items.map((t) => (renderRow ? <Fragment key={t.id}>{renderRow(t)}</Fragment> : <TaskRow key={t.id} task={t} />))}
        </div>
      )}

      {enablePagination && meta && totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--spacing-3)', marginTop: 'var(--spacing-5)' }}>
          <button
            className="btn-secondary"
            style={{ padding: '0.35rem 0.9rem', fontSize: '0.8rem', opacity: page <= 1 ? 0.5 : 1 }}
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            ← Назад
          </button>
          <span className="label-sm">стр. {meta.page} из {totalPages} · всего {meta.total}</span>
          <button
            className="btn-secondary"
            style={{ padding: '0.35rem 0.9rem', fontSize: '0.8rem', opacity: page >= totalPages ? 0.5 : 1 }}
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            Вперёд →
          </button>
        </div>
      )}
    </div>
  );
}
