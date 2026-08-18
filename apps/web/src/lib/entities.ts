// ============================================================
// Entity registry — the data side of the universal EntitySelector
// (à la Bitrix UI.EntitySelector "providers" / Salesforce polymorphic lookup).
//
// A "principal" {type,id} is exactly what core/access understands
// (user | circle | department | position | branch | ...). Adding a new
// selectable type later = register a loader + a chip renderer; no UI rewrite.
// ============================================================

import { apiGet } from './api';
import type { Circle, Contact, CounterpartyDto, CursorPage, StaffDirectory, WorkspaceMember } from '@superapp/shared';

export interface Principal {
  type: string;
  id: string;
}

export interface EntityOption {
  type: string;
  id: string;
  title: string; // primary display text (for search + fallback)
  // user
  firstName?: string;
  lastName?: string | null;
  role?: string | null;
  // group (circle/department/branch…)
  icon?: string | null;
  color?: string | null;
  count?: number;
}

export const ENTITY_TYPE_LABELS: Record<string, string> = {
  user: 'Люди',
  circle: 'Группы',
  department: 'Отделы',
  position: 'Должности',
  branch: 'Филиалы',
  counterparty: 'Контрагенты',
};

/** Контекст загрузки: workspace-скоупные типы (отдел/должность/филиал) требуют организацию. */
export interface EntityLoadContext {
  workspaceId?: string;
}

// Simple per-type cache (lists are small; invalidate on demand). Key = type|workspaceId.
const cache = new Map<string, EntityOption[]>();

// Один HTTP-вызов справочников на организацию (3 staff-типа делят ответ /staff).
// Форма ответа — shared `StaffDirectory`: локальное сужение до 3-4 полей было
// ВТОРЫМ описанием одной ручки (соседний потребитель уже читал её как StaffDirectory).
const staffDirCache = new Map<string, Promise<StaffDirectory>>();

function fetchStaffDirectory(workspaceId: string): Promise<StaffDirectory> {
  if (!staffDirCache.has(workspaceId)) {
    staffDirCache.set(
      workspaceId,
      apiGet<StaffDirectory>(`/workspaces/${workspaceId}/staff`).catch((e) => {
        staffDirCache.delete(workspaceId); // не кэшируем ошибку
        throw e;
      }),
    );
  }
  return staffDirCache.get(workspaceId)!;
}

