'use client';

// Вкладка «События» консоли «Безопасность»: весь журнал платформы с фильтрами (категория, тип,
// род актора, актор/субъект/организация, ID запроса, операция, период, исход, сеть). Поиск
// по IP идёт POST'ом и превращается в псевдонимы сети — IP не оседает в адресе страницы.
// Полный IP события — только командой `security.event.reveal_ip` (причина + SMS, раскрытие
// пишется в журнал); каждое чтение ленты — в агрегат «кто смотрел журнал».

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  AUDIT_ACTOR_KINDS,
  AUDIT_CATEGORIES,
  auditKeysOf,
  type AuditActorKind,
  type AuditCategory,
  type AuditOutcome,
  type PlatformCommandDto,
  type SecurityEventDto,
  type SecurityEventPageDto,
  type SecurityEventRevealIpDto,
} from '@superapp/shared';
import { Alert, Button, Card, Chip, DatePicker, Divider, EmojiIcon, EmptyState, IconButton, Input, LoadingBlock, Select, Table, TableCell, TableRow, type TableColumn } from '@/components/ui';
import { ActorView, SecurityEventModal } from '@/components/security/SecurityEventParts';
import { eventIcon, eventTone, outcomeTone } from '@/components/security/event-visuals';
import { CommandRunner } from '@/components/platform/CommandRunner';
import { PersonChip } from '@/app/circles/PersonCard';
import { fetchPlatformCommands, fetchPlatformSecurityEvents, lookupPlatformNetwork, platformCommandsKey, platformSecurityEventsKey } from '@/lib/platform/api';
import { apiErrorMessage } from '@/lib/platform-api';
import { useFormatters } from '@/lib/format';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OUTCOMES: AuditOutcome[] = ['success', 'failure', 'denied'];
const STAFF_KINDS: AuditActorKind[] = AUDIT_ACTOR_KINDS.filter((k) => k === 'user' || k === 'bot' || k === 'platform_staff' || k === 'system');
const uuidOr = (v: string) => (UUID_RE.test(v.trim()) ? v.trim().toLowerCase() : undefined);

