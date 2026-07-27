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
    <div className="">
      

      <div className="" style={{ paddingBottom: 'var(--spacing-16)' }}>
        {children}
      </div>
    </div>
  );
}