async function loadUsers(ctx?: EntityLoadContext): Promise<EntityOption[]> {
  // В контексте организации «Люди» = РОСТЕР этой организации (вся команда, ВКЛЮЧАЯ
  // СЕБЯ; Подрядчик изолирован), а не личное окружение: гранты шаблонов, подписанты
  // ЭДО, сторона документа и шеринг оргдиска адресуют СОТРУДНИКОВ. На личном
  // окружении здесь ломались оба края: «выдать себе» было невозможно (себя в своём
  // окружении нет по определению), сотрудник вне окружения в списке отсутствовал,
  // а человек ИЗ окружения, не работающий в организации, выбирался — и сервер
  // честно отвергал грант, что для человека выглядело как «ничего не работает».
  if (ctx?.workspaceId) return loadWorkspaceMembers(ctx.workspaceId);
  const acc: EntityOption[] = [];
  let cursor: string | undefined;
  do {
    const page = await apiGet<CursorPage<Contact>>('/contacts', {
      params: cursor ? { cursor } : undefined,
    });
    for (const c of page.items) {
      acc.push({
        type: 'user',
        id: c.them.id,
        title: `${c.them.firstName} ${c.them.lastName ?? ''}`.trim(),
        firstName: c.them.firstName,
        lastName: c.them.lastName,
        role: c.myRole,
      });
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return acc;
}

async function loadWorkspaceMembers(workspaceId: string): Promise<EntityOption[]> {
  const rows = await apiGet<WorkspaceMember[]>(`/workspaces/${workspaceId}/members`);
  return rows
    .filter((m) => m.role !== 'contractor')
    .map((m) => ({
      type: 'user',
      id: m.userId,
      title: m.userName,
      firstName: m.card?.firstName ?? m.userName,
      lastName: m.card?.lastName ?? null,
      // Подпись в пикере = Должность (принцип «роль организации на карте не видна»).
      role: [...new Set(m.assignments.map((a) => a.positionName))].join(', ') || null,
    }));
}

async function loadCircles(): Promise<EntityOption[]> {
  const rows = await apiGet<Circle[]>('/circles');
  return rows.map((g) => ({
    type: 'circle',
    id: g.id,
    title: g.name,
    icon: g.icon,
    color: g.color,
    count: g.membersCount,
  }));
}

// Workspace-скоупные типы оргструктуры (B2B «Сотрудники») — без workspaceId пустые.
async function loadDepartments(ctx?: EntityLoadContext): Promise<EntityOption[]> {
  if (!ctx?.workspaceId) return [];
  const dir = await fetchStaffDirectory(ctx.workspaceId);
  return dir.departments.map((d) => ({
    type: 'department',
    id: d.id,
    title: d.name,
    icon: 'workspace',
    count: d.membersCount,
  }));
}

async function loadPositions(ctx?: EntityLoadContext): Promise<EntityOption[]> {
  if (!ctx?.workspaceId) return [];
  const dir = await fetchStaffDirectory(ctx.workspaceId);
  return dir.positions.map((p) => ({
    type: 'position',
    id: p.id,
    title: p.departmentName ? `${p.name} · ${p.departmentName}` : p.name,
    icon: 'staff',
    count: p.holdersCount,
  }));
}

async function loadBranches(ctx?: EntityLoadContext): Promise<EntityOption[]> {
  if (!ctx?.workspaceId) return [];
  const dir = await fetchStaffDirectory(ctx.workspaceId);
  return dir.branches.map((b) => ({
    type: 'branch',
    id: b.id,
    title: b.name,
    icon: 'office',
    count: b.membersCount,
  }));
}

// Контрагенты — НЕ люди платформы: рисуются EntityChip (иконка организации),
// а не PersonChip. Workspace-скоупные, как оси оргструктуры.
async function loadCounterparties(ctx?: EntityLoadContext): Promise<EntityOption[]> {
  if (!ctx?.workspaceId) return [];
  const page = await apiGet<CursorPage<CounterpartyDto>>(`/workspaces/${ctx.workspaceId}/counterparties`, {
    params: { limit: 200 },
  });
  return page.items.map((c) => ({
    type: 'counterparty',
    id: c.id,
    title: c.bin ? `${c.name} · ${c.bin}` : c.name,
    icon: 'workspace',
    count: c.documentsCount,
  }));
}

const LOADERS: Record<string, (ctx?: EntityLoadContext) => Promise<EntityOption[]>> = {
  user: loadUsers,
  circle: loadCircles,
  department: loadDepartments,
  position: loadPositions,
  branch: loadBranches,
  counterparty: loadCounterparties,
};

const STAFF_TYPES = new Set(['department', 'position', 'branch']);

/** Load (and cache) all selectable options for an entity type (+ optional workspace ctx). */
export async function loadEntities(type: string, ctx?: EntityLoadContext): Promise<EntityOption[]> {
  const key = `${type}|${ctx?.workspaceId ?? ''}`;
  if (cache.has(key)) return cache.get(key)!;
  const loader = LOADERS[type];
  if (!loader) return [];
  const items = await loader(ctx);
  cache.set(key, items);
  return items;
}

/** Drop caches (e.g. after adding a contact / creating a group / editing справочники). */
export function invalidateEntities(type?: string) {
  if (type) {
    for (const k of [...cache.keys()]) if (k.startsWith(`${type}|`)) cache.delete(k);
    if (STAFF_TYPES.has(type)) staffDirCache.clear();
  } else {
    cache.clear();
    staffDirCache.clear();
  }
}
