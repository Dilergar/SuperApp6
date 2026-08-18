import axios, { isAxiosError, type AxiosRequestConfig } from 'axios';
import {
  type ApiOk,
  type ShareDriveNodesPage,
  SHARE_SESSION_HEADER,
  type ShareDriveNodeDto,
  type ShareGuestIdentityStartDto,
  type ShareGuestPeekDto,
  type ShareGuestSessionDto,
  type SignCheckResultDto,
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

// Типизированная распаковка конверта — тот же контракт `ApiOk<T>` из shared, что у
// хелперов транспорта, только на гостевом инстансе. ЕДИНСТВЕННОЕ место файла, где
// трогается `.data.data` (для него точечный override в eslint.config.mjs): раньше
// каждый фетчер распаковывал конверт сам из `any`, и типы возвратов были
// утверждениями, а не проверками.
async function guestGet<T>(path: string, config?: AxiosRequestConfig): Promise<T> {
  return (await publicApi.get<ApiOk<T>>(path, config)).data.data;
}
async function guestPost<T>(path: string, body?: unknown, config?: AxiosRequestConfig): Promise<T> {
  return (await publicApi.post<ApiOk<T>>(path, body, config)).data.data;
}

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
): { code?: string; attemptsLeft?: number; retryInSec?: number; resendInSec?: number } | null {
  if (isAxiosError(err)) {
    const details = (err.response?.data as { details?: Record<string, unknown> } | undefined)?.details;
    if (details) return details as { code?: string; attemptsLeft?: number; retryInSec?: number; resendInSec?: number };
  }
  return null;
}

const sessionHeaders = (session: string) => ({ [SHARE_SESSION_HEADER]: session });

/** Шаг 1: жива ли ссылка и нужен ли пароль (открытие не засчитывается) */
export async function sharePeek(token: string): Promise<ShareGuestPeekDto> {
  return guestGet<ShareGuestPeekDto>(`/share-links/guest/${encodeURIComponent(token)}`);
}

/** Шаг 2: открыть ссылку — засчитывается одно открытие */
export async function shareOpenSession(
  token: string,
  opts: { password?: string; verifyToken?: string; guestName?: string } = {},
): Promise<ShareGuestSessionDto> {
  return guestPost<ShareGuestSessionDto>(`/share-links/guest/${encodeURIComponent(token)}/session`, {
    ...(opts.password ? { password: opts.password } : {}),
    ...(opts.verifyToken ? { verifyToken: opts.verifyToken } : {}),
    ...(opts.guestName ? { guestName: opts.guestName } : {}),
  });
}

/** Ссылка требует подтверждение номера: запросить SMS-код (пароль — если ссылка запаролена) */
export async function shareIdentityStart(
  token: string,
  phone: string,
  password?: string,
): Promise<ShareGuestIdentityStartDto> {
  return guestPost<ShareGuestIdentityStartDto>(`/share-links/guest/${encodeURIComponent(token)}/identity/start`, {
    phone,
    ...(password ? { password } : {}),
  });
}

/** Проверка SMS-кода гостя — публичный /verify/check движка подтверждений */
export async function shareVerifyCheck(challengeId: string, code: string): Promise<{ verifyToken: string }> {
  return guestPost<{ verifyToken: string }>('/verify/check', { challengeId, code });
}

/** [dev] Код цепочки — работает только при NODE_ENV development/test, иначе 404 */
export async function shareVerifyDevCode(challengeId: string): Promise<string | null> {
  try {
    const data = await guestGet<{ code?: string | null } | null>('/verify/dev/last-code', {
      params: { challengeId },
    });
    return data?.code ?? null;
  } catch {
    return null;
  }
}

/** Свежее содержимое по действующему пропуску (обновление страницы, протухшие ссылки) */
export async function shareRefreshView(token: string, session: string): Promise<ShareGuestSessionDto> {
  return guestGet<ShareGuestSessionDto>(`/share-links/guest/${encodeURIComponent(token)}/view`, {
    headers: sessionHeaders(session),
  });
}

/** Содержимое папки внутри гостевой ссылки Диска */
export async function shareDriveList(
  session: string,
  params: { parentId?: string; cursor?: string; sort?: string; dir?: string },
): Promise<ShareDriveNodesPage> {
  return guestGet<ShareDriveNodesPage>('/drive/guest/nodes', { headers: sessionHeaders(session), params });
}

/**
 * ДЕЙСТВИЕ гостя над объектом ссылки (движок core/share-links, слот `actions`).
 * Первый потребитель — подпись документа внешним контрагентом.
 */
export async function shareAction<T>(
  token: string,
  session: string,
  key: string,
  body?: unknown,
): Promise<T> {
  return guestPost<T>(`/share-links/guest/${encodeURIComponent(token)}/actions/${key}`, body ?? {}, {
    headers: sessionHeaders(session),
  });
}

/**
 * ПУБЛИЧНАЯ проверка подписи (ст. 61 ЦК РК). Файл при этом НЕ уходит на сервер:
 * отпечаток считает браузер, сюда едет только 64 шестнадцатеричных символа.
 */
export async function signCheck(
  params: { sha256: string } | { actId: string; k: string },
): Promise<SignCheckResultDto> {
  return guestGet<SignCheckResultDto>('/sign/check', { params });
}

/** Один объект внутри ссылки — свежие ссылки на байты для клика «Скачать» */
export async function shareDriveNode(session: string, nodeId: string): Promise<ShareDriveNodeDto> {
  return guestGet<ShareDriveNodeDto>(`/drive/guest/nodes/${nodeId}`, { headers: sessionHeaders(session) });
}

/**
 * Адрес архива папки. Скачивание идёт обычной навигацией браузера, а не через axios:
 * архив собирается потоком и весит гигабайты — принимать его в память вкладки, чтобы
 * потом отдать как blob, нельзя.
 *
 * Отсюда единственное место, где пропуск едет НЕ заголовком, а в адресе: своих
 * заголовков у навигации браузера нет. Размен осознанный и небольшой — пропуск живёт
 * час, привязан к одной ссылке и по правам строго слабее самого адреса `/s/<токен>`,
 * который у гостя и так в адресной строке. Тем же приёмом раздаёт байты движок файлов
 * (подпись в query у `/files/raw`).
 */
export function shareDriveZipUrl(session: string, nodeId?: string): string {
  const params = new URLSearchParams({ session });
  if (nodeId) params.set('nodeId', nodeId);
  return `${API_URL}/drive/guest/download-zip?${params.toString()}`;
}

/**
 * Экземпляр ПОДПИСАНТА: штампованная копия и экспортный пакет по его же ссылке
 * (ст. 62 ЦК — подписанный документ живёт и у второй стороны). Тот же приём с
 * пропуском в адресе, что у ZIP-архива папки.
 */
export function shareSignPackageUrl(session: string, kind: 'stamped' | 'zip'): string {
  const params = new URLSearchParams({ session, kind });
  return `${API_URL}/sign/guest/package?${params.toString()}`;
}
