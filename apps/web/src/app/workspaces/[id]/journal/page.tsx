'use client';

// ============================================================
// «Журнал организации» — сводный B2B-аудит воркспейса на движке
// core/chatter: кто кого нанял/повысил/уволил + движение задач
// организации. Доступ: роль ≥ Менеджер (реальный гейт — серверный 403).
// ============================================================

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
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
// Ключ `null` — «Все»; слово к каждой категории даёт каталог
// (`workspaces.journal.category.*`), реестр несёт только состав фильтра.
// Место категории в ряду. Тип `Record<ChatterCategory, …>` делает полноту
// обязанностью КОМПИЛЯТОРА: категория, заведённая в реестре и забытая здесь,
// роняет сборку, а не прячет молча полгода записей.
const CATEGORY_ORDER: Record<ChatterCategory, number> = {
  staff: 1,
  hr: 2,
  tasks: 3,
  documents: 4,
  drive: 5,
  share: 6,
  processes: 7,
  objects: 8,
  notes: 9,
};

const CATEGORY_CHIPS: (ChatterCategory | null)[] = [
  null,
  ...(Object.keys(CATEGORY_ORDER) as ChatterCategory[]).sort((a, b) => CATEGORY_ORDER[a] - CATEGORY_ORDER[b]),
];

export default function WorkspaceJournalPage() {
  const t = useTranslations('workspaces');
  const tc = useTranslations('common');
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
      breadcrumb={wsQuery.data?.name ?? t('orgFallback')}
      title={t('journal.title')}
      description={t('journal.description')}
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
              title={t('notOpened.title')}
              description={t('notOpened.description')}
              action={<Button variant="matte" icon="dashboard" href="/dashboard">{t('toDashboard')}</Button>}
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
              title={t('journal.managerOnly.title')}
              description={t('journal.managerOnly.description')}
              action={<Button variant="matte" icon="workspace" href={`/workspaces/${id}`}>{t('toOrg')}</Button>}
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
        {CATEGORY_CHIPS.map((key) => (
          <Chip
            key={key ?? 'all'}
            tone="accent"
            selected={category === key}
            onClick={() => setCategory(key)}
          >
            {t(`journal.category.${key ?? 'all'}`)}
          </Chip>
        ))}
      </div>

      <BentoGrid>
        <Card span={12}>
          {journalQuery.isError ? (
            <EmptyState
              icon="warningCircle"
              title={t('journal.loadFailed.title')}
              description={t('journal.loadFailed.description')}
              action={
                <Button variant="matte" icon="refresh" onClick={() => journalQuery.refetch()}>
                  {tc('actions.retry')}
                </Button>
              }
            />
          ) : journalQuery.isPending ? (
            <LoadingBlock />
          ) : (
            <>
              <ChronicleFeed
                entries={entries}
                actors={actors}
                emptyText={t('journal.empty')}
              />
              {journalQuery.hasNextPage && (
                <div style={{ textAlign: 'center', marginTop: 'var(--spacing-5)' }}>
                  <Button
                    variant="matte"
                    size="sm"
                    loading={journalQuery.isFetchingNextPage}
                    onClick={() => journalQuery.fetchNextPage()}
                  >
                    {t('journal.showMore')}
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
