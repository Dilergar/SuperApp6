import type { NoteRelatedRefInput, NoteSpaceRef } from '@superapp/shared';

// ============================================================
// Контекст адреса для Заметок: какое пространство активно (личное / организация) и
// к какой сущности авто-привязать стикер, созданный на её карточке (Quick Note-паттерн).
// Правило каркаса: адрес обязан нести организацию (`/workspaces/[id]/…`).
// ============================================================

const UUID = '[0-9a-fA-F-]{36}';

export function noteScopeFromPath(pathname: string): NoteSpaceRef {
  const m = new RegExp(`^/workspaces/(${UUID})(?:/|$)`).exec(pathname);
  return m ? { workspaceId: m[1] } : {};
}

export function noteTargetFromPath(pathname: string, search?: string): NoteRelatedRefInput | null {
  let m = new RegExp(`^/tasks/(${UUID})(?:/|$)`).exec(pathname);
  if (m) return { targetType: 'task', targetId: m[1] };
  m = new RegExp(`^/workspaces/${UUID}/objects/(${UUID})(?:/|$)`).exec(pathname);
  if (m) return { targetType: 'branch', targetId: m[1] };
  m = new RegExp(`^/workspaces/${UUID}/documents/(${UUID})(?:/|$)`).exec(pathname);
  if (m) return { targetType: 'document', targetId: m[1] };
  if (new RegExp(`^/workspaces/${UUID}/counterparties/?$`).test(pathname) && search) {
    const open = new URLSearchParams(search).get('open');
    if (open && new RegExp(`^${UUID}$`).test(open)) return { targetType: 'counterparty', targetId: open };
  }
  return null;
}

/** Слой стикеров не живёт на гостевых и auth-страницах */
export function isNotesLayerAllowed(pathname: string): boolean {
  return !/^\/(login|register|reset-password|check|s|dev)(\/|$)/.test(pathname);
}
