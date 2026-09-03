'use client';

// «Сроки» — сводный экран КЭДО «что горит сегодня» (ЕСУТД, вручения, расчёты,
// испытательные, срочные договоры, ознакомления). Раздел сервиса «Сотрудники»,
// Менеджер+ (бейдж сайдбара ведёт сюда).

import { useParams } from 'next/navigation';
import { Button, EmptyState, LoadingBlock } from '@/components/ui';
import { DeadlinesTab } from '../DeadlinesTab';
import { MembersHeader, membersSectionHref, useLegacyMembersTabRedirect, useMembersBase } from '../members-lib';

export default function MembersDeadlinesPage() {
  const { id: workspaceId } = useParams<{ id: string }>();
  useLegacyMembersTabRedirect(workspaceId);
  const { isReady, ws, wsQ, canStaff } = useMembersBase(workspaceId);

  if (!isReady || wsQ.isLoading || !ws) return <LoadingBlock />;
  if (!canStaff) {
    return (
      <EmptyState
        icon="lock"
        title="Раздел управляющих"
        description="Кадровые сроки видят Менеджер и выше."
        action={<Button variant="matte" icon="arrowLeft" href={membersSectionHref(workspaceId, 'people')}>К людям</Button>}
      />
    );
  }

  return (
    <MembersHeader ws={ws} title="Кадровые сроки" description="ЕСУТД, вручения, расчёты, испытательные, срочные договоры, ознакомления">
      <DeadlinesTab workspaceId={workspaceId} />
    </MembersHeader>
  );
}
