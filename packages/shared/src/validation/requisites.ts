import { z } from 'zod';
import { ORG_FORMS, TAX_REGIMES, REQUISITE_LIMITS } from '../constants/requisites';
import {
  isCardExpiryAlive,
  isValidBik,
  isValidCardPan,
  isValidIinOrBin,
  isValidKbe,
  isValidKzIban,
  normalizeCardPan,
  normalizeIban,
} from '../utils/requisites';

// ============================================================
// Реквизиты — Zod-схемы (организация, человек, карта).
// Все номера проверяются КОНТРОЛЬНЫМИ СУММАМИ, а не только длиной: опечатка в
// БИН/ИИН/IBAN в договоре обнаруживается в банке недели спустя — форма обязана
// поймать её сразу.
// ============================================================

const noHtml = (s: string) => !/[<>]/.test(s);

export const iinSchema = z
  .string()
  .trim()
  .refine(isValidIinOrBin, 'ИИН: 12 цифр, проверьте номер — не сходится контрольная сумма');

export const binSchema = z
  .string()
  .trim()
  .refine(isValidIinOrBin, 'БИН: 12 цифр, проверьте номер — не сходится контрольная сумма');

export const kzIbanSchema = z
  .string()
  .trim()
  .transform(normalizeIban)
  .refine(isValidKzIban, 'IBAN: формат KZ + 18 знаков, проверьте номер счёта');

export const bikSchema = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase())
  .refine(isValidBik, 'БИК: 8 знаков, например CASPKZKA');

export const kbeSchema = z.string().trim().refine(isValidKbe, 'КБе — две цифры, например 17 или 19');

const orgFormValues = ORG_FORMS.map((f) => f.value) as [string, ...string[]];
const taxRegimeValues = TAX_REGIMES.map((r) => r.value) as [string, ...string[]];

/**
 * PUT /workspaces/:id/requisites — реквизиты организации (upsert целиком).
 * null очищает поле; отсутствие ключа сохраняет как было (контракт PATCH-полей).
 */
export const workspaceRequisitesSchema = z
  .object({
    orgForm: z.enum(orgFormValues).nullable().optional(),
    taxRegime: z.enum(taxRegimeValues).nullable().optional(),
    legalName: z
      .string()
      .trim()
      .min(1)
      .max(REQUISITE_LIMITS.legalNameMaxLength)
      .refine(noHtml, 'Недопустимые символы')
      .nullable()
      .optional(),
    bin: binSchema.nullable().optional(),
    legalAddress: z
      .string()
      .trim()
      .min(1)
      .max(REQUISITE_LIMITS.addressMaxLength)
      .refine(noHtml, 'Недопустимые символы')
      .nullable()
      .optional(),
    kbe: kbeSchema.nullable().optional(),
    vatPayer: z.boolean().optional(),
    vatSeries: z.string().trim().max(20).refine(noHtml, 'Недопустимые символы').nullable().optional(),
    vatNumber: z.string().trim().max(20).refine(noHtml, 'Недопустимые символы').nullable().optional(),
    vatDate: z.coerce.date().nullable().optional(),
    /** Директор — выбор из СОТРУДНИКОВ организации (валидируется сервером) */
    directorUserId: z.string().uuid().nullable().optional(),
    signBasis: z
      .string()
      .trim()
      .max(REQUISITE_LIMITS.signBasisMaxLength)
      .refine(noHtml, 'Недопустимые символы')
      .nullable()
      .optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Нечего менять');

/** POST /workspaces/:id/requisites/accounts */
export const createBankAccountSchema = z
  .object({
    iban: kzIbanSchema,
    bankName: z
      .string()
      .trim()
      .min(1, 'Укажите банк')
      .max(REQUISITE_LIMITS.bankNameMaxLength)
      .refine(noHtml, 'Недопустимые символы'),
    bik: bikSchema,
    isPrimary: z.boolean().optional(),
  })
  .strict();

/** PATCH /workspaces/:id/requisites/accounts/:accId */
export const updateBankAccountSchema = z
  .object({
    iban: kzIbanSchema.optional(),
    bankName: z
      .string()
      .trim()
      .min(1)
      .max(REQUISITE_LIMITS.bankNameMaxLength)
      .refine(noHtml, 'Недопустимые символы')
      .optional(),
    bik: bikSchema.optional(),
    isPrimary: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Нечего менять');

// ============================================================
// Человек: реквизитные поля анкеты (вливаются в updateProfileSchema)
// ============================================================

export const userRequisiteFieldsSchema = {
  iin: iinSchema.nullable().optional(),
  residentialAddress: z
    .string()
    .trim()
    .min(1)
    .max(REQUISITE_LIMITS.addressMaxLength)
    .refine(noHtml, 'Недопустимые символы')
    .nullable()
    .optional(),
  idDocNumber: z
    .string()
    .trim()
    .min(1)
    .max(REQUISITE_LIMITS.idDocNumberMaxLength)
    .refine((s) => /^[0-9A-Za-z№ -]+$/.test(s), 'Только цифры и буквы')
    .nullable()
    .optional(),
  idDocIssuedBy: z
    .string()
    .trim()
    .min(1)
    .max(REQUISITE_LIMITS.idDocIssuedByMaxLength)
    .refine(noHtml, 'Недопустимые символы')
    .nullable()
    .optional(),
  idDocIssuedAt: z.coerce.date().nullable().optional(),
};

// ============================================================
// Карта в «Кошельке» (реквизит для выплат, НЕ платёжный инструмент; без CVV)
// ============================================================

/** POST /wallet/cards */
export const createPaymentCardSchema = z
  .object({
    pan: z
      .string()
      .transform(normalizeCardPan)
      .refine(isValidCardPan, 'Проверьте номер карты — не сходится контрольная сумма'),
    /** IBAN карт-счёта (Kaspi показывает его в реквизитах карты) */
    iban: kzIbanSchema.nullable().optional(),
    holderName: z
      .string()
      .trim()
      .min(1, 'Имя как на карте')
      .max(REQUISITE_LIMITS.holderNameMaxLength)
      .refine((s) => !/[<>]/.test(s), 'Недопустимые символы'),
    expMonth: z.coerce.number().int().min(1).max(12),
    expYear: z.coerce.number().int().min(2000).max(2100),
    isPrimary: z.boolean().optional(),
  })
  .strict()
  .refine((v) => isCardExpiryAlive(v.expMonth, v.expYear), {
    message: 'Срок действия карты уже истёк',
    path: ['expYear'],
  });

/** PATCH /wallet/cards/:id — номер не правится (удалите карту и добавьте новую) */
export const updatePaymentCardSchema = z
  .object({
    iban: kzIbanSchema.nullable().optional(),
    holderName: z
      .string()
      .trim()
      .min(1)
      .max(REQUISITE_LIMITS.holderNameMaxLength)
      .refine((s) => !/[<>]/.test(s), 'Недопустимые символы')
      .optional(),
    expMonth: z.coerce.number().int().min(1).max(12).optional(),
    expYear: z.coerce.number().int().min(2000).max(2100).optional(),
    isPrimary: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Нечего менять');

export type WorkspaceRequisitesInput = z.infer<typeof workspaceRequisitesSchema>;
export type CreateBankAccountInput = z.infer<typeof createBankAccountSchema>;
export type UpdateBankAccountInput = z.infer<typeof updateBankAccountSchema>;
export type CreatePaymentCardInput = z.infer<typeof createPaymentCardSchema>;
export type UpdatePaymentCardInput = z.infer<typeof updatePaymentCardSchema>;
