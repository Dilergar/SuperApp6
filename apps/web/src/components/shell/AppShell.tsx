'use client';

// ============================================================
// AppShell — ЕДИНЫЙ каркас приложения: глобальный сайдбар + топбар.
//
// Заменяет 10 скопированных навбаров и пер-сервисный ServiceShell.
// Модель — прототип дизайн-пакета и Notion: один сайдбар со списком
// сервисов, у активного раскрываются его разделы (2 уровня максимум).
//
// Контекст «Личное / Организация» переключается в ТОПБАРЕ (там, где в
// прототипе стоит Overview|Analytics) и меняет набор пунктов и префикс
// адресов. Права и API не трогаются: изоляция B2B живёт в самом адресе.
//
// Состояния сайдбара: 264px ↔ рейл 60px (cookie + Ctrl/Cmd+B),
// <768px — шторка поверх контента.
// ============================================================

import Link from 'next/link';
import dynamic from 'next/dynamic';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '@/lib/stores/auth';
import {
  SIDEBAR_COOKIE, buildPersonalNav, buildWorkspaceNav, isBranchActive, isNavItemActive,
  type AppNavConfig, type AppNavItem,
} from '@/lib/app-nav';
import { hrDeadlinesCountKey } from '@/lib/queries';
import { fetchHrDeadlinesCount } from '@/lib/hr-api';
// Прямые импорты из файлов кита, НЕ из барабана '@/components/ui': шелл сидит
// в корневом графе каждой страницы, а барабан утащил бы туда весь кит
// (Modal, DatePicker, Dropzone…) — лишние сотни КБ в каждом чанке dev-сборки.
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/Button';
import { SearchField } from '@/components/ui/Input';
import { Menu } from '@/components/ui/Menu';
import { PersonAvatar } from '@/app/messenger/messenger-ui';
import { useMentionsUnread } from '@/lib/hooks/useMentionsUnread';
import { useApprovalsCount } from '@/lib/hooks/useApprovalsCount';
import { APPROVAL_INBOX_TITLE } from '@superapp/shared';
// Стопка — динамическим импортом по той же причине, что и барабан кита: она
// тянет Modal и клиент движка, а шелл сидит в корневом графе каждой страницы.
const DecisionStack = dynamic(
  () => import('@/components/approvals/DecisionStack').then((m) => m.DecisionStack),
  { ssr: false },
);
import { fetchTaskStats, fetchWorkspaces, taskStatsKey, workspacesKey } from '@/lib/queries';
import type { Workspace } from '@superapp/shared';

// Стабильный пустой список: дефолт `= []` в деструктуризации рождал бы новый
// массив на каждый рендер и заставлял пересчитывать nav-меню.
const NO_WORKSPACES: Workspace[] = [];

function writeSidebarCookie(collapsed: boolean) {
  document.cookie = `${SIDEBAR_COOKIE}=${collapsed ? 'collapsed' : 'expanded'}; path=/; max-age=31536000; samesite=lax`;
}

