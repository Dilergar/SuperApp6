'use client';

// «Активность безопасности» человека: чипы-фильтры, лента по дням, «Показать ещё»,
// модалка события (глубокая ссылка `?e=<id>` открывает её сразу). Окно — год; передачи
// данных и согласия — вся история (сервер решает проекцию, клиент только рисует).

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { AUDIT_PERSON_FILTERS, type AuditPersonFilter, type SecurityEventDto, type SecurityEventPageDto } from '@superapp/shared';
import { Alert, Button, Card, CardHeader, Chip, EmptyState, LoadingBlock } from '@/components/ui';
import { fetchSecurityEvent, fetchSecurityEvents } from '@/lib/audit-api';
import { securityEventKey, securityEventsKey } from '@/lib/queries';
import { useDayLabel, useFormatters } from '@/lib/format';
import { analytics } from '@/lib/analytics';
import { SecurityEventModal, SecurityEventRow } from './SecurityEventParts';

export function SecurityFeed({ onNotMe }: { onNotMe: (e: SecurityEventDto) => void }) {
  const t = useTranslations('audit');
  const tc = useTranslations('common');
  const fmt = useFormatters();
  const dayLabel = useDayLabel();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [filter, setFilter] = useState<AuditPersonFilter>('all');
  const openId = params.get('e');

  const q = useInfiniteQuery({
    queryKey: securityEventsKey(filter),
    queryFn: ({ pageParam }) => fetchSecurityEvents(filter, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last: SecurityEventPageDto) => last.nextCursor,
  });
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);

  // Событие из ссылки может лежать за пределами загруженной страницы — берём его отдельно
  const fromList = openId ? items.find((e) => e.id === openId) : undefined;
  const single = useQuery({ queryKey: securityEventKey(openId ?? '-'), queryFn: () => fetchSecurityEvent(openId!), enabled: !!openId && !fromList, retry: false });
  const opened = fromList ?? single.data ?? null;

  useEffect(() => {
    analytics.track('audit.feed.viewed', { viewer: 'person', filter });
  }, [filter]);

  const setOpen = (id: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (id) next.set('e', id);
    else next.delete('e');
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  // Лента по дням (день — в поясе зрителя)
  const groups = useMemo(() => {
    const out: Array<{ day: string; items: SecurityEventDto[] }> = [];
    for (const e of items) {
      const day = fmt.dayKey(e.occurredAt);
      const last = out[out.length - 1];
      if (last && last.day === day) last.items.push(e);
      else out.push({ day, items: [e] });
    }
    return out;
  }, [items, fmt]);

  return (
    <Card span={8}>
      <CardHeader title={t('ui.feed.title')} />
      <div role="group" aria-label={t('ui.feed.filters')} style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap', marginBottom: 'var(--spacing-4)' }}>
        {AUDIT_PERSON_FILTERS.map((f) => (
          <Chip key={f} size="sm" selected={filter === f} onClick={() => setFilter(f)}>{t(`filters.person.${f}`)}</Chip>
        ))}
      </div>
      {q.isPending ? (
        <LoadingBlock />
      ) : q.isError ? (
        <Alert tone="danger" action={<Button size="sm" variant="ghost" icon="refresh" onClick={() => void q.refetch()}>{tc('actions.retry')}</Button>}>
          {t('ui.feed.loadFailed')}
        </Alert>
      ) : items.length === 0 ? (
        <EmptyState icon="shield" title={t('ui.feed.empty')} />
      ) : (
        <>
          {groups.map((g) => (
            <section key={g.day} aria-label={dayLabel(g.day)} style={{ marginBottom: 'var(--spacing-4)' }}>
              <h3 className="label-caps" style={{ margin: '0 0 var(--spacing-2)' }}>{dayLabel(g.day)}</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
                {g.items.map((e) => (
                  <SecurityEventRow key={e.id} event={e} onOpen={(ev) => setOpen(ev.id)} />
                ))}
              </div>
            </section>
          ))}
          {q.hasNextPage && (
            <Button variant="outline" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{tc('actions.loadMore')}</Button>
          )}
          <p className="label-sm" style={{ marginTop: 'var(--spacing-3)' }}>{t('ui.feed.window')}</p>
        </>
      )}
      {openId && single.isError && !fromList && (
        <Alert tone="warning" onClose={() => setOpen(null)}>{t('ui.event.notFound')}</Alert>
      )}
      <SecurityEventModal
        event={opened}
        open={!!opened}
        viewer="person"
        onClose={() => setOpen(null)}
        onNotMe={(e) => {
          setOpen(null);
          onNotMe(e);
        }}
      />
    </Card>
  );
}
