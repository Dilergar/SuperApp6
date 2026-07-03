import { z } from 'zod';
import { FIN_LIMITS } from '../constants/finance';

const noHtml = (s: string) => !/[<>]/.test(s);

const finNameSchema = z
  .string()
  .min(1, 'Название обязательно')
  .max(FIN_LIMITS.maxNameLength)
  .refine((s) => s.trim().length > 0, 'Название обязательно')
  .refine(noHtml, 'Недопустимые символы');

const finIconSchema = z
  .string()
  .min(1)
  .max(FIN_LIMITS.maxIconLength)
  .refine(noHtml, 'Недопустимые символы');

const finNoteSchema = z
  .string()
  .max(FIN_LIMITS.maxNoteLength)
  .refine(noHtml, 'Недопустимые символы');

/** Integer minor units (tiyn), > 0. */
const finAmountSchema = z
  .number()
  .int('Сумма — целое число в минимальных единицах')
  .positive('Сумма должна быть больше 0')
  .max(FIN_LIMITS.maxAmount);

/** Date-only, YYYY-MM-DD. */
const finDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате ГГГГ-ММ-ДД')
  .refine((s) => !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime()), 'Некорректная дата');

const finCurrencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, 'Код валюты — 3 буквы (KZT, USD…)');

// ---------- accounts (asset) ----------

export const createFinAccountSchema = z
  .object({
    name: finNameSchema,
    subtype: z.enum(['cash', 'card', 'savings', 'other']),
    icon: finIconSchema.optional(),
    currencyCode: finCurrencyCodeSchema.optional(),
    /** Optional starting balance → creates an opening transaction (equity → asset). */
    openingBalance: z.number().int().min(0).max(FIN_LIMITS.maxAmount).optional(),
  })
  .strict();

