'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { useAuthStore } from '@/lib/stores/auth';

type Section =
  | 'card' | 'form' | 'skins' | 'wallet' | 'stats' | 'roles' | 'subscription' | 'settings' | 'security';

const SECTIONS: { key: Section; label: string }[] = [
  { key: 'card', label: 'Моя карточка' },
  { key: 'form', label: 'Моя Анкета' },
  { key: 'skins', label: 'Скины карточки' },
  { key: 'wallet', label: 'Кошелёк' },
  { key: 'stats', label: 'Статистика' },
  { key: 'roles', label: 'Мои роли' },
  { key: 'subscription', label: 'Подписка' },
  { key: 'settings', label: 'Настройки' },
  { key: 'security', label: 'Безопасность' },
];

/**
 * Shared chrome for all /profile/<section> routes: top nav + sidebar.
 * The active section lives in the URL (path segment), so a refresh keeps you
 * where you were and sections are deep-linkable / back-button friendly.
 */
export default function ProfileLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { isReady } = useRequireAuth();
  const logout = useAuthStore((s) => s.logout);

  const handleLogout = async () => {
    await logout();
    router.push('/login');
  };

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
        <div style={{ display: 'grid', gridTemplateColumns: '200px minmax(0, 1fr)', gap: 'var(--spacing-8)', minHeight: '70vh' }}>
          {/* Sidebar */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-1)' }}>
            <h2 className="title-md" style={{ marginBottom: 'var(--spacing-4)' }}>Профиль</h2>
            {SECTIONS.map((s) => {
              const active = pathname === `/profile/${s.key}`;
              return (
                <Link key={s.key} href={`/profile/${s.key}`}
                  style={{
                    padding: 'var(--spacing-2) var(--spacing-3)', textAlign: 'left',
                    borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                    fontFamily: 'var(--font-body)', fontSize: '0.85rem', fontWeight: 500,
                    background: active ? 'var(--surface-container-lowest)' : 'transparent',
                    color: active ? 'var(--on-surface)' : 'var(--on-surface-variant)',
                    boxShadow: active ? '0 2px 8px rgba(0, 0, 0, 0.06)' : 'none',
                  }}
                >
                  {s.label}
                </Link>
              );
            })}
            <div style={{ flex: 1 }} />
            <button onClick={handleLogout}
              style={{
                padding: 'var(--spacing-2) var(--spacing-3)', textAlign: 'left',
                borderRadius: 'var(--radius-sm)', border: 'none', cursor: 'pointer',
                fontFamily: 'var(--font-body)', fontSize: '0.85rem', fontWeight: 500,
                background: 'transparent', color: 'var(--danger)', marginTop: 'var(--spacing-8)',
              }}
            >
              Выйти
            </button>
          </div>

          {/* Content (per-section page) */}
          <div>{children}</div>
        </div>
      </div>
    </div>
  );
}
