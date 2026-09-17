// ============================================================
// core/realtime — один сокет платформы (namespace `/realtime`): формы событий провода.
// Карты типизируют И gateway (`Server<C2S, S2C>`), И клиентский синглтон `useRealtime`.
// Мессенджер и уведомления регистрируют свои relay в реестре движка; здесь — объединение.
// ============================================================

import type { MessengerClientToServerEvents, MessengerServerToClientEvents } from './messenger';

/** Новая строка ленты у адресата (relay события шины `notifications.created`). */
export interface WsNotificationNew {
  notificationId: string;
  /** `personal` | id организации */
  context: string;
  /** Строка непросмотрена → бейдж +1; схлопнутая в уже просмотренную — тоже (seen сбрасывается) */
  unseen: boolean;
  type: string;
}

/** Счётчики изменились (seen/read/archive в другой вкладке) — клиент перечитывает `counts`. */
export interface WsNotificationCounts {
  reason: 'seen' | 'read' | 'archived' | 'snoozed' | 'unsnoozed' | 'deleted' | 'created';
}

export interface NotificationServerToClientEvents {
  'notification:new': (p: WsNotificationNew) => void;
  'notification:counts': (p: WsNotificationCounts) => void;
}

/**
 * Снимок тарифа субъекта изменился (relay `entitlements.changed`: подписка, грант,
 * оверрайд, публикация версии). Клиент инвалидирует свой снимок и перечитывает.
 */
/** `keys:changed` — реестр ключей организации изменился (бот заморожен/разморожен, ключ создан/отозван); владельцу и админам */
export interface WsKeysChanged {
  workspaceId: string;
  /** Ботов, ждущих решения владельца (значок в шапке организации) */
  frozenBots: number;
}

export interface WsEntitlementsChanged {
  subjectType: 'user' | 'workspace' | 'family';
  subjectId: string;
}

export interface EntitlementsServerToClientEvents {
  'entitlements:changed': (p: WsEntitlementsChanged) => void;
}

export interface KeysServerToClientEvents {
  'keys:changed': (p: WsKeysChanged) => void;
}

export type RealtimeServerToClientEvents = MessengerServerToClientEvents &
  NotificationServerToClientEvents &
  EntitlementsServerToClientEvents &
  KeysServerToClientEvents;

/** Payload шины `entitlements.changed` (движок → relay для user; workspaces подписывается для организации). */
export interface EntitlementsChangedBusPayload {
  subjectType: 'user' | 'workspace' | 'family';
  subjectId: string;
}
export type RealtimeClientToServerEvents = MessengerClientToServerEvents;

/** Payload шины `notifications.created` (фанаут → relay). */
export interface NotificationsCreatedBusPayload {
  eventId: string;
  type: string;
  recipients: { userId: string; notificationId: string; context: string; unseen: boolean }[];
}

/** Payload шины `notifications.counts` (мутация состояния → relay в комнату человека). */
export interface NotificationsCountsBusPayload {
  userId: string;
  reason: WsNotificationCounts['reason'];
}
