// ============================================================
// core/audiences — формы провода адресата и контекста разворота
// ============================================================

import type { AudienceKind } from '../constants/audiences';

/** Адресат: вид + id (у относительных видов и `user` id может быть якорем `$initiator`/`$subject`/`$self`) */
export interface AudienceRef {
  type: AudienceKind;
  id: string;
}

/**
 * Контекст разворота. Якоря подставляются отсюда; `workspaceId` скоупит всё:
 * чужой отдел разворачивается в пусто, человек вне команды — в пусто.
 */
export interface AudienceContext {
  workspaceId: string | null;
  /** `$initiator` — кто запустил (автор заявки, инициатор процесса) */
  initiatorId?: string | null;
  /** `$subject` — сторона документа (работник в приказе) */
  subjectId?: string | null;
  /** `$self` — текущий пользователь */
  selfId?: string | null;
  /** Объект, в контексте которого считается вертикаль (иначе — основное место) */
  branchId?: string | null;
}

/** Подписанный адресат (для витрин: «Отдел «Продажи»», «Руководитель инициатора») */
export interface AudienceLabelDto {
  type: AudienceKind;
  id: string;
  label: string;
}
