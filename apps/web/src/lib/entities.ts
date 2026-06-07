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

// Simple per-type cache (lists are small; invalidate on demand).
const cache = new Map<string, EntityOption[]>();

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

const LOADERS: Record<string, () => Promise<EntityOption[]>> = {
  user: loadUsers,
  circle: loadCircles,
  // department/position/branch — register when the B2B «Сотрудники» service lands.
};

/** Load (and cache) all selectable options for an entity type. */
export async function loadEntities(type: string): Promise<EntityOption[]> {
  if (cache.has(type)) return cache.get(type)!;
  const loader = LOADERS[type];
  if (!loader) return [];
  const items = await loader();
  cache.set(type, items);
  return items;
}

/** Drop caches (e.g. after adding a contact / creating a group). */
export function invalidateEntities(type?: string) {
  if (type) cache.delete(type);
  else cache.clear();
}
