'use client';

// ============================================================
// Кабинет платформы → «Согласия и документы» (core/consents): охват принятия действующих
// версий, все версии документов без текста, журнал инцидентов ПДн со сроком уведомления
// органа. Мутации — ТОЛЬКО команды кабинета (черновик, публикация с «четырьмя глазами»,
// заверение ЭЦП, перезаверение, шаги инцидента): страница открывает запуск команды.
// ============================================================

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import type { PdIncidentDto, PlatformCommandDto } from '@superapp/shared';
import { Alert, Button, Card, Chip, EmptyState, LoadingBlock, PageHeader, SegmentedControl, Table, TableCell, TableRow, TickBar, type Tone } from '@/components/ui';
import { CommandRunner } from '@/components/platform/CommandRunner';
import { useFormatters } from '@/lib/format';
import { fetchPlatformCommands, fetchPlatformConsentDocuments, fetchPlatformPdIncidents, platformCommandsKey } from '@/lib/platform/api';
import { usePlatformAuth } from '@/lib/platform/usePlatformAuth';
import { platformConsentsDocumentsKey, platformConsentsIncidentsKey } from '@/lib/queries';

type Tab = 'documents' | 'incidents';

const VERSION_TONE: Record<string, Tone> = { draft: 'waiting', published: 'success', superseded: 'neutral', withdrawn: 'warning' };
const INCIDENT_TONE: Record<PdIncidentDto['status'], Tone> = { open: 'danger', authority_notified: 'waiting', subjects_notified: 'accent', closed: 'neutral' };

