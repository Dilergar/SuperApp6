import {
  createApiClient,
  ACCESS_TOKEN_KEY,
  REFRESH_TOKEN_KEY,
  type TokenStorage,
} from '@superapp/api-client';

// Веб-АДАПТЕР транспорта. Сам транспорт (интерцепторы, single-flight ротация
// refresh, хелперы) живёт в `@superapp/api-client` — общий с mobile, чтобы вторая
// копия не разъехалась с первой (ровно от этого умерло прошлое приложение).
// Здесь только веб-специфика: localStorage и редирект на /login.

// /api/v1 — канонический префикс (см. main.ts API); /api остаётся legacy-алиасом.
const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1';

// SSR-безопасно: на сервере window нет, запросов оттуда мы не делаем.
const webStorage: TokenStorage = {
  get: (key) => (typeof window === 'undefined' ? null : localStorage.getItem(key)),
  set: (key, value) => {
    if (typeof window !== 'undefined') localStorage.setItem(key, value);
  },
  remove: (key) => {
    if (typeof window !== 'undefined') localStorage.removeItem(key);
  },
};

const client = createApiClient({
  baseURL: API_URL,
  storage: webStorage,
  onAuthFailure: () => {
    if (typeof window !== 'undefined') window.location.href = '/login';
  },
  // `getWorkspaceId` НЕ передаётся НАМЕРЕННО: на вебе контекст организации живёт в
  // адресе страницы, а не в глобальном сторе, и глобальный заголовок включил бы
  // chokepoint (скоуп задач, «рабочий пропуск») на ЛИЧНЫХ запросах со страниц
  // /workspaces/*. Страницы организации ставят X-Workspace-Id пер-запросно через
  // config хелперов; точка инъекции — для mobile с его глобальным переключателем.
});

export const api = client.api;
export const apiGet = client.apiGet;
export const apiPost = client.apiPost;
export const apiPatch = client.apiPatch;
export const apiPut = client.apiPut;
export const apiDelete = client.apiDelete;
export const apiGetRaw = client.apiGetRaw;
export const apiPostRaw = client.apiPostRaw;

export { apiErrorMessage, apiErrorDetails } from '@superapp/api-client';
export { ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY };
