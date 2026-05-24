'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { api } from '@/lib/api';

/**
 * Top-level chrome for the organization area (Главная организации, Сотрудники, Профиль).
 * Just the nav bar + page container; the profile sub-area adds its own sidebar.
 * Mirrors how the personal /dashboard and /profile share the app shell.
 */
export default function WorkspaceAreaLayout({ children }: { children: React.ReactNode }) {
  const { isReady } = useRequireAuth();
  const { id } = useParams<{ id: string }>();
  const [name, setName] = useState('Организация');

  useEffect(() => {
    if (!isReady || !id) return;
    api
      .get(`/workspaces/${id}`)
      .then((r) => setName(r.data.data.name))
      .catch(() => {});
  }, [isReady, id]);

  if (!isReady) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="label-md" style={{ fontSize: '1rem' }}>Загрузка...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--surface)' }}>
      <nav
        className="fixed top-0 w-full z-50 px-6 py-4"
        style={{ background: 'rgba(245, 245, 220, 0.7)', backdropFilter: 'blur(10px)' }}
      >
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          {/* Org name → organization home */}
          <Link href={`/workspaces/${id}`} className="title-md" style={{ color: 'var(--primary)' }}>
            {name}
          </Link>
          <div style={{ display: 'flex', gap: 'var(--spacing-3)' }}>
            <Link href={`/workspaces/${id}/profile`} className="btn-secondary" style={{ padding: '0.4rem 1rem', fontSize: '0.8rem' }}>
              Профиль
            </Link>
            <Link href="/dashboard" className="btn-secondary" style={{ padding: '0.4rem 1rem', fontSize: '0.8rem' }}>
              Личная главная
            </Link>
          </div>
        </div>
      </nav>

      <div className="max-w-5xl mx-auto px-6 pt-24" style={{ paddingBottom: 'var(--spacing-16)' }}>
        {children}
      </div>
    </div>
  );
}
