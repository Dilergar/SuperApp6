import axios, { isAxiosError } from 'axios';

// /api/v1 — канонический префикс (см. main.ts API); /api остаётся legacy-алиасом.
const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1';

export const api = axios.create({
  baseURL: API_URL,
  timeout: 10000,
  headers: { 'Content-Type': 'application/json' },
});

/**
 * Человекочитаемая ошибка API (message из конверта AllExceptionsFilter), а не
 * axios-заглушка «Request failed…». Одна точка для всех алертов/баннеров веба.
 */
export function apiErrorMessage(err: unknown): string {
  if (isAxiosError(err)) {
    const msg = (err.response?.data as { message?: string } | undefined)?.message;
    if (msg) return msg;
  }
  return err instanceof Error ? err.message : String(err);
}

// Attach access token to every request
api.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('accessToken');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
  }
  return config;
});

// ---- Single-flight token refresh ----
// The backend ROTATES the refresh token on every /auth/refresh. Without single-flight,
// N parallel 401s (a page load fires 5+ requests at once) each called refresh with the
// SAME token: the first won, the rest replayed an already-revoked token → random forced
// logouts. Exactly one refresh runs at a time; concurrent 401s await its result.
// Cross-tab: localStorage is re-read inside the (Web-Locks-guarded) critical section,
// so a second tab that already rotated the tokens is picked up instead of replayed.
let refreshInFlight: Promise<string> | null = null;

function refreshAccessToken(): Promise<string> {
  if (refreshInFlight) return refreshInFlight;

  const seenAccess = localStorage.getItem('accessToken');
  const run = async (): Promise<string> => {
    const nowAccess = localStorage.getItem('accessToken');
    if (nowAccess && nowAccess !== seenAccess) return nowAccess; // another tab already rotated
    const refreshToken = localStorage.getItem('refreshToken');
    if (!refreshToken) throw new Error('No refresh token');
    const { data } = await axios.post(`${API_URL}/auth/refresh`, { refreshToken });
    localStorage.setItem('accessToken', data.data.accessToken);
    localStorage.setItem('refreshToken', data.data.refreshToken);
    return data.data.accessToken as string;
  };

  refreshInFlight = (async () => {
    if (typeof navigator !== 'undefined' && 'locks' in navigator) {
      return (await navigator.locks.request('superapp6-token-refresh', run)) as string;
    }
    return run();
  })().finally(() => {
    refreshInFlight = null;
  });
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
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
        if (typeof window !== 'undefined') {
          window.location.href = '/login';
        }
      }
    }

    return Promise.reject(error);
  },
);
