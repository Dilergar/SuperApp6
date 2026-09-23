'use client';

// ============================================================
// Консоль «Безопасность» Кабинета (core/audit): вкладки События · Команды · Тревоги ·
// Целостность. Вкладка видна только держателю своего права (журнал безопасности —
// `security.read`, журнал команд — `platform.audit.read`): узкая роль не видит вкладку,
// на которой получила бы 403 (правило «не предлагать отвергнутое»).
// ============================================================

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { PageHeader, Tabs, type TabItem } from '@/components/ui';
import { usePlatformAuth } from '@/lib/platform/usePlatformAuth';
import { fetchPlatformSecurityAlertSummary, platformSecurityAlertSummaryKey } from '@/lib/platform/api';
import { EventsTab } from './EventsTab';
import { CommandsTab } from './CommandsTab';
import { AlertsTab } from './AlertsTab';
import { IntegrityTab } from './IntegrityTab';

type Tab = 'events' | 'commands' | 'alerts' | 'integrity';

export default function PlatformSecurityPage() {
  const t = useTranslations('platform');
  const { can } = usePlatformAuth();
  const search = useSearchParams();
  // Счётчик вкладки «Тревоги» — незакрытая очередь (открытые + в работе); команда закрытия сбрасывает весь кэш Кабинета
  const summary = useQuery({ queryKey: platformSecurityAlertSummaryKey, queryFn: fetchPlatformSecurityAlertSummary, enabled: can('security.read'), staleTime: 30_000 });
  const unresolved = summary.data ? summary.data.open + summary.data.ack : undefined;
  const tabs = useMemo(() => {
    const out: TabItem<Tab>[] = [];
    if (can('security.read')) out.push({ key: 'events', label: t('security.tabs.events'), icon: 'list' });
    if (can('platform.audit.read')) out.push({ key: 'commands', label: t('security.tabs.commands'), icon: 'file' });
    if (can('security.read')) {
      out.push({ key: 'alerts', label: t('security.tabs.alerts'), icon: 'shieldWarning', count: unresolved });
      out.push({ key: 'integrity', label: t('security.tabs.integrity'), icon: 'fingerprint' });
    }
    return out;
  }, [can, t, unresolved]);
  const wanted = search.get('tab') as Tab | null;
  const [picked, setPicked] = useState<Tab | null>(wanted);
  const tab: Tab | null = tabs.some((x) => x.key === picked) ? picked : (tabs[0]?.key ?? null);

  return (
    <>
      <PageHeader breadcrumb={t('shell.title')} title={t('security.title')} description={t('security.description')} />
      {tabs.length > 1 && (
        <div style={{ marginBottom: 'var(--spacing-4)' }}>
          <Tabs items={tabs} value={tab ?? tabs[0].key} onChange={setPicked} aria-label={t('security.title')} />
        </div>
      )}
      {tab === 'events' && <EventsTab canReveal={can('platform.pii.reveal')} />}
      {tab === 'commands' && <CommandsTab />}
      {tab === 'alerts' && <AlertsTab canWrite={can('security.write')} />}
      {tab === 'integrity' && <IntegrityTab canExport={can('security.write')} />}
    </>
  );
}
