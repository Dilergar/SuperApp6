// ============================================================
// Реестр ГЛОБАЛЬНОЙ навигации SuperApp6.
//
// Модель (решение грилла редизайна): ОДИН сайдбар с деревом — список
// сервисов, у активного раскрываются его разделы (максимум 2 уровня).
// Контекст «Личное / Организация» переключается в ТОПБАРЕ и меняет набор
// пунктов и префикс адресов; права и API при этом не трогаются — изоляция
// B2B по-прежнему живёт в самом адресе /workspaces/<id>/…
//
// Новый сервис = +1 строка здесь. Своих навбаров страницы не рисуют.
// ============================================================
import type { IconName } from '@/components/ui/Icon';

export const SIDEBAR_COOKIE = 'sa6_sidebar';

export interface AppNavItem {
  key: string;
  label: string;
  icon: IconName;
  href: string;
  /** Активен только при точном совпадении адреса (для главной раздела). */
  exact?: boolean;
  /** Разделы сервиса — второй и последний уровень. */
  children?: Omit<AppNavItem, 'children'>[];
  /** Счётчик справа; 0 и undefined не рисуются. */
  badge?: number;
}

export interface AppNavGroup {
  key: string;
  label?: string;
  items: AppNavItem[];
}

export interface AppNavConfig {
  /** Что показывает переключатель контекста. */
  contextLabel: string;
  groups: AppNavGroup[];
  /**
   * Нижний блок сайдбара. В ЛИЧНОМ контексте он пуст осознанно: Профиль,
   * Кошелёк и Настройки живут в меню аватарки топбара, а Упоминания — под
   * колокольчиком там же. Дублировать их слева значит показывать одно и то
   * же дважды и растить сайдбар пунктами, которые человек уже нашёл справа.
   */
  footer: AppNavItem[];
}

/** Счётчики, которые сайдбар получает от страниц (бейджи «требует внимания»). */
export interface AppNavCounters {
  tasksInbox?: number;
  tasksToday?: number;
  tasksReview?: number;
  messenger?: number;
}

/** Личный контекст — сервисы человека. */
export function buildPersonalNav(c: AppNavCounters = {}): AppNavConfig {
  return {
    contextLabel: 'Личное',
    groups: [
      {
        key: 'main',
        label: 'Главное',
        items: [
          { key: 'dashboard', label: 'Главная', icon: 'home', href: '/dashboard', exact: true },
          { key: 'circles', label: 'Моё окружение', icon: 'circle', href: '/circles' },
          { key: 'messenger', label: 'Мессенджер', icon: 'messenger', href: '/messenger', badge: c.messenger },
        ],
      },
      {
        key: 'work',
        label: 'Дела',
        items: [
          {
            key: 'tasks',
            label: 'Задачи',
            icon: 'tasks',
            href: '/tasks',
            badge: c.tasksInbox,
            children: [
              { key: 'tasks-overview', label: 'Обзор', icon: 'dashboard', href: '/tasks', exact: true },
              { key: 'tasks-inbox', label: 'Входящие', icon: 'empty', href: '/tasks/inbox', badge: c.tasksInbox },
              { key: 'tasks-today', label: 'Сегодня', icon: 'sun', href: '/tasks/today', badge: c.tasksToday },
              { key: 'tasks-overdue', label: 'Просроченные', icon: 'overdue', href: '/tasks/overdue' },
              { key: 'tasks-upcoming', label: 'Предстоящие', icon: 'clock', href: '/tasks/upcoming' },
              { key: 'tasks-assigned', label: 'Мне поставили', icon: 'target', href: '/tasks/assigned' },
              { key: 'tasks-delegated', label: 'Я поручил', icon: 'handshake', href: '/tasks/delegated' },
              { key: 'tasks-review', label: 'На проверке', icon: 'eye', href: '/tasks/review', badge: c.tasksReview },
              { key: 'tasks-all', label: 'Все задачи', icon: 'list', href: '/tasks/all' },
              { key: 'tasks-done', label: 'Выполненные', icon: 'check', href: '/tasks/done' },
            ],
          },
          { key: 'calendar', label: 'Календарь', icon: 'calendar', href: '/calendar' },
          {
            key: 'finance',
            label: 'Финансы',
            icon: 'finance',
            href: '/finance',
            children: [
              { key: 'fin-overview', label: 'Обзор', icon: 'dashboard', href: '/finance', exact: true },
              { key: 'fin-feed', label: 'Лента', icon: 'list', href: '/finance/feed' },
              { key: 'fin-reports', label: 'Отчёты', icon: 'chart', href: '/finance/reports' },
              { key: 'fin-coins', label: 'Коины', icon: 'coins', href: '/finance/coins' },
              { key: 'fin-accounts', label: 'Счета', icon: 'card', href: '/finance/accounts' },
              { key: 'fin-categories', label: 'Категории', icon: 'folder', href: '/finance/categories' },
              { key: 'fin-people', label: 'Люди', icon: 'people', href: '/finance/people' },
              { key: 'fin-debts', label: 'Долги', icon: 'debt', href: '/finance/debts' },
              { key: 'fin-recurring', label: 'Повторы', icon: 'refresh', href: '/finance/recurring' },
            ],
          },
          {
            key: 'drive',
            label: 'Диск',
            icon: 'drive',
            href: '/drive',
            children: [
              { key: 'drive-my', label: 'Мой диск', icon: 'folder', href: '/drive', exact: true },
              { key: 'drive-photos', label: 'Фото', icon: 'image', href: '/drive/photos' },
              { key: 'drive-shared', label: 'Доступно мне', icon: 'share', href: '/drive/shared' },
              { key: 'drive-starred', label: 'Избранное', icon: 'star', href: '/drive/starred' },
              { key: 'drive-recent', label: 'Недавние', icon: 'clock', href: '/drive/recent' },
              { key: 'drive-trash', label: 'Корзина', icon: 'delete', href: '/drive/trash' },
            ],
          },
          { key: 'shop', label: 'Магазин', icon: 'shop', href: '/shop' },
          // КЭДО: личный архив кадровых документов — бессрочный, переживает
          // увольнение и закрытие компании (PersonalDocRecord)
          { key: 'my-documents', label: 'Мои документы', icon: 'file', href: '/my-documents' },
          { key: 'recorder', label: 'Диктофон', icon: 'recorder', href: '/recorder' },
        ],
      },
    ],
    // Профиль/Кошелёк/Настройки — в меню аватарки топбара, не здесь.
    footer: [],
  };
}

