'use client';

// ============================================================
// TasksShell — контекст сервиса «Задачи» (счётчики + форма создания).
//
// Держит: запрос счётчиков (GET /tasks/stats → бейджи сайдбара, живут на
// корневом ключе ['tasks'] — любая мутация задач обновляет их вместе со
// списками), модалку «+ Новая задача» (headerSlot; в свёрнутом рейле шапка
// скрыта — quick-add продублирован на Обзоре и во Входящих) и контекст
// useTasksService() для страниц-разделов.
// ============================================================

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { fetchTaskStats, taskStatsKey } from '@/lib/queries';
import { TaskCreateModal } from './TaskCreateModal';
import type { TaskStats } from '@superapp/shared';

export interface TasksServiceCtx {
  meId: string | null;
  /** Счётчики смарт-листов (карточки «Обзора»; undefined — ещё грузятся). */
  stats: TaskStats | undefined;
  /** Открыть модалку полной формы «+ Новая задача». */
  openCreate: () => void;
  /** Инвалидация корня ['tasks']: списки + деталь + счётчики + бейджи разом. */
  invalidate: () => void;
}

const Ctx = createContext<TasksServiceCtx | null>(null);

export function useTasksService(): TasksServiceCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTasksService вне TasksShell');
  return v;
}

export function TasksShell({ defaultCollapsed, children }: { defaultCollapsed?: boolean; children: React.ReactNode }) {
  const { isReady, user } = useRequireAuth();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);

  // Живость бейджей: инвалидация при мутациях + фоновый refetch раз в минуту
  // (напоминания/повторы меняют списки и без действий пользователя).
  const statsQ = useQuery({
    queryKey: taskStatsKey,
    queryFn: fetchTaskStats,
    enabled: isReady,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  const invalidate = useCallback(
    () => void queryClient.invalidateQueries({ queryKey: ['tasks'] }),
    [queryClient],
  );


  const ctx = useMemo<TasksServiceCtx>(
    () => ({
      meId: user?.id ?? null,
      stats: statsQ.data,
      openCreate: () => setCreateOpen(true),
      invalidate,
    }),
    [user?.id, statsQ.data, invalidate],
  );

  if (!isReady) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="label-md" style={{ fontSize: '1rem' }}>Загрузка...</p>
      </div>
    );
  }

  // Разделы Задач переехали в ГЛОБАЛЬНЫЙ сайдбар (AppShell), поэтому свой
  // каркас здесь больше не рисуется — остаётся только контекст сервиса
  // (счётчики, открытие формы) и сама форма создания.
  return (
    <>
      <Ctx.Provider value={ctx}>{children}</Ctx.Provider>
      {createOpen && <TaskCreateModal onClose={() => setCreateOpen(false)} />}
    </>
  );
}