export function AppShell({ defaultCollapsed = false, children }: { defaultCollapsed?: boolean; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const profile = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [isMobile, setIsMobile] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [openBranch, setOpenBranch] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  // ---- контекст: личное или конкретная организация (выводится из адреса)
  const wsMatch = pathname.match(/^\/workspaces\/([^/]+)/);
  const activeWsId = wsMatch?.[1] ?? null;

  // Ключ и загрузчик — общие с панелью организаций на дашборде (lib/queries):
  // её мутации инвалидируют этот же префикс, и переключатель контекста узнаёт
  // о новой организации сразу, а не после перезагрузки страницы.
  const { data: workspaces = NO_WORKSPACES } = useQuery({
    queryKey: workspacesKey,
    queryFn: fetchWorkspaces,
    staleTime: 60_000,
    enabled: !!profile,
  });

  // Бейджи «требует внимания». Тихо падаем в ноль: сломанный счётчик не имеет
  // права уронить навигацию всего приложения.
  // Ключ и загрузчик — общие с сервисом Задач (lib/queries), иначе бейдж
  // в сайдбаре и счётчики на страницах жили бы в разных кэшах и расходились.
  const { data: taskStats } = useQuery({
    queryKey: taskStatsKey,
    queryFn: fetchTaskStats,
    staleTime: 60_000,
    enabled: !!profile && !activeWsId,
  });
  // Готовый хук приложения, а не свой запрос: ключ у них общий, и второй
  // queryFn на том же ключе конфликтует с первым (ровно это и случилось).
  // Кормит ТОЛЬКО точку на колокольчике — пункта «Упоминания» в сайдбаре нет.
  const mentionsUnread = useMentionsUnread(!!profile);
  // Стопка «Ждут решения». Счётчик лёгкий и общий по всем источникам; сама
  // модалка грузится лениво — она тянет кит и клиент движка, а шелл сидит в
  // корневом графе КАЖДОЙ страницы.
  //
  // Скоуп СКВОЗНОЙ (без activeWsId) — как у колокольчика: верхние иконки висят над
  // любой страницей и отвечают на вопрос «что ждёт МЕНЯ», а не «что ждёт меня
  // здесь». Пока счётчик скоупился активным контекстом, приказ на подпись
  // переставал существовать, стоило переключиться в другую компанию или в личное.
  // Витрины ВНУТРИ контекста (плитки Главных) считают по-своему — там скоуп нужен.
  const approvalsCount = useApprovalsCount(!!profile);
  const [stackOpen, setStackOpen] = useState(false);

  // КЭДО: бейдж «Кадровые сроки» на пункте «Сотрудники» (Менеджер+; остальным
  // сервер честно отдаёт 0). Тихо падаем в ноль — как у остальных счётчиков.
  const activeWsRole = activeWsId ? workspaces.find((w) => w.id === activeWsId)?.myRole : null;
  const canSeeHrBadge = activeWsRole === 'manager' || activeWsRole === 'admin' || activeWsRole === 'owner';
  const { data: hrDeadlines } = useQuery({
    queryKey: activeWsId ? hrDeadlinesCountKey(activeWsId) : ['hr-deadlines-none'],
    queryFn: () => fetchHrDeadlinesCount(activeWsId!),
    staleTime: 60_000,
    enabled: !!profile && !!activeWsId && canSeeHrBadge,
    retry: false,
  });

  const nav: AppNavConfig = useMemo(() => {
    if (activeWsId) {
      const ws = workspaces.find((w) => w.id === activeWsId);
      return buildWorkspaceNav(activeWsId, ws?.name ?? 'Организация', ws?.myRole ?? null, {
        hrDeadlines: hrDeadlines?.count || undefined,
      });
    }
    return buildPersonalNav({
      tasksInbox: taskStats?.inbox,
      tasksToday: taskStats?.today,
      tasksReview: taskStats?.onReview,
    });
  }, [activeWsId, workspaces, taskStats, hrDeadlines]);

  // ---- ширина экрана: <768 шторка, 768–1199 авто-рейл, ≥1200 выбор человека
  useEffect(() => {
    const mqDesktop = window.matchMedia('(min-width: 1200px)');
    const mqMobile = window.matchMedia('(max-width: 767px)');
    const sync = () => {
      setIsMobile(mqMobile.matches);
      if (!mqMobile.matches) setCollapsed(mqDesktop.matches ? defaultCollapsed : true);
    };
    sync();
    mqDesktop.addEventListener('change', sync);
    mqMobile.addEventListener('change', sync);
    return () => {
      mqDesktop.removeEventListener('change', sync);
      mqMobile.removeEventListener('change', sync);
    };
  }, [defaultCollapsed]);

  // ---- Ctrl/Cmd+B — свернуть/развернуть; Esc — закрыть шторку
  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => { writeSidebarCookie(!c); return !c; });
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleCollapsed(); }
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleCollapsed]);

  // ---- переход закрывает шторку И стопку; активная ветка раскрывается сама
  // Каркас при клиентской навигации не размонтируется, поэтому «Открыть целиком»
  // внутри стопки меняло адрес, а модалка оставалась висеть поверх новой страницы
  // (с затемнением и заблокированной прокруткой) — выглядело как «кнопка не работает».
  useEffect(() => { setDrawerOpen(false); setStackOpen(false); }, [pathname]);
  useEffect(() => {
    const branch = nav.groups.flatMap((g) => g.items).find((i) => i.children?.length && isBranchActive(i, pathname));
    if (branch) setOpenBranch(branch.key);
  }, [pathname, nav]);

  const rail = collapsed && !isMobile;
  const contexts = [{ id: null as string | null, label: 'Личное' }, ...workspaces.map((w) => ({ id: w.id, label: w.name }))];

  function switchContext(id: string | null) {
    router.push(id ? `/workspaces/${id}` : '/dashboard');
  }

  async function handleLogout() {
    await logout();
    router.push('/login');
  }

  return (
    <div className={`svc-shell${rail ? ' collapsed' : ''}`}>
      {/* ---------------- Топбар ---------------- */}
      <header className="svc-topbar">
        <button className="svc-burger" aria-label="Открыть меню" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(true)}>
          <Icon name="list" size={20} />
        </button>

        <ContextSwitcher contexts={contexts} activeId={activeWsId} onSwitch={switchContext} forceMenu={isMobile} />

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <form
            onSubmit={(e) => { e.preventDefault(); if (query.trim()) router.push(`/messenger?q=${encodeURIComponent(query.trim())}`); }}
            className="app-topbar-search"
          >
            <SearchField value={query} onChange={(e) => setQuery(e.target.value)} onClear={() => setQuery('')} placeholder="Поиск…" width={240} />
          </form>
          {/* «＋» ведёт в быстрый ввод Входящих: он ловит мысль одной строкой,
              а разбор (срок, исполнитель) делается там же. Полная форма живёт
              на «Обзоре» — открыть её отсюда нельзя, контекст сервиса ниже. */}
          <IconButton href="/tasks/inbox" icon="add" label="Быстро записать задачу" />
          {/* Обёртка — неинтерактивный span: якорь кита сам ссылка (href→next/link),
              вложить его в <Link> значило бы «управление внутри управления». */}
          <span style={{ position: 'relative', display: 'inline-flex' }}>
            <IconButton
              href="/mentions"
              icon="bell"
              label={mentionsUnread ? 'Упоминания — есть непрочитанные' : 'Упоминания'}
            />
            {!!mentionsUnread && mentionsUnread > 0 && (
              // Синяя точка: красный в системе означает только опасность.
              // aria-hidden — смысл несёт label кнопки, точка чисто визуальная
              <span aria-hidden style={{ position: 'absolute', top: 7, right: 8, width: 8, height: 8, borderRadius: '50%', background: 'var(--primary)', border: '2px solid var(--surface)' }} />
            )}
          </span>
          {/* «Ждут решения» — не ссылка, а КНОПКА: стопка открывается модалкой
              поверх текущей страницы, чтобы разобрать её не уходя с работы.
              Счётчик приходит сложенным по всем источникам реестра.

              Кнопка видна ВСЕГДА, а не только при непустой стопке: внутри неё живёт
              вкладка «Мои заявки», адресованная как раз тому, у кого на руках ничего
              нет — автору отправленного документа. Пока кнопка появлялась по
              счётчику, посмотреть «где моё заявление» с личных страниц было негде. */}
          <span style={{ position: 'relative', display: 'inline-flex' }}>
            <IconButton
              icon="checkCircle"
              label={approvalsCount > 0 ? `${APPROVAL_INBOX_TITLE}: ${approvalsCount}` : APPROVAL_INBOX_TITLE}
              onClick={() => setStackOpen(true)}
            />
            {approvalsCount > 0 && (
              <span
                aria-hidden
                style={{
                  position: 'absolute', top: 2, right: 0, minWidth: 16, height: 16, padding: '0 4px',
                  borderRadius: 999, background: 'var(--primary)', color: 'var(--on-primary)',
                  fontSize: 10, lineHeight: '16px', textAlign: 'center', fontWeight: 600,
                  border: '2px solid var(--surface)',
                }}
              >
                {approvalsCount > 99 ? '99+' : approvalsCount}
              </span>
            )}
          </span>
          <Menu
            align="end"
            label="Профиль"
            items={[
              { key: 'profile', label: 'Мой профиль', icon: 'profile', href: '/profile/card' },
              { key: 'wallet', label: 'Кошелёк', icon: 'coins', href: '/profile/wallet' },
              { key: 'settings', label: 'Настройки', icon: 'settings', href: '/profile/settings' },
              { key: 'logout', label: 'Выйти', icon: 'signOut', danger: true, separatorBefore: true, onClick: () => void handleLogout() },
            ]}
            trigger={({ ref, onClick, ...aria }) => (
              <button ref={ref} onClick={onClick} {...aria} aria-label="Меню профиля" className="app-avatar-btn">
                {profile
                  ? <PersonAvatar userId={profile.id} name={`${profile.firstName} ${profile.lastName ?? ''}`.trim()} avatar={profile.avatar} size="sm" />
                  : <Icon name="user" size={18} />}
              </button>
            )}
          />
        </div>
      </header>

      {drawerOpen && <div className="svc-backdrop" aria-hidden onClick={() => setDrawerOpen(false)} />}

      {/* ---------------- Сайдбар ---------------- */}
      <aside className={`svc-sidebar${drawerOpen ? ' drawer-open' : ''}`} aria-label="Навигация приложения">
        <div className="svc-side-head">
          {/* Кнопка закрытия видна только в мобильной шторке (медиазапрос) */}
          <div className="svc-drawer-top">
            <span className="label-caps">Меню</span>
            <button className="svc-drawer-close" aria-label="Закрыть меню" onClick={() => setDrawerOpen(false)}>
              <Icon name="close" size={20} />
            </button>
          </div>
          <Link href="/dashboard" className="app-logo" aria-label="SuperApp6 — на главную">
            <span className="app-logo-mark">S</span>
            {!rail && (
              <span style={{ minWidth: 0 }}>
                <span className="app-logo-name">SuperApp6</span>
                <span className="app-logo-context">{nav.contextLabel}</span>
              </span>
            )}
          </Link>
        </div>

        <nav className="svc-side-nav">
          {nav.groups.map((g) => (
            <div key={g.key} className="svc-group">
              {g.label && <div className="svc-group-label">{g.label}</div>}
              {g.items.map((item) => (
                <NavItem
                  key={item.key}
                  item={item}
                  pathname={pathname}
                  rail={rail}
                  open={openBranch === item.key}
                  onToggle={() => setOpenBranch((k) => (k === item.key ? null : item.key))}
                />
              ))}
            </div>
          ))}
        </nav>

        {/* В личном контексте футер пуст (всё ушло в меню аватарки), и в
            мобильной шторке «Свернуть» тоже не рисуется — блок не должен
            оставлять от себя полосу пустого отступа. */}
        {(nav.footer.length > 0 || !isMobile) && (
          <div className="svc-side-foot">
            {nav.footer.map((item) => (
              <NavItem key={item.key} item={item} pathname={pathname} rail={rail} open={false} onToggle={() => {}} />
            ))}
            {!isMobile && (
              <button className="svc-item" onClick={toggleCollapsed} aria-label={rail ? 'Развернуть меню' : 'Свернуть меню'}>
                <span className="svc-ico"><Icon name={rail ? 'caretRight' : 'caretLeft'} size={18} /></span>
                {!rail && <span className="svc-label">Свернуть</span>}
              </button>
            )}
          </div>
        )}
      </aside>

      <main className="svc-main">
        <div className="svc-main-inner">{children}</div>
      </main>

      {/* Стопка решений монтируется, только когда её открыли: она тянет кит и
          клиент движка, а шелл живёт в графе каждой страницы. */}
      {/* Скоуп не передаём — стопка топбара сквозная, как и его счётчик */}
      {stackOpen && <DecisionStack open onClose={() => setStackOpen(false)} />}
    </div>
  );
}

