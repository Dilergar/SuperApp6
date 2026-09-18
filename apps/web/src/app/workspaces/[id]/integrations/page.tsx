'use client';

// ============================================================
// «Интеграции и ключи» организации (core/keys + core/webhooks). Главный экран —
// РЕЕСТР КЛЮЧЕЙ (решение грилла №12): одна таблица на ботов, личные ключи и вебхуки
// (кто создал, когда, для чего, права, статус, последнее использование, срок) с фильтрами
// и значком «ждут решения». Вкладки: Боты · Вебхуки · Журнал · Политика. Доступ —
// владелец и админы (гейт серверный: 403 keys.role_required; остальным раздела нет и в
// навигации). Любое создание/ротация/разморозка — под step-up (KeysStepUpProvider).
// ============================================================

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useParams, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { type BotDto, type KeyRegistryRowDto, type Workspace, type WorkspaceRole } from '@superapp/shared';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { apiGet } from '@/lib/api';
import { workspaceKey } from '@/lib/queries';
import { KeysStepUpProvider, StepUpWindowChip } from '@/components/keys';
import { BentoGrid, Button, Card, EmptyState, LoadingBlock, PageHeader, Tabs, type TabItem } from '@/components/ui';
import { RegistryTab } from './RegistryTab';
import { BotsTab } from './BotsTab';
import { JournalTab, type JournalFocus } from './JournalTab';
import { PolicyTab } from './PolicyTab';
import { WebhooksTab } from './WebhooksTab';

type Tab = 'registry' | 'bots' | 'webhooks' | 'journal' | 'policy';
const TABS: Tab[] = ['registry', 'bots', 'webhooks', 'journal', 'policy'];

export default function IntegrationsPage() {
  const t = useTranslations('keys');
  const tw = useTranslations('workspaces');
  const { isReady } = useRequireAuth();
  const { id } = useParams<{ id: string }>();
  const search = useSearchParams();
  const initial = (search.get('tab') as Tab | null) ?? (search.get('bot') ? 'bots' : 'registry');
  const [tab, setTab] = useState<Tab>(TABS.includes(initial) ? initial : 'registry');
  // Журнал одного предмета — открывается из строки реестра или карточки бота
  const [journalFocus, setJournalFocus] = useState<JournalFocus | null>(null);
  const openJournalFor = useCallback((focus: JournalFocus) => {
    setJournalFocus(focus);
    setTab('journal');
  }, []);
  const onRowJournal = useCallback((r: KeyRegistryRowDto) => {
    if (r.kind === 'bot' && r.botId) openJournalFor({ subjectType: 'bot', subjectId: r.botId, name: r.holder.name || r.name });
    else openJournalFor({ subjectType: r.kind === 'webhook' ? 'webhook_endpoint' : 'api_key', subjectId: r.id, name: r.name });
  }, [openJournalFor]);
  const onBotJournal = useCallback((b: BotDto) => openJournalFor({ subjectType: 'bot', subjectId: b.id, name: b.name }), [openJournalFor]);

  const wsQuery = useQuery({
    queryKey: workspaceKey(id),
    queryFn: async () => await apiGet<Workspace>(`/workspaces/${id}`),
    enabled: isReady,
  });
  const myRole = wsQuery.data?.myRole as WorkspaceRole | undefined;
  const isManager = myRole === 'owner' || myRole === 'admin';
  const isOwner = myRole === 'owner';

  if (!isReady || wsQuery.isPending) return <LoadingBlock />;

  const header = (
    <PageHeader
      breadcrumb={wsQuery.data?.name ?? tw('orgFallback')}
      title={t('title')}
      description={t('subtitle')}
      actions={isManager ? <StepUpWindowChip /> : undefined}
    />
  );

  if (wsQuery.isError) {
    return (
      <>
        {header}
        <BentoGrid>
          <Card span={12}>
            <EmptyState icon="blocked" title={tw('notOpened.title')} description={tw('notOpened.description')} action={<Button variant="matte" icon="dashboard" href="/dashboard">{tw('toDashboard')}</Button>} />
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
            <EmptyState icon="lock" title={t('noAccess.title')} description={t('noAccess.body')} />
          </Card>
        </BentoGrid>
      </>
    );
  }

  const tabs: TabItem<Tab>[] = [
    { key: 'registry', label: t('nav.registry'), icon: 'key' },
    { key: 'bots', label: t('nav.bots'), icon: 'robot' },
    { key: 'webhooks', label: t('nav.webhooks'), icon: 'webhook' },
    { key: 'journal', label: t('nav.journal'), icon: 'journal' },
    { key: 'policy', label: t('nav.policy'), icon: 'shield' },
  ];

  return (
    <KeysStepUpProvider>
      {header}
      <div style={{ marginBottom: 'var(--spacing-4)' }}>
        <Tabs items={tabs} value={tab} onChange={setTab} aria-label={t('nav.aria')} />
      </div>
      {tab === 'registry' && <RegistryTab workspaceId={id} isOwner={isOwner} onOpenBots={() => setTab('bots')} onOpenWebhooks={() => setTab('webhooks')} onOpenJournal={onRowJournal} />}
      {tab === 'bots' && <BotsTab workspaceId={id} isOwner={isOwner} focusBotId={search.get('bot')} onOpenJournal={onBotJournal} />}
      {tab === 'webhooks' && <WebhooksTab workspaceId={id} focusEndpointId={search.get('endpoint')} />}
      {tab === 'journal' && <JournalTab workspaceId={id} focus={journalFocus} onClearFocus={() => setJournalFocus(null)} />}
      {tab === 'policy' && <PolicyTab workspaceId={id} isOwner={isOwner} />}
    </KeysStepUpProvider>
  );
}
