'use client';

import { useRealtime, type RealtimeApi, type RealtimeHandlers } from '@/lib/realtime/useRealtime';

// ============================================================
// Тонкая обёртка над единым сокетом платформы (`lib/realtime/useRealtime`):
// страницы мессенджера сохраняют прежний API, соединение — одно на вкладку
// (его же слушают уведомления и звонки).
// ============================================================

export type MessengerSocketHandlers = Pick<
  RealtimeHandlers,
  'onMessageNew' | 'onMessageUpdated' | 'onMessageDeleted' | 'onReceipt' | 'onPresenceChanged' | 'onTyping' | 'onCallState' | 'onReconnect'
>;

export type MessengerSocket = RealtimeApi;

export function useMessengerSocket(handlers: MessengerSocketHandlers): MessengerSocket {
  return useRealtime(handlers);
}
