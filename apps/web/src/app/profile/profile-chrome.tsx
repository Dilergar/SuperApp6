'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { useAuthStore } from '@/lib/stores/auth';
import { useTranslations } from 'next-intl';

type Section =
  | 'card' | 'form' | 'skins' | 'wallet' | 'stats' | 'roles' | 'subscription' | 'settings' | 'notifications' | 'links' | 'security';

/** Реестр секций несёт КЛЮЧИ; слова даёт каталог `profile`. */
const SECTIONS: { key: Section; labelKey: string }[] = [
  { key: 'card', labelKey: 'nav.card' },
  { key: 'form', labelKey: 'nav.form' },
  { key: 'skins', labelKey: 'nav.skins' },
  { key: 'wallet', labelKey: 'nav.wallet' },
  { key: 'stats', labelKey: 'nav.stats' },
  { key: 'roles', labelKey: 'nav.roles' },
  { key: 'subscription', labelKey: 'nav.subscription' },
  { key: 'settings', labelKey: 'nav.settings' },
  // Уведомления — личные сквозные блоки (тишина, устройства) + наборы по контекстам
  { key: 'notifications', labelKey: 'nav.notifications' },
  // Ссылки наружу — рядом с «Безопасностью» намеренно: это тоже «что я раздал и кому»,
  // сосед активных сессий. Внутри Диска им не место — ссылки выдают и документы, а
  // завтра счета и витрины.
  { key: 'links', labelKey: 'nav.links' },
  { key: 'security', labelKey: 'nav.security' },
];

/**
 * Shared chrome for all /profile/<section> routes: top nav + sidebar.
 * The active section lives in the URL (path segment), so a refresh keeps you
 * where you were and sections are deep-linkable / back-button friendly.
 */
export function ProfileChrome({ children }: { children: React.ReactNode }) {
  const t = useTranslations('profile');
  const common = useTranslations('common');
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
        <p className="label-md" style={{ fontSize: '1rem' }}>{common('state.loading')}</p>
      </div>
    );
  }

  return (
    <div className="">
      

      <div className="" style={{ paddingBottom: 'var(--spacing-16)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '200px minmax(0, 1fr)', gap: 'var(--spacing-8)', minHeight: '70vh' }}>
          {/* Sidebar */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-1)' }}>
            <h2 className="title-md" style={{ marginBottom: 'var(--spacing-4)' }}>{t('title')}</h2>
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
                    boxShadow: active ? 'var(--shadow-card)' : 'none',
                  }}
                >
                  {t(s.labelKey)}
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
              {t('nav.logout')}
            </button>
          </div>

          {/* Content (per-section page) */}
          <div>{children}</div>
        </div>
      </div>
    </div>
  );
}
