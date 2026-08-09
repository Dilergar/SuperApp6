import type {
  SignActStateDto,
  SignFlowDto,
  SignPepStartDto,
  SignQrStartDto,
  SignStatusDto,
} from '@superapp/shared';
import { apiGet, apiGetRaw, apiPost } from '@/lib/api';

// ============================================================
// Фетчеры движка подписи. Типы — из @superapp/shared и стоят на ОБЕИХ сторонах
// провода; локальных описаний серверных ответов здесь нет и быть не должно
// (правило «Контракт API ↔ клиенты»).
// ============================================================

export const signStatusKey = ['sign', 'status'] as const;
export const signFlowKey = (requestId: string) => ['sign', 'request', requestId] as const;
export const signActStateKey = (actId: string) => ['sign', 'act', actId] as const;

export function fetchSignStatus(): Promise<SignStatusDto> {
  return apiGet<SignStatusDto>('/sign/status');
}

export function fetchSignFlow(requestId: string): Promise<SignFlowDto> {
  return apiGet<SignFlowDto>(`/sign/requests/${requestId}`);
}

/** Открыть подписание ШАГА МАРШРУТА: заявка заводится лениво и идемпотентно */
export function openSignForStep(stepId: string): Promise<SignFlowDto> {
  return apiPost<SignFlowDto>(`/sign/requests/for-step/${stepId}`, {});
}

export function fetchActState(actId: string): Promise<SignActStateDto> {
  return apiGet<SignActStateDto>(`/sign/acts/${actId}/state`);
}

export function startPep(actId: string, pdConsentAccepted?: boolean): Promise<SignPepStartDto> {
  return apiPost<SignPepStartDto>(`/sign/acts/${actId}/pep/start`, {
    consentAccepted: true,
    ...(pdConsentAccepted !== undefined ? { pdConsentAccepted } : {}),
  });
}

export function confirmPep(actId: string, challengeId: string, code: string): Promise<SignActStateDto> {
  return apiPost<SignActStateDto>(`/sign/acts/${actId}/pep/confirm`, { challengeId, code });
}

export function submitCms(actId: string, cms: string): Promise<SignActStateDto> {
  return apiPost<SignActStateDto>(`/sign/acts/${actId}/cms`, { cms });
}

export function startQr(actId: string): Promise<SignQrStartDto> {
  return apiPost<SignQrStartDto>(`/sign/acts/${actId}/qr/start`, {});
}

export function declineSign(actId: string, reason: string): Promise<SignActStateDto> {
  return apiPost<SignActStateDto>(`/sign/acts/${actId}/decline`, { reason });
}

/**
 * Юридические артефакты — БАЙТАМИ через обычный транспорт с токеном.
 *
 * Простой ссылкой их не забрать: браузерная навигация не несёт заголовок
 * Authorization, а токен у платформы живёт в localStorage, не в cookie, — «Протокол»
 * и «Пакет с подписями» по ссылке отвечали 401, то есть обе выгрузки, которых
 * требует ст. 62 ЦК, были недостижимы.
 */
export function fetchSignProtocol(requestId: string): Promise<Blob> {
  return apiGetRaw<Blob>(`/sign/requests/${requestId}/protocol`, { responseType: 'blob' });
}

export function fetchSignExport(requestId: string): Promise<Blob> {
  return apiGetRaw<Blob>(`/sign/requests/${requestId}/export`, { responseType: 'blob' });
}

/** Отдать пользователю готовые байты файлом */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Освобождаем адрес не сразу: Safari успевает начать скачивание не мгновенно.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Код цепочки в dev — та же подсказка, что у регистрации и сбросов */
export function fetchDevCode(challengeId: string): Promise<{ code: string | null }> {
  return apiGet<{ code: string | null }>(`/verify/dev/last-code?challengeId=${challengeId}`);
}
