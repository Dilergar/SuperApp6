'use client';

// ============================================================
// «Ссылки организации» — всё, что раздала наружу вся команда (core/share-links).
// Доступ: роль ≥ Менеджер (реальный гейт — серверный 403; здесь мягкая деградация).
//
// Зачем отдельно от «Моих ссылок»: менеджер раздал наружу три десятка ссылок и
// уволился — закрыть их было некому. Личный раздел показывает только свои, а
// пообъектный обход требует помнить все объекты, куда их успели выдать.
//
// Список — тот же обозреватель, что в профиле; отличия скоупа приходят пропсами.
// ============================================================

import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { WORKSPACE_ROLE_RANK, type Workspace, type WorkspaceRole } from '@superapp/shared';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { apiGet } from '@/lib/api';
import { workspaceKey, workspaceShareLinksScopeKey } from '@/lib/queries';
import {
  fetchWorkspaceShareLinks,
  fetchWorkspaceShareStats,
  revokeWorkspaceShareLinks,
} from '@/lib/share-links-api';
import { ShareLinksBrowser } from '@/components/share-links/ShareLinksBrowser';
import { BentoGrid, Button, Card, EmptyState, LoadingBlock, PageHeader } from '@/components/ui';

export default function WorkspaceLinksPage() {
  const { isReady } = useRequireAuth();
  const { id } = useParams<{ id: string }>();

  const wsQuery = useQuery({
    queryKey: workspaceKey(id),
    queryFn: async () => await apiGet<Workspace>(`/workspaces/${id}`),
    enabled: isReady,
  });

  const myRole = wsQuery.data?.myRole as WorkspaceRole | undefined;
  const isManager = !!myRole && (WORKSPACE_ROLE_RANK[myRole] ?? 0) >= WORKSPACE_ROLE_RANK.manager;

  if (!isReady || wsQuery.isPending) return <LoadingBlock />;

  const header = (
    <PageHeader
      breadcrumb={wsQuery.data?.name ?? 'Организация'}
      title="Ссылки наружу"
      description="Что команда раздала людям без аккаунта SuperApp6 — и кто именно раздал"
    />
  );

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
              title="Раздел доступен с роли Менеджер"
              description="Ссылки наружу видят и закрывают управляющие — так задумано. Свои ссылки есть у каждого в профиле."
              action={<Button variant="matte" icon="link" href="/profile/links">Мои ссылки</Button>}
            />
          </Card>
        </BentoGrid>
      </>
    );
  }

  return (
    <ShareLinksBrowser
      title="Ссылки наружу"
      subtitle={`Что раздала наружу команда «${wsQuery.data?.name ?? 'организации'}». Отозвать можно любую, в том числе чужую.`}
      emptyDescription="Ссылка появляется здесь, как только кто-то из команды поделится файлом, папкой или документом наружу."
      source={{
        keyPrefix: workspaceShareLinksScopeKey(id),
        list: ({ status, cursor }) =>
          fetchWorkspaceShareLinks(id, { status, ...(cursor ? { cursor } : {}) }),
        stats: () => fetchWorkspaceShareStats(id),
        revoke: (ids) => revokeWorkspaceShareLinks(id, ids),
        showAuthors: true,
      }}
    />
  );
}
