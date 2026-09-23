'use client';

// Вкладка «Тревоги» консоли «Безопасность»: рабочая очередь детекций (перебор, распыление,
// выгрузки…). Действия — только командами реестра (журнал, причина, step-up делает
// исполнитель Кабинета): закрыть тревогу, завершить сессии человека, заморозить аккаунт.

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { AUDIT_ALERT_STATUSES, type AuditAlertStatus, type PlatformCommandDto, type SecurityAlertDto, type SecurityAlertPageDto } from '@superapp/shared';
import { Alert, Button, Card, Chip, EmptyState, LoadingBlock, Menu, Table, TableCell, TableRow, type MenuAction, type TableColumn, type Tone } from '@/components/ui';
import { CommandRunner } from '@/components/platform/CommandRunner';
import { PersonChip } from '@/app/circles/PersonCard';
import { fetchPlatformCommands, fetchPlatformSecurityAlerts, platformCommandsKey, platformSecurityAlertsKey } from '@/lib/platform/api';
import { useFormatters } from '@/lib/format';

const STATUS_TONE: Record<AuditAlertStatus, Tone> = { open: 'waiting', ack: 'accent', closed: 'neutral' };

export function AlertsTab({ canWrite }: { canWrite: boolean }) {
  const t = useTranslations('platform');
  const ta = useTranslations('audit');
  const tc = useTranslations('common');
  const fmt = useFormatters();
  const [status, setStatus] = useState<AuditAlertStatus | 'all'>('open');
  const [runner, setRunner] = useState<{ command: PlatformCommandDto; input: Record<string, unknown> } | null>(null);
  const commandsQ = useQuery({ queryKey: platformCommandsKey, queryFn: fetchPlatformCommands, staleTime: 60_000 });
  const command = (key: string) => commandsQ.data?.find((c) => c.key === key) ?? null;

  const q = useInfiniteQuery({
    queryKey: platformSecurityAlertsKey(status),
    queryFn: ({ pageParam }) => fetchPlatformSecurityAlerts(status, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last: SecurityAlertPageDto) => last.nextCursor,
  });
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);

  /** Подпись вида тревоги — заголовок события детекции; незнакомый вид — сырым кодом */
  const kindLabel = (kind: string) => (ta.has(`events.detect.${kind}.title`) ? ta(`events.detect.${kind}.title`) : kind);

  const actions = (a: SecurityAlertDto): MenuAction[] => {
    const out: MenuAction[] = [];
    const close = command('security.alert.close');
    if (close && a.status !== 'closed') out.push({ key: 'close', label: t('security.alerts.close'), icon: 'check', onClick: () => setRunner({ command: close, input: { alertId: a.id, resolution: 'resolved' } }) });
    const revoke = command('security.session.revoke');
    if (revoke && a.subjectUserId) out.push({ key: 'revoke', label: t('security.alerts.revokeSessions'), icon: 'signOut', danger: true, onClick: () => setRunner({ command: revoke, input: { userId: a.subjectUserId } }) });
    const freeze = command('security.account.freeze');
    if (freeze && a.subjectUserId) out.push({ key: 'freeze', label: t('security.alerts.freeze'), icon: 'snowflake', danger: true, onClick: () => setRunner({ command: freeze, input: { userId: a.subjectUserId } }) });
    return out;
  };

  const columns: TableColumn[] = [
    { key: 'severity', label: t('security.alerts.col.severity'), width: 'max-content' },
    { key: 'kind', label: t('security.alerts.col.kind') },
    { key: 'subject', label: t('security.alerts.col.subject'), width: 'max-content', hideOnMobile: true },
    { key: 'opened', label: t('security.alerts.col.opened'), width: '8.5rem' },
    { key: 'status', label: t('security.alerts.col.status'), width: 'max-content' },
    { key: 'actions', label: '', width: '2.75rem' },
  ];

  return (
    <Card>
      <div role="group" aria-label={t('security.alerts.col.status')} style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap', marginBottom: 'var(--spacing-4)' }}>
        {(['all', ...AUDIT_ALERT_STATUSES] as const).map((s) => (
          <Chip key={s} size="sm" selected={status === s} onClick={() => setStatus(s)}>{s === 'all' ? tc('labels.all') : t(`security.alertStatus.${s}`)}</Chip>
        ))}
      </div>
      {q.isPending ? (
        <LoadingBlock />
      ) : q.isError ? (
        <Alert tone="danger" action={<Button size="sm" variant="ghost" icon="refresh" onClick={() => void q.refetch()}>{tc('actions.retry')}</Button>}>{tc('state.error')}</Alert>
      ) : items.length === 0 ? (
        <EmptyState icon="shield" title={t('security.alerts.empty')} />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <Table columns={columns} lines aria-label={t('security.tabs.alerts')}>
            {items.map((a, i) => {
              const menu = canWrite ? actions(a) : [];
              return (
                <TableRow key={a.id} rowIndex={i + 2}>
                  <TableCell><Chip size="sm" tone={a.severity === 'critical' ? 'danger' : 'warning'}>{ta(`severities.${a.severity}`)}</Chip></TableCell>
                  <TableCell>
                    <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                      <span className="body-sm" style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{kindLabel(a.kind)}</span>
                      <span className="label-sm">{t('security.alerts.hits', { n: a.hits })}{a.resolution ? ` · ${ta(`alertResolutions.${a.resolution}`)}` : ''}</span>
                    </span>
                  </TableCell>
                  <TableCell hideOnMobile>
                    {a.subject ? <PersonChip size="S" userId={a.subject.id} firstName={a.subject.firstName} lastName={a.subject.lastName} avatar={a.subject.avatar} /> : <span className="label-sm">{a.workspaceId ?? (a.ipHmac ? t('security.network') : '—')}</span>}
                  </TableCell>
                  <TableCell><span className="label-sm">{fmt.dateTime(a.openedAt, 'short')}</span></TableCell>
                  <TableCell><Chip size="sm" tone={STATUS_TONE[a.status]}>{t(`security.alertStatus.${a.status}`)}</Chip></TableCell>
                  <TableCell>{menu.length > 0 && <Menu items={menu} label={t('security.alerts.actions')} />}</TableCell>
                </TableRow>
              );
            })}
          </Table>
        </div>
      )}
      {q.hasNextPage && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 'var(--spacing-4)' }}>
          <Button variant="outline" onClick={() => void q.fetchNextPage()} loading={q.isFetchingNextPage}>{tc('actions.loadMore')}</Button>
        </div>
      )}
      {runner && <CommandRunner command={runner.command} initialInput={runner.input} open onClose={() => setRunner(null)} />}
    </Card>
  );
}
