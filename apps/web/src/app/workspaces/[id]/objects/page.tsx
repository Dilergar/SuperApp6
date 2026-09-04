'use client';

// ============================================================
// Сервис «Объекты» — дерево площадок организации.
// Видят ВСЕ сотрудники: каждый — свои объекты и путь к ним (тропинка предков
// рисуется, но не открывается). Управляющие правят свою ветку.
// ============================================================

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import type { ObjectNodeDto } from '@superapp/shared';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { Button, Card, EmptyState, LoadingBlock, PageHeader, Toggle } from '@/components/ui';
import { objectsTreeKey } from '@/lib/queries';
import { fetchObjectTree } from './objects-api';
import { ObjectTree } from './_components/ObjectTree';
import { ObjectForm } from './_components/ObjectForm';

export default function ObjectsPage() {
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

  const openCreate = (p: ObjectNodeDto | null) => {
    setParent(p);
    setCreating(true);
  };

  return (
    <>
      <PageHeader
        title="Объекты"
        description="Площадки, здания, этажи и склады организации. Внутри объекта — штат, график смен и оборудование."
        actions={
          <>
            <Toggle checked={showArchived} onChange={setShowArchived} label="Архив" />
            <Button variant="ghost" icon="toolbox" href={`/workspaces/${id}/objects/models`}>
              Модели оборудования
            </Button>
            {canCreate && (
              <Button variant="primary" icon="add" onClick={() => openCreate(null)}>
                Объект
              </Button>
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
            title={showArchived ? 'В архиве пусто' : 'Объектов пока нет'}
            description={
              canCreate
                ? 'Добавьте первый объект — точку, склад или офис. Внутрь можно вкладывать здания, этажи и зоны.'
                : 'Вас пока не назначили ни на один объект.'
            }
            action={
              canCreate ? (
                <Button variant="primary" icon="add" onClick={() => openCreate(null)}>
                  Добавить объект
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
