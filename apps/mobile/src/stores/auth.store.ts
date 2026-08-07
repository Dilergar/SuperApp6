import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import type { AuthTokens, RegisterInput, UserProfile } from '@superapp/shared';
import { ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY, apiGet, apiPost, setOnAuthFailure } from '../lib/api';

// Профиль и входные типы — из @superapp/shared, теми же хелперами apiGet<T>/apiPost<T>,
// что и веб (правило «Контракт API ↔ клиенты»). Прежняя версия держала СВОЮ урезанную
// копию `user` на пять полей и читала конверт голым `data.data` — ровно тот класс
// дрейфа, от которого умерло прошлое приложение.

interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: UserProfile | null;

  // Actions
  login: (phone: string, password: string) => Promise<void>;
  /** Вход регистрации описан Zod-схемой на сервере — тип берётся оттуда (`z.infer`). */
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
  loadSession: () => Promise<void>;
  fetchProfile: () => Promise<void>;
}

const setTokens = async (tokens: AuthTokens) => {
  await SecureStore.setItemAsync(ACCESS_TOKEN_KEY, tokens.accessToken);
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, tokens.refreshToken);
};
const clearTokens = async () => {
  await SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY);
  await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
};

export const useAuthStore = create<AuthState>((set, get) => ({
  isAuthenticated: false,
  isLoading: true,
  user: null,

  login: async (phone, password) => {
    const tokens = await apiPost<AuthTokens>('/auth/login', { phone, password });
    await setTokens(tokens);
    set({ isAuthenticated: true });
    await get().fetchProfile();
  },

  register: async (input) => {
    const tokens = await apiPost<AuthTokens>('/auth/register', input);
    await setTokens(tokens);
    set({ isAuthenticated: true });
    await get().fetchProfile();
  },

  logout: async () => {
    try {
      const refreshToken = await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
      if (refreshToken) await apiPost('/auth/logout', { refreshToken });
    } catch {
      // Выход не должен падать из-за сети — локальное состояние стираем в любом случае.
    }
    await clearTokens();
    set({ isAuthenticated: false, user: null });
  },

  loadSession: async () => {
    try {
      const token = await SecureStore.getItemAsync(ACCESS_TOKEN_KEY);
      if (token) {
        set({ isAuthenticated: true });
        await get().fetchProfile();
      }
    } catch {
      // Живой сессии нет — остаёмся на экране входа.
    } finally {
      set({ isLoading: false });
    }
  },

  fetchProfile: async () => {
    try {
      set({ user: await apiGet<UserProfile>('/users/me') });
    } catch {
      // Профиль подтянется при следующем заходе — сессию из-за сбоя сети не рвём.
    }
  },
}));

// Refresh окончательно провалился → транспорт уже стёр токены, здесь сбрасываем стор;
// навигацию на экран входа делает layout по isAuthenticated. Эта регистрация закрывает
// давний разрыв: колбэк был объявлен в адаптере, но его никто не вызывал, и «провал
// refresh никуда не ведёт» оставался правдой.
setOnAuthFailure(() => {
  useAuthStore.setState({ isAuthenticated: false, user: null });
});
