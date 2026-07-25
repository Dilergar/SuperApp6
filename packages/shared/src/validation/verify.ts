import { z } from 'zod';
import { passwordSchema, kzMobilePhoneSchema } from './auth';
import { VERIFY_PURPOSES, VERIFY_LIMITS } from '../constants/verify';

// ============================================================
// Движок подтверждений (core/verify) — Zod-схемы
// ============================================================

export const verifyPurposeSchema = z.enum(VERIFY_PURPOSES);

/** POST /verify/start */
export const verifyStartSchema = z.object({
  phone: kzMobilePhoneSchema,
  purpose: verifyPurposeSchema,
  // Слот под CAPTCHA (Cloudflare Turnstile) — включается env-флагом при выходе в прод.
  captchaToken: z.string().max(4096).optional(),
});

/**
 * POST /verify/step-up (залогинен): код на свой номер (или на НОВЫЙ при phone_change_new).
 * Пароль обязателен ДО отправки кода — два следствия:
 *  1) «неверный текущий пароль» больше не выясняется ПОСЛЕ сожжённой SMS;
 *  2) угнанный access-токен не превращается в бесплатную кнопку SMS-спама на номер
 *     владельца (Kaspi-модель: критичное действие = пароль + код).
 */
export const verifyStepUpSchema = z
  .object({
    purpose: z.enum(['password_change', 'phone_change_old', 'phone_change_new']),
    password: z.string().min(1, 'Введите пароль'),
    newPhone: kzMobilePhoneSchema.optional(),
  })
  .refine((v) => v.purpose !== 'phone_change_new' || !!v.newPhone, {
    path: ['newPhone'],
    message: 'Укажите новый номер телефона',
  });

/** POST /verify/check */
export const verifyCheckSchema = z.object({
  challengeId: z.string().uuid(),
  code: z
    .string()
    .regex(new RegExp(`^\\d{${VERIFY_LIMITS.codeLength}}$`), `Код — ${VERIFY_LIMITS.codeLength} цифр`),
});

/** Одноразовый пропуск, выданный /verify/check (64 hex-символа). */
export const verifyTokenSchema = z.string().regex(/^[a-f0-9]{64}$/, 'Некорректный токен подтверждения');

/** POST /auth/password-reset — завершение сброса пароля. */
export const passwordResetCompleteSchema = z.object({
  verifyToken: verifyTokenSchema,
  newPassword: passwordSchema,
});

/** POST /users/me/change-password — смена пароля залогиненным (пароль + SMS step-up). */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Введите текущий пароль'),
  newPassword: passwordSchema,
  verifyToken: verifyTokenSchema,
  // Свой refresh-токен: эта сессия ПЕРЕЖИВАЕТ отзыв (остальные гаснут). Не передан → гаснут все.
  currentRefreshToken: z.string().min(1).optional(),
});

/** POST /users/me/change-phone — смена номера (пароль + код на старый + код на новый). */
export const changePhoneSchema = z.object({
  password: z.string().min(1, 'Введите пароль'),
  newPhone: kzMobilePhoneSchema,
  oldVerifyToken: verifyTokenSchema, // purpose=phone_change_old, отправлен на ТЕКУЩИЙ номер
  newVerifyToken: verifyTokenSchema, // purpose=phone_change_new, отправлен на НОВЫЙ номер
  currentRefreshToken: z.string().min(1).optional(),
});

export type VerifyStartInput = z.infer<typeof verifyStartSchema>;
export type VerifyCheckInput = z.infer<typeof verifyCheckSchema>;
export type PasswordResetCompleteInput = z.infer<typeof passwordResetCompleteSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type ChangePhoneInput = z.infer<typeof changePhoneSchema>;
