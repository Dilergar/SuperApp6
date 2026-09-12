'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { parsePlatformQuery, type PlatformLookupHitDto } from '@superapp/shared';
import { Card, CardHeader, Chip, EmptyState, LoadingBlock, PageHeader } from '@/components/ui';
import { PersonAvatar } from '@/app/messenger/messenger-ui';
import { fetchPlatformLookup, platformLookupKey } from '@/lib/platform/api';
import { PLATFORM_RECENT_KEY } from '@/lib/platform-api';

// ============================================================
// Поиск — главный вход кабинета. Тип запроса распознаётся на лету (чип-подсказка),
// результаты группами «Люди» и «Организации», одно совпадение → сразу карточка,
// «Недавние» — localStorage зрителя. Стрелки и Enter ходят по результатам.
// ============================================================

const RECENT_KEY = PLATFORM_RECENT_KEY;
interface Recent { entity: 'user' | 'workspace'; id: string; label: string }

function hrefOf(hit: PlatformLookupHitDto): string {
  return hit.entity === 'user' ? `/platform/users/${hit.id}` : `/platform/workspaces/${hit.id}`;
}
function labelOf(hit: PlatformLookupHitDto): string {
  return hit.entity === 'user' ? `${hit.person.firstName} ${hit.person.lastName ?? ''}`.trim() : hit.name;
}

export function rememberRecent(entry: Recent): void {
  try {
    const list: Recent[] = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    const next = [entry, ...list.filter((r) => !(r.entity === entry.entity && r.id === entry.id))].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* приватный режим */
  }
}

export default function PlatformSearchPage() {
  const t = useTranslations('platform');
  const router = useRouter();
  const search = useSearchParams();
  const q = (search.get('q') ?? '').trim();
  const parsed = useMemo(() => parsePlatformQuery(q), [q]);
  const active = parsed.kind !== 'empty' && parsed.kind !== 'tooShort';
  const query = useQuery({ queryKey: platformLookupKey(q), queryFn: () => fetchPlatformLookup(q), enabled: active, retry: false });
  const [recent, setRecent] = useState<Recent[]>([]);
  const [hi, setHi] = useState(0);

  useEffect(() => {
    try {
      setRecent(JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'));
    } catch {
      setRecent([]);
    }
  }, []);

  const hits: PlatformLookupHitDto[] = useMemo(() => (query.data ? [...query.data.users, ...query.data.workspaces] : []), [query.data]);

  // Одно совпадение → сразу карточка
  useEffect(() => {
    if (active && query.data && hits.length === 1) {
      rememberRecent({ entity: hits[0].entity, id: hits[0].id, label: labelOf(hits[0]) });
      router.replace(hrefOf(hits[0]));
    }
  }, [active, query.data, hits, router]);

  useEffect(() => setHi(0), [q]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!hits.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); setHi((v) => Math.min(hits.length - 1, v + 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((v) => Math.max(0, v - 1)); }
      else if (e.key === 'Enter' && document.activeElement?.tagName !== 'INPUT') {
        const hit = hits[hi];
        if (hit) { rememberRecent({ entity: hit.entity, id: hit.id, label: labelOf(hit) }); router.push(hrefOf(hit)); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hits, hi, router]);

  return (
    <>
      <PageHeader
        breadcrumb={t('shell.title')}
        title={t('search.title')}
        chip={q ? <Chip tone={active ? 'accent' : 'warning'} size="sm">{t(`search.kind.${parsed.kind}`)}</Chip> : undefined}
        description={t('search.description')}
      />
      {!q ? (
        recent.length ? (
          <Card>
            <CardHeader title={t('search.recent')} />
            <div className="ui-stack" style={{ gap: '0.375rem' }}>
              {recent.map((r) => (
                <Link key={`${r.entity}:${r.id}`} href={r.entity === 'user' ? `/platform/users/${r.id}` : `/platform/workspaces/${r.id}`} className="body-sm">
                  {r.label} <span className="label-sm">· {t(r.entity === 'user' ? 'card.user' : 'card.workspace')}</span>
                </Link>
              ))}
            </div>
          </Card>
        ) : (
          <EmptyState icon="search" title={t('search.emptyTitle')} description={t('search.emptyText')} />
        )
      ) : !active ? (
        <EmptyState icon="search" title={t('search.tooShortTitle')} description={t('search.emptyText')} />
      ) : query.isPending ? (
        <LoadingBlock />
      ) : hits.length === 0 ? (
        <EmptyState icon="search" title={t('search.noResults')} description={t('search.emptyText')} />
      ) : (
        <div style={{ display: 'grid', gap: 'var(--spacing-4)', gridTemplateColumns: 'repeat(auto-fit, minmax(20rem, 1fr))' }}>
          {query.data && query.data.users.length > 0 && (
            <Card>
              <CardHeader title={t('search.people')} />
              <div className="ui-stack" style={{ gap: '0.375rem' }}>
                {query.data.users.map((u) => {
                  const idx = hits.indexOf(u);
                  return (
                    <Link
                      key={u.id}
                      href={hrefOf(u)}
                      onClick={() => rememberRecent({ entity: 'user', id: u.id, label: labelOf(u) })}
                      style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.375rem 0.5rem', borderRadius: 'var(--radius-md)', background: idx === hi ? 'var(--surface-container-high)' : 'transparent' }}
                    >
                      <PersonAvatar userId={u.id} name={labelOf(u)} avatar={u.person.avatar} size="sm" />
                      <span className="body-sm" style={{ fontWeight: 600 }}>{labelOf(u)}</span>
                      <span className="label-sm">{u.phoneMasked}</span>
                      {u.isStaff && <Chip tone="accent" size="sm">{t('chips.staff')}</Chip>}
                      {u.deletedAt && <Chip tone="danger" size="sm">{t('chips.deleted')}</Chip>}
                    </Link>
                  );
                })}
              </div>
            </Card>
          )}
          {query.data && query.data.workspaces.length > 0 && (
            <Card>
              <CardHeader title={t('search.organizations')} />
              <div className="ui-stack" style={{ gap: '0.375rem' }}>
                {query.data.workspaces.map((w) => {
                  const idx = hits.indexOf(w);
                  return (
                    <Link
                      key={w.id}
                      href={hrefOf(w)}
                      onClick={() => rememberRecent({ entity: 'workspace', id: w.id, label: w.name })}
                      style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.375rem 0.5rem', borderRadius: 'var(--radius-md)', background: idx === hi ? 'var(--surface-container-high)' : 'transparent' }}
                    >
                      <span className="body-sm" style={{ fontWeight: 600 }}>{w.name}</span>
                      {w.binMasked && <span className="label-sm">{w.binMasked}</span>}
                      {!w.isActive && <Chip tone="warning" size="sm">{t('chips.inactive')}</Chip>}
                    </Link>
                  );
                })}
              </div>
            </Card>
          )}
        </div>
      )}
    </>
  );
}
