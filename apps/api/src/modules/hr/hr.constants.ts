// ============================================================
// КЭДО (modules/hr) — внутренние константы модуля.
// ============================================================

import { ForbiddenException } from '@nestjs/common';
import { WORKSPACE_ROLE_RANK, type WorkspaceRole } from '@superapp/shared';

/**
 * refType хроники СТРАНИЦЫ ЧЕЛОВЕКА: `<workspaceId>:<userId>`.
 * workspaceId на записи заполнен → та же запись видна в «Журнале организации»
 * фильтром «Кадры» (журнал читает по workspaceId + категории, refType ему не важен).
 */
export const HR_MEMBER_REF_TYPE = 'hr_member';

export function hrMemberRefId(workspaceId: string, userId: string): string {
  return `${workspaceId}:${userId}`;
}

/** Джоб применения кадрового действия в дату вступления в силу (runAt = effectiveAt) */
export const HR_APPLY_JOB = 'hr.action.apply';
/** Джоб исполнения массовой операции (пачка действий) */
export const HR_BATCH_JOB = 'hr.batch.run';
/** Своя очередь: применение ходит в чужие сервисы и не должно подпирать default */
export const HR_QUEUE = 'hr';

/**
 * Кадровое действие/правка трудовой карточки по человеку с РАВНОЙ ИЛИ БОЛЕЕ
 * ВЫСОКОЙ ролью — запрещено (кроме Владельца, который вправе всё). Та же
 * лестница, что у ролей организации: админа снимает только Владелец, менеджер
 * не трогает админов. Без этого правила Менеджер оформлял увольнение
 * Владельцу — приказ, очередь ЕСУТД и «уволен» в трудовой карточке появлялись
 * по-настоящему, хотя членство снять он не вправе нигде больше.
 */
export function assertCanManageHrSubject(
  actorRole: WorkspaceRole,
  subjectRole: WorkspaceRole,
  what = 'кадровые действия',
): void {
  if (actorRole === 'owner') return;
  if ((WORKSPACE_ROLE_RANK[subjectRole] ?? 0) >= (WORKSPACE_ROLE_RANK[actorRole] ?? 0)) {
    throw new ForbiddenException(
      `Нельзя вести ${what} по сотруднику с равной или более высокой ролью в организации — это делает Владелец`,
    );
  }
}

/** Может ли актор вести кадровые дела по субъекту (не бросающая версия — для фильтров аудитории) */
export function canManageHrSubject(actorRole: WorkspaceRole, subjectRole: WorkspaceRole): boolean {
  if (actorRole === 'owner') return true;
  return (WORKSPACE_ROLE_RANK[subjectRole] ?? 0) < (WORKSPACE_ROLE_RANK[actorRole] ?? 0);
}
