'use client';

// ============================================================
// «Мои документы» (КЭДО, Этап 9) — ЛИЧНЫЙ архив: всё, что человек подписал,
// с чем ознакомился и что ему вручили работодатели. Доступ БЕССРОЧНЫЙ:
// записи переживают увольнение И закрытие компании (PersonalDocRecord +
// FileLink personal_doc держат файл живым после purge организации).
//
// Инвариант «контекст из пути» не нарушается: страница читает СВОИ записи,
// в живые организации ведут ссылки (паттерн MyApprovalsList).
// ============================================================

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { PERSONAL_DOC_KINDS, type PersonalDocKind } from '@superapp/shared';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { useFormatters } from '@/lib/format';
import { fetchMyHrDocuments } from '@/lib/hr-api';
import { myHrDocumentsKey } from '@/lib/queries';
import {
  Alert,
  Button,
  Card,
  Chip,
  EmptyState,
  LoadingBlock,
  PageHeader,
  SegmentedControl,
  type TabItem,
} from '@/components/ui';

type Filter = 'all' | PersonalDocKind;

export default function MyDocumentsPage() {
  const t = useTranslations('hr');
  const tc = useTranslations('common');
  const f = useFormatters();
  const { isReady } = useRequireAuth();
  const [filter, setFilter] = useState<Filter>('all');

  const docsQ = useQuery({
    queryKey: myHrDocumentsKey,
    queryFn: fetchMyHrDocuments,
    enabled: isReady,
  });

  if (!isReady || docsQ.isPending) return <LoadingBlock />;

  const items = (docsQ.data?.items ?? []).filter((r) => filter === 'all' || r.kind === filter);
  const tabs: TabItem<Filter>[] = [
    { key: 'all', label: tc('labels.all'), count: docsQ.data?.items.length ?? 0 },
    ...PERSONAL_DOC_KINDS.map((k) => ({ key: k as Filter, label: t(`personalDocKind.${k}`) })),
  ];

  return (
    <>
      <PageHeader
        title={t('personalDocs.title')}
        description={t('personalDocs.description')}
      />

      <div style={{ marginBottom: 'var(--gap-grid)' }}>
        <SegmentedControl aria-label={t('personalDocs.filter')} items={tabs} value={filter} onChange={setFilter} />
      </div>

      {docsQ.isError ? (
        <EmptyState
          icon="warningCircle"
          title={t('personalDocs.loadFailed')}
          action={
            <Button variant="matte" icon="refresh" onClick={() => docsQ.refetch()}>
              {tc('actions.retry')}
            </Button>
          }
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon="folder"
          title={t('personalDocs.emptyTitle')}
          description={t('personalDocs.emptyDescription')}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)' }}>
          {items.map((r) => (
            <Card key={r.id}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 700, wordBreak: 'break-word' }}>
                    {r.number ? `${r.title} № ${r.number}` : r.title}
                  </div>
                  <div className="meta" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
                    <span>{r.workspaceName}</span>
                    {!r.workspaceAlive && <Chip tone="neutral">{t('personalDocs.workspaceClosed')}</Chip>}
                    {r.docTypeName && <span>· {r.docTypeName}</span>}
                    <span>· {f.date(r.reachedAt)}</span>
                  </div>
                </div>
                <Chip tone={r.kind === 'signed' ? 'accent' : r.kind === 'acknowledged' ? 'neutral' : 'success'}>
                  {t(`personalDocKind.${r.kind}`)}
                </Chip>
                {r.downloadUrl && (
                  <Button variant="matte" size="sm" icon="download" href={r.downloadUrl}>
                    {tc('actions.download')}
                  </Button>
                )}
                {r.checkUrl && (
                  <Button variant="ghost" size="sm" icon="signature" href={r.checkUrl}>
                    {t('personalDocs.checkSignature')}
                  </Button>
                )}
                {r.workspaceAlive && r.orgDocumentId && (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="arrowRight"
                    href={`/workspaces/${r.workspaceId}/documents/${r.orgDocumentId}`}
                  >
                    {t('personalDocs.openInWorkspace')}
                  </Button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      {(docsQ.data?.items.length ?? 0) >= 200 && (
        <div style={{ marginTop: 'var(--spacing-3)' }} className="meta">
          {t('personalDocs.tail', { limit: 200 })}
        </div>
      )}

      <div style={{ marginTop: 'var(--gap-grid)' }}>
        {/* Экран-подсказка «нет ЭЦП» (Этап 9): получить ключ можно удалённо */}
        <Alert tone="accent" title={t('personalDocs.noQesTitle')}>
          {t('personalDocs.noQesBody')}
        </Alert>
      </div>
    </>
  );
}
