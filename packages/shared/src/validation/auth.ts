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

export const loginSchema = z.object({
  phone: phoneSchema,
  password: passwordSchema,
});

export const registerSchema = z.object({
  phone: phoneSchema,
  password: passwordSchema,
  firstName: z.string().min(1, 'Имя обязательно').max(50),
  lastName: z.string().max(50).optional(),
});

export const verifyOtpSchema = z.object({
  phone: phoneSchema,
  code: z.string().length(6, 'Код должен быть 6 цифр'),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1),
});
