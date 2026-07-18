import type {
  OFFICE_ROOM_KINDS,
  OFFICE_ROOM_ROLES,
  OFFICE_ROOM_STATUSES,
} from '../constants/office';

// ============================================
// Виртуальный офис (B2B) — типы
// v1: встреча-конференция (kind='meeting', аналог Google Meet).
// kind='channel' — задел Discord-фазы (постоянные комнаты).
// ============================================

export type OfficeRoomKind = (typeof OFFICE_ROOM_KINDS)[number];
export type OfficeRoomStatus = (typeof OFFICE_ROOM_STATUSES)[number];
export type OfficeRoomRole = (typeof OFFICE_ROOM_ROLES)[number];

export interface OfficeRoomPersonDto {
  id: string;
  firstName: string;
  lastName: string | null;
  avatar: string | null;
}

/** «Идёт сейчас»: активная CallSession комнаты */
export interface OfficeRoomLiveDto {
  sessionId: string;
  startedAt: string;
  participantCount: number;
  /** Кто сейчас в звонке (стек аватаров в списке встреч) */
  participants: OfficeRoomPersonDto[];
}

export interface OfficeRoomDto {
  id: string;
  workspaceId: string;
  name: string;
  kind: OfficeRoomKind;
  status: OfficeRoomStatus;
  createdById: string;
  createdBy: OfficeRoomPersonDto | null;
  createdAt: string;
  endedAt: string | null;
  /** Роль зрителя (null — ещё не участник; участником делает приглашение или первый вход) */
  myRole: OfficeRoomRole | null;
  live: OfficeRoomLiveDto | null;
}

/** GET /workspaces/:id/office/history — страница истории завершённых встреч */
export interface OfficeHistoryPageDto {
  items: OfficeRoomDto[];
  nextCursor: string | null;
}
