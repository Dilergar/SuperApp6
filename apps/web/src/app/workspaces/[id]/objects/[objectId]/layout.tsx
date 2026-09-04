'use client';

// ============================================================
// Каркас объекта: шапка + вкладки (Обзор / Штатное расписание / График смен /
// Оборудование / Хроника). Вкладки — вложенные СЕГМЕНТЫ с общим layout: у сетки
// смен и оборудования свои чанки, и открытие обзора не тянет их код.
// ============================================================

import { useMemo } from 'react';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { OBJECT_KINDS } from '@superapp/shared';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { Button, Card, Chip, EmptyState, LoadingBlock, PageHeader, Tabs, type TabItem } from '@/components/ui';
import { apiErrorMessage } from '@/lib/api';
import { objectKey } from '@/lib/queries';
import { fetchObject } from '../objects-api';

type TabKey = 'overview' | 'staffing' | 'shifts' | 'assets' | 'history';

export default function ObjectLayout({ children }: { children: React.ReactNode }) {
  const { isReady } = useRequireAuth();
  const router = useRouter();
  const pathname = usePathname();
  const { id, objectId } = useParams<{ id: string; objectId: string }>();

  const { data: node, isPending, error } = useQuery({
    queryKey: objectKey(id, objectId),
    queryFn: () => fetchObject(id, objectId),
    enabled: isReady && !!id && !!objectId,
  });

  const base = `/workspaces/${id}/objects/${objectId}`;
  const active: TabKey = useMemo(() => {
    const tail = pathname.slice(base.length).replace(/^\//, '').split('/')[0];
    if (tail === 'staffing' || tail === 'shifts' || tail === 'assets' || tail === 'history') return tail;
    return 'overview';
  }, [pathname, base]);

  const tabs: TabItem<TabKey>[] = [
    { key: 'overview', label: 'Обзор', icon: 'dashboard' },
    { key: 'staffing', label: 'Штатное расписание', icon: 'staff' },
    { key: 'shifts', label: 'График смен', icon: 'calendarCheck' },
    { key: 'assets', label: 'Оборудование', icon: 'wrench' },
    { key: 'history', label: 'Хроника', icon: 'journal' },
  ];

  if (!isReady) return null;
  if (isPending) return <LoadingBlock />;
  // Пустой белый экран вместо ответа сервера — худшее из состояний: человек не
  // знает, объект удалён, закрыт правами или упала сеть. Показываем причину и
  // дорогу назад, а вкладки не рисуем вовсе (детям без объекта грузить нечего).
  if (!node) {
    return (
      <>
        <PageHeader breadcrumb="Объекты" title="Объект недоступен" />
        <Card>
          <EmptyState
            icon="blocked"
            title="Объект не открылся"
            description={
              error
                ? apiErrorMessage(error)
                : 'Объект удалён или у вас нет к нему доступа. Попросите управляющего добавить вас на объект.'
            }
            action={
              <Button variant="primary" icon="arrowLeft" href={`/workspaces/${id}/objects`}>
                К списку объектов
              </Button>
            }
          />
        </Card>
      </>
    );
  }

  const kindLabel = OBJECT_KINDS.find((k) => k.value === node.kind)?.label ?? 'Объект';

  return (
    <>
      <PageHeader
        breadcrumb="Объекты"
        title={node.name}
        chip={
          <>
            <Chip tone="neutral">{kindLabel}</Chip>
            {node.isDefault && <Chip tone="accent">Основной</Chip>}
            {node.archivedAt && <Chip tone="neutral">В архиве</Chip>}
          </>
        }
        description={[node.address, node.effectiveLegalEntityName].filter(Boolean).join(' · ') || undefined}
      />
      <div style={{ marginBottom: 'var(--spacing-6)' }}>
        <Tabs
          items={tabs}
          value={active}
          onChange={(key) => router.push(key === 'overview' ? base : `${base}/${key}`)}
          aria-label="Разделы объекта"
        />
      </div>
      {children}
    </>
  );
}