// ------------------------------------------------------------

function NavItem({
  item, pathname, rail, open, onToggle,
}: {
  item: AppNavItem; pathname: string; rail: boolean; open: boolean; onToggle: () => void;
}) {
  const active = isNavItemActive(item, pathname);
  const branchActive = isBranchActive(item, pathname);
  const hasChildren = !!item.children?.length;

  const face = (
    <>
      <span className="svc-ico"><Icon name={item.icon} size={20} /></span>
      {!rail && <span className="svc-label">{item.label}</span>}
      {!rail && !!item.badge && item.badge > 0 && <span className="svc-badge">{item.badge}</span>}
      {rail && !!item.badge && item.badge > 0 && <span className="svc-badge-dot" />}
    </>
  );

  if (!hasChildren || rail) {
    return (
      <Link
        href={item.href}
        className={`svc-item${branchActive ? ' active' : ''}`}
        aria-current={active ? 'page' : undefined}
        title={rail ? item.label : undefined}
      >
        {face}
      </Link>
    );
  }

  return (
    <>
      <div className={`svc-item svc-parent${branchActive ? ' active' : ''}`}>
        <Link href={item.href} className="svc-parent-link" aria-current={active ? 'page' : undefined}>
          {face}
        </Link>
        <button
          className="svc-chevron"
          aria-expanded={open}
          aria-label={open ? `Свернуть ${item.label}` : `Развернуть ${item.label}`}
          onClick={onToggle}
        >
          <Icon name="caretDown" size={14} />
        </button>
      </div>
      {open && (
        <div className="svc-children">
          {item.children!.map((c) => (
            <div key={c.key} className="svc-branch">
              <Link
                href={c.href}
                className={`svc-item${isNavItemActive(c, pathname) ? ' active' : ''}`}
                aria-current={isNavItemActive(c, pathname) ? 'page' : undefined}
                style={{ fontSize: '0.8125rem', fontWeight: 500, padding: '0.4375rem 0.75rem' }}
              >
                <span className="svc-ico" style={{ width: '1.25rem', minWidth: '1.25rem' }}><Icon name={c.icon} size={16} /></span>
                <span className="svc-label">{c.label}</span>
                {!!c.badge && c.badge > 0 && <span className="svc-badge">{c.badge}</span>}
              </Link>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * Переключатель контекста. До трёх контекстов — сегменты (видно всё сразу,
 * ровно как просил пользователь); больше — выпадающее меню, иначе строка
 * уезжает за край у того, кто состоит в десятке организаций.
 */
function ContextSwitcher({
  contexts, activeId, onSwitch, forceMenu,
}: {
  contexts: { id: string | null; label: string }[];
  activeId: string | null;
  onSwitch: (id: string | null) => void;
  /** Телефон: сегменты не сжимаются (nowrap) и выталкивают правый блок топбара
      за экран уже при одной организации — всегда показываем выпадающее меню. */
  forceMenu?: boolean;
}) {
  const current = contexts.find((c) => c.id === activeId) ?? contexts[0];

  // Единственный контекст («Личное» без организаций) ничего не выталкивает —
  // сегмент остаётся и на телефоне
  if (contexts.length === 1 || (contexts.length <= 3 && !forceMenu)) {
    return (
      // role="group"+aria-pressed: это переключатель контекста, а не вкладки —
      // role="tab" без tabpanel был бы ложью для скринридера
      <div className="ui-segment" role="group" aria-label="Контекст">
        {contexts.map((c) => (
          <button
            key={c.id ?? 'personal'}
            type="button"
            className="ui-segment-item"
            aria-pressed={c.id === activeId}
            onClick={() => onSwitch(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>
    );
  }

  return (
    <Menu
      align="start"
      label="Контекст"
      items={contexts.map((c) => ({
        key: c.id ?? 'personal',
        label: c.label,
        icon: c.id ? ('workspace' as const) : ('user' as const),
        onClick: () => onSwitch(c.id),
      }))}
      trigger={({ ref, onClick, ...aria }) => (
        <button ref={ref} onClick={onClick} {...aria} className="app-context-btn">
          <Icon name={activeId ? 'workspace' : 'user'} size={17} />
          <span>{current?.label}</span>
          <Icon name="caretDown" size={13} style={{ opacity: 0.6 }} />
        </button>
      )}
    />
  );
}
