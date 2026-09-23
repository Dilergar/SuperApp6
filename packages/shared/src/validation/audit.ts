import { z } from 'zod';
import {
  AUDIT_ACTOR_KINDS,
  AUDIT_ALERT_RESOLUTIONS,
  AUDIT_CATEGORIES,
  AUDIT_EXPORT_FORMATS,
  AUDIT_LIMITS,
  AUDIT_OUTCOMES,
} from '../audit/types';
import { AUDIT_ORG_FILTERS, AUDIT_PERSON_FILTERS } from '../audit';
import { phoneSchema } from './auth';

// ============================================================
// core/audit — входы API (Zod) для человека, организации и Кабинета
// ============================================================

const uuid = z.string().uuid();
/** id события — bigint строкой (курсор и адрес модалки `?e=<id>`) */
export const auditEventIdSchema = z.string().regex(/^\d{1,19}$/, 'validation.audit.eventId');
const cursor = z.string().max(200).optional();
const iso = z.string().datetime({ offset: true });
const verifyToken = z.string().regex(/^[a-f0-9]{64}$/, 'validation.auth.verifyToken');
/** Псевдоним сети журнала: `sa6m:<версия>:<kid>:<mac>` */
const IP_PSEUDONYM_RE = /^sa6m:1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/;

/** Лента человека: `GET /users/me/security/events`. */
export const personSecurityEventsQuerySchema = z
  .object({
    filter: z.enum(AUDIT_PERSON_FILTERS).optional(),
    cursor,
    limit: z.coerce.number().int().min(1).max(AUDIT_LIMITS.feedPageSize).optional(),
  })
  .strict();
export type PersonSecurityEventsQuery = z.infer<typeof personSecurityEventsQuerySchema>;

/** Журнал организации: `GET /workspaces/:id/security/events`. */
export const orgSecurityEventsQuerySchema = z
  .object({
    filter: z.enum(AUDIT_ORG_FILTERS).optional(),
    actorId: uuid.optional(),
    from: iso.optional(),
    to: iso.optional(),
    op: z.string().max(96).regex(/^[A-Za-z0-9_.:-]+$/).optional(),
    outcome: z.enum(AUDIT_OUTCOMES).optional(),
    cursor,
    limit: z.coerce.number().int().min(1).max(AUDIT_LIMITS.feedPageSize).optional(),
  })
  .strict();
export type OrgSecurityEventsQuery = z.infer<typeof orgSecurityEventsQuerySchema>;