export default function PlatformConsentsPage() {
  const t = useTranslations('consents');
  const p = useTranslations('platform');
  const shell = useTranslations('shell');
  const f = useFormatters();
  const qc = useQueryClient();
  const { can } = usePlatformAuth();
  const [tab, setTab] = useState<Tab>('documents');
  const [runner, setRunner] = useState<{ command: PlatformCommandDto; input: Record<string, unknown> } | null>(null);

  const docsQ = useQuery({ queryKey: platformConsentsDocumentsKey, queryFn: fetchPlatformConsentDocuments, enabled: can('consents.read') });
  const incidentsQ = useQuery({ queryKey: platformConsentsIncidentsKey, queryFn: fetchPlatformPdIncidents, enabled: tab === 'incidents' && can('pd.incidents.read') });
  const commandsQ = useQuery({ queryKey: platformCommandsKey, queryFn: fetchPlatformCommands, staleTime: 60_000 });
  const cmd = (key: string) => commandsQ.data?.find((c) => c.key === key) ?? null;
  const open = (key: string, input: Record<string, unknown>) => {
    const c = cmd(key);
    if (c) setRunner({ command: c, input });
  };

  const tabs: Array<{ key: Tab; label: string }> = [{ key: 'documents', label: t('console.tabs.documents') }];
  if (can('pd.incidents.read')) tabs.push({ key: 'incidents', label: t('console.tabs.incidents') });

  return (
    <>
      <PageHeader
        breadcrumb={p('shell.title')}
        title={t('console.title')}
        description={t('console.description')}
        actions={
          tab === 'incidents'
            ? cmd('pd.incident.open') && <Button variant="primary" tone="danger" icon="shield" onClick={() => open('pd.incident.open', {})}>{p('commands.pdIncidentOpen.title')}</Button>
            : cmd('consents.versions.reattest') && <Button variant="ghost" icon="key" onClick={() => open('consents.versions.reattest', {})}>{p('commands.consentsVersionsReattest.title')}</Button>
        }
      />
      <SegmentedControl aria-label={t('console.title')} items={tabs} value={tab} onChange={(k) => setTab(k as Tab)} />

      {tab === 'documents' && (
        <div style={{ marginTop: 'var(--spacing-5)' }}>
          {docsQ.isPending ? <LoadingBlock /> : docsQ.isError ? <Alert tone="danger">{t('console.loadFailed')}</Alert> : (
            <>
              <h2 className="title-md" style={{ marginBottom: 'var(--spacing-3)' }}>{t('console.coverageTitle')}</h2>
              <div className="consents-coverage">
                {docsQ.data.coverage.map((c) => (
                  <Card key={c.documentKey} small>
                    <div style={{ display: 'grid', gap: 'var(--spacing-2)' }}>
                      <span style={{ fontWeight: 700, fontSize: '0.875rem' }}>{shell(`consents.documents.${c.documentKey}`)}</span>
                      {c.currentVersion === null ? (
                        <Chip size="sm" tone="warning">{t('console.notPublished')}</Chip>
                      ) : (
                        <>
                          <TickBar value={c.population > 0 ? Math.min(100, (c.accepted / c.population) * 100) : 0} aria-label={t('console.coverage', { accepted: c.accepted, population: c.population })} />
                          <span className="label-sm">{shell('consents.viewer.version', { version: c.currentVersion })} · {t('console.coverage', { accepted: f.number(c.accepted), population: f.number(c.population) })}</span>
                        </>
                      )}
                      <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
                        {cmd('consents.document.draft.save') && <Button size="sm" variant="ghost" icon="edit" onClick={() => open('consents.document.draft.save', { documentKey: c.documentKey, material: true })}>{p('commands.consentsDocumentDraftSave.title')}</Button>}
                        {cmd('consents.document.publish') && <Button size="sm" variant="ghost" icon="send" onClick={() => open('consents.document.publish', { documentKey: c.documentKey })}>{p('commands.consentsDocumentPublish.title')}</Button>}
                      </div>
                    </div>
                  </Card>
                ))}
              </div>

              <h2 className="title-md" style={{ margin: 'var(--spacing-6) 0 var(--spacing-3)' }}>{t('console.versionsTitle')}</h2>
              <p className="label-sm" style={{ marginBottom: 'var(--spacing-3)' }}>{t('console.commandsHint')}</p>
              <Table
                columns={[
                  { key: 'document', label: t('console.col.document') },
                  { key: 'version', label: t('console.col.version'), width: 'max-content' },
                  { key: 'status', label: t('console.col.status'), width: 'max-content' },
                  { key: 'effective', label: t('console.col.effective'), width: 'max-content', hideOnMobile: true },
                  { key: 'kind', label: t('console.col.kind'), width: 'max-content', hideOnMobile: true },
                  { key: 'signature', label: t('console.col.signature'), hideOnMobile: true },
                  { key: 'actions', label: '', width: 'max-content' },
                ]}
                lines
                aria-label={t('console.versionsTitle')}
              >
                {docsQ.data.versions.map((v, i) => (
                  <TableRow key={v.versionId} rowIndex={i + 1}>
                    <TableCell><span className="body-sm">{shell(`consents.documents.${v.documentKey}`)}</span></TableCell>
                    <TableCell>{v.version}</TableCell>
                    <TableCell><Chip size="sm" tone={VERSION_TONE[v.status] ?? 'neutral'}>{t(`console.status.${v.status}`)}</Chip></TableCell>
                    <TableCell>{v.status === 'draft' ? '—' : f.dateTime(v.effectiveFrom)}</TableCell>
                    <TableCell>
                      <span style={{ display: 'inline-flex', gap: '0.375rem', flexWrap: 'wrap' }}>
                        <Chip size="sm" tone="neutral">{v.material ? t('console.material') : t('console.immaterial')}</Chip>
                        {v.urgentReason && <Chip size="sm" tone="warning">{t('console.urgent')}</Chip>}
                        {v.attested && <Chip size="sm" tone="success" icon="sealCheck">{t('console.attested')}</Chip>}
                      </span>
                    </TableCell>
                    <TableCell><span className="receipt-mono">{v.signatureKid ? v.signatureKid.slice(0, 8) : '—'}</span></TableCell>
                    <TableCell>
                      {v.status !== 'draft' && !v.attested && cmd('consents.document.attest') && (
                        <Button size="sm" variant="ghost" icon="sealCheck" onClick={() => open('consents.document.attest', { versionId: v.versionId })}>{p('commands.consentsDocumentAttest.title')}</Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </Table>
            </>
          )}
        </div>
      )}

      {tab === 'incidents' && (
        <div style={{ marginTop: 'var(--spacing-5)' }} className="ui-stack">
          {incidentsQ.isPending ? <LoadingBlock /> : incidentsQ.isError ? <Alert tone="danger">{t('console.loadFailed')}</Alert> : !incidentsQ.data.length ? (
            <EmptyState icon="shield" title={t('console.incidentsEmpty')} />
          ) : (
            incidentsQ.data.map((inc) => (
              <Card key={inc.id}>
                <div style={{ display: 'grid', gap: 'var(--spacing-2)' }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-2)', alignItems: 'center' }}>
                    <span style={{ fontWeight: 700 }}>{t(`console.incident.kind.${inc.kind}`)}</span>
                    <Chip size="sm" tone={INCIDENT_TONE[inc.status]}>{t(`console.incident.status.${inc.status}`)}</Chip>
                    {inc.overdue && <Chip size="sm" tone="danger" icon="warning">{t('console.incident.overdue')}</Chip>}
                  </div>
                  <p className="label-sm" style={{ margin: 0 }}>
                    {t('console.incident.detected', { date: f.dateTime(inc.detectedAt) })}
                    {inc.status === 'open' && <> · {t('console.incident.deadline', { date: f.dateTime(inc.notifyDeadlineAt) })}</>}
                    {inc.affectedEstimate !== null && <> · {t('console.incident.affected', { count: f.number(inc.affectedEstimate) })}</>}
                  </p>
                  <p className="body-sm" style={{ margin: 0 }}>{inc.scope}</p>
                  <p className="body-sm" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{inc.summary}</p>
                  <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
                    {inc.status === 'open' && cmd('pd.incident.notify_authority') && <Button size="sm" variant="matte" tone="danger" onClick={() => open('pd.incident.notify_authority', { incidentId: inc.id })}>{p('commands.pdIncidentNotifyAuthority.title')}</Button>}
                    {inc.status === 'authority_notified' && cmd('pd.incident.notify_subjects') && <Button size="sm" variant="matte" tone="waiting" onClick={() => open('pd.incident.notify_subjects', { incidentId: inc.id })}>{p('commands.pdIncidentNotifySubjects.title')}</Button>}
                    {inc.status !== 'closed' && cmd('pd.incident.close') && <Button size="sm" variant="ghost" onClick={() => open('pd.incident.close', { incidentId: inc.id })}>{p('commands.pdIncidentClose.title')}</Button>}
                  </div>
                </div>
              </Card>
            ))
          )}
        </div>
      )}

      {runner && (
        <CommandRunner
          open
          command={runner.command}
          initialInput={runner.input}
          onClose={() => setRunner(null)}
          onDone={() => {
            void qc.invalidateQueries({ queryKey: platformConsentsDocumentsKey });
            void qc.invalidateQueries({ queryKey: platformConsentsIncidentsKey });
          }}
        />
      )}
    </>
  );
}
