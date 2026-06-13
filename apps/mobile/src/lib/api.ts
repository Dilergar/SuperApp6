import axios from 'axios';
import * as SecureStore from 'expo-secure-store';

// /api/v1 — канонический префикс: установленные нативные сборки пинятся на версию.
const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3001/api/v1';

export const api = axios.create({
  baseURL: API_URL,
  timeout: 10000,
  headers: { 'Content-Type': 'application/json' },
});

// Attach access token to every request
api.interceptors.request.use(async (config) => {
  const token = await SecureStore.getItemAsync('accessToken');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// ---- Single-flight token refresh ----
// The backend ROTATES the refresh token on every /auth/refresh. On a cold app start the
// access token is always expired and several screens fire requests at once — without
// single-flight each parallel 401 called refresh with the SAME token (first wins, the
// rest replay a revoked token → daily forced logout). One refresh at a time.
let refreshInFlight: Promise<string> | null = null;

function refreshAccessToken(): Promise<string> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const refreshToken = await SecureStore.getItemAsync('refreshToken');
      if (!refreshToken) throw new Error('No refresh token');
      const { data } = await axios.post(`${API_URL}/auth/refresh`, { refreshToken });
      await SecureStore.setItemAsync('accessToken', data.data.accessToken);
      await SecureStore.setItemAsync('refreshToken', data.data.refreshToken);
      return data.data.accessToken as string;
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

// Auto-refresh token on 401
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;

      try {
        const accessToken = await refreshAccessToken();
        originalRequest.headers.Authorization = `Bearer ${accessToken}`;
        return api(originalRequest);
      } catch {
        // Refresh failed — logout
        await SecureStore.deleteItemAsync('accessToken');
        await SecureStore.deleteItemAsync('refreshToken');
        // Navigation to login will be handled by auth store
      }
    }

    return Promise.reject(error);
  },
);
