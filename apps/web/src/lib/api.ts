import { readLocaleCookie } from '@/i18n/locale';
import { analytics } from '@/lib/analytics';
import { CONSENTS_PENDING_CODE, CONSENTS_PENDING_EVENT } from '@/lib/consents-events';
import {
  apiErrorDetails,
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
  // ВЫБРАННЫЙ язык (заголовок `X-Locale`): сервер рендерит ПРИ ЧТЕНИИ, и без него
  // он взял бы подсказку браузера — а её маршрутизирует рынок (русский браузер →
  // казахский), то есть выбор человека был бы перебит. Читаем cookie, а не стор:
  // cookie — тот же источник, что у RSC, поэтому серверный и клиентский тексты на
  // одной странице совпадают. Нет выбора (гость) → заголовка нет, решает сервер.
  getLocale: () => readLocaleCookie(),
  // Сессия и устройство аналитики → серверные события запроса ложатся в ту же сессию
  getAnalyticsContext: () => analytics.context(),
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

// Шлюз согласий (core/consents): сервер отвечает `403 consents.pending` на любом запросе, когда
// вступила в силу новая версия обязательного документа. Транспорт только СООБЩАЕТ об этом
// каркасу (событие окна) — экран рисует `ConsentGate`; сам отказ доезжает до вызывающего как есть.
client.api.interceptors.response.use(undefined, (error: unknown) => {
  if (typeof window !== 'undefined' && apiErrorDetails(error)?.code === CONSENTS_PENDING_CODE) {
    window.dispatchEvent(new Event(CONSENTS_PENDING_EVENT));
  }
  return Promise.reject(error);
});
export const apiGet = client.apiGet;
export const apiPost = client.apiPost;
export const apiPatch = client.apiPatch;
export const apiPut = client.apiPut;
export const apiDelete = client.apiDelete;
export const apiGetRaw = client.apiGetRaw;
export const apiPostRaw = client.apiPostRaw;

export { apiErrorMessage } from '@superapp/api-client';
export { apiErrorDetails };
export { ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY };
