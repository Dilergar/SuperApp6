'use client';

import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, CardHeader } from '@/components/ui';
import { usePlatformAuth } from '@/lib/platform/usePlatformAuth';
import { fetchPlatformDataSummary, platformDataKey } from '@/lib/platform/api';
import { LevelChip } from './data-ui';

/**
 * Плитка «Данные» на главной Кабинета: один сводный светофор (худшая из шести плиток
 * дашборда) и вход в дашборд. Без права `data.read` не рисуется вовсе.
 */
export function DataHealthTile() {
  const t = useTranslations('platform');
  const { can } = usePlatformAuth();
  const allowed = can('data.read');
  const q = useQuery({ queryKey: platformDataKey('summary'), queryFn: fetchPlatformDataSummary, enabled: allowed, refetchInterval: 60_000, staleTime: 30_000 });
  if (!allowed) return null;
  return (
    <Card>
      <CardHeader
        title={t('data.title')}
        subtitle={t('data.tileText')}
        style={{ marginBottom: 0 }}
        actions={
          <div style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'center', flexWrap: 'wrap' }}>
            {q.data && <LevelChip level={q.data.level} />}
            <Button size="sm" variant="outline" icon="database" href="/platform/data">{t('data.open')}</Button>
          </div>
        }
      />
    </Card>
  );
}
