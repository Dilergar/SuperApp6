'use client';

// «Сроки» — сводный экран КЭДО «что горит сегодня» (ЕСУТД, вручения, расчёты,
// испытательные, срочные договоры, ознакомления). Раздел сервиса «Сотрудники»,
// Менеджер+ (бейдж сайдбара ведёт сюда).

import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button, EmptyState, LoadingBlock } from '@/components/ui';
import { DeadlinesTab } from '../DeadlinesTab';
import { MembersHeader, membersSectionHref, useLegacyMembersTabRedirect, useMembersBase } from '../members-lib';

export default function MembersDeadlinesPage() {
  const { id: workspaceId } = useParams<{ id: string }>();
  const t = useTranslations('hr');
  useLegacyMembersTabRedirect(workspaceId);
  const { isReady, ws, wsQ, canStaff } = useMembersBase(workspaceId);

  if (!isReady || wsQ.isLoading || !ws) return <LoadingBlock />;
  if (!canStaff) {
    return (
      <EmptyState
        icon="lock"
        title={t('deadlines.lockedTitle')}
        description={t('deadlines.lockedDescription')}
        action={
          <Button variant="matte" icon="arrowLeft" href={membersSectionHref(workspaceId, 'people')}>
            {t('deadlines.toPeople')}
          </Button>
        }
      />
    );
  }

  return (
    <MembersHeader ws={ws} title={t('deadlines.title')} description={t('deadlines.description')}>
      <DeadlinesTab workspaceId={workspaceId} />
    </MembersHeader>
  );
}
