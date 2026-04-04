import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import { api } from '../lib/api';

interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: {
    id: string;
    phone: string;
    firstName: string;
    lastName: string | null;
    avatar: string | null;
  } | null;

  // Actions
  login: (phone: string, password: string) => Promise<void>;
  register: (data: { phone: string; password: string; firstName: string; lastName?: string }) => Promise<void>;
  logout: () => Promise<void>;
  loadSession: () => Promise<void>;
  fetchProfile: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  isAuthenticated: false,
  isLoading: true,
  user: null,

  login: async (phone, password) => {
    const { data } = await api.post('/auth/login', { phone, password });
    await SecureStore.setItemAsync('accessToken', data.data.accessToken);
    await SecureStore.setItemAsync('refreshToken', data.data.refreshToken);
    set({ isAuthenticated: true });
    await get().fetchProfile();
  },

  register: async (regData) => {
    const { data } = await api.post('/auth/register', regData);
    await SecureStore.setItemAsync('accessToken', data.data.accessToken);
    await SecureStore.setItemAsync('refreshToken', data.data.refreshToken);
    set({ isAuthenticated: true });
    await get().fetchProfile();
  },

  logout: async () => {
    try {
      const refreshToken = await SecureStore.getItemAsync('refreshToken');
      if (refreshToken) {
        await api.post('/auth/logout', { refreshToken });
      }
    } catch {
      // Ignore errors during logout
    }
    await SecureStore.deleteItemAsync('accessToken');
    await SecureStore.deleteItemAsync('refreshToken');
    set({ isAuthenticated: false, user: null });
  },

  loadSession: async () => {
    try {
      const token = await SecureStore.getItemAsync('accessToken');
      if (token) {
        set({ isAuthenticated: true });
        await get().fetchProfile();
      }
    } catch {
      // No valid session
    } finally {
      set({ isLoading: false });
    }
  },

  fetchProfile: async () => {
    try {
      const { data } = await api.get('/users/me');
      set({ user: data.data });
    } catch {
      // Profile fetch failed
    }
  },
}));
