'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { api } from '@/lib/api';
import type { Workspace } from '@superapp/shared';

type Gate = 'all' | 'manage' | 'owner';

const SECTIONS: { key: string; label: string; gate: Gate }[] = [
  { key: 'card', label: 'Карточка', gate: 'all' },
  { key: 'anketa', label: 'Анкета', gate: 'manage' },
  { key: 'stats', label: 'Статистика', gate: 'all' },
  { key: 'subscription', label: 'Подписка', gate: 'all' },
  { key: 'settings', label: 'Настройки', gate: 'manage' },
  { key: 'security', label: 'Безопасность', gate: 'owner' },
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
  const { isReady } = useRequireAuth();
  const pathname = usePathname();
  const { id } = useParams<{ id: string }>();
  const [ws, setWs] = useState<Workspace | null>(null);

  useEffect(() => {
    if (!isReady || !id) return;
    api.get(`/workspaces/${id}`).then((r) => setWs(r.data.data)).catch(() => {});
  }, [isReady, id]);

  const myRole = ws?.myRole;
  const canManage = myRole === 'owner' || myRole === 'admin';
  const isOwner = myRole === 'owner';
  const visible = (g: Gate) =>
    g === 'all' || (g === 'manage' && canManage) || (g === 'owner' && isOwner);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 'var(--spacing-8)', minHeight: '70vh' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-1)' }}>
        <Link
          href={`/workspaces/${id}`}
          className="label-sm"
          style={{ color: 'var(--on-surface-variant)', marginBottom: 'var(--spacing-3)' }}
        >
          ← Главная организации
        </Link>
        <h2 className="title-md" style={{ marginBottom: 'var(--spacing-4)' }}>Профиль</h2>
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
                boxShadow: active ? '0 2px 8px rgba(56, 57, 45, 0.06)' : 'none',
              }}
            >
              {s.label}
            </Link>
          );
        })}
      </div>

      <div>{children}</div>
    </div>
  );
}
