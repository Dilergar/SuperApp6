'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { useAuthStore } from '@/lib/stores/auth';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui';
import { useIsMobile } from '@/lib/hooks/useIsMobile';

type Section =
  | 'card' | 'form' | 'skins' | 'wallet' | 'stats' | 'roles' | 'subscription' | 'settings' | 'notifications' | 'links' | 'security' | 'keys' | 'my-data';

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
  { key: 'keys', labelKey: 'nav.keys' },
  { key: 'links', labelKey: 'nav.links' },
  // Согласия и «кому передавались мои данные» (core/consents) — сосед «Ссылок наружу» и «Безопасности»
  { key: 'my-data', labelKey: 'nav.myData' },
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
  // Телефон: боковое меню в 200px съедало половину экрана и сжимало секцию в столбик
  // по букве — вместо колонки разделы идут прокручиваемой строкой над содержимым
  const isMobile = useIsMobile();

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

  const link = (key: Section, labelKey: string) => {
    const active = pathname === `/profile/${key}`;
    return (
      <Link key={key} href={`/profile/${key}`} aria-current={active ? 'page' : undefined}
        style={{
          padding: 'var(--spacing-2) var(--spacing-3)', textAlign: 'left',
          borderRadius: 'var(--radius-sm)', cursor: 'pointer', whiteSpace: isMobile ? 'nowrap' : undefined,
          fontFamily: 'var(--font-body)', fontSize: '0.85rem', fontWeight: 500,
          background: active ? 'var(--surface-container-lowest)' : 'transparent',
          color: active ? 'var(--on-surface)' : 'var(--on-surface-variant)',
          boxShadow: active ? 'var(--shadow-card)' : 'none',
        }}
      >
        {t(labelKey)}
      </Link>
    );
  };
  const logoutButton = (
    <Button variant="ghost" tone="danger" size="sm" icon="signOut" onClick={() => void handleLogout()}>{t('nav.logout')}</Button>
  );

  if (isMobile) {
    return (
      <div style={{ paddingBottom: 'var(--spacing-16)' }}>
        <h2 className="title-md" style={{ marginBottom: 'var(--spacing-3)' }}>{t('title')}</h2>
        <nav aria-label={t('title')} style={{ display: 'flex', gap: 'var(--spacing-1)', overflowX: 'auto', paddingBottom: 'var(--spacing-2)', marginBottom: 'var(--spacing-4)' }}>
          {SECTIONS.map((s) => link(s.key, s.labelKey))}
        </nav>
        <div>{children}</div>
        <div style={{ marginTop: 'var(--spacing-8)' }}>{logoutButton}</div>
      </div>
    );
  }

  return (
    <div style={{ paddingBottom: 'var(--spacing-16)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '200px minmax(0, 1fr)', gap: 'var(--spacing-8)', minHeight: '70vh' }}>
        {/* Sidebar */}
        <nav aria-label={t('title')} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-1)' }}>
          <h2 className="title-md" style={{ marginBottom: 'var(--spacing-4)' }}>{t('title')}</h2>
          {SECTIONS.map((s) => link(s.key, s.labelKey))}
          <div style={{ flex: 1 }} />
          <div style={{ marginTop: 'var(--spacing-8)' }}>{logoutButton}</div>
        </nav>

        {/* Content (per-section page) */}
        <div>{children}</div>
      </div>
    </div>
  );
}
