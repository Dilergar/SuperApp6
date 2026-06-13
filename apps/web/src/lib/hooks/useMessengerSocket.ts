'use client';

import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useAuthStore } from '@/lib/stores/auth';
import type { ChatMessage, WsPresenceChanged, WsTyping } from '@superapp/shared';
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

/**
 * Owns exactly ONE socket.io connection per accessToken to the /messenger
 * namespace. Handlers are kept in a ref so the socket is NOT torn down on
 * every render — only when the token actually changes (login/refresh/logout).
 */
export function useMessengerSocket(handlers: MessengerSocketHandlers): MessengerSocket {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  const socketRef = useRef<Socket | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!isAuthenticated) return;

    const socket = io(`${serverOrigin()}/messenger`, {
      // auth as a FUNCTION: re-evaluated on EVERY (re)connection attempt. The access
      // token rotates every ~15 min; a captured object would replay the stale token
      // after the first expiry and every reconnect would be rejected forever.
      auth: (cb) => cb({ token: localStorageToken() ?? '' }),
      transports: ['websocket', 'polling'],
    });
    socketRef.current = socket;

    socket.on('message:new', (p: SocketMessageNew) => handlersRef.current.onMessageNew?.(p));
    socket.on('message:updated', (p: SocketMessageUpdated) => handlersRef.current.onMessageUpdated?.(p));
    socket.on('message:deleted', (p: SocketMessageDeleted) => handlersRef.current.onMessageDeleted?.(p));
    socket.on('receipt', (p: SocketReceipt) => handlersRef.current.onReceipt?.(p));
    socket.on('presence:changed', (p: WsPresenceChanged) => handlersRef.current.onPresenceChanged?.(p));
    socket.on('typing', (p: WsTyping) => handlersRef.current.onTyping?.(p));

    // Heartbeat: announce presence immediately on connect, then on a fixed
    // interval. The server's presence key TTL comfortably outlasts the interval,
    // so a brief blip won't flap us offline. Re-emit on reconnect too.
    const beat = () => socket.emit('heartbeat');
    let wasConnected = false;
    socket.on('connect', () => {
      beat();
      // Re-connect after a gap → messages emitted meanwhile were lost; let the
      // consumer refetch (first connect skips this — initial queries are in flight).
      if (wasConnected) handlersRef.current.onReconnect?.();
      wasConnected = true;
    });
    beat();
    const heartbeatTimer = setInterval(beat, PRESENCE.HEARTBEAT_INTERVAL_MS);

    return () => {
      clearInterval(heartbeatTimer);
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [isAuthenticated]);

  const emitDelivered = (chatId: string, seq: number) => {
    socketRef.current?.emit('message:delivered', { chatId, seq });
  };
  const emitRead = (chatId: string, seq: number) => {
    socketRef.current?.emit('message:read', { chatId, seq });
  };
  const emitTyping = (chatId: string, typing: boolean) => {
    socketRef.current?.emit(typing ? 'typing:start' : 'typing:stop', { chatId });
  };

  return { emitDelivered, emitRead, emitTyping };
}

function localStorageToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('accessToken');
}
