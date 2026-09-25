// ============================================================
// core/realtime — один сокет платформы (namespace `/realtime`): формы событий провода.
// Карты типизируют И gateway (`Server<C2S, S2C>`), И клиентский синглтон `useRealtime`.
// Мессенджер и уведомления регистрируют свои relay в реестре движка; здесь — объединение.
// ============================================================

import type { MessengerClientToServerEvents, MessengerServerToClientEvents } from './messenger';
import type { WsSecurityChanged } from './audit';
import type { WsLifecycleExportUpdated } from '../validation/lifecycle-export';

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

/** `security:changed` — журнал безопасности или сессии человека изменились (core/audit): личная комната */
export interface SecurityServerToClientEvents {
  'security:changed': (p: WsSecurityChanged) => void;
}

/**
 * `visibility:changed` — политика видимости владельца сменилась (core/visibility, R6):
 * организация опубликовала версию или человек поменял «кто видит» своей карточки. Клиент
 * сбрасывает RQ-ключи этой организации (или карточки человека) — план зрителя пересчитается.
 * Только коды и id: какие поля и кому — не едет.
 */
export interface WsVisibilityChanged {
  ownerKind: 'workspace' | 'user';
  ownerId: string;
  recordType: string;
  pv: number;
}

export interface VisibilityServerToClientEvents {
  'visibility:changed': (p: WsVisibilityChanged) => void;
}

/** Payload шины `visibility.changed` (движок → relay: организация — в комнату команды, человек — связанным). */
export interface VisibilityChangedBusPayload extends WsVisibilityChanged {
  /** Кому доставить: участники организации либо связанные с человеком (решает продюсер) */
  userIds: string[];
}

/**
 * `lifecycle:export.updated` — выгрузка данных собрана или упала (core/lifecycle Э6): заказчику.
 * Страница выгрузок перечитывает список; ссылок и содержимого событие не несёт.
 */
export interface LifecycleServerToClientEvents {
  'lifecycle:export.updated': (p: WsLifecycleExportUpdated) => void;
}

export type RealtimeServerToClientEvents = MessengerServerToClientEvents &
  NotificationServerToClientEvents &
  EntitlementsServerToClientEvents &
  KeysServerToClientEvents &
  SecurityServerToClientEvents &
  VisibilityServerToClientEvents &
  LifecycleServerToClientEvents;

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
