// ============================================================
// Реестр сайдбар-навигации сервисов (Принцип 1: переиспользуемый движок).
//
// Модель — как lib/entities.ts: центральный реестр, новый сервис = +1 билдер
// конфига. Конфиг кормит <ServiceShell/> (components/shell/ServiceShell.tsx):
// верхняя полоска + левый сайдбар с группами-секциями, сворачиванием в
// icon-рейл, флайаутами и мобильным drawer'ом.
//
// Правила (бенчмарки NN/g / shadcn / Notion / Jira):
// - максимум 2 уровня (item.children — один вложенный уровень, не глубже);
// - у каждого пункта иконка (эмодзи, конвенция приложения) + подпись;
// - группы с заголовками-секциями; активный пункт определяется по pathname.
// ============================================================

/**
 * Cookie состояния сайдбара (expanded|collapsed). Живёт здесь (модуль без
 * 'use client'), чтобы её могли читать и сервер-layout'ы (первый рендер сразу
 * в правильном виде, без «прыжка»), и клиентский ServiceShell.
 */
export const SIDEBAR_COOKIE = 'sa6_sidebar';

export interface ServiceNavItem {
  key: string;
  label: string;
  /** Эмодзи-иконка (в свёрнутом рейле остаётся только она + тултип). */
  icon: string;
  href: string;
  /** true — активен только при точном совпадении pathname (для index-роута). */
  exact?: boolean;
  /** Второй уровень (максимум — правило «не глубже 2»). */
  children?: ServiceNavItem[];
  /**
   * Счётчик-пилюля справа от подписи (модель Bitrix24/Slack: «требует внимания»).
   * undefined/0 — не рендерится; билдеры передают число только когда оно > 0.
   */
  badge?: number | string;
}

export interface ServiceNavGroup {
  key: string;
  /** Заголовок-секция (UPPERCASE в UI). Без label — просто блок с отступом. */
  label?: string;
  items: ServiceNavItem[];
}

export interface ServiceNavConfig {
  serviceKey: string;
  /** Имя сервиса в верхней полоске. */
  title: string;
  icon: string;
  /** Главная сервиса (клик по иконке в рейле). */
  homeHref: string;
  groups: ServiceNavGroup[];
  /**
   * Query-параметры, которые сайдбар переносит между разделами
   * (например ?book= у Финансов — контекст «чью книгу смотрю»).
   */
  preserveParams?: string[];
}

// ------------------------------------------------------------
// Финансы (B2C) — первый потребитель каркаса
// ------------------------------------------------------------

export function buildFinanceNav(ctx: ServiceNavContexts['finance']): ServiceNavConfig {
  return {
    serviceKey: 'finance',
    title: 'Финансы',
    icon: '💰',
    homeHref: '/finance',
    preserveParams: ['book'],
    groups: [
      {
        key: 'overview',
        label: 'Обзор',
        items: [
          { key: 'home', label: 'Обзор', icon: '📊', href: '/finance', exact: true },
          { key: 'feed', label: 'Лента', icon: '🧾', href: '/finance/feed' },
          { key: 'reports', label: 'Отчёты', icon: '📈', href: '/finance/reports' },
          // Коины — только в своей книге (экосистемная лента не шерится)
          ...(ctx.isOwnBook ? [{ key: 'coins', label: 'Коины', icon: '🪙', href: '/finance/coins' }] : []),
        ],
      },
      {
        key: 'data',
        label: 'Данные',
        items: [
          { key: 'accounts', label: 'Счета', icon: '💼', href: '/finance/accounts' },
          { key: 'categories', label: 'Категории', icon: '🏷️', href: '/finance/categories' },
          { key: 'people', label: 'Близкие', icon: '👥', href: '/finance/people' },
        ],
      },
      {
        key: 'planning',
        label: 'Планирование',
        items: [
          { key: 'debts', label: 'Долги', icon: '💳', href: '/finance/debts' },
          { key: 'recurring', label: 'Повторы', icon: '🔁', href: '/finance/recurring' },
        ],
      },
    ],
  };
}

// ------------------------------------------------------------
// Задачи (B2C) — смарт-листы как разделы (Todoist/Things-модель),
// счётчики-бейджи (Bitrix24), «Календарь» — пункт-ссылка на соседний сервис.
// ------------------------------------------------------------

/** Бейдж: показываем только положительные числа (0 = чисто, пилюли нет). */
function navBadge(v: number | undefined): number | undefined {
  return v && v > 0 ? v : undefined;
}

export function buildTasksNav(ctx: ServiceNavContexts['tasks']): ServiceNavConfig {
  const s = ctx.stats;
  return {
    serviceKey: 'tasks',
    title: 'Задачи',
    icon: '🗒️',
    homeHref: '/tasks',
    groups: [
      {
        key: 'main',
        items: [
          { key: 'home', label: 'Обзор', icon: '📊', href: '/tasks', exact: true },
          { key: 'inbox', label: 'Входящие', icon: '📥', href: '/tasks/inbox', badge: navBadge(s?.inbox) },
          { key: 'today', label: 'Сегодня', icon: '☀️', href: '/tasks/today', badge: navBadge(s?.today) },
          { key: 'overdue', label: 'Просроченные', icon: '⏰', href: '/tasks/overdue', badge: navBadge(s?.overdue) },
          { key: 'upcoming', label: 'Предстоящие', icon: '📅', href: '/tasks/upcoming' },
          // Соседний сервис: быстрый переход в календарь (там слой задач + планнер).
          { key: 'calendar', label: 'Календарь', icon: '🗓️', href: '/calendar' },
        ],
      },
      {
        key: 'assignments',
        label: 'Поручения',
        items: [
          { key: 'assigned', label: 'Мне поставили', icon: '🎯', href: '/tasks/assigned', badge: navBadge(s?.assignedToMe) },
          { key: 'delegated', label: 'Я поставил', icon: '📤', href: '/tasks/delegated' },
          { key: 'review', label: 'На проверке', icon: '🔍', href: '/tasks/review', badge: navBadge(s?.onReview) },
        ],
      },
      {
        key: 'lists',
        label: 'Списки',
        items: [
          { key: 'all', label: 'Все задачи', icon: '🗂️', href: '/tasks/all' },
          { key: 'done', label: 'Выполненные', icon: '✅', href: '/tasks/done' },
        ],
      },
    ],
  };
}

// ------------------------------------------------------------
// Центральный реестр: сервис → билдер конфига (как LOADERS в entities.ts).
// Новый сервис = ключ в ServiceNavContexts + запись в SERVICE_NAV; шеллы
// резолвят конфиг через getServiceNav — типобезопасно по ключу сервиса.
// ------------------------------------------------------------

/** Контекст гейтинга пунктов на сервис (какие права/режимы влияют на меню). */
export interface ServiceNavContexts {
  finance: { isOwnBook: boolean };
  /** Счётчики смарт-листов кормят бейджи; null/undefined — бейджей нет (ещё грузятся). */
  tasks: { stats?: import('@superapp/shared').TaskStats | null };
}

export const SERVICE_NAV: { [K in keyof ServiceNavContexts]: (ctx: ServiceNavContexts[K]) => ServiceNavConfig } = {
  finance: buildFinanceNav,
  tasks: buildTasksNav,
};

export function getServiceNav<K extends keyof ServiceNavContexts>(
  service: K,
  ctx: ServiceNavContexts[K],
): ServiceNavConfig {
  return SERVICE_NAV[service](ctx);
}
