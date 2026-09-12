'use client';

import { useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import type { PlatformAuditOutcome, PlatformAuditPageDto, PlatformAuditQuery } from '@superapp/shared';
import { Alert, Button, Chip, DatePicker, Input, LoadingBlock, PageHeader, Select } from '@/components/ui';
import { fetchPlatformAudit, fetchPlatformCommands, fetchPlatformStaff, platformAuditKey, platformCommandsKey, platformStaffKey } from '@/lib/platform/api';
import { AuditRows } from '@/components/platform/AuditRows';

const OUTCOMES: PlatformAuditOutcome[] = ['ok', 'denied', 'error'];

/** Журнал команд: фильтры (сотрудник, команда, цель, период, исход), плотная таблица с курсорной подгрузкой, раскрытие строки. */
export default function PlatformAuditPage() {
  const t = useTranslations('platform');
  const tc = useTranslations('common');
  const [actorId, setActorId] = useState<string | null>(null);
  const [commandKey, setCommandKey] = useState<string | null>(null);
  const [target, setTarget] = useState('');
  const [from, setFrom] = useState<Date | null>(null);
  const [to, setTo] = useState<Date | null>(null);
  const [outcome, setOutcome] = useState<PlatformAuditOutcome | null>(null);

  const staffQ = useQuery({ queryKey: platformStaffKey, queryFn: fetchPlatformStaff, staleTime: 60_000 });
  const commandsQ = useQuery({ queryKey: platformCommandsKey, queryFn: fetchPlatformCommands, staleTime: 60_000 });

  const filter: PlatformAuditQuery = useMemo(
    () => ({
      ...(actorId ? { actorId } : {}),
      ...(commandKey ? { commandKey } : {}),
      ...(target.trim() ? { targetId: target.trim() } : {}),
      ...(from ? { from: from.toISOString() } : {}),
      ...(to ? { to: new Date(to.getTime() + 86_399_000).toISOString() } : {}),
      ...(outcome ? { outcome } : {}),
    }),
    [actorId, commandKey, target, from, to, outcome],
  );

  const q = useInfiniteQuery({
    queryKey: platformAuditKey(filter),
    queryFn: ({ pageParam }) => fetchPlatformAudit({ ...filter, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: PlatformAuditPageDto) => last.nextCursor,
  });
  const page: PlatformAuditPageDto = useMemo(
    () => ({ items: q.data?.pages.flatMap((p) => p.items) ?? [], nextCursor: q.data?.pages.at(-1)?.nextCursor ?? null }),
    [q.data],
  );

  return (
    <>
      <PageHeader breadcrumb={t('shell.title')} title={t('nav.audit')} description={t('audit.description')} />
      <div style={{ display: 'flex', gap: 'var(--spacing-3)', flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 'var(--spacing-4)' }}>
        <Select
          label={t('audit.col.actor')}
          value={actorId}
          onChange={setActorId}
          placeholder={tc('labels.all')}
          width={220}
          options={(staffQ.data ?? []).map((s) => ({ value: s.userId, label: `${s.person.firstName} ${s.person.lastName ?? ''}`.trim() }))}
        />
        <Select
          label={t('audit.col.command')}
          value={commandKey}
          onChange={setCommandKey}
          placeholder={tc('labels.all')}
          width={260}
          options={(commandsQ.data ?? []).map((c) => ({ value: c.key, label: t(c.titleKey.replace(/^platform\./, '')) }))}
        />
        <Input label={t('audit.col.target')} value={target} onChange={(e) => setTarget(e.target.value)} placeholder="uuid" wrapClassName="" />
        <DatePicker label={t('audit.from')} value={from} onChange={setFrom} clearable width={160} />
        <DatePicker label={t('audit.to')} value={to} onChange={setTo} clearable width={160} />
        <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'center', paddingBottom: '0.5rem' }}>
          {OUTCOMES.map((o) => (
            <Chip key={o} size="sm" tone={o === 'ok' ? 'success' : o === 'denied' ? 'warning' : 'danger'} selected={outcome === o} onClick={() => setOutcome(outcome === o ? null : o)}>
              {t(`audit.outcome.${o}`)}
            </Chip>
          ))}
        </div>
        {(actorId || commandKey || target || from || to || outcome) && (
          <Button variant="ghost" size="sm" icon="close" onClick={() => { setActorId(null); setCommandKey(null); setTarget(''); setFrom(null); setTo(null); setOutcome(null); }}>
            {tc('actions.reset')}
          </Button>
        )}
      </div>
      {q.isPending ? (
        <LoadingBlock />
      ) : q.isError ? (
        <Alert tone="danger">{tc('state.error')}</Alert>
      ) : (
        <>
          <div style={{ overflowX: 'auto' }}>
            <AuditRows page={page} />
          </div>
          {q.hasNextPage && (
            <div style={{ marginTop: 'var(--spacing-4)' }}>
              <Button variant="outline" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{tc('actions.loadMore')}</Button>
            </div>
          )}
        </>
      )}
    </>
  );
}
