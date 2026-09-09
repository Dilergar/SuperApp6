'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { apiGet } from '@/lib/api';
import type { Workspace } from '@superapp/shared';

/**
 * Top-level chrome for the organization area (Главная организации, Сотрудники, Профиль).
 * Just the nav bar + page container; the profile sub-area adds its own sidebar.
 * Mirrors how the personal /dashboard and /profile share the app shell.
 *
 * Клиентский — поэтому вынесен из `layout.tsx`: провайдер каталога
 * (`ServiceMessages`) обязан выполняться на СЕРВЕРЕ, и layout остаётся его
 * серверной обёрткой (тот же приём, что в `app/profile/`).
 */
export function WorkspaceChrome({ children }: { children: React.ReactNode }) {
  const tc = useTranslations('common');
  const { isReady } = useRequireAuth();
  const { id } = useParams<{ id: string }>();
  const [, setName] = useState('');

  useEffect(() => {
    if (!isReady || !id) return;
    apiGet<Workspace>(`/workspaces/${id}`)
      .then((w) => setName(w.name))
      .catch(() => {});
  }, [isReady, id]);

  if (!isReady) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="label-md" style={{ fontSize: '1rem' }}>{tc('state.loading')}</p>
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
