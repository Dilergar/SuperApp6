import { create } from 'zustand';
import { api } from '../api';

export interface UserRole {
  role: string;
  context: string;
  tenantId: string | null;
}

export interface UserProfile {
  id: string;
  phone: string;
  firstName: string;
  lastName?: string | null;
  dateOfBirth?: string | null;
  avatar?: string | null;
  email?: string | null;
  roles: UserRole[];
  activeSubscription?: { plan: string; status: string; expiresAt: string } | null;
  circlesCount?: number;
  workspacesCount?: number;
  contactsCount?: number;
}

interface AuthState {
  user: UserProfile | null;
  isAuthenticated: boolean;
  isHydrated: boolean;

  // Actions
  hydrate: () => Promise<void>;
  login: (phone: string, password: string) => Promise<void>;
  register: (input: {
    phone: string;
    password: string;
    firstName: string;
    lastName?: string;
    dateOfBirth?: string;
  }) => Promise<void>;
  logout: () => Promise<void>;
  fetchProfile: () => Promise<void>;
}

const ACCESS_TOKEN_KEY = 'accessToken';
const REFRESH_TOKEN_KEY = 'refreshToken';

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
      const { data } = await api.get('/users/me');
      set({ user: data.data, isAuthenticated: true, isHydrated: true });
    } catch {
      clearTokens();
      set({ user: null, isAuthenticated: false, isHydrated: true });
    }
  },

  login: async (phone, password) => {
    const { data } = await api.post('/auth/login', { phone, password });
    setTokens(data.data.accessToken, data.data.refreshToken);
    await get().fetchProfile();
  },

  register: async (input) => {
    const { data } = await api.post('/auth/register', input);
    setTokens(data.data.accessToken, data.data.refreshToken);
    await get().fetchProfile();
  },

  logout: async () => {
    const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
    try {
      if (refreshToken) {
        await api.post('/auth/logout', { refreshToken });
      }
    } catch {
      // Ignore — still clear local state
    } finally {
      clearTokens();
      set({ user: null, isAuthenticated: false });
    }
  },

  fetchProfile: async () => {
    const { data } = await api.get('/users/me');
    set({ user: data.data, isAuthenticated: true });
  },
}));
