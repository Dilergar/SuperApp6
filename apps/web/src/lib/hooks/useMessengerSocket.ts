'use client';

import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useAuthStore } from '@/lib/stores/auth';
import type { ChatCallStatePayload, ChatMessage, WsPresenceChanged, WsTyping } from '@superapp/shared';
import { PRESENCE } from '@superapp/shared';

// ============================================================
// Server → client payload shapes (richer than the shared Ws* types;
// they carry routing/echo metadata the UI uses to reconcile caches).
// IMPORTANT: message.mine on these payloads is NOT viewer-correct —
// callers must recompute mine = message.authorId === currentUserId.
// ============================================================

export interface SocketMessageNew {
  chatId: string;
  message: ChatMessage;
  memberUserIds: string[];
  recipientIds: string[];
  authorName: string | null;
  chatType: string;
  preview: unknown;
}
export interface SocketMessageUpdated {
  chatId: string;
  message: ChatMessage;
}
export interface SocketMessageDeleted {
  chatId: string;
  message: ChatMessage;
}
export interface SocketReceipt {
  chatId: string;
  userId: string;
  deliveredSeq: number;
  lastReadSeq: number;
  memberUserIds: string[];
}

export interface MessengerSocketHandlers {
  onMessageNew?: (p: SocketMessageNew) => void;
  onMessageUpdated?: (p: SocketMessageUpdated) => void;
  onMessageDeleted?: (p: SocketMessageDeleted) => void;
  onReceipt?: (p: SocketReceipt) => void;
  /** Lightweight ping: a user's presence/contextual status may have changed → refetch it. */
  onPresenceChanged?: (p: WsPresenceChanged) => void;
  /** Someone started/stopped typing in a chat. */
  onTyping?: (p: WsTyping) => void;
  /**
   * Идемпотентный снимок звонка чата (started/joined/left/ended/recording — один
   * формат): дозвон DM, баннер «Идёт звонок», индикатор записи. active=null — звонка нет.
   */
  onCallState?: (p: ChatCallStatePayload) => void;
  /**
   * Fired after the socket RE-connects (not the first connect): socket events that
   * happened during the gap were lost — the consumer should invalidate/refetch chats
   * and the open conversation to catch up.
   */
  onReconnect?: () => void;
}

export interface MessengerSocket {
  emitDelivered: (chatId: string, seq: number) => void;
  emitRead: (chatId: string, seq: number) => void;
  /** Emit typing:start (typing=true) or typing:stop (typing=false) for a chat. */
  emitTyping: (chatId: string, typing: boolean) => void;
}

/** Strip the trailing /api or /api/v1 so we connect to the server ORIGIN, not the REST prefix. */
function serverOrigin(): string {
  const base = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1';
  return base.replace(/\/api(\/v\d+)?\/?$/, '');
}

// ============================================================
// Модульный СИНГЛТОН соединения: на вкладку — ровно ОДИН socket.io-коннект
// к /messenger, сколько бы компонентов ни звало хук. Раньше каждый вызов
// (CallsWatcher в Providers + страница мессенджера/задачи) держал СВОЙ сокет —
// двойной heartbeat и двойной серверный фанаут на те же события. Теперь события
// диспатчатся ВСЕМ подписчикам; соединение живёт, пока жив хотя бы один
// подписчик и пользователь авторизован.
// ============================================================

/** Подписчик = ref на его handlers (живёт в useRef компонента — колбэки всегда свежие). */
type HandlersRef = { current: MessengerSocketHandlers };

interface SingletonState {
  socket: Socket;
  subscribers: Set<HandlersRef>;
  /** Был ли уже connect на ЭТОМ соединении — отличает первый коннект от реконнекта. */
  wasConnected: boolean;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  onVisibility: () => void;
}

let state: SingletonState | null = null;

/** Раздать событие всем живым подписчикам (каждый ref всегда несёт свежие handlers). */
function dispatch(fn: (h: MessengerSocketHandlers) => void) {
  if (!state) return;
  for (const ref of state.subscribers) fn(ref.current);
}

