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
  /**
   * Ключ каталога в неймспейсе `shell` (`nav.tasks`), а не готовая строка.
   * Реестр называет ПУНКТ, каталог даёт ему имя на языке зрителя — тот же
   * приём, что `icon: 'tasks'`.
   */
  labelKey: string;
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
  labelKey?: string;
  items: AppNavItem[];
}

export interface AppNavConfig {
  /**
   * Что показывает переключатель контекста. У организации это ДАННЫЕ (её имя —
   * его не переводят), у личного контекста — ключ каталога: ровно поэтому поля
   * два, а не одно с «иногда ключом».
   */
  contextLabel?: string;
  contextLabelKey?: string;
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
    contextLabelKey: 'context.personal',
    groups: [
      {
        key: 'main',
        labelKey: 'group.main',
        items: [
          { key: 'dashboard', labelKey: 'nav.dashboard', icon: 'home', href: '/dashboard', exact: true },
          { key: 'circles', labelKey: 'nav.circles', icon: 'circle', href: '/circles' },
          { key: 'messenger', labelKey: 'nav.messenger', icon: 'messenger', href: '/messenger', badge: c.messenger },
          { key: 'notes', labelKey: 'nav.notes', icon: 'notes', href: '/notes' },
        ],
      },
      {
        key: 'work',
        labelKey: 'group.work',
        items: [
          {
            key: 'tasks',
            labelKey: 'nav.tasks',
            icon: 'tasks',
            href: '/tasks',
            badge: c.tasksInbox,
            children: [
              { key: 'tasks-overview', labelKey: 'nav.tasksOverview', icon: 'dashboard', href: '/tasks', exact: true },
              { key: 'tasks-inbox', labelKey: 'nav.tasksInbox', icon: 'empty', href: '/tasks/inbox', badge: c.tasksInbox },
              { key: 'tasks-today', labelKey: 'nav.tasksToday', icon: 'sun', href: '/tasks/today', badge: c.tasksToday },
              { key: 'tasks-overdue', labelKey: 'nav.tasksOverdue', icon: 'overdue', href: '/tasks/overdue' },
              { key: 'tasks-upcoming', labelKey: 'nav.tasksUpcoming', icon: 'clock', href: '/tasks/upcoming' },
              { key: 'tasks-assigned', labelKey: 'nav.tasksAssigned', icon: 'target', href: '/tasks/assigned' },
              { key: 'tasks-delegated', labelKey: 'nav.tasksDelegated', icon: 'handshake', href: '/tasks/delegated' },
              { key: 'tasks-review', labelKey: 'nav.tasksReview', icon: 'eye', href: '/tasks/review', badge: c.tasksReview },
              { key: 'tasks-all', labelKey: 'nav.tasksAll', icon: 'list', href: '/tasks/all' },
              { key: 'tasks-done', labelKey: 'nav.tasksDone', icon: 'check', href: '/tasks/done' },
            ],
          },
          { key: 'calendar', labelKey: 'nav.calendar', icon: 'calendar', href: '/calendar' },
          {
            key: 'finance',
            labelKey: 'nav.finance',
            icon: 'finance',
            href: '/finance',
            children: [
              { key: 'fin-overview', labelKey: 'nav.finOverview', icon: 'dashboard', href: '/finance', exact: true },
              { key: 'fin-feed', labelKey: 'nav.finFeed', icon: 'list', href: '/finance/feed' },
              { key: 'fin-reports', labelKey: 'nav.finReports', icon: 'chart', href: '/finance/reports' },
              { key: 'fin-coins', labelKey: 'nav.finCoins', icon: 'coins', href: '/finance/coins' },
              { key: 'fin-accounts', labelKey: 'nav.finAccounts', icon: 'card', href: '/finance/accounts' },
              { key: 'fin-categories', labelKey: 'nav.finCategories', icon: 'folder', href: '/finance/categories' },
              { key: 'fin-people', labelKey: 'nav.finPeople', icon: 'people', href: '/finance/people' },
              { key: 'fin-debts', labelKey: 'nav.finDebts', icon: 'debt', href: '/finance/debts' },
              { key: 'fin-recurring', labelKey: 'nav.finRecurring', icon: 'refresh', href: '/finance/recurring' },
            ],
          },
          {
            key: 'drive',
            labelKey: 'nav.drive',
            icon: 'drive',
            href: '/drive',
            children: [
              { key: 'drive-my', labelKey: 'nav.driveMy', icon: 'folder', href: '/drive', exact: true },
              { key: 'drive-photos', labelKey: 'nav.drivePhotos', icon: 'image', href: '/drive/photos' },
              { key: 'drive-shared', labelKey: 'nav.driveShared', icon: 'share', href: '/drive/shared' },
              { key: 'drive-starred', labelKey: 'nav.driveStarred', icon: 'star', href: '/drive/starred' },
              { key: 'drive-recent', labelKey: 'nav.driveRecent', icon: 'clock', href: '/drive/recent' },
              { key: 'drive-trash', labelKey: 'nav.driveTrash', icon: 'delete', href: '/drive/trash' },
            ],
          },
          { key: 'shop', labelKey: 'nav.shop', icon: 'shop', href: '/shop' },
          // КЭДО: личный архив кадровых документов — бессрочный, переживает
          // увольнение и закрытие компании (PersonalDocRecord)
          { key: 'my-documents', labelKey: 'nav.myDocuments', icon: 'file', href: '/my-documents' },
          { key: 'recorder', labelKey: 'nav.recorder', icon: 'recorder', href: '/recorder' },
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
  /** Ботов, ждущих решения владельца (core/keys) — бейдж на «Интеграции и ключи» */
  keysPending?: number;
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
    { key: 'ws-home', labelKey: 'nav.wsHome', icon: 'home', href: base, exact: true },
    // «Сотрудники» — ЕДИНСТВЕННЫЙ сервис организации со вторым уровнем сайдбара
    // (Диску, Процессам, Офису его не заводили намеренно — у них один маршрут с
    // вкладками). Отклонение осознанное: здесь пять разделов, один из которых —
    // полноэкранный канвас оргструктуры, и вкладками на одной странице (1359 строк)
    // это уже не жило. Бейдж = «Кадровые сроки» КЭДО (manager+): несданное в ЕСУТД,
    // вручения, расчёты — теперь на своём разделе.
    {
      key: 'ws-members',
      labelKey: 'nav.wsMembers',
      icon: 'staff',
      href: `${base}/members`,
      badge: c.hrDeadlines,
      children: [
        { key: 'ws-members-people', labelKey: 'nav.wsMembersPeople', icon: 'people', href: `${base}/members`, exact: true },
        { key: 'ws-members-org', labelKey: 'nav.wsMembersOrg', icon: 'department', href: `${base}/members/org` },
        ...(isManager
          ? [
              { key: 'ws-members-invites', labelKey: 'nav.wsMembersInvites', icon: 'userAdd' as IconName, href: `${base}/members/invitations` },
              { key: 'ws-members-deadlines', labelKey: 'nav.wsMembersDeadlines', icon: 'clock' as IconName, href: `${base}/members/deadlines`, badge: c.hrDeadlines },
            ]
          : []),
      ],
    },
    // Объекты — физические площадки сети: дерево, штатное расписание, график смен
    // и оборудование. Видят ВСЕ сотрудники (каждый — свои объекты); деньги внутри
    // закрыты правом branch.payroll.view.
    { key: 'ws-objects', labelKey: 'nav.wsObjects', icon: 'storefront', href: `${base}/objects` },
    // Заметки организации — приватные по умолчанию, шеринг людям/отделам/всей команде;
    // слой стикеров открывается Alt+N на любой странице организации.
    { key: 'ws-notes', labelKey: 'nav.wsNotes', icon: 'notes', href: `${base}/notes` },
    { key: 'ws-processes', labelKey: 'nav.wsProcesses', icon: 'processes', href: `${base}/processes` },
    { key: 'ws-office', labelKey: 'nav.wsOffice', icon: 'office', href: `${base}/office` },
    // Диск организации — ОДИН маршрут с вкладками внутри, как у остальных сервисов
    // организации (Сотрудники, Процессы, Офис): второй уровень сайдбара тут не заведён.
    { key: 'ws-drive', labelKey: 'nav.wsDrive', icon: 'drive', href: `${base}/drive` },
    // Документооборот — вся команда: внутренний контур (заявления, приказы) и
    // внешний (договоры с контрагентами); настройку внутри страницы закрывает роль.
    { key: 'ws-documents', labelKey: 'nav.wsDocuments', icon: 'file', href: `${base}/documents` },
    // Контрагенты — справочник внешних сторон, стоит РЯДОМ со своим главным
    // потребителем (дальше его же читают Счета, Финансы B2B, ЭСФ).
    { key: 'ws-counterparties', labelKey: 'nav.wsCounterparties', icon: 'workspace', href: `${base}/counterparties` },
  ];
  if (isManager) items.push({ key: 'ws-journal', labelKey: 'nav.wsJournal', icon: 'journal', href: `${base}/journal` });
  // Ключи и интеграции — только владелец и админы (решение грилла core/keys №11): остальным раздела нет
  if (rank >= 4) items.push({ key: 'ws-integrations', labelKey: 'nav.wsIntegrations', icon: 'plug', href: `${base}/integrations`, badge: c.keysPending });
  if (isOwner) items.push({ key: 'ws-wallet', labelKey: 'nav.wsWallet', icon: 'coins', href: `${base}/wallet` });

  return {
    contextLabel: workspaceName,
    groups: [{ key: 'ws', labelKey: 'group.organization', items }],
    footer: [{ key: 'ws-profile', labelKey: 'nav.wsProfile', icon: 'workspace', href: `${base}/profile/card` }],
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

/**
 * Рабочие столы, где полотно важнее меню (Заметки): каркас входит в них со СВЁРНУТЫМ
 * сайдбаром, а человек при желании разворачивает его руками — на этот визит. Личная
 * настройка (cookie `SIDEBAR_COOKIE`) не трогается: в остальных сервисах меню как было,
 * а следующий вход в рабочий стол снова сворачивает его.
 */
const RAIL_ROUTES = [/^\/notes(\/|$)/, /^\/workspaces\/[^/]+\/notes(\/|$)/];
export function prefersRail(pathname: string): boolean {
  return RAIL_ROUTES.some((re) => re.test(pathname));
}
