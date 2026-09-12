'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { parsePlatformQuery, type PlatformUserHitDto } from '@superapp/shared';
import { SearchField } from '@/components/ui';
import { PersonAvatar } from '@/app/messenger/messenger-ui';
import { fetchPlatformLookup } from '@/lib/platform/api';

/**
 * Выбор человека в кабинете — через поиск кабинета (телефон, ИИН, uuid, имя), а не
 * через продуктовый EntitySelector: у сотрудника кабинета может не быть продуктовой
 * сессии, а реестр продукта ходит с её токеном.
 */
export function PlatformUserPicker({ value, onChange }: { value: PlatformUserHitDto | null; onChange: (hit: PlatformUserHitDto | null) => void }) {
  const t = useTranslations('platform');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<PlatformUserHitDto[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const parsed = parsePlatformQuery(q);
    if (parsed.kind === 'empty' || parsed.kind === 'tooShort') {
      setHits([]);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      setBusy(true);
      fetchPlatformLookup(q)
        .then((r) => alive && setHits(r.users))
        .catch(() => alive && setHits([]))
        .finally(() => alive && setBusy(false));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [q]);

  if (value) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <PersonAvatar userId={value.id} name={`${value.person.firstName} ${value.person.lastName ?? ''}`.trim()} avatar={value.person.avatar} size="sm" />
        <span className="body-sm">{`${value.person.firstName} ${value.person.lastName ?? ''}`.trim()}</span>
        <span className="label-sm">{value.phoneMasked}</span>
        <button type="button" className="ui-chip ui-chip--sm" onClick={() => onChange(null)}>{t('picker.change')}</button>
      </div>
    );
  }
  return (
    <div className="ui-stack" style={{ gap: 'var(--spacing-2)' }}>
      <SearchField width="100%" value={q} onChange={(e) => setQ(e.target.value)} onClear={() => setQ('')} placeholder={t('picker.placeholder')} aria-label={t('picker.placeholder')} />
      {busy && <span className="label-sm">{t('search.searching')}</span>}
      {hits.map((h) => (
        <button
          key={h.id}
          type="button"
          onClick={() => onChange(h)}
          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.375rem 0.5rem', borderRadius: 'var(--radius-md)', background: 'transparent', border: '1px solid var(--divider)', cursor: 'pointer', textAlign: 'left' }}
        >
          <PersonAvatar userId={h.id} name={`${h.person.firstName} ${h.person.lastName ?? ''}`.trim()} avatar={h.person.avatar} size="sm" />
          <span className="body-sm">{`${h.person.firstName} ${h.person.lastName ?? ''}`.trim()}</span>
          <span className="label-sm">{h.phoneMasked}</span>
        </button>
      ))}
    </div>
  );
}
