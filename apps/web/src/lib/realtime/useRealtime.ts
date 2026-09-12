'use client';

import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import { ACCESS_TOKEN_KEY } from '@/lib/api';
import { useAuthStore } from '@/lib/stores/auth';
import type {
  RealtimeClientToServerEvents,
  RealtimeServerToClientEvents,
  WsCallState,
  WsEntitlementsChanged,
  WsMessageDeleted,
  WsMessageNew,
  WsMessageUpdated,
  WsNotificationCounts,
  WsNotificationNew,
  WsPresenceChanged,
  WsReceipt,
  WsTyping,
} from '@superapp/shared';
import { PRESENCE } from '@superapp/shared';

// ============================================================
// core/realtime на клиенте — ОДИН socket.io-коннект на вкладку к namespace `/realtime`
// (модульный синглтон с подписчиками). Формы событий — из @superapp/shared, ими же
// типизирован gateway: опечатка в имени или payload не той формы — ошибка компиляции
// с обеих сторон провода. Мессенджер и уведомления — подписчики одного соединения.
// ВАЖНО: message.mine в payload НЕ зрителе-корректен — потребитель пересчитывает.
// ============================================================

export interface RealtimeHandlers {
  onMessageNew?: (p: WsMessageNew) => void;
  onMessageUpdated?: (p: WsMessageUpdated) => void;
  onMessageDeleted?: (p: WsMessageDeleted) => void;
  onReceipt?: (p: WsReceipt) => void;
  /** Лёгкий пинг: presence/контекстный статус человека мог измениться → перечитать. */
  onPresenceChanged?: (p: WsPresenceChanged) => void;
  onTyping?: (p: WsTyping) => void;
  /** Идемпотентный снимок звонка чата (дозвон DM, баннер «Идёт звонок», запись). */
  onCallState?: (p: WsCallState) => void;
  /** Новая строка ленты уведомлений у меня (бейдж +1, голова ленты). */
  onNotificationNew?: (p: WsNotificationNew) => void;
  /** Счётчики уведомлений изменились в другой вкладке — перечитать counts. */
  onNotificationCounts?: (p: WsNotificationCounts) => void;
  /** Тариф субъекта изменился (подписка, грант, публикация версии) — перечитать снимок. */
  onEntitlementsChanged?: (p: WsEntitlementsChanged) => void;
  /**
   * После РЕ-коннекта (не первого connect): события за время провала потеряны —
   * подписчик догоняется (перечитывает чаты/ленту/counts).
   */
  onReconnect?: () => void;
}

export interface RealtimeApi {
  emitDelivered: (chatId: string, seq: number) => void;
  emitRead: (chatId: string, seq: number) => void;
  emitTyping: (chatId: string, typing: boolean) => void;
}

/** Обрезаем /api или /api/v1 — коннект идёт к ORIGIN сервера, не к REST-префиксу. */
function serverOrigin(): string {
  const base = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1';
  return base.replace(/\/api(\/v\d+)?\/?$/, '');
}

type HandlersRef = { current: RealtimeHandlers };

interface SingletonState {
  socket: Socket<RealtimeServerToClientEvents, RealtimeClientToServerEvents>;
  subscribers: Set<HandlersRef>;
  wasConnected: boolean;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  onVisibility: () => void;
}

let state: SingletonState | null = null;

function dispatch(fn: (h: RealtimeHandlers) => void) {
  if (!state) return;
  for (const ref of state.subscribers) fn(ref.current);
}

function createSingleton(): SingletonState {
  const socket: Socket<RealtimeServerToClientEvents, RealtimeClientToServerEvents> = io(`${serverOrigin()}/realtime`, {
    // auth как ФУНКЦИЯ: перевычисляется на КАЖДОЙ попытке (ре)коннекта — access-токен
    // ротируется каждые ~15 мин, захваченный объект переигрывал бы протухший.
    auth: (cb) => cb({ token: localStorageToken() ?? '' }),
    transports: ['websocket', 'polling'],
  });

  socket.on('message:new', (p) => dispatch((h) => h.onMessageNew?.(p)));
  socket.on('message:updated', (p) => dispatch((h) => h.onMessageUpdated?.(p)));
  socket.on('message:deleted', (p) => dispatch((h) => h.onMessageDeleted?.(p)));
  socket.on('receipt', (p) => dispatch((h) => h.onReceipt?.(p)));
  socket.on('presence:changed', (p) => dispatch((h) => h.onPresenceChanged?.(p)));
  socket.on('typing', (p) => dispatch((h) => h.onTyping?.(p)));
  socket.on('call:state', (p) => dispatch((h) => h.onCallState?.(p)));
  socket.on('notification:new', (p) => dispatch((h) => h.onNotificationNew?.(p)));
  socket.on('notification:counts', (p) => dispatch((h) => h.onNotificationCounts?.(p)));
  socket.on('entitlements:changed', (p) => dispatch((h) => h.onEntitlementsChanged?.(p)));

  // Heartbeat presence с visibility-гейтом: ОДИН интервал на соединение; скрытая
  // вкладка биений не шлёт (away-модель Slack) — серверный TTL переведёт в offline.
  const beat = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    socket.emit('heartbeat');
  };
  const startBeats = () => {
    if (s.heartbeatTimer == null) s.heartbeatTimer = setInterval(beat, PRESENCE.HEARTBEAT_INTERVAL_MS);
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
  if (state.heartbeatTimer != null) clearInterval(state.heartbeatTimer);
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', state.onVisibility);
  state.socket.removeAllListeners();
  state.socket.disconnect();
  state = null;
}

const REALTIME_API: RealtimeApi = {
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
 * Подписка на ОБЩИЙ singleton-сокет /realtime. Handlers живут в ref — сокет не
 * пересоздаётся на каждый рендер; соединение рвётся, когда размонтировался последний
 * подписчик или человек разлогинился. StrictMode-safe (Set-семантика).
 */
export function useRealtime(handlers: RealtimeHandlers): RealtimeApi {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!isAuthenticated) return;
    const ref = handlersRef;
    acquire(ref);
    return () => release(ref);
  }, [isAuthenticated]);

  return REALTIME_API;
}

function localStorageToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(ACCESS_TOKEN_KEY);
}
