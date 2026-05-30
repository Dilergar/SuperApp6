import { z } from 'zod';
import { WALLET_LIMITS } from '../constants/wallet';

const noHtml = (s: string) => !/[<>]/.test(s);

const currencyNameSchema = z
  .string()
  .min(1, 'Название валюты обязательно')
  .max(WALLET_LIMITS.maxCurrencyNameLength)
  .refine(noHtml, 'Недопустимые символы');

// Emoji / short symbol — no tickers. Reject HTML and whitespace-only.
const iconSchema = z
  .string()
  .min(1, 'Выберите иконку')
  .max(WALLET_LIMITS.maxIconLength)
  .refine((s) => s.trim().length > 0, 'Выберите иконку')
  .refine(noHtml, 'Недопустимые символы');

// Positive integers only; no fractional coins. Bounded by the emission cap.
const amountSchema = z
  .number()
  .int('Только целые монеты')
  .positive('Сумма должна быть больше 0')
  .max(WALLET_LIMITS.maxTxnAmount);

export const createCurrencySchema = z
  .object({ name: currencyNameSchema, icon: iconSchema })
  .strict();

export const updateCurrencySchema = z
  .object({ name: currencyNameSchema.optional(), icon: iconSchema.optional() })
  .strict()
  .refine((d) => d.name !== undefined || d.icon !== undefined, {
    message: 'Нечего обновлять',
  });

export const mintSchema = z.object({ amount: amountSchema }).strict();

// Company treasury → employee payout (B2B, Phase 9).
export const payEmployeeSchema = z
  .object({ userId: z.string().uuid(), amount: amountSchema })
  .strict();

export const burnSchema = z
  .object({ currencyId: z.string().uuid(), amount: amountSchema })
  .strict();

export const walletHistoryQuerySchema = z.object({
  currencyId: z.string().uuid().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
