const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * Управленческие разделы организации: настройки и реквизиты, состав и приглашения, структура
 * и штат, ключи и вебхуки, юрлица, политика уведомлений. Сюда НЕ входят: архив организации,
 * передача владения, выход (владелец, не согласный с новыми условиями, обязан иметь возможность
 * уйти или передать организацию) и вся повседневная работа (задачи, документы, чат, объекты).
 */
const MANAGEMENT_SECTIONS = ['requisites', 'members', 'invitations', 'staff', 'org', 'keys', 'webhooks', 'legal-entities', 'notification-policy'];
const BY_PATH = new RegExp(`/workspaces/(${UUID})(?:/(${MANAGEMENT_SECTIONS.join('|')})(?:/|$)|/?$)`, 'i');
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Организация, чьё УПРАВЛЕНИЕ меняет запрос, либо null. Мягкий шлюз согласий закрывает
 * владельцу только такие запросы; сотрудники и повседневная работа не затрагиваются никогда.
 */
export function workspaceManagementTarget(method: string | undefined, path: string | undefined, headerWorkspaceId: string | undefined): string | null {
  if (!method || !path || !MUTATING.has(method.toUpperCase())) return null;
  const clean = path.split('?')[0]!;
  const m = BY_PATH.exec(clean);
  if (m) {
    // DELETE /workspaces/:id — архив организации: остаётся доступным
    if (!m[2] && method.toUpperCase() === 'DELETE') return null;
    return m[1]!.toLowerCase();
  }
  // Тариф организации меняется запросом с заголовком контекста
  if (headerWorkspaceId && /\/entitlements(\/|$)/i.test(clean)) return headerWorkspaceId;
  return null;
}
