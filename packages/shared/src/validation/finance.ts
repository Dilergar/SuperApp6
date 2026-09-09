import { z } from 'zod';
import { FIN_LIMITS } from '../constants/finance';

const noHtml = (s: string) => !/[<>]/.test(s);

const finNameSchema = z
  .string()
  .min(1, 'validation.finance.nameRequired')
  .max(FIN_LIMITS.maxNameLength)
  .refine((s) => s.trim().length > 0, 'validation.finance.nameRequired')
  .refine(noHtml, 'validation.finance.badCharacters');

const finIconSchema = z
  .string()
  .min(1)
  .max(FIN_LIMITS.maxIconLength)
  .refine(noHtml, 'validation.finance.badCharacters');

const finNoteSchema = z
  .string()
  .max(FIN_LIMITS.maxNoteLength)
  .refine(noHtml, 'validation.finance.badCharacters');

/** Integer minor units (tiyn), > 0. */
const finAmountSchema = z
  .number()
  .int('validation.finance.amountMinorUnits')
  .positive('validation.finance.amountPositive')
  .max(FIN_LIMITS.maxAmount);

/** Date-only, YYYY-MM-DD. */
const finDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'validation.finance.isoDate')
  .refine((s) => !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime()), 'validation.finance.invalidDate');

const finCurrencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, 'validation.finance.currencyCode');

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
  .refine((d) => Object.keys(d).length > 0, { message: 'validation.finance.nothingToUpdate' });

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
  .refine((d) => Object.keys(d).length > 0, { message: 'validation.finance.nothingToUpdate' });

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
  .refine((d) => Object.keys(d).length > 0, { message: 'validation.finance.nothingToUpdate' });

// ---------- budgets + reports (Phase 2) ----------

const finPeriodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'validation.finance.monthPeriod');

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
  .refine((d) => d.type !== 'installment' || !!d.categoryAccountId, { message: 'validation.finance.installmentCategoryRequired' })
  .refine((d) => d.type !== 'loan' || !!d.creditAccountId, { message: 'validation.finance.loanAccountRequired' });

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
  .refine((d) => Object.keys(d).length > 0, { message: 'validation.finance.nothingToUpdate' });

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
  .refine((d) => d.interval !== 'monthly' || !!d.dayOfMonth, { message: 'validation.finance.dayOfMonthRequired' })
  .refine((d) => d.interval !== 'weekly' || !!d.weekday, { message: 'validation.finance.weekdayRequired' });

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
  .refine((d) => Object.keys(d).length > 0, { message: 'validation.finance.nothingToUpdate' });

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
