import type {
  CallRecordingDto,
  CallsStatusDto,
  CallTokenDto,
  CallTokenInput,
  ChatCallStatePayload,
} from '@superapp/shared';
import { apiGet, apiPost } from './api';

// ============================================================
// Движок звонков (core/calls) — API-клиент веба
// ============================================================

export async function getCallsStatus(): Promise<CallsStatusDto> {
  return apiGet<CallsStatusDto>('/calls/status');
}

/** Токен входа в звонок сущности (доступ решает резолвер refType на бэке) */
export async function getCallToken(input: CallTokenInput): Promise<CallTokenDto> {
  return apiPost<CallTokenDto>('/calls/token', input);
}

/** Завершить созвон для всех (модератор): комната удаляется, у всех disconnect */
export async function endCallSession(sessionId: string): Promise<void> {
  await apiPost(`/calls/rooms/${sessionId}/end`, {});
}

/** Живые звонки моих чатов — watcher входящих при загрузке/reconnect (холодный старт) */
export async function getMyActiveChatCalls(): Promise<ChatCallStatePayload[]> {
  const res = await apiGet<{ items: ChatCallStatePayload[] }>('/messenger/calls/active');
  return res.items;
}

/** Исключить участника из звонка (модератор) */
export async function kickCallParticipant(sessionId: string, userId: string): Promise<void> {
  await apiPost(`/calls/rooms/${sessionId}/kick`, { userId });
}

/** ⏺ Начать запись созвона (участник; всем загорается индикатор «● Запись») */
export async function startCallRecording(sessionId: string): Promise<CallRecordingDto> {
  return apiPost<CallRecordingDto>(`/calls/rooms/${sessionId}/recording/start`, {});
}

/** ⏹ Остановить запись (инициатор записи или модератор) */
export async function stopCallRecording(sessionId: string): Promise<CallRecordingDto> {
  return apiPost<CallRecordingDto>(`/calls/rooms/${sessionId}/recording/stop`, {});
}

/** «Получить запись»: полная запись придёт в мой Диктофон → «Журнал звонков» */
export async function claimCallRecording(sessionId: string): Promise<CallRecordingDto> {
  return apiPost<CallRecordingDto>(`/calls/rooms/${sessionId}/recording/claim`, {});
}

/** Принудительно замьютить трек участника (модератор) */
export async function muteCallTrack(
  sessionId: string,
  userId: string,
  trackSid: string,
  muted: boolean,
): Promise<void> {
  await apiPost(`/calls/rooms/${sessionId}/mute`, { userId, trackSid, muted });
}
