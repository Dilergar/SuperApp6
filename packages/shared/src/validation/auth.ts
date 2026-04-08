import { z } from 'zod';

// Kazakhstan phone: +7 XXX XXX XX XX
const phoneRegex = /^\+7\d{10}$/;

export const phoneSchema = z
  .string()
  .regex(phoneRegex, 'Номер телефона должен быть в формате +7XXXXXXXXXX');

export const passwordSchema = z
  .string()
  .min(8, 'Пароль должен содержать минимум 8 символов')
  .max(100);

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
  phone: phoneSchema,
  password: passwordSchema,
  firstName: z.string().min(1, 'Имя обязательно').max(50),
  lastName: z.string().max(50).optional(),
  dateOfBirth: dateOfBirthSchema.optional(),
});

export const verifyOtpSchema = z.object({
  phone: phoneSchema,
  code: z.string().length(6, 'Код должен быть 6 цифр'),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1),
});
