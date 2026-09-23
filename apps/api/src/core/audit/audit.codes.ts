import {
  AUDIT_ACTOR_KIND_CODE,
  AUDIT_CATEGORY_CODE,
  AUDIT_CLIENTS,
  AUDIT_OUTCOME_CODE,
  AUDIT_SEVERITIES,
  type AuditActorKind,
  type AuditCategory,
  type AuditClient,
  type AuditOutcome,
  type AuditSeverity,
} from '@superapp/shared';

// ============================================================
// core/audit — smallint-коды колонок ↔ словари shared. Чистый модуль без DI: его импортируют
// проекции прежних журналов в core/keys и core/platform, не замыкая цикл файлов
// (keys → audit.query → keys.envelope → keys.store → keys.audit).
// ============================================================

const invert = <T extends string>(codes: Record<T, number>): Map<number, T> => new Map(Object.entries(codes).map(([k, v]) => [v as number, k as T]));

const CATEGORY_OF = invert(AUDIT_CATEGORY_CODE);
const OUTCOME_OF = invert(AUDIT_OUTCOME_CODE);
const ACTOR_KIND_OF = invert(AUDIT_ACTOR_KIND_CODE);
const SEVERITY_OF = new Map<number, AuditSeverity>(AUDIT_SEVERITIES.map((s, i) => [i, s]));
const CLIENT_OF = new Map<number, AuditClient>(AUDIT_CLIENTS.map((c, i) => [i, c]));

export const auditCategoryOf = (code: number): AuditCategory | undefined => CATEGORY_OF.get(code);
export const auditOutcomeOf = (code: number): AuditOutcome => OUTCOME_OF.get(code) ?? 'unknown';
export const auditActorKindOf = (code: number): AuditActorKind => ACTOR_KIND_OF.get(code) ?? 'system';
export const auditSeverityOf = (code: number): AuditSeverity => SEVERITY_OF.get(code) ?? 'info';
/**
 * Детали, которые видит только платформа (служебные псевдонимы и снимки команд Кабинета): их
 * срезает КАЖДАЯ проекция не-платформы — лента человека и организации, журнал ключей, стрим в SIEM.
 */
export const AUDIT_PLATFORM_ONLY_DETAILS: ReadonlySet<string> = new Set(['targetHmac', 'input', 'inputHash', 'before', 'after', 'ticketRef']);

export const auditClientOf = (code: number | null | undefined): AuditClient | null => (code === null || code === undefined ? null : (CLIENT_OF.get(code) ?? null));