/** Консоль «Безопасность» Кабинета: `GET /platform/security/events`. */
export const platformSecurityEventsQuerySchema = z
  .object({
    category: z.enum(AUDIT_CATEGORIES).optional(),
    key: z.string().max(96).regex(/^[a-z_.]+$/).optional(),
    actorKind: z.enum(AUDIT_ACTOR_KINDS).optional(),
    actorId: uuid.optional(),
    subjectUserId: uuid.optional(),
    workspaceId: uuid.optional(),
    requestId: uuid.optional(),
    /**
     * Псевдонимы сети (`sa6m:`) через запятую — «все события с этого IP» без IP в адресе.
     * Несколько — потому что ключ псевдонимов ротируется: один IP под двумя ключами.
     */
    ipHmac: z
      .string()
      .max(600)
      .transform((v) => v.split(',').map((x) => x.trim()).filter(Boolean))
      .pipe(z.array(z.string().max(128).regex(IP_PSEUDONYM_RE)).min(1).max(4))
      .optional(),
    op: z.string().max(96).regex(/^[A-Za-z0-9_.:-]+$/).optional(),
    outcome: z.enum(AUDIT_OUTCOMES).optional(),
    from: iso.optional(),
    to: iso.optional(),
    cursor,
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();
export type PlatformSecurityEventsQuery = z.infer<typeof platformSecurityEventsQuerySchema>;

/** «Это не я» — оспорить событие своей ленты. */
export const notMeStartSchema = z.object({ eventId: auditEventIdSchema }).strict();
export type NotMeStartInput = z.infer<typeof notMeStartSchema>;

/** Финал мастера: что человек сделал на шагах 3–4. */
export const notMeCompleteSchema = z.object({ eventId: auditEventIdSchema, passwordChanged: z.boolean(), phoneConfirmed: z.boolean() }).strict();
export type NotMeCompleteInput = z.infer<typeof notMeCompleteSchema>;

/** Подтвердить новую сессию раньше срока cooling: пропуск `security_confirm` (пароль + SMS). */
export const sessionConfirmSchema = z.object({ verifyToken }).strict();
export type SessionConfirmInput = z.infer<typeof sessionConfirmSchema>;

export const deviceRenameSchema = z
  .object({ label: z.string().trim().min(1, 'validation.audit.deviceLabel').max(64).refine((s) => !/[<>\u0000-\u001f]/.test(s), 'validation.auth.badCharacters') })
  .strict();
export type DeviceRenameInput = z.infer<typeof deviceRenameSchema>;

export const securitySettingsSchema = z
  .object({
    sessionMaxIdleDays: z
      .number()
      .int()
      .refine((n) => AUDIT_LIMITS.sessionMaxIdleDaysOptions.includes(n), 'validation.audit.idleDays'),
  })
  .strict();
export type SecuritySettingsInput = z.infer<typeof securitySettingsSchema>;

// ---- Заморозка без входа (публичные ручки) ----

export const freezeStartSchema = z.object({ phone: phoneSchema }).strict();
export type FreezeStartInput = z.infer<typeof freezeStartSchema>;

export const freezeConfirmSchema = z.object({ verifyToken }).strict();
export type FreezeConfirmInput = z.infer<typeof freezeConfirmSchema>;

/** Разморозка: пароль проверяется ДО отправки SMS (сброс паролем по SMS заморозку не снимает). */
export const unfreezeStartSchema = z.object({ phone: phoneSchema, password: z.string().min(1).max(100) }).strict();
export type UnfreezeStartInput = z.infer<typeof unfreezeStartSchema>;

export const unfreezeConfirmSchema = z.object({ verifyToken }).strict();
export type UnfreezeConfirmInput = z.infer<typeof unfreezeConfirmSchema>;

// ---- Выгрузка журнала организацией ----

export const orgAuditExportSchema = z
  .object({
    format: z.enum(AUDIT_EXPORT_FORMATS),
    from: iso,
    to: iso,
    filter: z.enum(AUDIT_ORG_FILTERS).optional(),
  })
  .strict()
  .refine((v) => Date.parse(v.from) < Date.parse(v.to), { message: 'validation.audit.range', path: ['to'] });
export type OrgAuditExportInput = z.infer<typeof orgAuditExportSchema>;

// ---- Кабинет ----

export const securityAlertsQuerySchema = z
  .object({
    status: z.enum(['open', 'ack', 'closed']).optional(),
    cursor,
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();
export type SecurityAlertsQuery = z.infer<typeof securityAlertsQuerySchema>;

/** Консоль: псевдонимы сети по введённому IP (POST — IP не попадает в адрес и логи прокси). */
export const securityNetworkLookupSchema = z.object({ ip: z.string().ip() }).strict();
export type SecurityNetworkLookupInput = z.infer<typeof securityNetworkLookupSchema>;

// ---- Команды Кабинета (security.*) ----

/** Завершить сессию человека (id семейства) либо все его сессии (без `sessionId`). */
export const securitySessionRevokeInputSchema = z.object({ userId: uuid, sessionId: uuid.optional() }).strict();
export type SecuritySessionRevokeInput = z.infer<typeof securitySessionRevokeInputSchema>;

export const securityAccountFreezeInputSchema = z.object({ userId: uuid }).strict();
export type SecurityAccountFreezeInput = z.infer<typeof securityAccountFreezeInputSchema>;

export const securityAccountUnfreezeInputSchema = z.object({ userId: uuid }).strict();
export type SecurityAccountUnfreezeInput = z.infer<typeof securityAccountUnfreezeInputSchema>;

export const securityAlertCloseInputSchema = z.object({ alertId: uuid, resolution: z.enum(AUDIT_ALERT_RESOLUTIONS) }).strict();
export type SecurityAlertCloseInput = z.infer<typeof securityAlertCloseInputSchema>;

/** Окно дат команды Кабинета: от < до и не шире `platformQueryMaxDays`. */
const rangeOk = (v: { from: string; to: string }) => Date.parse(v.from) < Date.parse(v.to);
const rangeShort = (v: { from: string; to: string }) => Date.parse(v.to) - Date.parse(v.from) <= AUDIT_LIMITS.platformQueryMaxDays * 86_400_000;
/** Окно синхронного пересчёта (проверка дайджестов, повтор стрима) — `platformScanMaxDays`. */
const scanShort = (v: { from: string; to: string }) => Date.parse(v.to) - Date.parse(v.from) <= AUDIT_LIMITS.platformScanMaxDays * 86_400_000;

/** Проверить дайджесты целостности, подписанные в окне. */
export const securityDigestVerifyInputSchema = z
  .object({ from: iso, to: iso })
  .strict()
  .refine(rangeOk, { message: 'validation.audit.range', path: ['to'] })
  .refine(scanShort, { message: 'validation.audit.rangeTooLong', path: ['from'] });
export type SecurityDigestVerifyInput = z.infer<typeof securityDigestVerifyInputSchema>;

/** Выгрузка журнала Кабинетом (весь журнал за окно) — автору команды. */
export const securityExportInputSchema = z
  .object({ format: z.enum(AUDIT_EXPORT_FORMATS), from: iso, to: iso })
  .strict()
  .refine(rangeOk, { message: 'validation.audit.range', path: ['to'] })
  .refine(rangeShort, { message: 'validation.audit.rangeTooLong', path: ['from'] });
export type SecurityExportInput = z.infer<typeof securityExportInputSchema>;

/** Повторить стрим `security.*` организации за окно (SIEM потерял доставки). */
export const securityStreamReplayInputSchema = z
  .object({ workspaceId: uuid, from: iso, to: iso })
  .strict()
  .refine(rangeOk, { message: 'validation.audit.range', path: ['to'] })
  .refine(scanShort, { message: 'validation.audit.rangeTooLong', path: ['from'] });
export type SecurityStreamReplayInput = z.infer<typeof securityStreamReplayInputSchema>;

/** Раскрыть полный IP события (только платформа; раскрытие — событие `platform.access.reveal`). */
export const securityEventRevealIpInputSchema = z.object({ eventId: auditEventIdSchema }).strict();
export type SecurityEventRevealIpInput = z.infer<typeof securityEventRevealIpInputSchema>;
