import type {
  CallRecordingDto,
  CallsStatusDto,
  CallTokenDto,
  CallTokenInput,
  ChatCallStatePayload,
} from '@superapp/shared';
import { api } from './api';

// ============================================================
// Движок звонков (core/calls) — API-клиент веба
// ============================================================

export async function getCallsStatus(): Promise<CallsStatusDto> {
  const res = await api.get('/calls/status');
  return res.data.data;
}

/** Токен входа в звонок сущности (доступ решает резолвер refType на бэке) */
export async function getCallToken(input: CallTokenInput): Promise<CallTokenDto> {
  const res = await api.post('/calls/token', input);
  return res.data.data;
}

/** Завершить созвон для всех (модератор): комната удаляется, у всех disconnect */
export async function endCallSession(sessionId: string): Promise<void> {
  await api.post(`/calls/rooms/${sessionId}/end`, {});
}

/** Живые звонки моих чатов — watcher входящих при загрузке/reconnect (холодный старт) */
export async function getMyActiveChatCalls(): Promise<ChatCallStatePayload[]> {
  const res = await api.get('/messenger/calls/active');
  return res.data.data.items;
}

/** Исключить участника из звонка (модератор) */
export async function kickCallParticipant(sessionId: string, userId: string): Promise<void> {
  await api.post(`/calls/rooms/${sessionId}/kick`, { userId });
}

/** ⏺ Начать запись созвона (участник; всем загорается индикатор «● Запись») */
export async function startCallRecording(sessionId: string): Promise<CallRecordingDto> {
  const res = await api.post(`/calls/rooms/${sessionId}/recording/start`, {});
  return res.data.data;
}

/** ⏹ Остановить запись (инициатор записи или модератор) */
export async function stopCallRecording(sessionId: string): Promise<CallRecordingDto> {
  const res = await api.post(`/calls/rooms/${sessionId}/recording/stop`, {});
  return res.data.data;
}

/** «Получить запись»: полная запись придёт в мой Диктофон → «Журнал звонков» */
export async function claimCallRecording(sessionId: string): Promise<CallRecordingDto> {
  const res = await api.post(`/calls/rooms/${sessionId}/recording/claim`, {});
  return res.data.data;
}

/** Принудительно замьютить трек участника (модератор) */
export async function muteCallTrack(
  sessionId: string,
  userId: string,
  trackSid: string,
  muted: boolean,
): Promise<void> {
  await api.post(`/calls/rooms/${sessionId}/mute`, { userId, trackSid, muted });
}
