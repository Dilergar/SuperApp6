import type { DatabaseService } from '../../shared/database/database.service';

/**
 * Общие кирпичи резолверов `NotificationRefRegistry` (батчем, не check() в цикле).
 * Живут в движке, чтобы каждый владелец сущности не писал свой запрос членства.
 */

/** Кто из адресатов — действующий член организации. */
export async function workspaceMembersOf(db: DatabaseService, workspaceId: string, userIds: string[]): Promise<string[]> {
  if (!userIds.length) return [];
  const rows = await db.userRole.findMany({
    where: { userId: { in: userIds }, context: 'workspace', tenantId: workspaceId, isActive: true },
    select: { userId: true },
  });
  return [...new Set(rows.map((r) => r.userId))];
}

/** Адресаты, входящие в явный список (стороны заказа, участники события, ждущие решения). */
export function intersect(userIds: string[], allowed: Iterable<string>): string[] {
  const set = new Set(allowed);
  return userIds.filter((id) => set.has(id));
}
