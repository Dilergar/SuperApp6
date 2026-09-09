'use client';

// ============================================================
// Каркас объекта: шапка + вкладки (Обзор / Штатное расписание / График смен /
// Оборудование / Хроника). Вкладки — вложенные СЕГМЕНТЫ с общим layout: у сетки
// смен и оборудования свои чанки, и открытие обзора не тянет их код.
// ============================================================

import { useMemo } from 'react';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { OBJECT_KINDS } from '@superapp/shared';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { Button, Card, Chip, EmptyState, LoadingBlock, PageHeader, Tabs, type TabItem } from '@/components/ui';
import { apiErrorMessage } from '@/lib/api';
import { objectKey } from '@/lib/queries';
import { fetchObject } from '../objects-api';

type TabKey = 'overview' | 'staffing' | 'shifts' | 'assets' | 'history';

export default function ObjectLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations('objects');
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
    { key: 'overview', label: t('tabs.overview'), icon: 'dashboard' },
    { key: 'staffing', label: t('tabs.staffing'), icon: 'staff' },
    { key: 'shifts', label: t('tabs.shifts'), icon: 'calendarCheck' },
    { key: 'assets', label: t('assets.breadcrumb'), icon: 'wrench' },
    { key: 'history', label: t('tabs.history'), icon: 'journal' },
  ];

  if (!isReady) return null;
  if (isPending) return <LoadingBlock />;
  // Пустой белый экран вместо ответа сервера — худшее из состояний: человек не
  // знает, объект удалён, закрыт правами или упала сеть. Показываем причину и
  // дорогу назад, а вкладки не рисуем вовсе (детям без объекта грузить нечего).
  if (!node) {
    return (
      <>
        <PageHeader breadcrumb={t('breadcrumb')} title={t('card.unavailable')} />
        <Card>
          <EmptyState
            icon="blocked"
            title={t('card.notOpened')}
            description={error ? apiErrorMessage(error) : t('card.notOpenedHint')}
            action={
              <Button variant="primary" icon="arrowLeft" href={`/workspaces/${id}/objects`}>
                {t('card.backToList')}
              </Button>
            }
          />
        </Card>
      </>
    );
  }

  const kindLabel = OBJECT_KINDS.some((k) => k.value === node.kind) ? t(`kind.${node.kind}`) : t('entity');

  return (
    <>
      <PageHeader
        breadcrumb={t('breadcrumb')}
        title={node.name}
        chip={
          <>
            <Chip tone="neutral">{kindLabel}</Chip>
            {node.isDefault && <Chip tone="accent">{t('card.main')}</Chip>}
            {node.archivedAt && <Chip tone="neutral">{t('archived')}</Chip>}
          </>
        }
        description={[node.address, node.effectiveLegalEntityName].filter(Boolean).join(' · ') || undefined}
      />
      <div style={{ marginBottom: 'var(--spacing-6)' }}>
        <Tabs
          items={tabs}
          value={active}
          onChange={(key) => router.push(key === 'overview' ? base : `${base}/${key}`)}
          aria-label={t('tabs.aria')}
        />
      </div>
      {children}
    </>
  );
}
