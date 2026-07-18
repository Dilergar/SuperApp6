import type { CALL_RECORDING_STATUSES, CALL_SESSION_STATUSES } from '../constants/calls';

// ============================================
// Calls Engine (core/calls) — типы
// Звонок привязан к сущности-родителю (refType+refId, паттерн files/voice);
// доступ решает резолвер потребителя (CallsRefRegistry). Сессия = один созвон:
// живёт от первого токена до room_finished; сущность-родитель (встреча) живёт дольше.
// ============================================

export type CallSessionStatus = (typeof CALL_SESSION_STATUSES)[number];
export type CallRecordingStatus = (typeof CALL_RECORDING_STATUSES)[number];

/** GET /calls/status — веб прячет кнопки звонков, когда движок выключен */
export interface CallsStatusDto {
  enabled: boolean;
  /** ws-адрес LiveKit для браузера (null = движок выключен) */
  wsUrl: string | null;
  /** Кнопка ⏺ записи показывается только когда поднят egress (LIVEKIT_EGRESS_DIR) */
  recordingEnabled: boolean;
}

/**
 * Живой созвон сущности (activeCall в DTO чатов + socket call:state).
 * participantUserIds — кто СЕЙЧАС в комнате (открытые строки журнала): клиент рингует
 * DM только при непустом списке (звонящий реально подключился) без себя в нём.
 */
export interface CallActiveDto {
  sessionId: string;
  startedById: string;
  participantUserIds: string[];
  startedAt: string;
  /** Идёт запись (индикатор «● Запись» у всех участников) */
  recording: boolean;
}

/** POST /calls/token — вход в звонок сущности */
export interface CallTokenInput {
  refType: string;
  refId: string;
}

export interface CallTokenDto {
  /** JWT LiveKit на подключение к комнате (подписывается локально, короткий TTL) */
  token: string;
  wsUrl: string;
  roomName: string;
  sessionId: string;
  /** Зритель может модерировать (kick/mute/завершить) — веб показывает кнопки */
  moderator: boolean;
}

/** POST /calls/rooms/:sessionId/recording/{start|stop|claim} — состояние записи созвона */
export interface CallRecordingDto {
  id: string;
  sessionId: string;
  status: CallRecordingStatus;
  startedById: string;
  startedAt: string;
  /** Я уже нажал «Получить запись» (инициатор клеймится автоматически) */
  claimed: boolean;
}
