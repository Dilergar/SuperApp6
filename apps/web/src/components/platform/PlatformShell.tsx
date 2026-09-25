'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { PlatformCapability } from '@superapp/shared';
import { Button, Chip, Icon, IconButton, SearchField, type IconName } from '@/components/ui';
import { PersonAvatar } from '@/app/messenger/messenger-ui';
import { usePlatformAuth } from '@/lib/platform/usePlatformAuth';
import { usePlatformAuthStore } from '@/lib/stores/platform-auth';
import { formatCountdown } from '@/lib/format';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { StepUpModal } from './StepUpModal';

// ============================================================
// Каркас кабинета платформы (Stripe/Shopify/Linear-модель): слева сайдбар 264px
// (Поиск · Тарифы · Аналитика · Согласия · Заявки · Безопасность · Сотрудники), сверху строка поиска (`/` фокус,
// `Esc` очистка), справа чип sudo с обратным отсчётом, аватар сотрудника, выход.
// Визуальный язык — DESIGN.md и кит, своего второго не заводим.
// ============================================================

// Пункт живёт только у того, чьё право открывает его страницу: иначе узкая роль
// видела бы раздел и получала 403 на входе (правило «не предлагать отвергнутое»).
// Несколько прав — «любое из»: консоль «Безопасность» открыта и держателю журнала команд,
// и держателю журнала безопасности (каждая вкладка проверяет своё право сама).
const NAV: { key: string; href: string; icon: IconName; exact?: boolean; capability: PlatformCapability | readonly PlatformCapability[] }[] = [
  { key: 'search', href: '/platform', icon: 'search', exact: true, capability: 'platform.lookup.read' },
  { key: 'entitlements', href: '/platform/entitlements', icon: 'crown', capability: 'entitlements.catalog.read' },
  { key: 'analytics', href: '/platform/analytics', icon: 'chart', capability: 'analytics.read' },
  { key: 'consents', href: '/platform/consents', icon: 'docs', capability: 'consents.read' },
  { key: 'requests', href: '/platform/requests', icon: 'check', capability: 'platform.audit.read' },
  { key: 'security', href: '/platform/audit', icon: 'shieldWarning', capability: ['security.read', 'platform.audit.read'] },
  { key: 'data', href: '/platform/data', icon: 'database', capability: 'data.read' },
  { key: 'staff', href: '/platform/staff', icon: 'shield', capability: 'platform.staff.read' },
];

const SIDEBAR_KEY = 'sa6_platform_sidebar';

