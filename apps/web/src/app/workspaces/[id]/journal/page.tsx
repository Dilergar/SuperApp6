'use client';

// ============================================================
// «Журнал организации» — сводный B2B-аудит воркспейса на движке
// core/chatter: кто кого нанял/повысил/уволил + движение задач
// организации. Доступ: роль ≥ Менеджер (реальный гейт — серверный 403).
// ============================================================

import { useMemo, useState } from 'react';
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
import { apiGet } from '@/lib/api';
import { workspaceKey, workspaceJournalKey, fetchWorkspaceJournal } from '@/lib/queries';
import { ChronicleFeed } from '@/components/chatter/ChronicleFeed';
import {
  BentoGrid, Button, Card, Chip, EmptyState, LoadingBlock, PageHeader,
} from '@/components/ui';

// Фильтр обязан покрывать ВСЕ категории реестра: записи категории без чипа
// («Документы» до 2026-08-03) видны только в общей ленте — то есть найти их
// в журнале за полгода практически нельзя.
const CATEGORY_CHIPS: { key: ChatterCategory | null; label: string }[] = [
  { key: null, label: 'Все' },
  { key: 'staff', label: 'Сотрудники' },
  { key: 'tasks', label: 'Задачи' },
  { key: 'documents', label: 'Документы' },
  { key: 'drive', label: 'Диск' },
  { key: 'share', label: 'Ссылки наружу' },
  { key: 'processes', label: 'Процессы' },
];

export default function WorkspaceJournalPage() {
  const { isReady } = useRequireAuth();
  const { id } = useParams<{ id: string }>();
  const [category, setCategory] = useState<ChatterCategory | null>(null);

  const wsQuery = useQuery({
    queryKey: workspaceKey(id),
    queryFn: async () => await apiGet<Workspace>(`/workspaces/${id}`),
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

  if (!isReady || wsQuery.isPending) return <LoadingBlock />;

  const header = (
    <PageHeader
      breadcrumb={wsQuery.data?.name ?? 'Организация'}
      title="Журнал организации"
      description="Хроника событий: найм и роли, должности, движение задач — кто, что и когда"
    />
  );

  // Ошибка загрузки организации (напр. 403 не-члену по прямому URL) — не залипаем на
  // «Загрузке»: disabled-запрос журнала в RQ v5 вечно isPending, поэтому выходим здесь.
  if (wsQuery.isError) {
    return (
      <>
        {header}
        <BentoGrid>
          <Card span={12}>
            <EmptyState
              icon="blocked"
              title="Организация не открылась"
              description="Возможно, у вас нет доступа. Обновите страницу или вернитесь к списку организаций."
              action={<Button variant="matte" icon="dashboard" href="/dashboard">На главную</Button>}
            />
          </Card>
        </BentoGrid>
      </>
    );
  }

  if (!isManager) {
    return (
      <>
        {header}
        <BentoGrid>
          <Card span={12}>
            <EmptyState
              icon="lock"
              title="Журнал доступен с роли Менеджер"
              description="HR-события организации видны управляющим — так задумано."
              action={<Button variant="matte" icon="workspace" href={`/workspaces/${id}`}>К организации</Button>}
            />
          </Card>
        </BentoGrid>
      </>
    );
  }

  return (
    <>
      {header}

      {/* Фильтр-чипы категорий */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: 'var(--gap-grid)' }}>
        {CATEGORY_CHIPS.map((c) => (
          <Chip
            key={c.label}
            tone="accent"
            selected={category === c.key}
            onClick={() => setCategory(c.key)}
          >
            {c.label}
          </Chip>
        ))}
      </div>

      <BentoGrid>
        <Card span={12}>
          {journalQuery.isError ? (
            <EmptyState
              icon="warningCircle"
              title="Не удалось загрузить журнал"
              description="Похоже, сервер не ответил. Попробуйте ещё раз."
              action={<Button variant="matte" icon="refresh" onClick={() => journalQuery.refetch()}>Повторить</Button>}
            />
          ) : journalQuery.isPending ? (
            <LoadingBlock />
          ) : (
            <>
              <ChronicleFeed
                entries={entries}
                actors={actors}
                emptyText="Пока пусто — здесь появятся найм, смены ролей и движение задач организации"
              />
              {journalQuery.hasNextPage && (
                <div style={{ textAlign: 'center', marginTop: 'var(--spacing-5)' }}>
                  <Button
                    variant="matte"
                    size="sm"
                    loading={journalQuery.isFetchingNextPage}
                    onClick={() => journalQuery.fetchNextPage()}
                  >
                    Показать ещё
                  </Button>
                </div>
              )}
            </>
          )}
        </Card>
      </BentoGrid>
    </>
  );
}
