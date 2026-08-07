import * as SecureStore from 'expo-secure-store';
import { ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY, createApiClient, type TokenStorage } from '@superapp/api-client';

// Mobile-АДАПТЕР транспорта. Сам транспорт — общий пакет `@superapp/api-client`:
// вторая рукописная копия уже успела разъехаться с вебом (не перечитывала хранилище
// после чужой ротации, а провал refresh никуда не вёл — комментарий обещал «сделает
// стор», а стор этого не делал).

// /api/v1 — канонический префикс: установленные нативные сборки пинятся на версию.
const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3001/api/v1';

const secureStorage: TokenStorage = {
  get: (key) => SecureStore.getItemAsync(key),
  set: (key, value) => SecureStore.setItemAsync(key, value),
  remove: (key) => SecureStore.deleteItemAsync(key),
};

const client = createApiClient({
  baseURL: API_URL,
  storage: secureStorage,
  // Навигацию на экран входа делает стор авторизации, подписанный на этот колбэк.
  onAuthFailure: () => {
    onAuthFailureHandler?.();
  },
});

let onAuthFailureHandler: (() => void) | null = null;

/** Стор авторизации регистрирует сюда свой выход — транспорт про навигацию не знает. */
export function setOnAuthFailure(handler: (() => void) | null): void {
  onAuthFailureHandler = handler;
}

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