/** Счётчики бейджей организации («требует внимания» — Кадровые сроки). */
export interface WorkspaceNavCounters {
  hrDeadlines?: number;
}

/** Контекст организации — рабочие сервисы. `role` решает, что показывать. */
export function buildWorkspaceNav(
  workspaceId: string,
  workspaceName: string,
  role: string | null,
  c: WorkspaceNavCounters = {},
): AppNavConfig {
  const base = `/workspaces/${workspaceId}`;
  const RANK: Record<string, number> = { contractor: 0, trainee: 1, staff: 2, manager: 3, admin: 4, owner: 5 };
  const rank = RANK[role ?? ''] ?? 0;
  const isManager = rank >= 3;
  const isOwner = rank >= 5;

  const items: AppNavItem[] = [
    { key: 'ws-home', label: 'Главная', icon: 'home', href: base, exact: true },
    // Бейдж = «Кадровые сроки» КЭДО: несданное в ЕСУТД, вручения, расчёты
    { key: 'ws-members', label: 'Сотрудники', icon: 'staff', href: `${base}/members`, badge: c.hrDeadlines },
    { key: 'ws-processes', label: 'Процессы', icon: 'processes', href: `${base}/processes` },
    { key: 'ws-office', label: 'Виртуальный офис', icon: 'office', href: `${base}/office` },
    // Диск организации — ОДИН маршрут с вкладками внутри, как у остальных сервисов
    // организации (Сотрудники, Процессы, Офис): второй уровень сайдбара тут не заведён.
    { key: 'ws-drive', label: 'Диск', icon: 'drive', href: `${base}/drive` },
    // Документооборот — вся команда: внутренний контур (заявления, приказы) и
    // внешний (договоры с контрагентами); настройку внутри страницы закрывает роль.
    { key: 'ws-documents', label: 'Документооборот', icon: 'file', href: `${base}/documents` },
    // Контрагенты — справочник внешних сторон, стоит РЯДОМ со своим главным
    // потребителем (дальше его же читают Счета, Финансы B2B, ЭСФ).
    { key: 'ws-counterparties', label: 'Контрагенты', icon: 'workspace', href: `${base}/counterparties` },
  ];
  if (isManager) items.push({ key: 'ws-journal', label: 'Журнал', icon: 'journal', href: `${base}/journal` });
  if (isOwner) items.push({ key: 'ws-wallet', label: 'Кошелёк компании', icon: 'coins', href: `${base}/wallet` });

  return {
    contextLabel: workspaceName,
    groups: [{ key: 'ws', label: 'Организация', items }],
    footer: [{ key: 'ws-profile', label: 'Профиль организации', icon: 'workspace', href: `${base}/profile/card` }],
  };
}

/** Активен ли пункт для текущего адреса. */
export function isNavItemActive(item: Pick<AppNavItem, 'href' | 'exact'>, pathname: string): boolean {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/** Активна ли ветка (сам пункт или любой его раздел). */
export function isBranchActive(item: AppNavItem, pathname: string): boolean {
  if (isNavItemActive(item, pathname)) return true;
  return (item.children ?? []).some((c) => isNavItemActive(c, pathname));
}
