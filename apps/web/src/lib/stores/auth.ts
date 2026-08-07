import { create } from 'zustand';
import { isAxiosError } from 'axios';
import type { AuthTokens, RegisterInput, UserProfile } from '@superapp/shared';
import { ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY, apiGet, apiPost } from '../api';
import { resetSessionCaches } from '../session-reset';

// Локального `UserProfile` здесь БОЛЬШЕ НЕТ: он был урезанной копией серверного
// (без реквизитов, без companyCardVisibility, почти всё optional), из-за чего
// `/profile` жил на трёх кастах, а переименование поля на сервере компилятор поймать
// не мог. Тип берётся из @superapp/shared и стоит на обеих сторонах провода.

interface AuthState {
  user: UserProfile | null;
  isAuthenticated: boolean;
  isHydrated: boolean;

  // Actions
  hydrate: () => Promise<void>;
  login: (phone: string, password: string) => Promise<void>;
  /** Вход регистрации описан Zod-схемой на сервере — тип берётся оттуда (`z.infer`). */
  register: (input: RegisterInput) => Promise<void>;
  /** Принять готовую пару токенов (автовход после сброса пароля) и подтянуть профиль. */
  applySession: (tokens: { accessToken: string; refreshToken: string }) => Promise<void>;
  logout: () => Promise<void>;
  fetchProfile: () => Promise<void>;
}

// Ключи хранилища — ИЗ АДАПТЕРА транспорта (единая точка с интерцепторами):
// своя копия литералов уже успела разойтись по трём файлам.
const setTokens = (accessToken: string, refreshToken: string) => {
  localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
  localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
};

const clearTokens = () => {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
};

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  isAuthenticated: false,
  isHydrated: false,

  // Called once on app mount — restores session from localStorage
  hydrate: async () => {
    if (typeof window === 'undefined') return;
    const token = localStorage.getItem(ACCESS_TOKEN_KEY);
    if (!token) {
      set({ isHydrated: true });
      return;
    }
    try {
      set({ user: await apiGet<UserProfile>('/users/me'), isAuthenticated: true, isHydrated: true });
    } catch (err) {
      // Токены сносим ТОЛЬКО когда сервер отказал в доступе. 401 сюда долетает уже
      // после неудачной попытки обновления (интерсептор в lib/api), то есть сессия
      // действительно мертва. А вот 500, таймаут и оффлайн — не повод: раньше любой
      // блип API на старте уничтожал refresh-токен и выкидывал человека вводить
      // пароль заново.
      const status = isAxiosError(err) ? err.response?.status : undefined;
      const rejected = status === 401 || status === 403;
      if (rejected) clearTokens();
      set({ user: null, isAuthenticated: false, isHydrated: true });
    }
  },

  login: async (phone, password) => {
    const tokens = await apiPost<AuthTokens>('/auth/login', { phone, password });
    // Второй ремень к сбросу в logout: на /login можно прийти и не выходя (ссылкой),
    // и тогда чужой кэш дожил бы до входа следующего человека.
    resetSessionCaches();
    setTokens(tokens.accessToken, tokens.refreshToken);
    await get().fetchProfile();
  },

  register: async (input) => {
    const tokens = await apiPost<AuthTokens>('/auth/register', input);
    setTokens(tokens.accessToken, tokens.refreshToken);
    await get().fetchProfile();
  },

  applySession: async ({ accessToken, refreshToken }) => {
    resetSessionCaches();
    setTokens(accessToken, refreshToken);
    await get().fetchProfile();
  },

  logout: async () => {
    const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
    try {
      if (refreshToken) {
        await apiPost('/auth/logout', { refreshToken });
      }
    } catch {
      // Ignore — still clear local state
    } finally {
      clearTokens();
      set({ user: null, isAuthenticated: false });
      // Выход — клиентский переход, вкладка не перезагружается: без явного сброса
      // кэши пережили бы смену аккаунта (см. lib/session-reset).
      resetSessionCaches();
    }
  },

  fetchProfile: async () => {
    set({ user: await apiGet<UserProfile>('/users/me'), isAuthenticated: true });
  },
}));
