import axios, {
  isAxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type InternalAxiosRequestConfig,
} from 'axios';
import {
  ANALYTICS_HEADERS,
  IDEMPOTENCY_ERROR_CODES,
  IDEMPOTENCY_KEY_HEADER,
  LOCALE_HEADER,
  SHOULD_RETRY_HEADER,
  type ApiOk,
} from '@superapp/shared';

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
  /**
   * ВЫБРАННЫЙ человеком язык: вернуть код (`kk`/`ru`/`en`) → уедет заголовком
   * `X-Locale`, и сервер ответит именно на нём (тексты уведомлений, хроники и
   * отказов рендерятся при чтении).
   *
   * Отдельный заголовок, а не `Accept-Language`: тот — подсказка браузера, и
   * сервер вправе её маршрутизировать под рынок. Выбор человека маршруту не
   * подчиняется. Не задан → сервер решает сам по `Accept-Language` (гость).
   */
  getLocale?: () => string | null | undefined;
  /**
   * Контекст аналитики (`@superapp/analytics`): сессия и устройство клиента → заголовки
   * `X-Analytics-Session` / `X-Analytics-Device`. Сервер кладёт их в серверные события
   * этого запроса (создал задачу — в той же сессии, что и открыл страницу). `null` —
   * человек отказался от аналитики, заголовков нет.
   */
  getAnalyticsContext?: () => { sessionId: string; deviceId: string } | null;
  /** Таймаут по умолчанию, мс (0 = без таймаута). Загрузки файлов переопределяют его в конфиге вызова. */
  timeout?: number;
}

export const ACCESS_TOKEN_KEY = 'accessToken';
export const REFRESH_TOKEN_KEY = 'refreshToken';

export interface ApiClient {
  /** Сырой axios-инстанс. Нужен транспортным краям (загрузка файлов, отмена) — не для чтения DTO. */
  api: AxiosInstance;
  apiGet<T>(path: string, config?: AxiosRequestConfig): Promise<T>;
  apiPost<T = void>(path: string, body?: unknown, config?: IdempotentRequestConfig): Promise<T>;
  apiPatch<T = void>(path: string, body?: unknown, config?: IdempotentRequestConfig): Promise<T>;
  apiPut<T = void>(path: string, body?: unknown, config?: IdempotentRequestConfig): Promise<T>;
  apiDelete<T = void>(path: string, config?: IdempotentRequestConfig): Promise<T>;
  /** Тело ответа ЦЕЛИКОМ — для конвертов с полями рядом с `data`. */
  apiGetRaw<TBody>(path: string, config?: AxiosRequestConfig): Promise<TBody>;
  apiPostRaw<TBody>(path: string, body?: unknown, config?: IdempotentRequestConfig): Promise<TBody>;
}

type RetriableConfig = InternalAxiosRequestConfig & {
  _retry?: boolean;
  /** Сколько раз транспорт УЖЕ повторял этот запрос сам (авто-повтор) */
  _idemAttempts?: number;
};

/** Конфиг вызова с опцией ключа повтора: хелперы принимают его напрямую. */
export interface IdempotentRequestConfig extends AxiosRequestConfig {
  /**
   * Ключ повтора для ЭТОЙ мутации. Не задан — транспорт сгенерирует свой (одна
   * попытка = один ключ). Веб передаёт сюда ключ НАМЕРЕНИЯ формы (`useIdempotencyKey`):
   * тогда двойной клик и повтор после обрыва — одно и то же намерение, а не два.
   */
  idempotencyKey?: string;
}

const MUTATIONS = new Set(['post', 'patch', 'put', 'delete']);

/** Статусы, после которых повтор ОСМЫСЛЕН (сервер не дошёл до дела либо просит подождать). */
const RETRIABLE_STATUSES = new Set([502, 503, 504]);

/** Потолок авто-повторов транспорта: больше — это уже не сеть, а отказ. */
const MAX_AUTO_RETRIES = 3;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8000;

/**
 * Пауза перед повтором: full jitter (AWS Builders' Library) — без него N клиентов,
 * оборвавшихся на одной секунде, вернутся ровно одной волной.
 */
