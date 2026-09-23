import type { AuditEventDef, AuditOutcome, AuditSeverity } from './types';

// ============================================================
// OCSF 1.x — внешняя схема для SIEM (экспорт, стрим). Внутренняя схема своя
// (`security_events`), наружу уходит маппинг: SIEM клиента (Splunk, Sentinel, Elastic,
// QRadar) понимает OCSF без парсера под нас. Каждый ключ реестра объявляет класс и
// действие — маппер ниже собирает `class_uid/activity_id/type_uid/severity_id/status_id`.
// ============================================================

/** Классы OCSF, которыми пользуется реестр. */
export const OCSF_CLASS = {
  /** Findings */
  detectionFinding: 2004,
  /** Identity & Access Management */
  accountChange: 3001,
  authentication: 3002,
  authorizeSession: 3003,
  entityManagement: 3004,
  userAccessManagement: 3005,
  groupManagement: 3006,
  /** Application Activity */
  webResourcesActivity: 6001,
  apiActivity: 6003,
  datastoreActivity: 6005,
} as const;

/** Действия классов (activity_id). 99 — «прочее» у любого класса. */
export const OCSF_ACTIVITY = {
  authentication: { logon: 1, logoff: 2, authTicket: 3, preauth: 6, other: 99 },
  accountChange: { create: 1, enable: 2, passwordChange: 3, passwordReset: 4, disable: 5, delete: 6, attachPolicy: 7, detachPolicy: 8, lock: 9, unlock: 12, other: 99 },
  groupManagement: { assignPrivileges: 1, revokePrivileges: 2, addUser: 3, removeUser: 4, delete: 5, create: 6, other: 99 },
  userAccessManagement: { assignPrivileges: 1, revokePrivileges: 2 },
  entityManagement: { create: 1, read: 2, update: 3, delete: 4, enable: 8, disable: 9, activate: 10, deactivate: 11, suspend: 12, resume: 13, other: 99 },
  apiActivity: { create: 1, read: 2, update: 3, delete: 4, other: 99 },
  webResourcesActivity: { read: 2, search: 5, export: 7, share: 8, other: 99 },
  datastoreActivity: { read: 1 },
  detectionFinding: { create: 1, update: 2, close: 3 },
} as const;

/** Категория OCSF = старшая цифра класса. */
export const ocsfCategoryOf = (classUid: number): number => Math.floor(classUid / 1000);

const OCSF_SEVERITY: Record<AuditSeverity, number> = { info: 1, low: 2, medium: 3, high: 4, critical: 5 };
const OCSF_STATUS: Record<AuditOutcome, number> = { success: 1, failure: 2, denied: 2, unknown: 0 };

/** Поля события, нужные маппингу (DTO наружу — без IP, UA и имён людей). */
export interface OcsfSource {
  eventId: string;
  key: string;
  occurredAt: string;
  severity: AuditSeverity;
  outcome: AuditOutcome;
  reasonCode: string | null;
  actor: { kind: string; id: string | null };
  subjectUserId: string | null;
  workspaceId: string | null;
  target: { type: string; id: string } | null;
  country: string | null;
  deviceClass: string | null;
  client: string | null;
  requestId: string | null;
  details: Record<string, unknown>;
}

/** Событие в OCSF 1.x (подмножество полей, которое мы честно заполняем). */
export interface OcsfEvent {
  class_uid: number;
  category_uid: number;
  activity_id: number;
  type_uid: number;
  severity_id: number;
  status_id: number;
  status_code?: string;
  time: number;
  metadata: { uid: string; version: string; product: { name: string; vendor_name: string }; event_code: string; correlation_uid?: string };
  actor: { user?: { uid: string; type: string } };
  user?: { uid: string };
  src_endpoint?: { location?: { country: string }; type?: string };
  resources?: Array<{ type: string; uid: string }>;
  unmapped: Record<string, unknown>;
}

export const OCSF_VERSION = '1.3.0';

export function toOcsf(def: Pick<AuditEventDef, 'ocsf'>, e: OcsfSource): OcsfEvent {
  const classUid = def.ocsf.classUid;
  return {
    class_uid: classUid,
    category_uid: ocsfCategoryOf(classUid),
    activity_id: def.ocsf.activityId,
    type_uid: classUid * 100 + def.ocsf.activityId,
    severity_id: OCSF_SEVERITY[e.severity],
    status_id: OCSF_STATUS[e.outcome],
    ...(e.reasonCode ? { status_code: e.reasonCode } : {}),
    time: Date.parse(e.occurredAt),
    metadata: {
      uid: e.eventId,
      version: OCSF_VERSION,
      product: { name: 'SuperApp6', vendor_name: 'SuperApp6' },
      event_code: e.key,
      ...(e.requestId ? { correlation_uid: e.requestId } : {}),
    },
    actor: e.actor.id ? { user: { uid: e.actor.id, type: e.actor.kind } } : {},
    ...(e.subjectUserId ? { user: { uid: e.subjectUserId } } : {}),
    ...(e.country || e.deviceClass ? { src_endpoint: { ...(e.country ? { location: { country: e.country } } : {}), ...(e.deviceClass ? { type: e.deviceClass } : {}) } } : {}),
    ...(e.target ? { resources: [{ type: e.target.type, uid: e.target.id }] } : {}),
    unmapped: { workspace_id: e.workspaceId, client: e.client, details: e.details },
  };
}
