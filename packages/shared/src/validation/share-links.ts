import { z } from 'zod';
import { SHARE_LINK_LIMITS } from '../constants/share-links';
import { kzMobilePhoneSchema } from './auth';

// ============================================
// core/share-links — Zod-схемы
// ============================================

/**
 * refType — свободная строка, а не enum: движок не знает своих потребителей, и
 * закрытый список означал бы правку общего пакета на каждый новый сервис.
 * Незарегистрированный тип отсекает сам движок (400 по реестру).
 */
const refType = z.string().trim().min(1).max(64);

/** Подпись «для кого»: угловые скобки запрещены правилом платформы против XSS */
const label = z
  .string()
  .trim()
  .max(SHARE_LINK_LIMITS.maxLabelLength)
  .refine((s) => !/[<>]/.test(s), 'Недопустимые символы в подписи');

/** Срок действия только в будущем — «истекла в момент создания» это опечатка, а не сценарий */
const futureDate = z.coerce.date().refine((d) => d.getTime() > Date.now(), 'Срок должен быть в будущем');

const password = z
  .string()
  .min(SHARE_LINK_LIMITS.passwordMinLength, `Минимум ${SHARE_LINK_LIMITS.passwordMinLength} символа`)
  .max(SHARE_LINK_LIMITS.passwordMaxLength);

const maxOpens = z.coerce.number().int().positive().max(SHARE_LINK_LIMITS.maxOpensCeiling);

/** POST /share-links */
export const createShareLinkSchema = z
  .object({
    refType,
    refId: z.string().uuid(),
    label: label.optional(),
    /** Без срока — бессрочная (модель Google Drive/Dropbox): живёт, пока не отозвали */
    expiresAt: futureDate.optional(),
    password: password.optional(),
    maxOpens: maxOpens.optional(),
    /** Умолчания живут в схеме БД — здесь только явное переопределение */
    allowDownload: z.boolean().optional(),
    notifyOnOpen: z.boolean().optional(),
    requireIdentity: z.boolean().optional(),
  })
  .strict();

/**
 * PATCH /share-links/:id — null очищает поле, отсутствие ключа сохраняет как было.
 * Без этого различия «убрать пароль» и «не трогать пароль» выглядели бы одинаково.
 */
export const updateShareLinkSchema = z
  .object({
    label: label.nullable().optional(),
    expiresAt: futureDate.nullable().optional(),
    password: password.nullable().optional(),
    maxOpens: maxOpens.nullable().optional(),
    // Тумблеры — не nullable: «выключить» это false, а не «очистить».
    allowDownload: z.boolean().optional(),
    notifyOnOpen: z.boolean().optional(),
    requireIdentity: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Нечего менять');

/** GET /share-links?refType&refId */
export const listShareLinksQuerySchema = z.object({ refType, refId: z.string().uuid() }).strict();

/**
 * GET /share-links/mine — все ссылки, которые выдал Я, из всех сервисов сразу.
 * `status` — не хранимое поле, а вычисляемое (`shareLinkStatus`), поэтому фильтр
 * сознательно грубый: «действующие» против «всех остальных».
 */
export const mineShareLinksQuerySchema = z
  .object({
    status: z.enum(['active', 'inactive', 'all']).default('active'),
    cursor: z.string().max(128).optional(),
    limit: z.coerce.number().int().min(1).max(SHARE_LINK_LIMITS.minePageSize).optional(),
  })
  .strict();

/** POST /share-links/bulk-revoke — отозвать пачку своих ссылок одним движением */
export const bulkRevokeSchema = z
  .object({ ids: z.array(z.string().uuid()).min(1).max(100) })
  .strict();

/** GET /share-links/:id/visits */
export const shareVisitsQuerySchema = z
  .object({
    cursor: z.string().max(64).optional(),
    limit: z.coerce.number().int().min(1).max(SHARE_LINK_LIMITS.maxVisitsPageSize).optional(),
  })
  .strict();

/** Имя, которым гость представляется: угловые скобки запрещены правилом платформы против XSS */
const guestName = z
  .string()
  .trim()
  .min(1, 'Представьтесь, пожалуйста')
  .max(SHARE_LINK_LIMITS.guestNameMaxLength)
  .refine((s) => !/[<>]/.test(s), 'Недопустимые символы в имени');

/** POST /share-links/guest/:token/session */
export const shareGuestSessionSchema = z
  .object({
    password: z.string().max(SHARE_LINK_LIMITS.passwordMaxLength).optional(),
    // Ссылка с requireIdentity: пропуск core/verify (цель share_link_guest) + имя.
    // Обязательность решает сервер по самой ссылке — схема лишь описывает форму.
    verifyToken: z.string().length(64).optional(),
    guestName: guestName.optional(),
  })
  .strict();

/**
 * POST /share-links/guest/:token/identity/start — запрос SMS-кода гостем.
 * Пароль (если ссылка запаролена) обязателен УЖЕ ЗДЕСЬ: иначе любой, у кого есть
 * только адрес, тратил бы SMS-бюджет платформы, не зная пароля.
 */
export const shareGuestIdentityStartSchema = z
  .object({
    phone: kzMobilePhoneSchema,
    password: z.string().max(SHARE_LINK_LIMITS.passwordMaxLength).optional(),
  })
  .strict();

export type CreateShareLinkInput = z.infer<typeof createShareLinkSchema>;
export type UpdateShareLinkInput = z.infer<typeof updateShareLinkSchema>;
export type MineShareLinksQuery = z.infer<typeof mineShareLinksQuerySchema>;
export type BulkRevokeInput = z.infer<typeof bulkRevokeSchema>;
export type ListShareLinksQuery = z.infer<typeof listShareLinksQuerySchema>;
export type ShareVisitsQuery = z.infer<typeof shareVisitsQuerySchema>;
export type ShareGuestSessionInput = z.infer<typeof shareGuestSessionSchema>;
export type ShareGuestIdentityStartInput = z.infer<typeof shareGuestIdentityStartSchema>;
