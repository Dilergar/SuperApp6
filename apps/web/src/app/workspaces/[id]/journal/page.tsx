'use client';

// ============================================================
// «Журнал организации» — сводный B2B-аудит воркспейса на движке
// core/chatter: кто кого нанял/повысил/уволил + движение задач
// организации. Доступ: роль ≥ Менеджер (реальный гейт — серверный 403).
// ============================================================

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  WORKSPACE_ROLE_RANK,
  type ChatterActorLite,
  type ChatterCategory,
  type Workspace,
  type WorkspaceRole,
} from '@superapp/shared';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { api } from '@/lib/api';
import { workspaceKey, workspaceJournalKey, fetchWorkspaceJournal } from '@/lib/queries';
import { ChronicleFeed } from '@/components/chatter/ChronicleFeed';

const CATEGORY_CHIPS: { key: ChatterCategory | null; label: string }[] = [
  { key: null, label: 'Все' },
  { key: 'staff', label: 'Сотрудники' },
  { key: 'tasks', label: 'Задачи' },
];

export default function WorkspaceJournalPage() {
  const { isReady } = useRequireAuth();
  const { id } = useParams<{ id: string }>();
  const [category, setCategory] = useState<ChatterCategory | null>(null);

  const wsQuery = useQuery({
    queryKey: workspaceKey(id),
    queryFn: async () => (await api.get(`/workspaces/${id}`)).data.data as Workspace,
    enabled: isReady,
  });

  const myRole = wsQuery.data?.myRole as WorkspaceRole | undefined;
  const isManager = !!myRole && (WORKSPACE_ROLE_RANK[myRole] ?? 0) >= WORKSPACE_ROLE_RANK.manager;

  const journalQuery = useInfiniteQuery({
    queryKey: workspaceJournalKey(id, category),
    queryFn: ({ pageParam }) =>
      fetchWorkspaceJournal(id, {
        cursor: (pageParam as string | undefined) || undefined,
        ...(category ? { category } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: isReady && isManager,
  });

  const entries = useMemo(
    () => (journalQuery.data?.pages ?? []).flatMap((p) => p.items),
    [journalQuery.data],
  );
  const actors = useMemo(() => {
    const merged: Record<string, ChatterActorLite> = {};
    for (const p of journalQuery.data?.pages ?? []) Object.assign(merged, p.actors);
    return merged;
  }, [journalQuery.data]);

  if (!isReady || wsQuery.isPending) return <p className="label-md">Загрузка…</p>;

  // Ошибка загрузки организации (напр. 403 не-члену по прямому URL) — не залипаем на
  // «Загрузке»: disabled-запрос журнала в RQ v5 вечно isPending, поэтому выходим здесь.
  if (wsQuery.isError) {
    return (
      <div className="card" style={{ maxWidth: 560 }}>
        <h1 className="title-lg" style={{ marginBottom: 'var(--spacing-2)' }}>Журнал организации</h1>
        <p className="label-md">Не удалось открыть организацию — возможно, у вас нет доступа. Обновите страницу.</p>
      </div>
    );
  }

  if (!isManager) {
    return (
      <div className="card" style={{ maxWidth: 560 }}>
        <h1 className="title-lg" style={{ marginBottom: 'var(--spacing-2)' }}>Журнал организации</h1>
        <p className="label-md">Журнал доступен с роли Менеджер.</p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 860 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--spacing-3)', marginBottom: 'var(--spacing-2)', paddingLeft: 'var(--spacing-2)' }}>
        <h1 className="display-md" style={{ fontSize: '1.7rem' }}>Журнал организации</h1>
        {wsQuery.data && (
          <Link href={`/workspaces/${id}`} className="label-md" style={{ textDecoration: 'underline' }}>
            {wsQuery.data.name}
          </Link>
        )}
      </div>
      <p className="label-md" style={{ marginBottom: 'var(--spacing-6)', paddingLeft: 'var(--spacing-2)' }}>
        Хроника событий: найм и роли, должности, движение задач — кто, что и когда.
      </p>

      {/* Фильтр-чипы категорий */}
      <div style={{ display: 'flex', gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-5)', paddingLeft: 'var(--spacing-2)' }}>
        {CATEGORY_CHIPS.map((c) => {
          const active = category === c.key;
          return (
            <button
              key={c.label}
              onClick={() => setCategory(c.key)}
              className="ghost-border"
              style={{
                padding: '0.3rem 0.9rem',
                cursor: 'pointer',
                fontSize: '0.84rem',
                fontWeight: 600,
                background: active ? 'var(--secondary-container)' : 'var(--surface-container-lowest)',
                color: 'var(--on-surface)',
              }}
            >
              {c.label}
            </button>
          );
        })}
      </div>

      <div className="card" style={{ transform: 'rotate(-0.2deg)' }}>
        {journalQuery.isError ? (
          <div style={{ textAlign: 'center', padding: 'var(--spacing-4)' }}>
            <p className="label-md" style={{ marginBottom: 'var(--spacing-3)' }}>
              Не удалось загрузить журнал.
            </p>
            <button
              className="ghost-border label-md"
              style={{ padding: '0.4rem 1.4rem', cursor: 'pointer' }}
              onClick={() => journalQuery.refetch()}
            >
              Повторить
            </button>
          </div>
        ) : journalQuery.isPending ? (
          <p className="label-md">Загрузка журнала…</p>
        ) : (
          <>
            <ChronicleFeed
              entries={entries}
              actors={actors}
              emptyText="Пока пусто — здесь появятся найм, смены ролей и движение задач организации"
            />
            {journalQuery.hasNextPage && (
              <div style={{ textAlign: 'center', marginTop: 'var(--spacing-5)' }}>
                <button
                  className="ghost-border label-md"
                  style={{ padding: '0.4rem 1.4rem', cursor: 'pointer' }}
                  disabled={journalQuery.isFetchingNextPage}
                  onClick={() => journalQuery.fetchNextPage()}
                >
                  {journalQuery.isFetchingNextPage ? 'Загрузка…' : 'Показать ещё'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
