'use client';

// Вкладка «Целостность» консоли «Безопасность»: подписанные дайджесты журнала (окно, строк,
// корень Меркла, статус проверки) и месячные партиции со статусом архива. Проверка дайджестов
// и выгрузка партиций — команды и джобы движка; здесь — только их результат.

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import type { PlatformCommandDto, SecurityDigestDto, SecurityDigestVerifyDto, SecurityPartitionDto } from '@superapp/shared';
import { Alert, Button, Card, CardHeader, Chip, EmptyState, LoadingBlock, Table, TableCell, TableRow, type TableColumn, type Tone } from '@/components/ui';
import { CommandRunner } from '@/components/platform/CommandRunner';
import { ManifestModal } from './ManifestModal';
import {
  fetchPlatformCommands,
  fetchPlatformSecurityDigests,
  fetchPlatformSecurityExportUrl,
  fetchPlatformSecurityExports,
  fetchPlatformSecurityPartitions,
  platformCommandsKey,
  platformSecurityDigestsKey,
  platformSecurityExportsKey,
  platformSecurityPartitionsKey,
} from '@/lib/platform/api';
import { toastApiError } from '@/lib/api-errors';
import { toast } from '@/lib/toast';
import { useBytes, useFormatters } from '@/lib/format';

const PARTITION_TONE: Record<SecurityPartitionDto['status'], Tone> = { in_db: 'success', archived: 'accent', dropped: 'neutral' };

function digestState(d: SecurityDigestDto): { key: 'verified' | 'mismatch' | 'unverified'; tone: Tone } {
  if (d.verifyOk === true) return { key: 'verified', tone: 'success' };
  if (d.verifyOk === false) return { key: 'mismatch', tone: 'danger' };
  return { key: 'unverified', tone: 'neutral' };
}

