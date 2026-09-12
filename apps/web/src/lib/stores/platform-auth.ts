import { create } from 'zustand';
import { isAxiosError } from 'axios';
import type { PlatformMeDto } from '@superapp/shared';
import { PLATFORM_RECENT_KEY, clearPlatformToken, hasPlatformToken, platformGet, platformPost, setPlatformToken } from '../platform-api';

// ============================================================
// Сессия кабинета платформы. Отдельный стор от продуктового `useAuthStore`:
// это другой токен, другая жизнь (без refresh, простой 20 минут) и другой человек
// с точки зрения сервера (сотрудник платформы, а не пользователь продукта).
// ============================================================

export type PlatformAuthStatus = 'idle' | 'loading' | 'ready' | 'anonymous' | 'forbidden';

interface PlatformAuthState {
  me: PlatformMeDto | null;
  status: PlatformAuthStatus;
  hydrate: () => Promise<void>;
  /** Принять токен после входа и подтянуть `me`. */
  applyToken: (token: string) => Promise<void>;
  refreshMe: () => Promise<void>;
  /** Окно sudo обновилось (step-up подтверждён) — без похода за `me`. */
  setSudoUntil: (iso: string | null) => void;
  logout: () => Promise<void>;
}

export const usePlatformAuthStore = create<PlatformAuthState>((set, get) => ({
  me: null,
  status: 'idle',

  hydrate: async () => {
    if (typeof window === 'undefined') return;
    if (!hasPlatformToken()) {
      set({ me: null, status: 'anonymous' });
      return;
    }
    set({ status: 'loading' });
    await get().refreshMe();
  },

  applyToken: async (token) => {
    setPlatformToken(token);
    set({ status: 'loading' });
    await get().refreshMe();
  },

  refreshMe: async () => {
    try {
      const me = await platformGet<PlatformMeDto>('/platform/me');
      set({ me, status: 'ready' });
    } catch (err) {
      const status = isAxiosError(err) ? err.response?.status : undefined;
      if (status === 403) {
        // Токен жив, но человек не сотрудник (приостановлен) — своя страница «нет доступа»
        set({ me: null, status: 'forbidden' });
        return;
      }
      if (status === 401 || status === 404) clearPlatformToken();
      set({ me: null, status: 'anonymous' });
    }
  },

  setSudoUntil: (iso) => {
    const me = get().me;
    if (me) set({ me: { ...me, sudoUntil: iso } });
  },

  logout: async () => {
    try {
      if (hasPlatformToken()) await platformPost('/platform/auth/logout', {});
    } catch {
      /* сессия могла уже истечь — локально всё равно чистим */
    } finally {
      clearPlatformToken();
      // «Недавние» — имена людей, которых смотрел сотрудник: на общем компьютере они
      // переживали бы выход, хотя сервер уже ничего не отдаёт.
      try {
        localStorage.removeItem(PLATFORM_RECENT_KEY);
      } catch {
        /* приватный режим */
      }
      set({ me: null, status: 'anonymous' });
    }
  },
}));
