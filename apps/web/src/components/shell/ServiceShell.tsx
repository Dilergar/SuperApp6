'use client';

// ============================================================
// ServiceShell — переиспользуемый каркас сервиса (Принцип 1).
//
// Двухуровневая навигация (модель Salesforce/Stripe, решение продукта):
// верхняя полоска остаётся под будущую глобальную навигацию SuperApp6,
// у каждого сервиса — свой левый сайдбар с разделами.
//
// Состояния сайдбара (бенчмарки shadcn/Notion/Jira/GitLab, NN/g):
// - развёрнут 260px ↔ icon-рейл 60px (тултипы-флайауты у иконок);
// - персистенция в cookie `sa6_sidebar` (сервер-layout сервиса читает её и
//   передаёт defaultCollapsed — первый рендер сразу правильный, без прыжка);
// - Ctrl/Cmd+B — переключение; Esc закрывает drawer/флайаут;
// - 768–1199px — авто-рейл (выбор пользователя возвращается на десктопе);
// - <768px — сайдбар прячется, бургер в полоске открывает drawer поверх
//   контента (подложка, скролл-лок, закрытие по Esc/подложке/переходу);
// - активный пункт: aria-current="page" + восковой «мазок» слева;
// - prefers-reduced-motion уважается (анимации гасятся в CSS).
//
// NB: использует useSearchParams → layout сервиса ОБЯЗАН оборачивать
// ServiceShell в <Suspense> (см. apps/web/src/app/finance/layout.tsx).
// ============================================================

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { SIDEBAR_COOKIE, type ServiceNavConfig, type ServiceNavItem } from '@/lib/service-nav';

function writeSidebarCookie(collapsed: boolean) {
  document.cookie = `${SIDEBAR_COOKIE}=${collapsed ? 'collapsed' : 'expanded'}; path=/; max-age=31536000; samesite=lax`;
}

/** Флайаут у рейла: подпись пункта (лист) или подпись + дети (родитель). */
interface RailFlyout {
  key: string;
  label: string;
  top: number;
  children?: ServiceNavItem[];
  badge?: number | string;
}

/** Пилюля-счётчик пункта (модель Bitrix24/Slack). 0/undefined не рендерится. */
function NavBadge({ value }: { value?: number | string }) {
  if (value == null || value === 0) return null;
  return <span className="svc-badge">{value}</span>;
}