function createSingleton(): SingletonState {
  const socket = io(`${serverOrigin()}/messenger`, {
    // auth как ФУНКЦИЯ: перевычисляется на КАЖДОЙ попытке (ре)коннекта. Access-токен
    // ротируется каждые ~15 мин; захваченный объект переигрывал бы протухший токен,
    // и каждый reconnect отбивался бы навсегда.
    auth: (cb) => cb({ token: localStorageToken() ?? '' }),
    transports: ['websocket', 'polling'],
  });

  socket.on('message:new', (p: SocketMessageNew) => dispatch((h) => h.onMessageNew?.(p)));
  socket.on('message:updated', (p: SocketMessageUpdated) => dispatch((h) => h.onMessageUpdated?.(p)));
  socket.on('message:deleted', (p: SocketMessageDeleted) => dispatch((h) => h.onMessageDeleted?.(p)));
  socket.on('receipt', (p: SocketReceipt) => dispatch((h) => h.onReceipt?.(p)));
  socket.on('presence:changed', (p: WsPresenceChanged) => dispatch((h) => h.onPresenceChanged?.(p)));
  socket.on('typing', (p: WsTyping) => dispatch((h) => h.onTyping?.(p)));
  socket.on('call:state', (p: ChatCallStatePayload) => dispatch((h) => h.onCallState?.(p)));

  // Heartbeat с visibility-гейтом: ОДИН интервал на соединение (не на подписчика).
  // Скрытая вкладка биения НЕ шлёт — away-модель Slack: серверный TTL presence-ключа
  // сам переведёт в offline, фоновые вкладки не держат «онлайн» вечно. На возврат
  // видимости — немедленный beat (сразу «онлайн») + возобновление интервала.
  const beat = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    socket.emit('heartbeat');
  };
  const startBeats = () => {
    if (s.heartbeatTimer == null) {
      s.heartbeatTimer = setInterval(beat, PRESENCE.HEARTBEAT_INTERVAL_MS);
    }
  };
  const stopBeats = () => {
    if (s.heartbeatTimer != null) {
      clearInterval(s.heartbeatTimer);
      s.heartbeatTimer = null;
    }
  };

  const s: SingletonState = {
    socket,
    subscribers: new Set(),
    wasConnected: false,
    heartbeatTimer: null,
    onVisibility: () => {
      if (document.visibilityState === 'visible') {
        beat();
        startBeats();
      } else {
        stopBeats();
      }
    },
  };

  socket.on('connect', () => {
    beat();
    // Реконнект после разрыва: события за время провала потеряны — каждый подписчик
    // должен догнаться (первый коннект пропускаем: начальные запросы ещё в полёте).
    // Флаг общий на СОЕДИНЕНИЕ — рассылаем всем.
    if (s.wasConnected) dispatch((h) => h.onReconnect?.());
    s.wasConnected = true;
  });

  beat();
  if (typeof document === 'undefined' || document.visibilityState === 'visible') startBeats();
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', s.onVisibility);

  return s;
}

function acquire(ref: HandlersRef) {
  if (!state) state = createSingleton();
  state.subscribers.add(ref);
}

function release(ref: HandlersRef) {
  if (!state) return;
  state.subscribers.delete(ref);
  if (state.subscribers.size > 0) return;
  // Последний подписчик размонтировался (или все ушли на логауте) →
  // гасим соединение и сбрасываем синглтон целиком.
  if (state.heartbeatTimer != null) clearInterval(state.heartbeatTimer);
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', state.onVisibility);
  state.socket.removeAllListeners();
  state.socket.disconnect();
  state = null;
}

/** Единый emit-API: роутит в текущий синглтон (нет соединения → no-op, как раньше). */
const MESSENGER_SOCKET_API: MessengerSocket = {
  emitDelivered: (chatId, seq) => {
    state?.socket.emit('message:delivered', { chatId, seq });
  },
  emitRead: (chatId, seq) => {
    state?.socket.emit('message:read', { chatId, seq });
  },
  emitTyping: (chatId, typing) => {
    state?.socket.emit(typing ? 'typing:start' : 'typing:stop', { chatId });
  },
};

/**
 * Подписка на ОБЩИЙ singleton-сокет /messenger. Handlers живут в ref — сокет не
 * пересоздаётся на каждый рендер; соединение рвётся, только когда размонтировался
 * последний подписчик или пользователь разлогинился. StrictMode-safe: двойной
 * mount/unmount эффектов одного подписчика не рвёт соединение у остальных
 * (Set-семантика — размер не падает до нуля, пока жив кто-то ещё).
 */
export function useMessengerSocket(handlers: MessengerSocketHandlers): MessengerSocket {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!isAuthenticated) return;
    const ref = handlersRef;
    acquire(ref);
    return () => release(ref);
  }, [isAuthenticated]);

  return MESSENGER_SOCKET_API;
}

function localStorageToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('accessToken');
}
