import axios, {
  isAxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type InternalAxiosRequestConfig,
} from 'axios';
import type { ApiOk } from '@superapp/shared';

/**
 * Хранилище токенов. Синхронное на вебе (localStorage), асинхронное на mobile
 * (expo-secure-store) — поэтому контракт допускает и то, и другое: транспорт
 * везде делает `await`.
 */
export interface TokenStorage {
  get(key: string): string | null | Promise<string | null>;
  set(key: string, value: string): void | Promise<void>;
  remove(key: string): void | Promise<void>;
}

export interface ApiClientConfig {
  /** Базовый адрес API, включая версию: `…/api/v1`. */
  baseURL: string;
  storage: TokenStorage;
  /**
   * Сессия окончательно мертва (refresh не удался). Веб — редирект на /login,
   * mobile — сброс стора и навигация. Токены транспорт стирает сам ДО вызова.
   */
  onAuthFailure?: () => void;
  /** Контекст организации: вернуть id → уедет заголовком `X-Workspace-Id` на каждом запросе. */
  getWorkspaceId?: () => string | null;
  /** Таймаут по умолчанию, мс (0 = без таймаута). Загрузки файлов переопределяют его в конфиге вызова. */
  timeout?: number;
}

export const ACCESS_TOKEN_KEY = 'accessToken';
export const REFRESH_TOKEN_KEY = 'refreshToken';

export interface ApiClient {
  /** Сырой axios-инстанс. Нужен транспортным краям (загрузка файлов, отмена) — не для чтения DTO. */
  api: AxiosInstance;
  apiGet<T>(path: string, config?: AxiosRequestConfig): Promise<T>;
  apiPost<T = void>(path: string, body?: unknown, config?: AxiosRequestConfig): Promise<T>;
  apiPatch<T = void>(path: string, body?: unknown, config?: AxiosRequestConfig): Promise<T>;
  apiPut<T = void>(path: string, body?: unknown, config?: AxiosRequestConfig): Promise<T>;
  apiDelete<T = void>(path: string, config?: AxiosRequestConfig): Promise<T>;
  /** Тело ответа ЦЕЛИКОМ — для конвертов с полями рядом с `data`. */
  apiGetRaw<TBody>(path: string, config?: AxiosRequestConfig): Promise<TBody>;
  apiPostRaw<TBody>(path: string, body?: unknown, config?: AxiosRequestConfig): Promise<TBody>;
}

type RetriableConfig = InternalAxiosRequestConfig & { _retry?: boolean };

/**
 * Межвкладочный замок: на вебе есть Web Locks (вторая вкладка ждёт, а не ротирует
 * наперегонки), в React Native его нет — там достаточно модульного промиса, потому
 * что процесс один.
 */
function withLock<T>(name: string, run: () => Promise<T>): Promise<T> {
  const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }) : undefined;
  if (nav?.locks) return nav.locks.request(name, run) as Promise<T>;
  return run();
}