export function ServiceShell({
  nav,
  headerSlot,
  defaultCollapsed = false,
  children,
}: {
  nav: ServiceNavConfig;
  /** Слот в шапке сайдбара (переключатель книги/организации). Виден в развёрнутом виде и в drawer. */
  headerSlot?: React.ReactNode;
  defaultCollapsed?: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const search = useSearchParams();

  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [isMobile, setIsMobile] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [flyout, setFlyout] = useState<RailFlyout | null>(null);

  // выбор пользователя (cookie) — поверх него живёт авто-рейл планшета
  const userChoice = useRef(defaultCollapsed);
  const burgerRef = useRef<HTMLButtonElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const wasDrawerOpen = useRef(false);
  const flyoutOpenTimer = useRef<number | null>(null);
  const flyoutCloseTimer = useRef<number | null>(null);

  // ---- брейкпоинты: <768 mobile (drawer), 768–1199 авто-рейл, ≥1200 выбор пользователя
  useEffect(() => {
    const mqDesktop = window.matchMedia('(min-width: 1200px)');
    const mqMobile = window.matchMedia('(max-width: 767px)');
    const apply = () => {
      setIsMobile(mqMobile.matches);
      setCollapsed(mqDesktop.matches ? userChoice.current : true);
    };
    apply();
    mqDesktop.addEventListener('change', apply);
    mqMobile.addEventListener('change', apply);
    return () => {
      mqDesktop.removeEventListener('change', apply);
      mqMobile.removeEventListener('change', apply);
    };
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((v) => {
      const next = !v;
      userChoice.current = next;
      writeSidebarCookie(next);
      return next;
    });
    setFlyout(null);
  }, []);

  // ---- Ctrl/Cmd+B + Esc
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
        e.preventDefault();
        toggleCollapsed();
      }
      if (e.key === 'Escape') {
        setDrawerOpen(false);
        setFlyout(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleCollapsed]);

  // ---- drawer: закрыть при навигации, скролл-лок, фокус-менеджмент
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  useEffect(() => {
    document.body.style.overflow = drawerOpen ? 'hidden' : '';
    if (drawerOpen) {
      wasDrawerOpen.current = true;
      // фокус на первый пункт — клавиатура сразу в меню
      asideRef.current?.querySelector<HTMLElement>('a, button')?.focus();
    } else if (wasDrawerOpen.current) {
      wasDrawerOpen.current = false;
      burgerRef.current?.focus();
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [drawerOpen]);

  // ---- контекстные query-параметры (?book=…) переносим между разделами
  const withParams = useCallback(
    (href: string) => {
      const keep = nav.preserveParams ?? [];
      if (keep.length === 0) return href;
      const qs = new URLSearchParams();
      for (const k of keep) {
        const v = search.get(k);
        if (v) qs.set(k, v);
      }
      const s = qs.toString();
      return s ? `${href}?${s}` : href;
    },
    [nav.preserveParams, search],
  );

  const isItemActive = useCallback(
    (item: ServiceNavItem): boolean => {
      if (item.exact) return pathname === item.href;
      if (pathname === item.href || pathname.startsWith(`${item.href}/`)) return true;
      return (item.children ?? []).some((c) => pathname === c.href || pathname.startsWith(`${c.href}/`));
    },
    [pathname],
  );

  const rail = collapsed && !isMobile && !drawerOpen;

  // ---- флайаут рейла (NN/g: пауза 300–500мс на открытие, грейс ≥500мс на закрытие; клик — мгновенно)
  const clearFlyoutTimers = () => {
    if (flyoutOpenTimer.current) window.clearTimeout(flyoutOpenTimer.current);
    if (flyoutCloseTimer.current) window.clearTimeout(flyoutCloseTimer.current);
    flyoutOpenTimer.current = null;
    flyoutCloseTimer.current = null;
  };
  const openFlyout = (item: ServiceNavItem, el: HTMLElement, immediate = false) => {
    clearFlyoutTimers();
    const show = () => {
      const rect = el.getBoundingClientRect();
      setFlyout({ key: item.key, label: item.label, top: rect.top + rect.height / 2, children: item.children, badge: item.badge });
    };
    if (immediate) show();
    else flyoutOpenTimer.current = window.setTimeout(show, 350);
  };
  const scheduleFlyoutClose = (delay = 500) => {
    clearFlyoutTimers();
    flyoutCloseTimer.current = window.setTimeout(() => setFlyout(null), delay);
  };
  useEffect(() => () => clearFlyoutTimers(), []);
  useEffect(() => {
    if (!rail) setFlyout(null);
  }, [rail]);

  // флайаут может быть открыт кликом (родитель в рейле) — клик мимо закрывает
  useEffect(() => {
    if (!flyout) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest('.svc-flyout') || t.closest('.svc-sidebar'))) return;
      setFlyout(null);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [flyout]);

  // ---- рейл: только иконка; ховер/фокус → флайаут; у родителя клик открывает
  // флайаут с детьми (модель Jira/ADS), а не навигирует вслепую
  const renderRailItem = (item: ServiceNavItem) => {
    const active = isItemActive(item);
    const hasChildren = (item.children?.length ?? 0) > 0;
    return (
      <Link
        key={item.key}
        href={withParams(item.href)}
        className={`svc-item${active ? ' active' : ''}`}
        aria-current={active ? 'page' : undefined}
        aria-label={item.label}
        aria-haspopup={hasChildren ? 'menu' : undefined}
        onMouseEnter={(e) => openFlyout(item, e.currentTarget)}
        onMouseLeave={() => scheduleFlyoutClose()}
        onFocus={(e) => openFlyout(item, e.currentTarget, true)}
        onBlur={() => scheduleFlyoutClose(200)}
        onClick={(e) => {
          if (hasChildren) {
            e.preventDefault();
            openFlyout(item, e.currentTarget, true);
          } else {
            setFlyout(null);
          }
        }}
      >
        <span className="svc-ico" aria-hidden>{item.icon}</span>
        {item.badge != null && item.badge !== 0 && <span className="svc-badge-dot" aria-hidden />}
      </Link>
    );
  };

  return (
    <div className={`svc-shell${collapsed && !isMobile ? ' collapsed' : ''}`}>
      {/* Верхняя полоска — будущая глобальная навигация SuperApp6 */}
      <header className="svc-topbar">
        <button
          ref={burgerRef}
          className="svc-burger"
          aria-label="Открыть меню разделов"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
        >
          ☰
        </button>
        <Link href="/dashboard" className="label-md svc-topbar-back">← SuperApp6</Link>
        <span className="title-md" style={{ color: 'var(--primary)' }}>{nav.title}</span>
      </header>

      {/* Подложка drawer'а (мобилка) */}
      {drawerOpen && <div className="svc-backdrop" aria-hidden onClick={() => setDrawerOpen(false)} />}

      {/* Сайдбар сервиса */}
      <aside
        ref={asideRef}
        className={`svc-sidebar${drawerOpen ? ' drawer-open' : ''}`}
        aria-label={`Разделы: ${nav.title}`}
      >
        <div className="svc-side-head">
          {drawerOpen && (
            <div className="svc-drawer-top">
              <span className="title-md" style={{ color: 'var(--primary)' }}>{nav.icon} {nav.title}</span>
              <button className="svc-drawer-close" aria-label="Закрыть меню" onClick={() => setDrawerOpen(false)}>×</button>
            </div>
          )}
          {rail ? (
            <button
              className="svc-rail-service"
              title={`${nav.title} — развернуть меню`}
              aria-label={`${nav.title} — развернуть меню`}
              onClick={toggleCollapsed}
            >
              {nav.icon}
            </button>
          ) : (
            headerSlot
          )}
        </div>

        <nav className="svc-side-nav" onScroll={() => setFlyout(null)}>
          {nav.groups.map((g) => (
            <div key={g.key} className="svc-group">
              {g.label && <div className="svc-group-label">{g.label}</div>}
              {g.items.map((item) =>
                rail ? (
                  renderRailItem(item)
                ) : (
                  <NavTreeItem
                    key={item.key}
                    item={item}
                    depth={0}
                    pathname={pathname}
                    withParams={withParams}
                    isBranchActive={isItemActive}
                  />
                ),
              )}
            </div>
          ))}
        </nav>

        <div className="svc-side-foot">
          {!isMobile && (
            <button
              className="svc-item svc-collapse"
              onClick={toggleCollapsed}
              aria-label={rail ? 'Развернуть сайдбар (Ctrl+B)' : 'Свернуть сайдбар (Ctrl+B)'}
              title={rail ? 'Развернуть (Ctrl+B)' : 'Свернуть (Ctrl+B)'}
              onMouseEnter={(e) => { if (rail) openFlyout({ key: '__collapse', label: 'Развернуть (Ctrl+B)', icon: '', href: '#' }, e.currentTarget); }}
              onMouseLeave={() => { if (rail) scheduleFlyoutClose(); }}
            >
              <span className="svc-ico" aria-hidden>
                <svg width="15" height="15" viewBox="0 0 15 15" fill="none" style={{ transform: rail ? 'rotate(180deg)' : undefined, transition: 'transform 0.2s ease' }}>
                  <path d="M9.5 3.2 5.4 7.4l4.2 4.3" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M12.4 3.6 8.6 7.4l3.7 3.9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" opacity="0.45" />
                </svg>
              </span>
              {!rail && <span className="svc-label">Свернуть</span>}
            </button>
          )}
        </div>
      </aside>

      {/* Флайаут рейла: бумажный чип с подписью (+ дети вторым уровнем) */}
      {rail && flyout && (
        <div
          className="svc-flyout"
          style={{ top: flyout.top }}
          onMouseEnter={clearFlyoutTimers}
          onMouseLeave={() => scheduleFlyoutClose(300)}
        >
          <div className={`svc-flyout-label${flyout.children?.length ? ' group' : ''}`}>
            {flyout.label}
            <NavBadge value={flyout.badge} />
          </div>
          {flyout.children && flyout.children.length > 0 && (
            <div className="svc-flyout-items">
              {flyout.children.map((c) => (
                <div key={c.key} className="svc-branch">
                  <Link
                    href={withParams(c.href)}
                    className={`svc-item${isItemActive(c) ? ' active' : ''}`}
                    onClick={() => setFlyout(null)}
                  >
                    <span className="svc-ico" aria-hidden>{c.icon}</span>
                    <span className="svc-label">{c.label}</span>
                    <NavBadge value={c.badge} />
                  </Link>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Контент раздела */}
      <main className="svc-main">
        <div className="svc-main-inner">{children}</div>
      </main>
    </div>
  );
}

export type { ServiceNavConfig };

// ------------------------------------------------------------
// Пункт дерева (развёрнутый сайдбар и drawer): родитель = ссылка + шеврон-
// дисклоужер (W3C: если родитель — ссылка, раскрытие отдельной кнопкой),
// дети — с ветками-линиями (tree lines). Открыт по умолчанию; раздел с
// активным ребёнком раскрывается сам.
// ------------------------------------------------------------

function NavTreeItem({
  item,
  depth,
  pathname,
  withParams,
  isBranchActive,
}: {
  item: ServiceNavItem;
  depth: number;
  pathname: string;
  withParams: (href: string) => string;
  isBranchActive: (item: ServiceNavItem) => boolean;
}) {
  const children = item.children ?? [];
  const hasChildren = children.length > 0;
  // активность САМОГО пункта (без детей): активный ребёнок подсвечивается сам,
  // родитель при этом остаётся обычным (как на референсе)
  const selfActive = item.exact
    ? pathname === item.href
    : pathname === item.href || pathname.startsWith(`${item.href}/`);
  const childActive = hasChildren && children.some((c) => isBranchActive(c));
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (childActive) setOpen(true);
  }, [childActive]);

  if (!hasChildren) {
    return (
      <Link
        href={withParams(item.href)}
        className={`svc-item${selfActive ? ' active' : ''}`}
        aria-current={selfActive ? 'page' : undefined}
        style={depth > 0 ? { fontSize: '0.82rem', padding: '0.35rem 0.6rem' } : undefined}
      >
        <span className="svc-ico" aria-hidden>{item.icon}</span>
        <span className="svc-label">{item.label}</span>
        <NavBadge value={item.badge} />
      </Link>
    );
  }

  return (
    <div>
      <div className={`svc-item svc-parent${selfActive ? ' active' : ''}`}>
        <Link
          href={withParams(item.href)}
          className="svc-parent-link"
          aria-current={selfActive ? 'page' : undefined}
        >
          <span className="svc-ico" aria-hidden>{item.icon}</span>
          <span className="svc-label">{item.label}</span>
          <NavBadge value={item.badge} />
        </Link>
        <button
          className="svc-chevron"
          aria-expanded={open}
          aria-label={open ? `Свернуть «${item.label}»` : `Развернуть «${item.label}»`}
          onClick={() => setOpen((v) => !v)}
        >
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
            <path d="M2.4 4.3 6 7.9l3.6-3.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      {open && (
        <div className="svc-children">
          {children.map((c) => (
            <div key={c.key} className="svc-branch">
              <NavTreeItem
                item={c}
                depth={depth + 1}
                pathname={pathname}
                withParams={withParams}
                isBranchActive={isBranchActive}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
