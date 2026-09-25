import { DELETED_USER_MARKER } from './person-marker.generated';
import type { Translator } from './translator';

// ============================================================
// Томбстоун стёртого человека (core/lifecycle) — лёгкий модуль без каталогов
// ============================================================
// Имя стёртого в базе — метка «удалённый пользователь» на языке ИСТОЧНИКА, одна на всех: это
// МАРКЕР, а не текст. Зритель видит метку на своём языке (render-at-read). Модуль уходит в
// браузер (подпуть `./person-marker`) и в рендер хроники — каталогов он не тянет.

export { DELETED_USER_MARKER };

/** Имя (имя + фамилия) — маркер томбстоуна: фамилии у стёртого нет. */
export function isDeletedUserMarker(firstName: string | null | undefined, lastName?: string | null): boolean {
  return (firstName ?? '').trim() === DELETED_USER_MARKER && !(lastName ?? '').trim();
}

/** Снимок имени для показа: маркер томбстоуна → метка на языке зрителя, иначе как есть. */
export function localizePersonSnapshot(t: Translator, name: string): string {
  return name.trim() === DELETED_USER_MARKER ? t('common.labels.deletedUser') : name;
}
