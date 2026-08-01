import axios, { isAxiosError } from 'axios';
import {
  SHARE_SESSION_HEADER,
  type ShareDriveNodeDto,
  type ShareGuestPeekDto,
  type ShareGuestSessionDto,
} from '@superapp/shared';

// ============================================================
// Клиент ГОСТЕВЫХ ручек — для человека БЕЗ аккаунта (страница /s/<токен>).
//
// Отдельный инстанс axios БЕЗ единого перехватчика намеренно: обычный `api` на любой
// 401 гасит токены и жёстко уводит на /login. Гостю там делать нечего, и «ссылка
// истекла» превратилось бы в «вас разлогинило». Серверная сторона это правило держит
// со своей стороны (гостевые ручки не отвечают 401 никогда) — здесь второй ремень.
// ============================================================

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1';

export const publicApi = axios.create({
  baseURL: API_URL,
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
});

/** Машиночитаемый код ошибки движка (`details.code`) — по нему ветвится страница */
export function apiErrorCode(err: unknown): string | null {
  return apiErrorDetails(err)?.code ?? null;
}

/**
 * Весь `details` целиком: кроме кода движок кладёт туда числа для человека —
 * сколько попыток осталось и через сколько секунд снимется блокировка подбора.
 */
export function apiErrorDetails(
  err: unknown,
): { code?: string; attemptsLeft?: number; retryInSec?: number } | null {
  if (isAxiosError(err)) {
    const details = (err.response?.data as { details?: Record<string, unknown> } | undefined)?.details;
    if (details) return details as { code?: string; attemptsLeft?: number; retryInSec?: number };
  }
  return null;
}

const sessionHeaders = (session: string) => ({ [SHARE_SESSION_HEADER]: session });

/** Шаг 1: жива ли ссылка и нужен ли пароль (открытие не засчитывается) */
export async function sharePeek(token: string): Promise<ShareGuestPeekDto> {
  const { data } = await publicApi.get(`/share-links/guest/${encodeURIComponent(token)}`);
  return data.data;
}

/** Шаг 2: открыть ссылку — засчитывается одно открытие */
export async function shareOpenSession(token: string, password?: string): Promise<ShareGuestSessionDto> {
  const { data } = await publicApi.post(`/share-links/guest/${encodeURIComponent(token)}/session`, {
    ...(password ? { password } : {}),
  });
  return data.data;
}

/** Свежее содержимое по действующему пропуску (обновление страницы, протухшие ссылки) */
export async function shareRefreshView(token: string, session: string): Promise<ShareGuestSessionDto> {
  const { data } = await publicApi.get(`/share-links/guest/${encodeURIComponent(token)}/view`, {
    headers: sessionHeaders(session),
  });
  return data.data;
}

/** Содержимое папки внутри гостевой ссылки Диска */
export async function shareDriveList(
  session: string,
  params: { parentId?: string; cursor?: string; sort?: string; dir?: string },
): Promise<{ items: ShareDriveNodeDto[]; nextCursor: string | null }> {
  const { data } = await publicApi.get('/drive/guest/nodes', { headers: sessionHeaders(session), params });
  return { items: data.data, nextCursor: data.nextCursor ?? null };
}

/** Один объект внутри ссылки — свежие ссылки на байты для клика «Скачать» */
export async function shareDriveNode(session: string, nodeId: string): Promise<ShareDriveNodeDto> {
  const { data } = await publicApi.get(`/drive/guest/nodes/${nodeId}`, { headers: sessionHeaders(session) });
  return data.data;
}
