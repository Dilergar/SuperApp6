// ============================================================
// Entity registry — the data side of the universal EntitySelector
// (à la Bitrix UI.EntitySelector "providers" / Salesforce polymorphic lookup).
//
// A "principal" {type,id} is exactly what core/access understands
// (user | circle | department | position | branch | ...). Adding a new
// selectable type later = register a loader + a chip renderer; no UI rewrite.
// ============================================================

import { api } from './api';

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
};

/** Контекст загрузки: workspace-скоупные типы (отдел/должность/филиал) требуют организацию. */
export interface EntityLoadContext {
  workspaceId?: string;
}

// Simple per-type cache (lists are small; invalidate on demand). Key = type|workspaceId.
const cache = new Map<string, EntityOption[]>();

// Один HTTP-вызов справочников на организацию (3 staff-типа делят ответ /staff).
const staffDirCache = new Map<string, Promise<StaffDirectoryPayload>>();

interface StaffDirectoryPayload {
  departments: Array<{ id: string; name: string; membersCount?: number }>;
  positions: Array<{ id: string; name: string; departmentName?: string | null; holdersCount?: number }>;
  branches: Array<{ id: string; name: string; membersCount?: number }>;
}

function fetchStaffDirectory(workspaceId: string): Promise<StaffDirectoryPayload> {
  if (!staffDirCache.has(workspaceId)) {
    staffDirCache.set(
      workspaceId,
      api
        .get(`/workspaces/${workspaceId}/staff`)
        .then((r) => r.data.data as StaffDirectoryPayload)
        .catch((e) => {
          staffDirCache.delete(workspaceId); // не кэшируем ошибку
          throw e;
        }),
    );
  }
  return staffDirCache.get(workspaceId)!;
}

async function loadUsers(): Promise<EntityOption[]> {
  const acc: EntityOption[] = [];
  let cursor: string | undefined;
  do {
    const res = await api.get('/contacts', { params: cursor ? { cursor } : undefined });
    const rows = res.data.data as Array<{
      them: { id: string; firstName: string; lastName: string | null };
      myRole: string | null;
    }>;
    for (const c of rows) {
      acc.push({
        type: 'user',
        id: c.them.id,
        title: `${c.them.firstName} ${c.them.lastName ?? ''}`.trim(),
        firstName: c.them.firstName,
        lastName: c.them.lastName,
        role: c.myRole,
      });
    }
    cursor = res.data.nextCursor ?? undefined;
  } while (cursor);
  return acc;
}

async function loadCircles(): Promise<EntityOption[]> {
  const res = await api.get('/circles');
  const rows = res.data.data as Array<{ id: string; name: string; icon: string | null; color: string | null; membersCount?: number }>;
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
    icon: '🏛️',
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
    icon: '💼',
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
    icon: '📍',
    count: b.membersCount,
  }));
}

const LOADERS: Record<string, (ctx?: EntityLoadContext) => Promise<EntityOption[]>> = {
  user: loadUsers,
  circle: loadCircles,
  department: loadDepartments,
  position: loadPositions,
  branch: loadBranches,
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