export function IntegrityTab({ canExport }: { canExport: boolean }) {
  const t = useTranslations('platform');
  const tc = useTranslations('common');
  const fmt = useFormatters();
  const bytes = useBytes();
  const digests = useQuery({ queryKey: platformSecurityDigestsKey, queryFn: fetchPlatformSecurityDigests });
  const partitions = useQuery({ queryKey: platformSecurityPartitionsKey, queryFn: fetchPlatformSecurityPartitions });
  const exports = useQuery({ queryKey: platformSecurityExportsKey, queryFn: fetchPlatformSecurityExports });
  const commandsQ = useQuery({ queryKey: platformCommandsKey, queryFn: fetchPlatformCommands, staleTime: 60_000 });
  const command = (key: string) => commandsQ.data?.find((c) => c.key === key) ?? null;
  const [runner, setRunner] = useState<{ command: PlatformCommandDto; input: Record<string, unknown> } | null>(null);
  const [manifest, setManifest] = useState<{ partition: string; month: string } | null>(null);
  const monthOf = (p: SecurityPartitionDto) => `${fmt.month(Date.parse(p.from) + 15 * 86_400_000)} · ${p.from.slice(0, 4)}`;

  const runVerify = () => {
    const c = command('security.digest.verify');
    if (c) setRunner({ command: c, input: { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date().toISOString() } });
  };
  const runExport = () => {
    const c = command('security.export');
    if (c) setRunner({ command: c, input: { format: 'ndjson', from: new Date(Date.now() - 30 * 86_400_000).toISOString(), to: new Date().toISOString() } });
  };
  const download = async (fileId: string) => {
    try {
      const { url } = await fetchPlatformSecurityExportUrl(fileId);
      window.location.assign(url);
    } catch (err) {
      toastApiError(err);
    }
  };

  const digestCols: TableColumn[] = [
    { key: 'window', label: t('security.integrity.col.window') },
    { key: 'rows', label: t('security.integrity.col.rows'), width: 'max-content', align: 'end' },
    { key: 'root', label: t('security.integrity.col.root'), width: 'max-content', hideOnMobile: true },
    { key: 'signed', label: t('security.integrity.col.signed'), width: '8.5rem', hideOnMobile: true },
    { key: 'status', label: t('security.integrity.col.status'), width: 'max-content' },
  ];
  const partitionCols: TableColumn[] = [
    { key: 'month', label: t('security.integrity.col.month') },
    { key: 'status', label: t('security.integrity.col.status'), width: 'max-content' },
    { key: 'rows', label: t('security.integrity.col.rows'), width: 'max-content', align: 'end', hideOnMobile: true },
    { key: 'archived', label: t('security.integrity.col.archived'), width: '8.5rem', hideOnMobile: true },
    { key: 'manifest', label: '', width: 'max-content' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gap-grid)' }}>
      <Card>
        <CardHeader
          title={t('security.integrity.digests')}
          subtitle={t('security.integrity.digestsHint')}
          actions={command('security.digest.verify') ? <Button size="sm" variant="outline" icon="fingerprint" onClick={runVerify}>{t('security.integrity.verify24h')}</Button> : undefined}
        />
        {digests.isPending ? (
          <LoadingBlock />
        ) : digests.isError ? (
          <Alert tone="danger">{tc('state.error')}</Alert>
        ) : !digests.data.length ? (
          <EmptyState icon="history" title={t('security.integrity.noDigests')} />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <Table columns={digestCols} lines aria-label={t('security.integrity.digests')}>
              {digests.data.map((d, i) => {
                const st = digestState(d);
                return (
                  <TableRow key={d.id} rowIndex={i + 2}>
                    <TableCell><span className="label-sm">{d.firstAt && d.lastAt ? fmt.timeRange(d.firstAt, d.lastAt) : fmt.dateTime(d.signedAt, 'short')}</span></TableCell>
                    <TableCell align="end"><span className="label-sm">{fmt.number(d.count)}</span></TableCell>
                    <TableCell hideOnMobile><code style={{ fontSize: '0.75rem' }}>{d.merkleRoot.slice(0, 16)}…</code></TableCell>
                    <TableCell hideOnMobile><span className="label-sm">{fmt.dateTime(d.signedAt, 'short')}</span></TableCell>
                    <TableCell><Chip size="sm" tone={st.tone}>{t(`security.integrity.${st.key}`)}</Chip></TableCell>
                  </TableRow>
                );
              })}
            </Table>
          </div>
        )}
      </Card>
      <Card>
        <CardHeader title={t('security.integrity.partitions')} subtitle={t('security.integrity.partitionsHint')} />
        {partitions.isPending ? (
          <LoadingBlock />
        ) : partitions.isError ? (
          <Alert tone="danger">{tc('state.error')}</Alert>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <Table columns={partitionCols} lines aria-label={t('security.integrity.partitions')}>
              {partitions.data.map((p, i) => (
                <TableRow key={p.name} rowIndex={i + 2}>
                  <TableCell><span className="body-sm">{fmt.month(Date.parse(p.from) + 15 * 86_400_000)} · <span className="label-sm">{p.from.slice(0, 4)}</span></span></TableCell>
                  <TableCell><Chip size="sm" tone={PARTITION_TONE[p.status]}>{t(`security.integrity.partitionStatus.${p.status}`)}</Chip></TableCell>
                  <TableCell align="end" hideOnMobile><span className="label-sm">{p.rows === null ? '—' : fmt.number(p.rows)}</span></TableCell>
                  <TableCell hideOnMobile><span className="label-sm">{p.archivedAt ? fmt.date(p.archivedAt) : '—'}</span></TableCell>
                  <TableCell>
                    {p.status !== 'in_db' && (
                      <Button size="sm" variant="ghost" icon="fingerprint" onClick={() => setManifest({ partition: p.name, month: monthOf(p) })}>{t('security.integrity.manifest.open')}</Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </Table>
          </div>
        )}
      </Card>
      <Card>
        <CardHeader
          title={t('security.integrity.exports')}
          subtitle={t('security.integrity.exportsHint')}
          actions={canExport && command('security.export') ? <Button size="sm" variant="outline" icon="download" onClick={runExport}>{t('security.integrity.export')}</Button> : undefined}
        />
        {exports.isPending ? (
          <LoadingBlock />
        ) : exports.isError ? (
          <Alert tone="danger">{tc('state.error')}</Alert>
        ) : !exports.data.length ? (
          <EmptyState icon="download" title={t('security.integrity.noExports')} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
            {exports.data.map((f) => (
              <div key={f.fileId} style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
                <span className="body-sm" style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{f.name}</span>
                <span className="label-sm">{bytes(f.size)} · {fmt.dateTime(f.createdAt, 'short')}</span>
                <Button size="sm" variant="ghost" icon="download" onClick={() => void download(f.fileId)}>{t('security.integrity.download')}</Button>
              </div>
            ))}
          </div>
        )}
      </Card>
      {manifest && <ManifestModal partition={manifest.partition} month={manifest.month} onClose={() => setManifest(null)} />}
      {runner && (
        <CommandRunner
          command={runner.command}
          initialInput={runner.input}
          open
          onClose={() => setRunner(null)}
          onDone={(res) => {
            if (runner.command.key !== 'security.digest.verify') return;
            const r = res.result as SecurityDigestVerifyDto | null;
            if (!r) return;
            if (r.ok) toast(t('security.integrity.verifyOk', { digests: r.digests, rows: r.rows }), 'success');
            else toast(t('security.integrity.verifyFailed', { n: r.mismatched.length }), 'danger');
          }}
        />
      )}
    </div>
  );
}
