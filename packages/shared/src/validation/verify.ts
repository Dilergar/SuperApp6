import { z } from 'zod';
import { passwordSchema, kzMobilePhoneSchema } from './auth';
import { VERIFY_PURPOSES, VERIFY_LIMITS, STEP_UP_WINDOW_PURPOSES } from '../constants/verify';
import { consentSelectionSchema } from './consents';

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
  /**
   * Цель `register`: что человек принял ДО отправки SMS (отправка кода — уже обработка
   * номера). Без поля старт регистрации отвергается, SMS не уходит; принятое кладётся в
   * `VerifyChallenge.context`, и записи приёмки строятся ИЗ НЕГО, а не из тела шага 3.
   */
  consents: consentSelectionSchema.optional(),
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
    purpose: z.enum(['password_change', 'phone_change_old', 'phone_change_new', 'keys_manage', 'account_delete', 'security_confirm', 'visibility_reveal', 'visibility_manage', 'data_export']),
    password: z.string().min(1, 'validation.verify.passwordRequired'),
    newPhone: kzMobilePhoneSchema.optional(),
  })
  .refine((v) => v.purpose !== 'phone_change_new' || !!v.newPhone, {
    path: ['newPhone'],
    message: 'validation.verify.newPhoneRequired',
  });

/** POST /verify/check */
export const verifyCheckSchema = z.object({
  challengeId: z.string().uuid(),
  code: z
    .string()
    .regex(new RegExp(`^\\d{${VERIFY_LIMITS.codeLength}}$`), 'validation.verify.code'),
});

/** Одноразовый пропуск, выданный /verify/check (64 hex-символа). */
export const verifyTokenSchema = z.string().regex(/^[a-f0-9]{64}$/, 'validation.verify.token');

/** POST /auth/password-reset — завершение сброса пароля. */
export const passwordResetCompleteSchema = z.object({
  verifyToken: verifyTokenSchema,
  newPassword: passwordSchema,
});

/** POST /users/me/change-password — смена пароля залогиненным (пароль + SMS step-up). */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'validation.verify.currentPasswordRequired'),
  newPassword: passwordSchema,
  verifyToken: verifyTokenSchema,
  // Свой refresh-токен: эта сессия ПЕРЕЖИВАЕТ отзыв (остальные гаснут). Клиенты с `fam` в
  // access-токене (core/audit) его не шлют — текущее семейство сервер знает сам.
  currentRefreshToken: z.string().min(1).optional(),
  // Откуда смена: профиль или мастер «Это не я» (журнал безопасности различает)
  via: z.enum(['settings', 'not_me']).optional(),
});

/** POST /users/me/change-phone — смена номера (пароль + код на старый + код на новый). */
export const changePhoneSchema = z.object({
  password: z.string().min(1, 'validation.verify.passwordRequired'),
  newPhone: kzMobilePhoneSchema,
  oldVerifyToken: verifyTokenSchema, // purpose=phone_change_old, отправлен на ТЕКУЩИЙ номер
  newVerifyToken: verifyTokenSchema, // purpose=phone_change_new, отправлен на НОВЫЙ номер
  currentRefreshToken: z.string().min(1).optional(),
});

/**
 * DELETE /users/me — удаление аккаунта (= отзыв согласия на обработку ПДн): пароль + SMS-пропуск
 * цели `account_delete`. На уровне схемы пропуск опционален: ОБЯЗАТЕЛЬНОСТЬ решает сервер
 * (secure-by-default — в production без него отказ; development/test живут без SMS).
 */
export const deleteAccountSchema = z
  .object({
    password: z.string().min(1, 'validation.verify.passwordRequired'),
    verifyToken: verifyTokenSchema.optional(),
    /** «Стереть все мои сообщения» (мастер удаления): томбстоун вместо текста в чужих чатах */
    eraseMessages: z.boolean().optional(),
  })
  .strict();
export type DeleteAccountInput = z.infer<typeof deleteAccountSchema>;

export type VerifyStartInput = z.infer<typeof verifyStartSchema>;
export type VerifyCheckInput = z.infer<typeof verifyCheckSchema>;
export type PasswordResetCompleteInput = z.infer<typeof passwordResetCompleteSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type ChangePhoneInput = z.infer<typeof changePhoneSchema>;

/** POST /verify/step-up/confirm — гашение пропуска цели с окном → окно (core/verify/step-up.service). */
export const stepUpConfirmSchema = z
  .object({
    purpose: z.enum(STEP_UP_WINDOW_PURPOSES),
    verifyToken: verifyTokenSchema,
  })
  .strict();
export type StepUpConfirmInput = z.infer<typeof stepUpConfirmSchema>;

/** GET /verify/step-up/status?purpose= */
export const stepUpStatusQuerySchema = z.object({ purpose: z.enum(STEP_UP_WINDOW_PURPOSES) }).strict();
