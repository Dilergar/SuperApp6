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

/** Ответ `GET /users/me/sessions`. */
export interface SessionInfo {
  id: string;
  /** User-Agent устройства на момент входа; у сессий старше 2026-08-07 — null. */
  deviceInfo: string | null;
  /** ISO. Строка сессии ротируется на каждом refresh, поэтому это «начало текущего цикла». */
  lastActive: string;
  createdAt: string;
  /** Эта сессия — та, из которой пришёл запрос (`sid` в payload access-токена). */
  isCurrent: boolean;
}
