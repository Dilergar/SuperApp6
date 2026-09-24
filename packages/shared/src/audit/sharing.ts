import { z } from 'zod';
import { OCSF_ACTIVITY as A, OCSF_CLASS as C } from './ocsf';
import {
  AUDIT_LINK_FIELDS,
  AUDIT_LINK_REVOKE_REASONS,
  AUDIT_SHARE_RESOURCES,
  AUDIT_VIS,
  defineAuditEvents,
  detailCode,
  detailCount,
  detailId,
} from './types';

// ============================================================
// Доступы: кто открыл данные ОРГАНИЗАЦИИ коллеге/отделу и кто раздал их наружу ссылкой
// ============================================================
// Внутри организации доступ дают только её сотрудникам и её осям (вся команда, отдел,
// должность, филиал) — наружу так данные не уходят; журнал отвечает админу на вопрос «кто
// кому что открыл» (Google Workspace Drive audit, Microsoft 365 SharingSet). Личный шеринг
// журналом не ведётся — это история объекта. Публичная ссылка (доступ без аккаунта) — дверь
// НАРУЖУ: её жизнь и атаки на неё пишутся всегда; каждое открытие — в журнале визитов самой
// ссылки (`ShareLinkVisit`), здесь не дублируется. Видимость «организация» действует, когда
// объект принадлежит организации (`workspace_id` задан); личная ссылка видна только платформе —
// человек видит её учёт `pd.publication` и раздел «Мои ссылки».

const resource = z.enum(AUDIT_SHARE_RESOURCES);
/** Уровень доступа (viewer · editor · manager · use …) — код объекта, не роль организации */
const access = detailCode(24);
/** Кому открыто: человек или ось организации (workspace · department · position · branch …) */
const principal = { principalType: detailCode(24), principalId: detailCode(64) };

export const SHARING_AUDIT_EVENTS = defineAuditEvents({
  /**
   * Доступ открыт или изменён: `previousAccess` — прежний уровень, `none` — доступа не было
   * (поле обязательно: фраза выбирает «открыт/изменён» по нему, а пропущенный аргумент
   * уронил бы её в языке зрителя)
   */
  'sharing.access.granted': {
    category: 'sharing',
    severity: 'medium',
    visibility: AUDIT_VIS.workspace,
    details: z.object({ resource, access, previousAccess: access, ...principal }).strict(),
    vocab: 'privilege_permissions_changed',
    ocsf: { classUid: C.userAccessManagement, activityId: A.userAccessManagement.assignPrivileges },
    subjectFrom: 'actor',
  },
  'sharing.access.revoked': {
    category: 'sharing',
    severity: 'low',
    visibility: AUDIT_VIS.workspace,
    details: z.object({ resource, ...principal }).strict(),
    vocab: 'privilege_permissions_changed',
    ocsf: { classUid: C.userAccessManagement, activityId: A.userAccessManagement.revokePrivileges },
    subjectFrom: 'actor',
  },
  /** Публичная ссылка создана: чем закрыта (код доступа, подтверждение личности), срок, потолок открытий */
  'sharing.link.created': {
    category: 'sharing',
    severity: 'medium',
    visibility: AUDIT_VIS.workspace,
    details: z
      .object({
        resource: detailCode(32),
        passcode: z.boolean(),
        identity: z.boolean(),
        expires: z.boolean(),
        maxOpens: detailCount().optional(),
        download: z.boolean(),
      })
      .strict(),
    vocab: 'privilege_permissions_changed',
    ocsf: { classUid: C.webResourcesActivity, activityId: A.webResourcesActivity.share },
    subjectFrom: 'actor',
  },
  /** Настройки ссылки изменены — только коды изменённых полей */
  'sharing.link.updated': {
    category: 'sharing',
    severity: 'low',
    visibility: AUDIT_VIS.workspace,
    details: z.object({ resource: detailCode(32), fields: z.array(z.enum(AUDIT_LINK_FIELDS)).min(1).max(AUDIT_LINK_FIELDS.length) }).strict(),
    vocab: 'privilege_permissions_changed',
    ocsf: { classUid: C.webResourcesActivity, activityId: A.webResourcesActivity.share },
    subjectFrom: 'actor',
  },
  /** Ссылка закрыта: сам автор, «закрыть мои», админ организации массово, система (объект удалён) */
  'sharing.link.revoked': {
    category: 'sharing',
    severity: 'low',
    visibility: AUDIT_VIS.workspace,
    details: z.object({ resource: detailCode(32), reason: z.enum(AUDIT_LINK_REVOKE_REASONS) }).strict(),
    vocab: 'privilege_permissions_changed',
    ocsf: { classUid: C.webResourcesActivity, activityId: A.webResourcesActivity.share },
  },
  /**
   * Подбор кода доступа к ссылке упёрся в блок — автор узнаёт сразу (сменить код или закрыть
   * ссылку). Одна строка на залп: пишет тот, кто перевёл ссылку в блок.
   */
  'sharing.link.password_locked': {
    category: 'sharing',
    severity: 'high',
    visibility: AUDIT_VIS.both,
    notify: 'security.link.passwordLocked',
    details: z.object({ resource: detailCode(32), attempts: detailCount(), minutes: detailCount() }).strict(),
    vocab: 'authn_login_lock',
    ocsf: { classUid: C.authentication, activityId: A.authentication.logon },
  },
  /** Новый гость с подтверждённым номером впервые открыл ссылку (кто из внешних видел данные) */
  'sharing.link.guest_verified': {
    category: 'sharing',
    severity: 'medium',
    visibility: AUDIT_VIS.workspace,
    details: z.object({ resource: detailCode(32), guestId: detailId() }).strict(),
    vocab: 'sensitive_read',
    ocsf: { classUid: C.webResourcesActivity, activityId: A.webResourcesActivity.read },
  },
});
