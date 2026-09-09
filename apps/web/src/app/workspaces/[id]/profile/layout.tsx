'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { apiGet } from '@/lib/api';
import type { Workspace } from '@superapp/shared';

type Gate = 'all' | 'manage' | 'owner';

// Реестр несёт СОСТАВ и гейты; слово к разделу даёт каталог
// (`workspaces.profile.section.*`).
const SECTIONS: { key: string; gate: Gate }[] = [
  { key: 'card', gate: 'all' },
  { key: 'anketa', gate: 'manage' },
  { key: 'stats', gate: 'all' },
  { key: 'subscription', gate: 'all' },
  { key: 'settings', gate: 'manage' },
  { key: 'notifications', gate: 'manage' },
  { key: 'security', gate: 'owner' },
];

const linkBase: React.CSSProperties = {
  padding: 'var(--spacing-2) var(--spacing-3)',
  textAlign: 'left',
  borderRadius: 'var(--radius-sm)',
  cursor: 'pointer',
  fontFamily: 'var(--font-body)',
  fontSize: '0.85rem',
  fontWeight: 500,
};

/** Profile sub-area sidebar (sits inside the org-area shell from ../layout). */
export default function WorkspaceProfileLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations('workspaces');
  const { isReady } = useRequireAuth();
  const pathname = usePathname();
  const { id } = useParams<{ id: string }>();
  const [ws, setWs] = useState<Workspace | null>(null);

  useEffect(() => {
    if (!isReady || !id) return;
    apiGet<Workspace>(`/workspaces/${id}`).then(setWs).catch(() => {});
  }, [isReady, id]);

  const myRole = ws?.myRole;
  const canManage = myRole === 'owner' || myRole === 'admin';
  const isOwner = myRole === 'owner';
  const visible = (g: Gate) =>
    g === 'all' || (g === 'manage' && canManage) || (g === 'owner' && isOwner);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '200px minmax(0, 1fr)', gap: 'var(--spacing-8)', minHeight: '70vh' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-1)' }}>
        <Link
          href={`/workspaces/${id}`}
          className="label-sm"
          style={{ color: 'var(--on-surface-variant)', marginBottom: 'var(--spacing-3)' }}
        >
          ← {t('profile.back')}
        </Link>
        <h2 className="title-md" style={{ marginBottom: 'var(--spacing-4)' }}>{t('profile.title')}</h2>
        {SECTIONS.filter((s) => visible(s.gate)).map((s) => {
          const active = pathname === `/workspaces/${id}/profile/${s.key}`;
          return (
            <Link
              key={s.key}
              href={`/workspaces/${id}/profile/${s.key}`}
              style={{
                ...linkBase,
                background: active ? 'var(--surface-container-lowest)' : 'transparent',
                color: active ? 'var(--on-surface)' : 'var(--on-surface-variant)',
                boxShadow: active ? 'var(--shadow-card)' : 'none',
              }}
            >
              {t(`profile.section.${s.key}`)}
            </Link>
          );
        })}
      </div>

      <div>{children}</div>
    </div>
  );
}
