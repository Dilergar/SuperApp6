import { z } from 'zod';
import { SUPPORTED_LOCALES } from '../constants/i18n';
import { CONSENT_BUNDLE_KEYS, type ConsentBundleKey } from '../consents/bundles';
import { CONSENT_CHANNELS, CONSENT_DOCUMENT_KEYS, CONSENT_LIMITS, CONSENT_TEXT_DOCUMENT_KEYS, type ConsentDocumentKey } from '../consents/registry';
import { PD_INCIDENT_KINDS, PD_INCIDENT_LIMITS } from '../consents/pd-actions';

// ============================================================
// core/consents — входные схемы (единственное описание формы: тип = z.infer)
// ============================================================

const uuid = z.string().uuid();
const locale = z.enum(SUPPORTED_LOCALES);
const documentKey = z.enum(CONSENT_DOCUMENT_KEYS as [ConsentDocumentKey, ...ConsentDocumentKey[]]);
const textDocumentKey = z.enum(CONSENT_TEXT_DOCUMENT_KEYS as [ConsentDocumentKey, ...ConsentDocumentKey[]]);
const bundleKey = z.enum(CONSENT_BUNDLE_KEYS as [ConsentBundleKey, ...ConsentBundleKey[]]);

/**
 * Что человек принял ДО действия: id версий, которые ему ПОКАЗАЛИ, и язык показа.
 * Сервер сверяет их с действующими версиями пакета — принять «что-то» нельзя.
 * Эта же форма кладётся в `VerifyChallenge.context` на шаге 1 регистрации.
 */
export const consentSelectionSchema = z
  .object({
    versionIds: z.array(uuid).min(1).max(12),
    locale,
    channel: z.enum(CONSENT_CHANNELS).default('web'),
  })
  .strict();
export type ConsentSelectionInput = z.infer<typeof consentSelectionSchema>;

/** `POST /consents/accept` — приёмка из продукта (баннер, блокирующий экран, тумблер, интеграция). */
export const consentAcceptSchema = consentSelectionSchema
  .extend({
    bundleKey: bundleKey.optional(),
    /** Субъект — организация: принять может только её владелец */
    workspaceId: uuid.optional(),
  })
  .strict();
export type ConsentAcceptInput = z.infer<typeof consentAcceptSchema>;

/** `POST /consents/revoke` — отзыв отзывного согласия / отказ от opt-out вида. */
export const consentRevokeSchema = z.object({ documentKey }).strict();
export type ConsentRevokeInput = z.infer<typeof consentRevokeSchema>;

export const consentDocumentQuerySchema = z.object({ locale: locale.optional() }).strict();
export type ConsentDocumentQuery = z.infer<typeof consentDocumentQuerySchema>;

export const consentTransfersQuerySchema = z
  .object({ cursor: z.string().max(64).optional(), limit: z.coerce.number().int().min(1).max(CONSENT_LIMITS.pageSize).optional() })
  .strict();
export type ConsentTransfersQuery = z.infer<typeof consentTransfersQuerySchema>;

// ---- Команды кабинета платформы ----

const localizedBody = z.object({ kk: z.string().trim().min(1).max(CONSENT_LIMITS.bodyMax), ru: z.string().trim().min(1).max(CONSENT_LIMITS.bodyMax), en: z.string().trim().min(1).max(CONSENT_LIMITS.bodyMax) }).strict();
const localizedSummary = z.object({ kk: z.string().trim().min(1).max(CONSENT_LIMITS.summaryMax), ru: z.string().trim().min(1).max(CONSENT_LIMITS.summaryMax), en: z.string().trim().min(1).max(CONSENT_LIMITS.summaryMax) }).strict();
const localizedChange = z.object({ kk: z.string().trim().max(CONSENT_LIMITS.changeSummaryMax), ru: z.string().trim().max(CONSENT_LIMITS.changeSummaryMax), en: z.string().trim().max(CONSENT_LIMITS.changeSummaryMax) }).strict();

/** `consents.document.draft.save` — создать/обновить ЕДИНСТВЕННЫЙ черновик документа. */
export const consentsDraftSaveInputSchema = z
  .object({
    documentKey: textDocumentKey,
    bodies: localizedBody,
    summaries: localizedSummary,
    changeSummary: localizedChange.optional(),
    /** Существенная версия поднимает шлюз; опечатки и реквизиты — несущественная */
    material: z.boolean(),
  })
  .strict();
export type ConsentsDraftSaveInput = z.infer<typeof consentsDraftSaveInputSchema>;

/** `consents.document.publish` — черновик → действующая версия с датой вступления в силу. */
export const consentsPublishInputSchema = z
  .object({
    documentKey: textDocumentKey,
    /** Дата вступления; пусто — через `defaultEffectiveInDays` (B2B — не раньше `workspaceNoticeDays`) */
    effectiveFrom: z.string().datetime({ offset: true }).optional(),
    /** Срочная публикация «сегодня»: только с причиной (её несёт сама команда) и вторым сотрудником */
    urgent: z.boolean().optional(),
  })
  .strict();
export type ConsentsPublishInput = z.infer<typeof consentsPublishInputSchema>;

/** `consents.document.attest` — заверение версии ЭЦП руководителя (через core/sign). */
export const consentsAttestInputSchema = z.object({ versionId: uuid, signerUserId: uuid }).strict();
export type ConsentsAttestInput = z.infer<typeof consentsAttestInputSchema>;

/** `consents.versions.reattest` — переподписать версии, подписанные скомпрометированной версией ключа. */
export const consentsReattestInputSchema = z.object({ kid: uuid.optional() }).strict();
export type ConsentsReattestInput = z.infer<typeof consentsReattestInputSchema>;

export const pdIncidentOpenInputSchema = z
  .object({
    kind: z.enum(PD_INCIDENT_KINDS),
    /** Момент обнаружения; пусто — сейчас. В будущем быть не может */
    detectedAt: z.string().datetime({ offset: true }).optional(),
    scope: z.string().trim().min(3).max(PD_INCIDENT_LIMITS.scopeMax),
    summary: z.string().trim().min(10).max(PD_INCIDENT_LIMITS.summaryMax),
    affectedEstimate: z.number().int().min(0).max(1_000_000_000).optional(),
  })
  .strict();
export type PdIncidentOpenInput = z.infer<typeof pdIncidentOpenInputSchema>;

export const pdIncidentStepInputSchema = z
  .object({ incidentId: uuid, note: z.string().trim().max(PD_INCIDENT_LIMITS.summaryMax).optional() })
  .strict();
export type PdIncidentStepInput = z.infer<typeof pdIncidentStepInputSchema>;
