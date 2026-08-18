import { z } from 'zod';
import { COUNTERPARTY_KINDS, COUNTERPARTY_LIMITS } from '../constants/counterparties';
import { ORG_FORMS, TAX_REGIMES } from '../constants/requisites';
import { isValidBik, isValidIinOrBin, isValidKbe, isValidKzIban, normalizeIban } from '../utils/requisites';
import { normalizePhone } from '../utils/phone';
import { queryBoolean } from './query';

// ============================================================
// Сервис «Контрагенты» — Zod. Валидации — контрольные суммы, не длина
// (те же чистые функции, что и в реквизитах организации): опечатка в БИН
// ловится до отправки, а не при первом отказе налоговой.
// ============================================================

const safeText = (max: number, min = 1) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((v) => !/[<>]/.test(v), { message: 'Символы < и > запрещены' });

const kindEnum = z.enum(COUNTERPARTY_KINDS.map((k) => k.value) as [string, ...string[]]);

/** БИН/ИИН: 12 цифр + два прохода весов mod 11 */
const binSchema = z
  .string()
  .trim()
  .refine((v) => isValidIinOrBin(v), { message: 'Номер не проходит контрольную сумму (12 цифр)' });

const ibanSchema = z
  .string()
  .trim()
  .transform((v) => normalizeIban(v))
  .refine((v) => isValidKzIban(v), { message: 'IBAN не проходит контроль (KZ + 18 знаков)' });

const bikSchema = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .refine((v) => isValidBik(v), { message: 'БИК — 8 знаков SWIFT-формата' });

const kbeSchema = z
  .string()
  .trim()
  .refine((v) => isValidKbe(v), { message: 'КБе — две цифры' });

/** Телефон контакта нормализуется сразу: по нему сверяется личность подписанта */
const phoneSchema = z
  .string()
  .trim()
  .transform((v) => normalizePhone(v))
  .refine((v) => /^\+\d{10,15}$/.test(v), { message: 'Номер телефона в международном формате' });

/**
 * Поля карточки. ВАЖНО: та же схема стоит и на POST, и на PATCH (partial) —
 * проверка только на создании означала бы, что через правку уезжает что угодно.
 */
const counterpartyFields = {
  kind: kindEnum,
  name: safeText(COUNTERPARTY_LIMITS.maxNameLength),
  legalName: safeText(300).nullable().optional(),
  bin: binSchema.nullable().optional(),
  orgForm: z
    .enum(ORG_FORMS.map((f) => f.value) as [string, ...string[]])
    .nullable()
    .optional(),
  legalAddress: safeText(500).nullable().optional(),
  /** Фактический адрес; пусто = совпадает с юридическим (обычная оговорка договора) */
  actualAddress: safeText(500).nullable().optional(),
  kbe: kbeSchema.nullable().optional(),
  /** Налоговый режим — тот же справочник, что в анкете своей организации */
  taxRegime: z
    .enum(TAX_REGIMES.map((r) => r.value) as [string, ...string[]])
    .nullable()
    .optional(),
  vatPayer: z.boolean().optional(),
  vatSeries: safeText(20).nullable().optional(),
  vatNumber: safeText(20).nullable().optional(),
  /** YYYY-MM-DD (дата свидетельства НДС) */
  vatDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  directorName: safeText(200).nullable().optional(),
  signBasis: safeText(200).nullable().optional(),
  phone: phoneSchema.nullable().optional(),
  email: z.string().trim().email().max(200).nullable().optional(),
  comment: safeText(1000).nullable().optional(),
};

export const createCounterpartySchema = z.object({
  ...counterpartyFields,
  kind: kindEnum.optional(), // дефолт legal ставит сервис
  name: safeText(COUNTERPARTY_LIMITS.maxNameLength),
});

export const updateCounterpartySchema = z.object(counterpartyFields).partial();

export const createCounterpartyContactSchema = z.object({
  name: safeText(200),
  position: safeText(200).nullable().optional(),
  phone: phoneSchema.nullable().optional(),
  email: z.string().trim().email().max(200).nullable().optional(),
});

export const updateCounterpartyContactSchema = createCounterpartyContactSchema.partial();

export const createCounterpartyBankAccountSchema = z.object({
  iban: ibanSchema,
  bankName: safeText(200),
  bik: bikSchema,
  isPrimary: z.boolean().optional(),
});

export const listCounterpartiesSchema = z.object({
  search: z.string().trim().max(120).optional(),
  kind: kindEnum.optional(),
  /** Фильтр «Вид» списка = орг-форма формы (ОДИН источник, `counterpartyFormQuery`) */
  orgForm: z
    .enum(ORG_FORMS.map((f) => f.value) as [string, ...string[]])
    .optional(),
  /** ТОЛЬКО queryBoolean: `?archived=false` обязан значить ложь (правило платформы) */
  archived: queryBoolean.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(COUNTERPARTY_LIMITS.maxPageSize)
    .default(COUNTERPARTY_LIMITS.pageSize),
});

export type CreateCounterpartyInput = z.infer<typeof createCounterpartySchema>;
export type UpdateCounterpartyInput = z.infer<typeof updateCounterpartySchema>;
export type CreateCounterpartyContactInput = z.infer<typeof createCounterpartyContactSchema>;
export type UpdateCounterpartyContactInput = z.infer<typeof updateCounterpartyContactSchema>;
export type CreateCounterpartyBankAccountInput = z.infer<typeof createCounterpartyBankAccountSchema>;
export type ListCounterpartiesInput = z.infer<typeof listCounterpartiesSchema>;
