// Входные формы (`/auth/login`, `/auth/register`, `/auth/refresh`) описаны ОДИН раз —
// Zod-схемами в `validation/auth.ts`; тип берётся оттуда через `z.infer`
// (`LoginInput`/`RegisterInput`/`RefreshTokenInput`). Рукописные интерфейсы здесь
// были вторым описанием и уже успели соврать: `registerSchema` несёт `verifyToken`
// (обязателен в production с 2026-07-25), а интерфейс о нём не знал.

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Секунды жизни access-токена. */
  expiresIn: number;
}