export function createApiClient(config: ApiClientConfig): ApiClient {
  const { baseURL, storage, onAuthFailure, getWorkspaceId } = config;

  const api = axios.create({
    baseURL,
    timeout: config.timeout ?? 10000,
    headers: { 'Content-Type': 'application/json' },
  });

  api.interceptors.request.use(async (cfg) => {
    const token = await storage.get(ACCESS_TOKEN_KEY);
    if (token) cfg.headers.Authorization = `Bearer ${token}`;
    const workspaceId = getWorkspaceId?.();
    if (workspaceId) cfg.headers['X-Workspace-Id'] = workspaceId;
    return cfg;
  });

  // ---- Single-flight token refresh ----
  // Бэкенд РОТИРУЕТ refresh-токен на каждом /auth/refresh. Без single-flight N
  // параллельных 401 (загрузка страницы стреляет 5+ запросами разом) звали refresh с
  // ОДНИМ И ТЕМ ЖЕ токеном: первый выигрывал, остальные повторяли уже отозванный →
  // случайные разлогины. Ротация идёт строго по одной, остальные ждут её результат.
  // Межвкладочность: хранилище перечитывается ВНУТРИ критической секции, поэтому
  // вкладка, чей сосед уже ротировал, подхватывает свежий токен, а не повторяет старый.
  let refreshInFlight: Promise<string> | null = null;

  function refreshAccessToken(): Promise<string> {
    if (refreshInFlight) return refreshInFlight;

    const seenAccessPromise = Promise.resolve(storage.get(ACCESS_TOKEN_KEY));

    const run = async (): Promise<string> => {
      const seenAccess = await seenAccessPromise;
      const nowAccess = await storage.get(ACCESS_TOKEN_KEY);
      if (nowAccess && nowAccess !== seenAccess) return nowAccess; // сосед уже ротировал
      const refreshToken = await storage.get(REFRESH_TOKEN_KEY);
      if (!refreshToken) throw new Error('No refresh token');
      const { data } = await axios.post<ApiOk<{ accessToken: string; refreshToken: string }>>(
        `${baseURL}/auth/refresh`,
        { refreshToken },
      );
      await storage.set(ACCESS_TOKEN_KEY, data.data.accessToken);
      await storage.set(REFRESH_TOKEN_KEY, data.data.refreshToken);
      return data.data.accessToken;
    };

    refreshInFlight = withLock('superapp6-token-refresh', run).finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  }

  api.interceptors.response.use(
    (response) => response,
    async (error: unknown) => {
      const originalRequest = isAxiosError(error) ? (error.config as RetriableConfig | undefined) : undefined;

      if (isAxiosError(error) && error.response?.status === 401 && originalRequest && !originalRequest._retry) {
        originalRequest._retry = true;
        try {
          const accessToken = await refreshAccessToken();
          originalRequest.headers.Authorization = `Bearer ${accessToken}`;
          return api(originalRequest);
        } catch {
          await storage.remove(ACCESS_TOKEN_KEY);
          await storage.remove(REFRESH_TOKEN_KEY);
          onAuthFailure?.();
        }
      }

      return Promise.reject(error);
    },
  );

  // ---- Типизированные хелперы границы (CLAUDE.md → «Контракт API ↔ клиенты») ----
  // Единственный законный способ ходить в API из клиента: T берётся из
  // @superapp/shared, и единственный `as` границы живёт здесь, а не в сотнях мест.
  // Голый `api.get(...).data.data as X` запрещён линтером: такой каст глушит
  // компилятор, и поле, переименованное на сервере, молча становится undefined на
  // экране (так умерло прошлое mobile-приложение).
  return {
    api,
    async apiGet<T>(path: string, cfg?: AxiosRequestConfig): Promise<T> {
      return (await api.get<ApiOk<T>>(path, cfg)).data.data;
    },
    async apiPost<T = void>(path: string, body?: unknown, cfg?: AxiosRequestConfig): Promise<T> {
      return (await api.post<ApiOk<T>>(path, body, cfg)).data.data;
    },
    async apiPatch<T = void>(path: string, body?: unknown, cfg?: AxiosRequestConfig): Promise<T> {
      return (await api.patch<ApiOk<T>>(path, body, cfg)).data.data;
    },
    async apiPut<T = void>(path: string, body?: unknown, cfg?: AxiosRequestConfig): Promise<T> {
      return (await api.put<ApiOk<T>>(path, body, cfg)).data.data;
    },
    async apiDelete<T = void>(path: string, cfg?: AxiosRequestConfig): Promise<T> {
      return (await api.delete<ApiOk<T>>(path, cfg)).data.data;
    },
    async apiGetRaw<TBody>(path: string, cfg?: AxiosRequestConfig): Promise<TBody> {
      return (await api.get<TBody>(path, cfg)).data;
    },
    async apiPostRaw<TBody>(path: string, body?: unknown, cfg?: AxiosRequestConfig): Promise<TBody> {
      return (await api.post<TBody>(path, body, cfg)).data;
    },
  };
}

/**
 * Человекочитаемая ошибка API (`message` из конверта AllExceptionsFilter), а не
 * axios-заглушка «Request failed…». Одна точка для всех тостов/баннеров клиентов.
 */
export function apiErrorMessage(err: unknown): string {
  if (isAxiosError(err)) {
    const msg = (err.response?.data as { message?: string } | undefined)?.message;
    if (msg) return msg;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Машиночитаемые детали отказа (`details.code` и т.п.) — клиент не ветвится по русскому тексту. */
export function apiErrorDetails(err: unknown): Record<string, unknown> | undefined {
  if (isAxiosError(err)) {
    return (err.response?.data as { details?: Record<string, unknown> } | undefined)?.details;
  }
  return undefined;
}
