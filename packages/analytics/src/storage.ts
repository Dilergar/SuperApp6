/**
 * Хранилище SDK. Веб — localStorage; mobile — адаптер поверх AsyncStorage/MMKV (этап 2),
 * поэтому контракт допускает и синхронные, и асинхронные значения.
 */
export interface AnalyticsStorageAdapter {
  get(key: string): string | null | Promise<string | null>;
  set(key: string, value: string): void | Promise<void>;
  remove(key: string): void | Promise<void>;
}

/** localStorage с защитой от SSR и приватного режима (квота, запрет доступа). */
export function webStorageAdapter(): AnalyticsStorageAdapter {
  const ls = (): Storage | null => {
    try {
      return typeof window !== 'undefined' ? window.localStorage : null;
    } catch {
      return null;
    }
  };
  return {
    get: (key) => {
      try {
        return ls()?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set: (key, value) => {
      try {
        ls()?.setItem(key, value);
      } catch {
        /* квота или запрет — SDK живёт в памяти */
      }
    },
    remove: (key) => {
      try {
        ls()?.removeItem(key);
      } catch {
        /* нет доступа */
      }
    },
  };
}

/** Хранилище в памяти (тесты, SSR, окружения без localStorage). */
export function memoryStorageAdapter(): AnalyticsStorageAdapter {
  const map = new Map<string, string>();
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => void map.set(key, value),
    remove: (key) => void map.delete(key),
  };
}
