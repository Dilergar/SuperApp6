import axios from 'axios';
import { createApiClient, ACCESS_TOKEN_KEY, type TokenStorage } from '@superapp/api-client';
import { LOCALE_HEADER, PLATFORM_ACCESS_TOKEN_KEY, type ApiOk } from '@superapp/shared';
import { readLocaleCookie } from '@/i18n/locale';

// ============================================================
// Клиент КАБИНЕТА платформы (core/platform) — второй транспорт со СВОИМ токеном.
//
// Токен кабинета живёт под своим ключом localStorage, без refresh (8 часов, простой
// 20 минут): 401 = сессия мертва → на вход кабинета с возвратом на страницу.
// Продуктовый токен сюда не попадает никогда, токен кабинета — в продукт тоже
// (сервер отвергает и то и другое). Заголовок организации не ставится: кабинет его
// не принимает (400).
// ============================================================

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1';
const LOGIN_PATH = '/platform/login';

const platformStorage: TokenStorage = {
  get: (key) => (typeof window === 'undefined' || key !== ACCESS_TOKEN_KEY ? null : localStorage.getItem(PLATFORM_ACCESS_TOKEN_KEY)),
  set: (key, value) => {
    if (typeof window !== 'undefined' && key === ACCESS_TOKEN_KEY) localStorage.setItem(PLATFORM_ACCESS_TOKEN_KEY, value);
  },
  remove: (key) => {
    if (typeof window !== 'undefined' && key === ACCESS_TOKEN_KEY) localStorage.removeItem(PLATFORM_ACCESS_TOKEN_KEY);
  },
};

const client = createApiClient({
  baseURL: API_URL,
  storage: platformStorage,
  getLocale: () => readLocaleCookie(),
  // Refresh-токена у кабинета нет: транспорт после 401 стирает токен и зовёт нас
  onAuthFailure: () => {
    if (typeof window === 'undefined') return;
    if (window.location.pathname === LOGIN_PATH) return;
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `${LOGIN_PATH}?next=${next}`;
  },
});

export const platformGet = client.apiGet;
export const platformPost = client.apiPost;
export const platformPatch = client.apiPatch;
export const platformDelete = client.apiDelete;

/** Локальный след кабинета: «недавние» карточки поиска (имена людей на устройстве сотрудника). */
export const PLATFORM_RECENT_KEY = 'sa6_platform_recent';

export function hasPlatformToken(): boolean {
  return typeof window !== 'undefined' && !!localStorage.getItem(PLATFORM_ACCESS_TOKEN_KEY);
}
export function setPlatformToken(token: string): void {
  localStorage.setItem(PLATFORM_ACCESS_TOKEN_KEY, token);
}
export function clearPlatformToken(): void {
  localStorage.removeItem(PLATFORM_ACCESS_TOKEN_KEY);
}

/**
 * ПУБЛИЧНЫЕ ручки входа (`/platform/auth/start|login`) и проверка кода (`/verify/check`):
 * отдельный axios БЕЗ перехватчиков. Продуктовый клиент на 401 «неверный пароль» попытался
 * бы обновить ПРОДУКТОВУЮ сессию и увёл бы на /login продукта; клиент кабинета — на вход
 * кабинета. Тут ни того ни другого быть не должно (тот же приём, что у гостевого клиента).
 */
export async function platformPublicPost<T>(path: string, body: unknown): Promise<T> {
  const locale = readLocaleCookie();
  const res = await axios.post<ApiOk<T>>(`${API_URL}${path}`, body, {
    headers: { 'Content-Type': 'application/json', ...(locale ? { [LOCALE_HEADER]: locale } : {}) },
    timeout: 10000,
  });
  const envelope = res.data;
  return envelope.data;
}

export async function platformPublicGet<T>(path: string): Promise<T> {
  const locale = readLocaleCookie();
  const res = await axios.get<ApiOk<T>>(`${API_URL}${path}`, {
    headers: { ...(locale ? { [LOCALE_HEADER]: locale } : {}) },
    timeout: 10000,
  });
  const envelope = res.data;
  return envelope.data;
}

export { apiErrorMessage, apiErrorDetails } from '@superapp/api-client';
