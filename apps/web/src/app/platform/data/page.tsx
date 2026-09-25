'use client';

// ============================================================
// Дашборд «Данные» Кабинета (core/lifecycle): Обзор · Хранилище · Сроки · Стирания ·
// Бэкапы · Канарейка. Право `data.read`. Вкладка живёт в адресе (`?tab=`): строка «Нужно
// внимание» ведёт прямо на вкладку причины, ссылку можно переслать дежурному. Данные
// перечитываются раз в 30 секунд, пока вкладка браузера видна.
// ============================================================

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { Alert, EmptyState, LoadingBlock, PageHeader, Tabs, type IconName, type TabItem } from '@/components/ui';
import { usePlatformAuth } from '@/lib/platform/usePlatformAuth';
import {
  fetchPlatformDataBackups,
  fetchPlatformDataCanary,
  fetchPlatformDataErasure,
  fetchPlatformDataOverview,
  fetchPlatformDataRetention,
  fetchPlatformDataStorage,
  platformDataKey,
} from '@/lib/platform/api';
import { DATA_TABS, type DataTab } from '@/components/platform/data/data-ui';
import { DataOverview } from '@/components/platform/data/DataOverview';
import { DataBackupsTab, DataCanaryTab, DataErasureTab, DataRetentionTab, DataStorageTab } from '@/components/platform/data/DataTabs';

const REFRESH_MS = 30_000;

const TAB_ICON: Record<DataTab, IconName> = {
  overview: 'dashboard',
  storage: 'database',
  retention: 'hourglass',
  erasure: 'fingerprint',
  backups: 'archive',
  canary: 'shield',
};

export default function PlatformDataPage() {
  const tp = useTranslations('platform');
  const t = useTranslations('platformData');
  const { can } = usePlatformAuth();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const wanted = search.get('tab');
  const tab: DataTab = (DATA_TABS as readonly string[]).includes(wanted ?? '') ? (wanted as DataTab) : 'overview';
  const allowed = can('data.read');

  const tabs = useMemo<TabItem<DataTab>[]>(() => DATA_TABS.map((k) => ({ key: k, label: t(`tabs.${k}`), icon: TAB_ICON[k] })), [t]);
  const select = (next: DataTab) => router.replace(next === 'overview' ? pathname : `${pathname}?tab=${next}`, { scroll: false });

  return (
    <>
      <PageHeader breadcrumb={tp('shell.title')} title={tp('data.title')} description={t('description')} />
      {!allowed ? (
        <EmptyState icon="lock" title={t('forbidden')} />
      ) : (
        <>
          <div style={{ marginBottom: 'var(--spacing-4)' }}>
            <Tabs items={tabs} value={tab} onChange={select} aria-label={tp('data.title')} />
          </div>
          {tab === 'overview' && <TabBody tab={tab} fetcher={fetchPlatformDataOverview} render={(d) => <DataOverview data={d} />} />}
          {tab === 'storage' && <TabBody tab={tab} fetcher={fetchPlatformDataStorage} render={(d) => <DataStorageTab data={d} />} />}
          {tab === 'retention' && <TabBody tab={tab} fetcher={fetchPlatformDataRetention} render={(d) => <DataRetentionTab data={d} />} />}
          {tab === 'erasure' && <TabBody tab={tab} fetcher={fetchPlatformDataErasure} render={(d) => <DataErasureTab data={d} />} />}
          {tab === 'backups' && <TabBody tab={tab} fetcher={fetchPlatformDataBackups} render={(d) => <DataBackupsTab data={d} />} />}
          {tab === 'canary' && <TabBody tab={tab} fetcher={fetchPlatformDataCanary} render={(d) => <DataCanaryTab data={d} />} />}
        </>
      )}
    </>
  );
}

/** Загрузка одной вкладки: свой ключ на вкладку (одна форма кэша), фоновое обновление без мигания. */
function TabBody<T>({ tab, fetcher, render }: { tab: DataTab; fetcher: () => Promise<T>; render: (data: T) => React.ReactNode }) {
  const tc = useTranslations('common');
  const q: UseQueryResult<T> = useQuery({ queryKey: platformDataKey(tab), queryFn: fetcher, refetchInterval: REFRESH_MS, staleTime: 10_000 });
  if (q.isPending) return <LoadingBlock />;
  if (q.isError) return <Alert tone="danger">{tc('state.error')}</Alert>;
  return <>{render(q.data)}</>;
}