export const updateFinAccountSchema = z
  .object({
    name: finNameSchema.optional(),
    icon: finIconSchema.nullable().optional(),
    archived: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(10000).optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, { message: 'Нечего обновлять' });

/** «У меня сейчас на счёте N» → adjusting opening transaction (equity ↔ asset) for the delta. */
export const setFinAccountBalanceSchema = z
  .object({
    balance: z.number().int().min(-FIN_LIMITS.maxAmount).max(FIN_LIMITS.maxAmount),
  })
  .strict();

// ---------- categories (expense / income accounts) ----------

export const createFinCategorySchema = z
  .object({
    kind: z.enum(['expense', 'income']),
    name: finNameSchema,
    icon: finIconSchema.optional(),
    parentId: z.string().uuid().optional(),
  })
  .strict();

export const updateFinCategorySchema = z
  .object({
    name: finNameSchema.optional(),
    icon: finIconSchema.nullable().optional(),
    archived: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(10000).optional(),
    parentId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, { message: 'Нечего обновлять' });

// ---------- transactions ----------

export const createFinTransactionSchema = z
  .object({
    fromAccountId: z.string().uuid(),
    toAccountId: z.string().uuid(),
    amount: finAmountSchema,
    /** Only for cross-currency money→money moves (обмен): amount in the destination currency. */
    amountTo: finAmountSchema.optional(),
    occurredOn: finDateSchema.optional(),
    note: finNoteSchema.optional(),
    personUserId: z.string().uuid().optional(),
  })
  .strict();

export const updateFinTransactionSchema = z
  .object({
    fromAccountId: z.string().uuid().optional(),
    toAccountId: z.string().uuid().optional(),
    amount: finAmountSchema.optional(),
    amountTo: finAmountSchema.nullable().optional(),
    occurredOn: finDateSchema.optional(),
    note: finNoteSchema.nullable().optional(),
    personUserId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, { message: 'Нечего обновлять' });

// ---------- budgets + reports (Phase 2) ----------

const finPeriodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Период в формате ГГГГ-ММ');

/** PUT semantics: amount = null удаляет лимит. Лимиты ставятся на категории РАСХОДОВ. */
export const upsertFinBudgetSchema = z
  .object({
    period: finPeriodSchema,
    categoryAccountId: z.string().uuid(),
    amount: finAmountSchema.nullable(),
    currencyCode: finCurrencyCodeSchema.optional(),
  })
  .strict();

export const finMonthReportQuerySchema = z.object({
  period: finPeriodSchema,
  bookId: z.string().uuid().optional(),
});

export const finTrendQuerySchema = z.object({
  months: z.coerce.number().int().min(1).max(24).optional(),
  bookId: z.string().uuid().optional(),
});

// ---------- people (Phase 3) ----------

export const addFinPersonSchema = z.object({ userId: z.string().uuid() }).strict();

export const finPeopleReportQuerySchema = z.object({
  from: finDateSchema.optional(),
  to: finDateSchema.optional(),
  bookId: z.string().uuid().optional(),
});

// ---------- coin feed (Phase 7) ----------

export const finCoinFeedQuerySchema = z.object({
  cursor: z.string().regex(/^\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

// ---------- shares (Phase 6) ----------

export const upsertFinShareSchema = z
  .object({
    principalType: z.enum(['user', 'circle']),
    principalId: z.string().uuid(),
    role: z.enum(['viewer', 'editor']),
  })
  .strict();

// ---------- debts (Phase 5) ----------

export const createFinDebtSchema = z
  .object({
    name: finNameSchema,
    type: z.enum(['installment', 'loan']),
    monthlyPayment: finAmountSchema,
    months: z.number().int().min(1).max(600),
    /** Итог долга; по умолчанию = платёж × месяцев. */
    totalAmount: finAmountSchema.optional(),
    dueDay: z.number().int().min(1).max(31),
    currencyCode: finCurrencyCodeSchema.optional(),
    occurredOn: finDateSchema.optional(),
    note: finNoteSchema.optional(),
    personUserId: z.string().uuid().optional(),
    /** installment: категория покупки (расход полной суммой). */
    categoryAccountId: z.string().uuid().optional(),
    /** loan: счёт зачисления денег. */
    creditAccountId: z.string().uuid().optional(),
    /** loan: получено на счёт (меньше итога → разница = «Проценты по кредитам»). */
    amountReceived: finAmountSchema.optional(),
  })
  .strict()
  .refine((d) => d.type !== 'installment' || !!d.categoryAccountId, { message: 'Для рассрочки укажите категорию покупки' })
  .refine((d) => d.type !== 'loan' || !!d.creditAccountId, { message: 'Для кредита укажите счёт зачисления' });

export const payFinDebtSchema = z
  .object({
    fromAccountId: z.string().uuid(),
    /** По умолчанию — ежемесячный платёж (не больше остатка). */
    amount: finAmountSchema.optional(),
  })
  .strict();

export const updateFinDebtSchema = z
  .object({
    name: finNameSchema.optional(),
    dueDay: z.number().int().min(1).max(31).optional(),
    monthlyPayment: finAmountSchema.optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, { message: 'Нечего обновлять' });

// ---------- recurring (Phase 5) ----------

export const createFinRecurringSchema = z
  .object({
    title: finNameSchema,
    fromAccountId: z.string().uuid(),
    toAccountId: z.string().uuid(),
    amount: finAmountSchema,
    note: finNoteSchema.optional(),
    personUserId: z.string().uuid().optional(),
    interval: z.enum(['monthly', 'weekly']),
    dayOfMonth: z.number().int().min(1).max(31).optional(),
    weekday: z.number().int().min(1).max(7).optional(),
    autoRecord: z.boolean().optional(),
  })
  .strict()
  .refine((d) => d.interval !== 'monthly' || !!d.dayOfMonth, { message: 'Укажите день месяца' })
  .refine((d) => d.interval !== 'weekly' || !!d.weekday, { message: 'Укажите день недели' });

export const updateFinRecurringSchema = z
  .object({
    title: finNameSchema.optional(),
    amount: finAmountSchema.optional(),
    note: finNoteSchema.nullable().optional(),
    dayOfMonth: z.number().int().min(1).max(31).optional(),
    weekday: z.number().int().min(1).max(7).optional(),
    autoRecord: z.boolean().optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, { message: 'Нечего обновлять' });

export const listFinTransactionsQuerySchema = z.object({
  bookId: z.string().uuid().optional(),
  from: finDateSchema.optional(),
  to: finDateSchema.optional(),
  accountId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  personUserId: z.string().uuid().optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
