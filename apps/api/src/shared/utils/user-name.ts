import { isDeletedUserMarker } from '@superapp/i18n';

type NameParts = { firstName: string; lastName: string | null };
/** Строка пользователя может нести «надгробие» удалённого аккаунта */
type MaybeDeleted = NameParts & { deletedAt?: Date | null };

/**
 * Имя человека из строки пользователя. Единственный источник правды — сервисы
 * когда-то держали по своей копии.
 *
 * Строки НЕТ (аккаунт удалён, связь пустая) → `null`, а НЕ слово-заглушка. Слово
 * («Кто-то») — это текст продукта, и его даёт КАТАЛОГ в языке того, кто читает:
 *   - витрина: `fullNameOrNull(u) ?? this.i18n.translate('common.labels.someone')`;
 *   - вечная запись: `null` в колонку снимка (рендер подставит слово при чтении)
 *     либо `<имя>Key: 'common.labels.someone'` в payload (docs/i18n.md).
 * Запечённое в базу «Someone» осталось бы английским у казахоязычного читателя
 * навсегда — миграции для этого не существует.
 */
export function fullNameOrNull(u: MaybeDeleted | null | undefined): string | null {
  if (!u) return null;
  // Аккаунт удалён: в колонке лежит «надгробие» в языке ИСТОЧНИКА (PII вычищено).
  // Наружу отдаём null — слово («Удалённый пользователь») подставит каталог в языке
  // того, кто смотрит.
  // Без `deletedAt` в выборке надгробие узнаётся по маркеру томбстоуна (core/lifecycle)
  if (u.deletedAt || isDeletedUserMarker(u.firstName, u.lastName)) return null;
  return [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.firstName || null;
}

/**
 * Имя человека, который ТОЧНО есть (обязательная связь). Пустая строка вместо
 * заглушки: слово вместо имени — работа каталога, а не этой функции.
 */
export function fullName(u: NameParts): string {
  return fullNameOrNull(u) ?? '';
}
