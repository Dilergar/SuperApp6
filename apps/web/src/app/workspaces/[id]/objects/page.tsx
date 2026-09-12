'use client';

// ============================================================
// Сервис «Объекты» — дерево площадок организации.
// Видят ВСЕ сотрудники: каждый — свои объекты и путь к ним (тропинка предков
// рисуется, но не открывается). Управляющие правят свою ветку.
// ============================================================

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import type { ObjectNodeDto } from '@superapp/shared';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { Button, Card, EmptyState, LoadingBlock, PageHeader, Toggle } from '@/components/ui';
import { EntitlementGauge, EntitlementLock, useEntitlementGate } from '@/components/entitlements';
import { objectsTreeKey } from '@/lib/queries';
import { fetchObjectTree } from './objects-api';
import { ObjectTree } from './_components/ObjectTree';
import { ObjectForm } from './_components/ObjectForm';

export default function ObjectsPage() {
  const t = useTranslations('objects');
  const { isReady } = useRequireAuth();
  const { id } = useParams<{ id: string }>();
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [parent, setParent] = useState<ObjectNodeDto | null>(null);

  const { data, isPending } = useQuery({
    queryKey: objectsTreeKey(id, showArchived),
    queryFn: () => fetchObjectTree(id, showArchived),
    enabled: isReady && !!id,
  });

  if (!isReady) return null;

  const nodes = data?.nodes ?? [];
  const canCreate = data?.canCreate ?? false;
  // Замок тарифа организации: на лимите создание не предлагается (сервер всё равно ответит 402)
  const objectsGate = useEntitlementGate('objects.maxPerWorkspace', id, 'ent-lock-objects');

  const openCreate = (p: ObjectNodeDto | null) => {
    setParent(p);
    setCreating(true);
  };

  return (
    <>
      <PageHeader
        title={t('breadcrumb')}
        description={t('page.description')}
        actions={
          <>
            <Toggle checked={showArchived} onChange={setShowArchived} label={t('page.archive')} />
            <Button variant="ghost" icon="toolbox" href={`/workspaces/${id}/objects/models`}>
              {t('models.breadcrumb')}
            </Button>
            {canCreate && (
              <>
                <EntitlementGauge keyName="objects.maxPerWorkspace" workspaceId={id} />
                <EntitlementLock keyName="objects.maxPerWorkspace" workspaceId={id} id="ent-lock-objects" />
                <Button variant="primary" icon="add" disabled={objectsGate.blocked} aria-describedby={objectsGate.describedBy} onClick={() => openCreate(null)}>
                  {t('entity')}
                </Button>
              </>
            )}
          </>
        }
      />

      <Card>
        {isPending ? (
          <LoadingBlock />
        ) : nodes.length === 0 ? (
          <EmptyState
            icon="storefront"
            title={showArchived ? t('page.emptyArchive') : t('page.empty')}
            description={canCreate ? t('page.emptyHintManage') : t('page.emptyHint')}
            action={
              canCreate ? (
                <Button variant="primary" icon="add" disabled={objectsGate.blocked} aria-describedby={objectsGate.describedBy} onClick={() => openCreate(null)}>
                  {t('page.addFirst')}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ObjectTree workspaceId={id} nodes={nodes} onAddChild={(p) => openCreate(p)} />
        )}
      </Card>

      <ObjectForm
        key={parent?.id ?? 'root'}
        workspaceId={id}
        open={creating}
        parent={parent}
        onClose={() => setCreating(false)}
      />
    </>
  );
}