function backoffMs(attempt: number): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.random() * ceiling;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** uuid из веб-крипто; в средах без него (старый RN) — случайная строка того же алфавита. */
function newKey(): string {
  const c = typeof globalThis !== 'undefined' ? (globalThis as { crypto?: Crypto }).crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  let out = '';
  for (let i = 0; i < 32; i++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

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
  const { baseURL, storage, onAuthFailure, getWorkspaceId, getLocale, getAnalyticsContext } = config;

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
    // Ставим ТОЛЬКО когда выбор действительно есть: у гостя его нет, и решать
    // за него должен сервер по `Accept-Language` браузера.
    const locale = getLocale?.();
    if (locale) cfg.headers[LOCALE_HEADER] = locale;
    // Ключ повтора (core/idempotency) на КАЖДОЙ мутации. Живёт в config запроса,
    // поэтому и 401→refresh, и авто-повтор ниже уходят с ТЕМ ЖЕ ключом — сервер
    // видит одно намерение, а не N разных.
    //
    // Анонимные запросы (без `Authorization`) ключа не получают НАМЕРЕННО: без
    // принципала скоуп собрать не из чего, и ключ был бы украшением, а не защитой.
    const method = (cfg.method ?? 'get').toLowerCase();
    if (MUTATIONS.has(method) && cfg.headers.Authorization) {
      const explicit = (cfg as AxiosRequestConfig & { idempotencyKey?: string }).idempotencyKey;
      if (!cfg.headers[IDEMPOTENCY_KEY_HEADER]) cfg.headers[IDEMPOTENCY_KEY_HEADER] = explicit ?? newKey();
    }
    // Отказ SDK аналитики не должен ломать ни один запрос — контекст best-effort
    try {
      const analytics = getAnalyticsContext?.();
      if (analytics) {
        cfg.headers[ANALYTICS_HEADERS.session] = analytics.sessionId;
        cfg.headers[ANALYTICS_HEADERS.device] = analytics.deviceId;
      }
    } catch {
      /* без заголовков аналитики */
    }
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

  /**
   * Стоит ли повторять САМОМУ, не спрашивая человека. Повтор безопасен ровно
   * потому, что мутация ушла с ключом повтора: сервер либо исполнит её впервые,
   * либо вернёт исход первой попытки.
   */
  function shouldAutoRetry(error: unknown, cfg: RetriableConfig | undefined): boolean {
    if (!cfg || !isAxiosError(error)) return false;
    const method = (cfg.method ?? 'get').toLowerCase();
    if (!MUTATIONS.has(method)) return false;
    // Без ключа повторять нельзя: эффект случился бы дважды
    if (!cfg.headers?.[IDEMPOTENCY_KEY_HEADER]) return false;
    // multipart: тело — поток, второй раз его не отправить (и сервер его не отпечатывает)
    const contentType = String(cfg.headers?.['Content-Type'] ?? '');
    if (contentType.toLowerCase().startsWith('multipart/form-data')) return false;
    if ((cfg._idemAttempts ?? 0) >= MAX_AUTO_RETRIES) return false;

    const res = error.response;
    // Ответа нет вовсе: обрыв, таймаут, сеть — исход неизвестен, а ключ его защищает
    if (!res) return true;
    // Сервер сказал явно
    const hint = String(res.headers?.[SHOULD_RETRY_HEADER.toLowerCase()] ?? '');
    if (hint === 'false') return false;
    if (hint === 'true') return true;
    if (RETRIABLE_STATUSES.has(res.status)) return true;
    const code = (res.data as { details?: { code?: string } } | undefined)?.details?.code;
    return res.status === 409 && code === IDEMPOTENCY_ERROR_CODES.inFlight;
  }

  api.interceptors.response.use(
    (response) => response,
    async (error: unknown) => {
      const originalRequest = isAxiosError(error) ? (error.config as RetriableConfig | undefined) : undefined;

      if (shouldAutoRetry(error, originalRequest) && originalRequest) {
        originalRequest._idemAttempts = (originalRequest._idemAttempts ?? 0) + 1;
        // `Retry-After` сервера сильнее нашей паузы: он знает, сколько ещё держит аренду
        const after = Number(
          isAxiosError(error) ? (error.response?.headers?.['retry-after'] as string | undefined) : undefined,
        );
        const wait = Number.isFinite(after) && after > 0 ? Math.min(after * 1000, BACKOFF_CAP_MS) : backoffMs(originalRequest._idemAttempts);
        await sleep(wait);
        return api(originalRequest);
      }

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
    async apiPost<T = void>(path: string, body?: unknown, cfg?: IdempotentRequestConfig): Promise<T> {
      return (await api.post<ApiOk<T>>(path, body, cfg)).data.data;
    },
    async apiPatch<T = void>(path: string, body?: unknown, cfg?: IdempotentRequestConfig): Promise<T> {
      return (await api.patch<ApiOk<T>>(path, body, cfg)).data.data;
    },
    async apiPut<T = void>(path: string, body?: unknown, cfg?: IdempotentRequestConfig): Promise<T> {
      return (await api.put<ApiOk<T>>(path, body, cfg)).data.data;
    },
    async apiDelete<T = void>(path: string, cfg?: IdempotentRequestConfig): Promise<T> {
      return (await api.delete<ApiOk<T>>(path, cfg)).data.data;
    },
    async apiGetRaw<TBody>(path: string, cfg?: AxiosRequestConfig): Promise<TBody> {
      return (await api.get<TBody>(path, cfg)).data;
    },
    async apiPostRaw<TBody>(path: string, body?: unknown, cfg?: IdempotentRequestConfig): Promise<TBody> {
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
