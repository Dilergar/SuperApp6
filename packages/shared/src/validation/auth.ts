import { z } from 'zod';
import { isKzMobilePhone } from '../constants/verify';

// XSS protection: reject HTML tags and dangerous characters
const noHtml = (s: string) => !/[<>]/.test(s);
const noHtmlMsg = 'Недопустимые символы';

// Kazakhstan phone: +7 XXX XXX XX XX
const phoneRegex = /^\+7\d{10}$/;

/**
 * ШИРОКАЯ форма номера (+7 и 10 цифр) — для чтения того, что уже лежит в базе:
 * вход, поиск по номеру, приглашение на чужой номер. Аккаунты, заведённые до
 * гео-щита, обязаны продолжать логиниться.
 */
export const phoneSchema = z
  .string()
  .regex(phoneRegex, 'Номер телефона должен быть в формате +7XXXXXXXXXX');

/**
 * УЗКАЯ форма — казахстанский мобильный. Применяется там, где номер выбирает
 * клиент И движок подтверждений должен послать на него SMS (регистрация,
 * сброс пароля, новый номер при смене). Раньше это ограничение жило только
 * внутри движка, и форма принимала +7 999…, чтобы через шаг ответить 400.
 */
export const kzMobilePhoneSchema = z
  .string()
  .refine(isKzMobilePhone, 'Введите казахстанский мобильный номер: +7 (7XX) XXX-XX-XX');

export const passwordSchema = z
  .string()
  .min(8, 'Пароль должен содержать минимум 8 символов')
  .max(100)
  .refine((p) => /[A-Z]/.test(p), 'Пароль должен содержать заглавную букву')
  .refine((p) => /[a-z]/.test(p), 'Пароль должен содержать строчную букву')
  .refine((p) => /\d/.test(p), 'Пароль должен содержать цифру')
  .refine((p) => /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(p), 'Пароль должен содержать спецсимвол');

// ISO date YYYY-MM-DD, sane human range (1900..today)
export const dateOfBirthSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата рождения должна быть в формате YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return false;
    const year = d.getUTCFullYear();
    return year >= 1900 && d.getTime() <= Date.now();
  }, 'Некорректная дата рождения');

export const loginSchema = z.object({
  phone: phoneSchema,
  password: passwordSchema,
});

export const registerSchema = z.object({
  // Узкая форма: регистрация всегда проходит через SMS-подтверждение (в production —
  // обязательно), а SMS движок шлёт только на казахстанские мобильные.
  phone: kzMobilePhoneSchema,
  password: passwordSchema,
  firstName: z.string().min(1, 'Имя обязательно').max(50).refine(noHtml, noHtmlMsg),
  lastName: z.string().max(50).refine(noHtml, noHtmlMsg).optional(),
  dateOfBirth: dateOfBirthSchema.optional(),
  // Одноразовый пропуск движка подтверждений (POST /verify/check, purpose=register).
  // На уровне схемы опционален: ОБЯЗАТЕЛЬНОСТЬ решает сервер (secure-by-default —
  // в production без него регистрация отклоняется; dev/test живут без SMS).
  verifyToken: z
    .string()
    .regex(/^[a-f0-9]{64}$/, 'Некорректный токен подтверждения')
    .optional(),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1),
});

// ---- Входные типы: ЕДИНСТВЕННОЕ описание формы входа ----
// Рукописные интерфейсы в types/*.ts удалены: два независимых описания одного
// входа расходятся молча (Zod уходил вперёд, интерфейс врал).
export type LoginInput = z.infer<typeof loginSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;