export function EventsTab({ canReveal }: { canReveal: boolean }) {
  const t = useTranslations('platform');
  const ta = useTranslations('audit');
  const tc = useTranslations('common');
  const fmt = useFormatters();
  // Переход из карточки 360: «Открыть в журнале» несёт субъекта или организацию в адресе
  const search = useSearchParams();
  const [category, setCategory] = useState<AuditCategory | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [actorKind, setActorKind] = useState<AuditActorKind | null>(null);
  const [actorId, setActorId] = useState('');
  const [subjectId, setSubjectId] = useState(search.get('subject') ?? '');
  const [workspaceId, setWorkspaceId] = useState(search.get('workspace') ?? '');
  const [requestId, setRequestId] = useState('');
  const [op, setOp] = useState('');
  const [from, setFrom] = useState<Date | null>(null);
  const [to, setTo] = useState<Date | null>(null);
  const [outcome, setOutcome] = useState<AuditOutcome | null>(null);
  const [network, setNetwork] = useState<string[] | null>(null);
  const [ip, setIp] = useState('');
  const [ipBusy, setIpBusy] = useState(false);
  const [ipError, setIpError] = useState('');
  const [opened, setOpened] = useState<SecurityEventDto | null>(null);
  const [revealed, setRevealed] = useState<SecurityEventRevealIpDto | null>(null);
  const [runner, setRunner] = useState<{ command: PlatformCommandDto; input: Record<string, unknown> } | null>(null);

  const commandsQ = useQuery({ queryKey: platformCommandsKey, queryFn: fetchPlatformCommands, staleTime: 60_000 });
  const revealCommand = commandsQ.data?.find((c) => c.key === 'security.event.reveal_ip') ?? null;

  const filter = useMemo(
    () => ({
      ...(category ? { category } : {}),
      ...(key ? { key } : {}),
      ...(actorKind ? { actorKind } : {}),
      ...(uuidOr(actorId) ? { actorId: uuidOr(actorId) } : {}),
      ...(uuidOr(subjectId) ? { subjectUserId: uuidOr(subjectId) } : {}),
      ...(uuidOr(workspaceId) ? { workspaceId: uuidOr(workspaceId) } : {}),
      ...(uuidOr(requestId) ? { requestId: uuidOr(requestId) } : {}),
      ...(/^[A-Za-z0-9_.:-]{1,96}$/.test(op.trim()) ? { op: op.trim() } : {}),
      ...(from ? { from: from.toISOString() } : {}),
      ...(to ? { to: new Date(to.getTime() + 86_399_000).toISOString() } : {}),
      ...(outcome ? { outcome } : {}),
      ...(network?.length ? { ipHmac: network.join(',') } : {}),
    }),
    [category, key, actorKind, actorId, subjectId, workspaceId, requestId, op, from, to, outcome, network],
  );
  const q = useInfiniteQuery({
    queryKey: platformSecurityEventsKey(filter),
    queryFn: ({ pageParam }) => fetchPlatformSecurityEvents({ ...filter, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: SecurityEventPageDto) => last.nextCursor,
  });
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const keyOptions = useMemo(() => (category ? auditKeysOf([category]) : []).map((k) => ({ value: k, label: k })), [category]);

  const findByIp = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setIpError('');
    setIpBusy(true);
    try {
      const res = await lookupPlatformNetwork(ip.trim());
      setNetwork(res.pseudonyms);
      setIp('');
    } catch (err) {
      setIpError(apiErrorMessage(err));
    } finally {
      setIpBusy(false);
    }
  };

  const reset = () => {
    setCategory(null);
    setKey(null);
    setActorKind(null);
    setActorId('');
    setSubjectId('');
    setWorkspaceId('');
    setRequestId('');
    setOp('');
    setFrom(null);
    setTo(null);
    setOutcome(null);
    setNetwork(null);
  };
  const dirty = Object.keys(filter).length > 0;

  const columns: TableColumn[] = [
    { key: 'time', label: t('security.col.time'), width: '8.5rem' },
    { key: 'event', label: t('security.col.event') },
    { key: 'actor', label: t('security.col.actor'), width: 'max-content' },
    { key: 'subject', label: t('security.col.subject'), width: 'max-content', hideOnMobile: true },
    { key: 'outcome', label: t('security.col.outcome'), width: 'max-content' },
  ];

  const networkBlock = opened && (
    <>
      <Divider />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
        <span className="label-caps">{t('security.network')}</span>
        <span className="body-sm">{opened.location.ipNet ?? '—'}</span>
        {revealed && revealed.eventId === opened.id ? (
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <code style={{ fontSize: '0.8rem' }}>{revealed.ip ?? '—'}</code>
            {revealed.ip && <IconButton icon="copy" label={ta('ui.event.copy')} size={28} onClick={() => void navigator.clipboard?.writeText(revealed.ip ?? '').catch(() => undefined)} />}
            {revealed.pseudonyms.length > 0 && (
              <Button size="sm" variant="outline" icon="filter" onClick={() => { setNetwork(revealed.pseudonyms); setOpened(null); }}>{t('security.allFromIp')}</Button>
            )}
          </div>
        ) : (
          canReveal &&
          revealCommand && (
            <div>
              <Button size="sm" variant="outline" icon="eye" onClick={() => setRunner({ command: revealCommand, input: { eventId: opened.id } })}>{t('security.revealIp')}</Button>
            </div>
          )
        )}
      </div>
      {Object.keys(opened.details).length > 0 && (
        <>
          <Divider />
          <span className="label-caps">{t('security.details')}</span>
          <pre style={{ margin: 'var(--spacing-2) 0 0', whiteSpace: 'pre-wrap', fontSize: '0.75rem', overflowWrap: 'anywhere' }}>{JSON.stringify(opened.details, null, 1)}</pre>
        </>
      )}
    </>
  );

  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)', marginBottom: 'var(--spacing-4)' }}>
        <div style={{ display: 'flex', gap: 'var(--spacing-3)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Select
            label={t('security.filters.category')}
            value={category}
            onChange={(v) => { setCategory(v as AuditCategory | null); setKey(null); }}
            placeholder={tc('labels.all')}
            width={220}
            options={AUDIT_CATEGORIES.map((c) => ({ value: c, label: ta(`categories.${c}`) }))}
          />
          {category && <Select label={t('security.filters.key')} value={key} onChange={setKey} placeholder={tc('labels.all')} width={260} options={keyOptions} />}
          <Input label={t('security.filters.requestId')} value={requestId} onChange={(e) => setRequestId(e.target.value)} placeholder="uuid" />
          <Input label={t('security.filters.op')} value={op} onChange={(e) => setOp(e.target.value)} />
          <DatePicker label={t('audit.from')} value={from} onChange={setFrom} clearable width={160} />
          <DatePicker label={t('audit.to')} value={to} onChange={setTo} clearable width={160} />
        </div>
        <div style={{ display: 'flex', gap: 'var(--spacing-3)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Input label={t('security.filters.actor')} value={actorId} onChange={(e) => setActorId(e.target.value)} placeholder="uuid" />
          <Input label={t('security.filters.subject')} value={subjectId} onChange={(e) => setSubjectId(e.target.value)} placeholder="uuid" />
          <Input label={t('security.filters.workspace')} value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} placeholder="uuid" />
          <form onSubmit={findByIp} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
            <Input label={t('security.ipLookup')} value={ip} onChange={(e) => setIp(e.target.value)} placeholder={t('security.ip')} autoComplete="off" />
            <Button type="submit" variant="outline" icon="search" loading={ipBusy} disabled={!ip.trim()}>{t('security.find')}</Button>
          </form>
        </div>
        <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap', alignItems: 'center' }}>
          {STAFF_KINDS.map((k) => (
            <Chip key={k} size="sm" selected={actorKind === k} onClick={() => setActorKind(actorKind === k ? null : k)}>{ta(`actorKinds.${k}`)}</Chip>
          ))}
          <span aria-hidden style={{ width: '0.5rem' }} />
          {OUTCOMES.map((o) => (
            <Chip key={o} size="sm" tone={outcomeTone(o)} selected={outcome === o} onClick={() => setOutcome(outcome === o ? null : o)}>{ta(`outcomes.${o}`)}</Chip>
          ))}
          {network && <Chip size="sm" tone="accent" icon="mapPin" onRemove={() => setNetwork(null)} removeLabel={tc('actions.remove')}>{t('security.filters.byNetwork')}</Chip>}
          {dirty && <Button variant="ghost" size="sm" icon="close" onClick={reset}>{tc('actions.reset')}</Button>}
        </div>
        {ipError && <Alert tone="danger" onClose={() => setIpError('')}>{ipError}</Alert>}
      </div>

      {q.isPending ? (
        <LoadingBlock />
      ) : q.isError ? (
        <Alert tone="danger" action={<Button size="sm" variant="ghost" icon="refresh" onClick={() => void q.refetch()}>{tc('actions.retry')}</Button>}>{tc('state.error')}</Alert>
      ) : items.length === 0 ? (
        <EmptyState icon="shield" title={t('audit.empty')} />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <Table columns={columns} lines aria-label={t('security.tabs.events')}>
            {items.map((e, i) => (
              <TableRow key={e.id} rowIndex={i + 2} onClick={() => setOpened(e)}>
                <TableCell><span className="label-sm">{fmt.dateTime(e.occurredAt, 'short')}</span></TableCell>
                <TableCell>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 }}>
                    <EmojiIcon emoji={eventIcon(e)} tone={eventTone(e)} size={28} />
                    <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                      <span className="body-sm" style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{e.title}</span>
                      <span className="label-sm" style={{ overflowWrap: 'anywhere' }}>{e.op ?? e.key}</span>
                    </span>
                  </span>
                </TableCell>
                <TableCell><ActorView actor={e.actor} /></TableCell>
                <TableCell hideOnMobile>
                  {e.subject ? <PersonChip size="S" userId={e.subject.id} firstName={e.subject.firstName} lastName={e.subject.lastName} avatar={e.subject.avatar} /> : <span className="label-sm">—</span>}
                </TableCell>
                <TableCell><Chip size="sm" tone={outcomeTone(e.outcome)}>{ta(`outcomes.${e.outcome}`)}</Chip></TableCell>
              </TableRow>
            ))}
          </Table>
        </div>
      )}
      {q.hasNextPage && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 'var(--spacing-4)' }}>
          <Button variant="outline" onClick={() => void q.fetchNextPage()} loading={q.isFetchingNextPage}>{tc('actions.loadMore')}</Button>
        </div>
      )}

      <SecurityEventModal event={opened} open={!!opened && !runner} viewer="platform" onClose={() => setOpened(null)} extra={networkBlock} />
      {runner && (
        <CommandRunner
          command={runner.command}
          initialInput={runner.input}
          open
          onClose={() => setRunner(null)}
          onDone={(res) => {
            const r = res.result as SecurityEventRevealIpDto | null;
            if (r && typeof r === 'object' && 'eventId' in r) setRevealed(r);
          }}
        />
      )}
    </Card>
  );
}
