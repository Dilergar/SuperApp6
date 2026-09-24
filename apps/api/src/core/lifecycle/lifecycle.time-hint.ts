import { uuidVersion, uuidv7Time } from '@superapp/shared';

/**
 * Подсказка времени для поиска по одному id в таблице, партиционированной по времени
 * создания: у UUIDv7 время — в самом id, окно ± `slackMs` вокруг него сужает поиск до одной
 * партиции (без подсказки планировщик открывает все). Для id другой версии — null: ищем
 * по всем партициям. Колонка времени строки обязана ставиться из того же момента, что и id
 * (или хотя бы в пределах окна).
 */
export function idTimeHint(id: string, slackMs = 3_600_000): { gte: Date; lt: Date } | null {
  if (uuidVersion(id) !== 7) return null;
  const t = uuidv7Time(id);
  if (!t) return null;
  return { gte: new Date(t.getTime() - slackMs), lt: new Date(t.getTime() + slackMs) };
}

/** `where` Prisma для строки партиционированной таблицы по id: id + окно времени, если оно есть. */
export function byIdWithTimeHint(id: string): { id: string; createdAt?: { gte: Date; lt: Date } } {
  const hint = idTimeHint(id);
  return hint ? { id, createdAt: hint } : { id };
}