export function PlatformShell({ children }: { children: React.ReactNode }) {
  const t = useTranslations('platform');
  const tc = useTranslations('common');
  const pathname = usePathname();
  const router = useRouter();
  const isLogin = pathname === '/platform/login';
  const { me, status, sudoActive, sudoLeftSec, can } = usePlatformAuth({ redirect: !isLogin });
  const allowed = (cap: PlatformCapability | readonly PlatformCapability[]) => (typeof cap === 'string' ? can(cap) : cap.some((c) => can(c)));
  const logout = usePlatformAuthStore((s) => s.logout);
  const isMobile = useIsMobile();
  const [collapsed, setCollapsed] = useState(false);
  const [query, setQuery] = useState('');
  const [stepUp, setStepUp] = useState(false);
  // SearchField ref не пробрасывает — фокусируем input внутри обёртки
  const searchWrapRef = useRef<HTMLFormElement>(null);
  const searchInput = () => searchWrapRef.current?.querySelector('input') ?? null;

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(SIDEBAR_KEY) === 'collapsed');
    } catch {
      /* приватный режим */
    }
  }, []);

  // `/` фокусирует поиск, `Esc` очищает — вне полей ввода
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (e.key === '/' && !typing) {
        e.preventDefault();
        searchInput()?.focus();
      } else if (e.key === 'Escape' && target === searchInput()) {
        setQuery('');
        searchInput()?.blur();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (isLogin) return <>{children}</>;

  if (status === 'forbidden') {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ padding: 'var(--spacing-8)' }}>
        <div className="card" style={{ maxWidth: 420, padding: 'var(--spacing-8)', textAlign: 'center' }}>
          <Icon name="shield" size={32} />
          <h1 className="title-md" style={{ margin: 'var(--spacing-4) 0 var(--spacing-2)' }}>{t('noAccess.title')}</h1>
          <p className="body-sm" style={{ marginBottom: 'var(--spacing-6)' }}>{t('noAccess.text')}</p>
          <Button variant="matte" icon="signOut" onClick={() => void logout().then(() => router.replace('/platform/login'))}>
            {t('shell.logout')}
          </Button>
        </div>
      </div>
    );
  }

  if (status !== 'ready' || !me) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="label-md" style={{ fontSize: '1rem' }}>{tc('state.loading')}</p>
      </div>
    );
  }

  const toggle = () => {
    setCollapsed((v) => {
      try {
        localStorage.setItem(SIDEBAR_KEY, !v ? 'collapsed' : 'expanded');
      } catch {
        /* ignore */
      }
      return !v;
    });
  };

  const submitSearch = () => {
    const q = query.trim();
    router.push(q ? `/platform?q=${encodeURIComponent(q)}` : '/platform');
  };

  const width = isMobile ? 0 : collapsed ? 60 : 264;

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--surface)' }}>
      {!isMobile && (
        <aside
          aria-label={t('shell.nav')}
          style={{ width, minWidth: width, borderRight: '1px solid var(--divider)', padding: 'var(--spacing-4) var(--spacing-3)', display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: collapsed ? 'center' : 'space-between', marginBottom: 'var(--spacing-4)' }}>
            {!collapsed && <span className="label-caps">{t('shell.title')}</span>}
            <IconButton icon={collapsed ? 'arrowRight' : 'arrowLeft'} label={tc('a11y.actions')} size={28} onClick={toggle} />
          </div>
          {NAV.filter((item) => allowed(item.capability)).map((item) => {
            const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
            return (
              <Link
                key={item.key}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                title={t(`nav.${item.key}`)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.625rem', padding: '0.5rem 0.625rem', borderRadius: 'var(--radius-md)',
                  background: active ? 'var(--surface-container-high)' : 'transparent', color: 'inherit', fontWeight: active ? 700 : 500,
                  justifyContent: collapsed ? 'center' : 'flex-start',
                }}
              >
                <Icon name={item.icon} size={18} />
                {!collapsed && <span className="body-sm">{t(`nav.${item.key}`)}</span>}
              </Link>
            );
          })}
        </aside>
      )}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', padding: 'var(--spacing-3) var(--spacing-5)', borderBottom: '1px solid var(--divider)', flexWrap: 'wrap' }}>
          {isMobile && (
            <nav aria-label={t('shell.nav')} style={{ display: 'flex', gap: '0.25rem' }}>
              {NAV.filter((item) => allowed(item.capability)).map((item) => (
                <IconButton key={item.key} icon={item.icon} label={t(`nav.${item.key}`)} size={32} onClick={() => router.push(item.href)} />
              ))}
            </nav>
          )}
          <form
            ref={searchWrapRef}
            onSubmit={(e) => {
              e.preventDefault();
              submitSearch();
            }}
            style={{ flex: 1, minWidth: '14rem' }}
          >
            <SearchField width="100%" value={query} onChange={(e) => setQuery(e.target.value)} onClear={() => setQuery('')} placeholder={t('shell.searchPlaceholder')} aria-label={t('nav.search')} />
          </form>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)' }}>
            {sudoActive ? (
              <Chip tone="success" size="sm" icon="shield">{t('shell.sudoActive', { time: formatCountdown(sudoLeftSec) })}</Chip>
            ) : (
              <Chip tone="neutral" size="sm" icon="shield" onClick={() => setStepUp(true)}>{t('shell.sudoNeeded')}</Chip>
            )}
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
              <PersonAvatar userId={me.userId} name={`${me.person.firstName} ${me.person.lastName ?? ''}`.trim()} avatar={me.person.avatar} size="sm" />
              {!isMobile && <span className="body-sm">{`${me.person.firstName} ${me.person.lastName ?? ''}`.trim()}</span>}
            </span>
            <IconButton icon="signOut" label={t('shell.logout')} size={32} onClick={() => void logout().then(() => router.replace('/platform/login'))} />
          </div>
        </header>
        <main style={{ padding: 'var(--spacing-6) var(--spacing-5) var(--spacing-16)', flex: 1, minWidth: 0 }}>{children}</main>
      </div>
      <StepUpModal open={stepUp} onClose={() => setStepUp(false)} />
    </div>
  );
}
