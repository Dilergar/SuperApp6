'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChatSummary, ChatMessage, ChatDetail, RichCardPayload, PresenceInfo } from '@superapp/shared';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import {
  useMessengerSocket,
  type SocketMessageNew,
  type SocketMessageUpdated,
  type SocketMessageDeleted,
  type SocketReceipt,
} from '@/lib/hooks/useMessengerSocket';
import {
  listChats,
  getChat,
  getMessages,
  openDm,
  createGroup,
  renameChat,
  addMembers,
  removeMember,
  leaveChat,
  setAdmin,
  deleteChat,
  sendMessage,
  sendAttachmentMessage,
  editMessage,
  deleteMessage,
  markRead,
  getPresence,
} from '@/lib/messenger-api';
import { useMentionsUnread } from '@/lib/hooks/useMentionsUnread';
import { ChatList } from './ChatList';
import { Conversation } from './Conversation';
import { NewChatModal } from './NewChatModal';
import { GroupManageModal } from './GroupManageModal';
import { MentionsNavLink } from './MentionsNavLink';
import { GlobalSearch } from './GlobalSearch';

// react-query keys
const chatsKey = ['messenger', 'chats'] as const;
const messagesKey = (chatId: string) => ['messenger', 'messages', chatId] as const;
const detailKey = (chatId: string) => ['messenger', 'detail', chatId] as const;

export default function MessengerPage() {
  return (
    <Suspense fallback={<FullScreenLoading />}>
      <MessengerInner />
    </Suspense>
  );
}

function MessengerInner() {
  const { isReady, user } = useRequireAuth();
  const currentUserId = user?.id ?? '';
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  // Unread "mentions of me" — drives the nav badge (shares the hub's cache key).
  const mentionsUnread = useMentionsUnread(isReady);

  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  // A deep-linked message (from the Mentions Hub) to scroll-to + flash once loaded.
  const [highlightMsgId, setHighlightMsgId] = useState<string | null>(null);
  const [showNewChat, setShowNewChat] = useState(false);
  const [showManage, setShowManage] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  // ---- Inbox (left pane) ----
  const chatsQuery = useQuery({ queryKey: chatsKey, queryFn: listChats, enabled: isReady });
  const chats = useMemo(() => chatsQuery.data ?? [], [chatsQuery.data]);

  // ---- Open chat detail (right pane header + participants) ----
  const detailQuery = useQuery({
    queryKey: activeChatId ? detailKey(activeChatId) : ['messenger', 'detail', 'none'],
    queryFn: () => getChat(activeChatId as string),
    enabled: isReady && !!activeChatId,
  });

  // ---- Messages of the open chat ----
  const messagesQuery = useQuery({
    queryKey: activeChatId ? messagesKey(activeChatId) : ['messenger', 'messages', 'none'],
    queryFn: () => getMessages(activeChatId as string),
    enabled: isReady && !!activeChatId,
  });
  const messages = useMemo(() => messagesQuery.data ?? [], [messagesQuery.data]);

  // ============================================================
  // Presence (Phase 4) — a Map<userId, PresenceInfo>. Filled by an initial
  // fetch for inbox DM peers + the open chat's participants, then kept fresh
  // by `presence:changed` pings (refetch the pinged user, debounced/batched).
  // ============================================================

  const [presence, setPresence] = useState<Map<string, PresenceInfo>>(new Map());
  const presenceRef = useRef(presence);
  presenceRef.current = presence;

  const mergePresence = useCallback((items: PresenceInfo[]) => {
    if (items.length === 0) return;
    setPresence((old) => {
      const next = new Map(old);
      for (const p of items) next.set(p.userId, p);
      return next;
    });
  }, []);

  const fetchPresence = useCallback(
    (userIds: string[]) => {
      const unique = Array.from(new Set(userIds.filter(Boolean)));
      if (unique.length === 0) return;
      getPresence(unique).then(mergePresence).catch(() => {});
    },
    [mergePresence],
  );

  // Debounced batch of users pinged by `presence:changed` (coalesce bursts).
  const pendingPresenceRef = useRef<Set<string>>(new Set());
  const presenceFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queuePresenceRefetch = useCallback(
    (userId: string) => {
      pendingPresenceRef.current.add(userId);
      if (presenceFlushTimer.current) return;
      presenceFlushTimer.current = setTimeout(() => {
        const ids = Array.from(pendingPresenceRef.current);
        pendingPresenceRef.current = new Set();
        presenceFlushTimer.current = null;
        fetchPresence(ids);
      }, 300);
    },
    [fetchPresence],
  );

  // Initial fetch for the inbox DM peers whenever the chat list changes.
  const inboxPeerIds = useMemo(
    () => chats.filter((c) => c.type === 'dm' && c.peerUserId).map((c) => c.peerUserId as string),
    [chats],
  );
  const inboxPeerKey = useMemo(() => [...inboxPeerIds].sort().join(','), [inboxPeerIds]);
  useEffect(() => {
    if (inboxPeerIds.length) fetchPresence(inboxPeerIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inboxPeerKey, fetchPresence]);

  // Fetch presence for the open chat's participants (covers DM peer + group members)
  // — minus myself; the server already tailors to the viewer.
  const participantIds = useMemo(
    () => (detailQuery.data ? detailQuery.data.participants.map((p) => p.userId).filter((id) => id !== currentUserId) : []),
    [detailQuery.data, currentUserId],
  );
  const participantKey = useMemo(() => [...participantIds].sort().join(','), [participantIds]);
  useEffect(() => {
    if (participantIds.length) fetchPresence(participantIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [participantKey, fetchPresence]);

  // ============================================================
  // Typing (Phase 4) — Map<chatId, Map<userId, expiry-timeout>>. A `typing`
  // event with typing=true (re)arms a ~5s auto-expire so a missed stop never
  // leaves a stuck indicator; typing=false (or expiry) removes the user.
  // ============================================================

  const [typing, setTyping] = useState<Map<string, Set<string>>>(new Map());
  const typingTimersRef = useRef<Map<string, Map<string, ReturnType<typeof setTimeout>>>>(new Map());

  const removeTyping = useCallback((chatId: string, userId: string) => {
    setTyping((old) => {
      const set = old.get(chatId);
      if (!set || !set.has(userId)) return old;
      const next = new Map(old);
      const nextSet = new Set(set);
      nextSet.delete(userId);
      if (nextSet.size === 0) next.delete(chatId);
      else next.set(chatId, nextSet);
      return next;
    });
    const chatTimers = typingTimersRef.current.get(chatId);
    const t = chatTimers?.get(userId);
    if (t) {
      clearTimeout(t);
      chatTimers!.delete(userId);
    }
  }, []);

  const addTyping = useCallback(
    (chatId: string, userId: string) => {
      if (userId === currentUserId) return; // never show my own typing
      setTyping((old) => {
        const set = old.get(chatId) ?? new Set<string>();
        if (set.has(userId)) return old;
        const next = new Map(old);
        next.set(chatId, new Set(set).add(userId));
        return next;
      });
      let chatTimers = typingTimersRef.current.get(chatId);
      if (!chatTimers) {
        chatTimers = new Map();
        typingTimersRef.current.set(chatId, chatTimers);
      }
      const existing = chatTimers.get(userId);
      if (existing) clearTimeout(existing);
      chatTimers.set(userId, setTimeout(() => removeTyping(chatId, userId), 5000));
    },
    [currentUserId, removeTyping],
  );

  // ============================================================
  // Cache helpers (all defined BEFORE the socket so handlers can close over them)
  // ============================================================

  const upsertMessageInCache = useCallback(
    (chatId: string, msg: ChatMessage) => {
      queryClient.setQueryData<ChatMessage[]>(messagesKey(chatId), (old) => {
        const list = old ? [...old] : [];
        const byId = list.findIndex((m) => m.id === msg.id);
        if (byId >= 0) {
          list[byId] = { ...list[byId], ...msg };
          return list;
        }
        // Reconcile an optimistic temp bubble of mine (same author + content).
        if (msg.authorId === currentUserId) {
          const tempIdx = list.findIndex(
            (m) => m.id.startsWith('temp-') && (m.content ?? '') === (msg.content ?? ''),
          );
          if (tempIdx >= 0) {
            list[tempIdx] = msg;
            return list;
          }
        }
        list.push(msg);
        list.sort((a, b) => a.seq - b.seq);
        return list;
      });
    },
    [queryClient, currentUserId],
  );

  const patchMessageInCache = useCallback(
    (chatId: string, msg: ChatMessage) => {
      queryClient.setQueryData<ChatMessage[]>(messagesKey(chatId), (old) =>
        old ? old.map((m) => (m.id === msg.id ? { ...m, ...msg } : m)) : old,
      );
    },
    [queryClient],
  );

  // After a rich-card button executes, the server returns the freshly re-rendered
  // card for the actor — patch it onto the message's payload in place (primary path;
  // a socket message:updated, if the backend also emits one, just confirms it).
  const handleCardUpdated = useCallback(
    (messageId: string, card: RichCardPayload) => {
      if (!activeChatId) return;
      queryClient.setQueryData<ChatMessage[]>(messagesKey(activeChatId), (old) =>
        old
          ? old.map((m) =>
              m.id === messageId
                ? { ...m, type: 'rich_card', payload: card as unknown as Record<string, unknown> }
                : m,
            )
          : old,
      );
    },
    [activeChatId, queryClient],
  );

  // Advance my own messages' tick status when a recipient's read cursor moves.
  const applyReceiptToCache = useCallback(
    (r: SocketReceipt) => {
      queryClient.setQueryData<ChatMessage[]>(messagesKey(r.chatId), (old) => {
        if (!old) return old;
        return old.map((m) => {
          if (m.authorId !== currentUserId) return m;
          let status = m.status;
          if (r.lastReadSeq >= m.seq) status = 'read';
          else if (r.deliveredSeq >= m.seq && status !== 'read') status = 'delivered';
          return status === m.status ? m : { ...m, status };
        });
      });
    },
    [queryClient, currentUserId],
  );

  const bumpInboxPreview = useCallback(
    (chatId: string, msg: ChatMessage, opts?: { incrementUnread?: boolean }) => {
      queryClient.setQueryData<ChatSummary[]>(chatsKey, (old) => {
        if (!old) return old;
        const idx = old.findIndex((c) => c.id === chatId);
        if (idx < 0) {
          // Unknown chat (brand-new DM started by the peer) → refetch inbox.
          queryClient.invalidateQueries({ queryKey: chatsKey });
          return old;
        }
        const chat = old[idx];
        // Idempotent on seq: a re-delivered socket echo (reconnect/dup) for a seq we've
        // already folded into the preview must NOT double-count unread or reorder.
        const knownSeq = chat.lastMessage?.seq ?? 0;
        if (msg.seq <= knownSeq && msg.seq !== Number.MAX_SAFE_INTEGER) return old;
        // attachment без подписи: клиентский фолбэк превью (сервер пришлёт своё при рефетче)
        let attachmentFallback: string | null = null;
        if (msg.type === 'attachment') {
          const files = (msg.payload as { files?: unknown[] } | null)?.files;
          const n = Array.isArray(files) ? files.length : 0;
          attachmentFallback = n > 1 ? `📎 Файлы: ${n}` : '📎 Файл';
        }
        const updated: ChatSummary = {
          ...chat,
          lastMessage: {
            id: msg.id,
            seq: msg.seq,
            authorId: msg.authorId,
            authorName: msg.authorName,
            type: msg.type,
            text: msg.deletedAt ? null : (msg.content ?? attachmentFallback),
            createdAt: msg.createdAt,
            deleted: !!msg.deletedAt,
          },
          updatedAt: msg.createdAt,
          unreadCount: opts?.incrementUnread ? chat.unreadCount + 1 : chat.unreadCount,
        };
        const rest = old.filter((_, i) => i !== idx);
        const pinned = rest.filter((c) => c.pinned);
        const unpinned = rest.filter((c) => !c.pinned);
        return updated.pinned ? [updated, ...pinned, ...unpinned] : [...pinned, updated, ...unpinned];
      });
    },
    [queryClient],
  );

  // Patch the inbox preview only when the changed message is the chat's last one.
  const bumpInboxPreviewIfLast = useCallback(
    (chatId: string, msg: ChatMessage) => {
      const list = queryClient.getQueryData<ChatSummary[]>(chatsKey);
      const chat = list?.find((c) => c.id === chatId);
      if (chat?.lastMessage?.id !== msg.id) return;
      queryClient.setQueryData<ChatSummary[]>(chatsKey, (old) =>
        old
          ? old.map((c) =>
              c.id === chatId && c.lastMessage
                ? {
                    ...c,
                    lastMessage: {
                      ...c.lastMessage,
                      text: msg.deletedAt ? null : msg.content,
                      deleted: !!msg.deletedAt,
                    },
                  }
                : c,
            )
          : old,
      );
    },
    [queryClient],
  );

  const clearUnread = useCallback(
    (chatId: string) => {
      queryClient.setQueryData<ChatSummary[]>(chatsKey, (old) =>
        old ? old.map((c) => (c.id === chatId ? { ...c, unreadCount: 0 } : c)) : old,
      );
    },
    [queryClient],
  );

  // ============================================================
  // Socket — handlers close over stable cache helpers above.
  // socketRef lets handlers emit without depending on render order.
  // ============================================================

  const socketRef = useRef<ReturnType<typeof useMessengerSocket> | null>(null);
  const activeChatIdRef = useRef<string | null>(null);
  activeChatIdRef.current = activeChatId;

  const socket = useMessengerSocket({
    onReconnect: () => {
      // Messages sent while the socket was down were lost — pull the inbox and the
      // open conversation fresh.
      queryClient.invalidateQueries({ queryKey: chatsKey });
      const open = activeChatIdRef.current;
      if (open) queryClient.invalidateQueries({ queryKey: messagesKey(open) });
    },
    onMessageNew: (p: SocketMessageNew) => {
      const mine = p.message.authorId === currentUserId;
      const msg: ChatMessage = { ...p.message, mine };
      upsertMessageInCache(p.chatId, msg);

      const isOpen = activeChatIdRef.current === p.chatId;
      bumpInboxPreview(p.chatId, msg, { incrementUnread: !mine && !isOpen });

      if (!mine) {
        // Acknowledge delivery for any message I receive.
        socketRef.current?.emitDelivered(p.chatId, p.message.seq);
        // If the chat is open, also mark it read immediately.
        if (isOpen) {
          markRead(p.chatId, p.message.seq).catch(() => {});
          socketRef.current?.emitRead(p.chatId, p.message.seq);
          clearUnread(p.chatId);
        }
      }
    },
    onMessageUpdated: (p: SocketMessageUpdated) => {
      const msg: ChatMessage = { ...p.message, mine: p.message.authorId === currentUserId };
      patchMessageInCache(p.chatId, msg);
      bumpInboxPreviewIfLast(p.chatId, msg);
    },
    onMessageDeleted: (p: SocketMessageDeleted) => {
      const msg: ChatMessage = { ...p.message, mine: p.message.authorId === currentUserId };
      patchMessageInCache(p.chatId, msg);
      bumpInboxPreviewIfLast(p.chatId, msg);
    },
    onReceipt: (p: SocketReceipt) => {
      applyReceiptToCache(p);
    },
    onPresenceChanged: (p) => {
      queuePresenceRefetch(p.userId);
    },
    onTyping: (p) => {
      if (p.typing) addTyping(p.chatId, p.userId);
      else removeTyping(p.chatId, p.userId);
    },
  });
  socketRef.current = socket;

  // ============================================================
  // When a chat opens / new messages arrive while open → mark read.
  // Use the latest REAL (persisted) seq — never the optimistic sentinel
  // (MAX_SAFE_INTEGER), which would corrupt the server read cursor.
  // messagesQuery is keyed by chatId, so `messages` always belongs to the
  // active chat (no stale-chat seq leaks across switches).
  // ============================================================

  const latestRealSeq = useMemo(() => {
    let max = 0;
    for (const m of messages) {
      if (m.id.startsWith('temp-')) continue;
      if (m.seq !== Number.MAX_SAFE_INTEGER && m.seq > max) max = m.seq;
    }
    return max;
  }, [messages]);

  useEffect(() => {
    if (!activeChatId || !latestRealSeq) return;
    markRead(activeChatId, latestRealSeq).catch(() => {});
    socketRef.current?.emitRead(activeChatId, latestRealSeq);
    clearUnread(activeChatId);
  }, [activeChatId, latestRealSeq, clearUnread]);

  // ============================================================
  // Typing emitter — the composer calls this on every keystroke. Emit
  // `typing:start` once, then auto-`typing:stop` after ~3s idle (also stops
  // on send/blur via onTypingChange(false)). All chat-scoped so switching
  // chats won't leak a "still typing" into the previous one.
  // ============================================================

  const myTypingActiveRef = useRef(false);
  const myTypingChatRef = useRef<string | null>(null);
  const myTypingIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopMyTyping = useCallback(() => {
    if (myTypingIdleTimer.current) {
      clearTimeout(myTypingIdleTimer.current);
      myTypingIdleTimer.current = null;
    }
    if (myTypingActiveRef.current && myTypingChatRef.current) {
      socketRef.current?.emitTyping(myTypingChatRef.current, false);
    }
    myTypingActiveRef.current = false;
    myTypingChatRef.current = null;
  }, []);

  const handleTypingChange = useCallback(
    (isTyping: boolean) => {
      if (!activeChatId) return;
      if (!isTyping) {
        stopMyTyping();
        return;
      }
      // If we switched chats mid-type, stop the old one first.
      if (myTypingActiveRef.current && myTypingChatRef.current !== activeChatId) {
        if (myTypingChatRef.current) socketRef.current?.emitTyping(myTypingChatRef.current, false);
        myTypingActiveRef.current = false;
      }
      if (!myTypingActiveRef.current) {
        myTypingActiveRef.current = true;
        myTypingChatRef.current = activeChatId;
        socketRef.current?.emitTyping(activeChatId, true);
      }
      if (myTypingIdleTimer.current) clearTimeout(myTypingIdleTimer.current);
      myTypingIdleTimer.current = setTimeout(stopMyTyping, 3000);
    },
    [activeChatId, stopMyTyping],
  );

  // Stop typing when the active chat changes (don't leak into the new chat).
  useEffect(() => {
    return () => {
      stopMyTyping();
    };
  }, [activeChatId, stopMyTyping]);

  // Clear all typing-expiry timers on unmount.
  useEffect(() => {
    const timers = typingTimersRef.current;
    return () => {
      for (const chatTimers of timers.values()) {
        for (const t of chatTimers.values()) clearTimeout(t);
      }
      timers.clear();
      if (presenceFlushTimer.current) clearTimeout(presenceFlushTimer.current);
    };
  }, []);

  // ============================================================
  // Deep links: ?chat=<id> and ?dm=<userId>
  // ============================================================

  const handledDeepLink = useRef<string | null>(null);

  useEffect(() => {
    if (!isReady) return;
    const chatParam = searchParams.get('chat');
    const dmParam = searchParams.get('dm');
    const msgParam = searchParams.get('msg');
    const linkKey = `chat=${chatParam ?? ''}&dm=${dmParam ?? ''}&msg=${msgParam ?? ''}`;
    if (handledDeepLink.current === linkKey) return;

    if (dmParam) {
      handledDeepLink.current = linkKey;
      openDm(dmParam)
        .then((detail: ChatDetail) => {
          queryClient.setQueryData(detailKey(detail.id), detail);
          setActiveChatId(detail.id);
          queryClient.invalidateQueries({ queryKey: chatsKey });
          router.replace(`/messenger?chat=${detail.id}`);
        })
        .catch(() => {
          handledDeepLink.current = null;
        });
    } else if (chatParam) {
      handledDeepLink.current = linkKey;
      setActiveChatId(chatParam);
      // Hand the target message to the conversation; it flashes once loaded.
      setHighlightMsgId(msgParam);
    }
  }, [isReady, searchParams, queryClient, router]);

  // ============================================================
  // Actions
  // ============================================================

  const selectChat = useCallback(
    (chatId: string) => {
      setActiveChatId(chatId);
      setHasMore(true);
      router.replace(`/messenger?chat=${chatId}`);
    },
    [router],
  );

  const handlePickPerson = useCallback(
    async (userId: string) => {
      setShowNewChat(false);
      try {
        const detail = await openDm(userId);
        queryClient.setQueryData(detailKey(detail.id), detail);
        await queryClient.invalidateQueries({ queryKey: chatsKey });
        selectChat(detail.id);
      } catch {
        /* swallow — surfaced by the empty state if needed */
      }
    },
    [queryClient, selectChat],
  );

  const handleCreateGroup = useCallback(
    async (name: string, memberIds: string[]) => {
      try {
        const detail = await createGroup(name, memberIds);
        queryClient.setQueryData(detailKey(detail.id), detail);
        await queryClient.invalidateQueries({ queryKey: chatsKey });
        setShowNewChat(false);
        selectChat(detail.id);
      } catch {
        /* swallow — modal stays open so the user can retry */
      }
    },
    [queryClient, selectChat],
  );

  // ---- group management (chat-detail mutations) ----
  // Each refreshes the chat-detail cache and the inbox (title/member changes).
  const refreshAfterManage = useCallback(
    (chatId: string, detail?: ChatDetail) => {
      if (detail) queryClient.setQueryData(detailKey(chatId), detail);
      else queryClient.invalidateQueries({ queryKey: detailKey(chatId) });
      queryClient.invalidateQueries({ queryKey: chatsKey });
    },
    [queryClient],
  );

  const handleRenameGroup = useCallback(
    async (chatId: string, title: string) => {
      const detail = await renameChat(chatId, title);
      refreshAfterManage(chatId, detail);
    },
    [refreshAfterManage],
  );

  const handleAddMembers = useCallback(
    async (chatId: string, userIds: string[]) => {
      const detail = await addMembers(chatId, userIds);
      refreshAfterManage(chatId, detail);
    },
    [refreshAfterManage],
  );

  const handleRemoveMember = useCallback(
    async (chatId: string, userId: string) => {
      await removeMember(chatId, userId);
      refreshAfterManage(chatId);
    },
    [refreshAfterManage],
  );

  const handleSetAdmin = useCallback(
    async (chatId: string, userId: string, admin: boolean) => {
      const detail = await setAdmin(chatId, userId, admin);
      refreshAfterManage(chatId, detail);
    },
    [refreshAfterManage],
  );

  const handleLeaveGroup = useCallback(
    async (chatId: string) => {
      await leaveChat(chatId);
      setShowManage(false);
      setActiveChatId(null);
      router.replace('/messenger');
      queryClient.invalidateQueries({ queryKey: chatsKey });
    },
    [queryClient, router],
  );

  const handleDeleteGroup = useCallback(
    async (chatId: string) => {
      await deleteChat(chatId);
      setShowManage(false);
      setActiveChatId(null);
      router.replace('/messenger');
      queryClient.invalidateQueries({ queryKey: chatsKey });
    },
    [queryClient, router],
  );

  const handleSend = useCallback(
    async (content: string, replyToId?: string) => {
      if (!activeChatId) return;
      const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const now = new Date().toISOString();
      // Seed the optimistic bubble's quoted preview from the message being replied to.
      const quoted = replyToId
        ? queryClient
            .getQueryData<ChatMessage[]>(messagesKey(activeChatId))
            ?.find((m) => m.id === replyToId)
        : undefined;
      const optimistic: ChatMessage = {
        id: tempId,
        chatId: activeChatId,
        authorId: currentUserId,
        authorName: user?.firstName ?? null,
        authorAvatar: user?.avatar ?? null,
        type: 'text',
        content,
        payload: null,
        seq: Number.MAX_SAFE_INTEGER, // sort to the very bottom until reconciled
        editedAt: null,
        deletedAt: null,
        createdAt: now,
        mine: true,
        status: 'sent',
        replyTo: quoted
          ? {
              id: quoted.id,
              authorName: quoted.authorName,
              text: quoted.deletedAt ? null : quoted.content,
              deleted: !!quoted.deletedAt,
            }
          : null,
      };
      queryClient.setQueryData<ChatMessage[]>(messagesKey(activeChatId), (old) =>
        old ? [...old, optimistic] : [optimistic],
      );

      try {
        const saved = await sendMessage(activeChatId, content, replyToId);
        // Replace the temp bubble with the persisted message; dedupe socket echo.
        queryClient.setQueryData<ChatMessage[]>(messagesKey(activeChatId), (old) => {
          if (!old) return [saved];
          const withoutTemp = old.filter((m) => m.id !== tempId);
          if (withoutTemp.some((m) => m.id === saved.id)) {
            return [...withoutTemp].sort((a, b) => a.seq - b.seq);
          }
          return [...withoutTemp, saved].sort((a, b) => a.seq - b.seq);
        });
        bumpInboxPreview(activeChatId, saved);
      } catch {
        // Drop the optimistic bubble on failure.
        queryClient.setQueryData<ChatMessage[]>(messagesKey(activeChatId), (old) =>
          old ? old.filter((m) => m.id !== tempId) : old,
        );
      }
    },
    [activeChatId, currentUserId, user, queryClient, bumpInboxPreview],
  );

  // Ф9: альбом вложений — БЕЗ temp-пузыря (реконсиляция temp идёт по content и
  // споткнулась бы о пустую подпись): await POST → upsert; id-дедуп гасит socket-эхо.
  const handleSendAttachments = useCallback(
    async (fileIds: string[], caption: string, replyToId?: string) => {
      if (!activeChatId) return;
      try {
        const saved = await sendAttachmentMessage(activeChatId, fileIds, caption || undefined, replyToId);
        upsertMessageInCache(activeChatId, saved);
        bumpInboxPreview(activeChatId, saved);
      } catch (e) {
        console.error('Не удалось отправить вложения', e);
      }
    },
    [activeChatId, upsertMessageInCache, bumpInboxPreview],
  );

  const handleEdit = useCallback(
    async (messageId: string, content: string) => {
      if (!activeChatId) return;
      try {
        const saved = await editMessage(messageId, content);
        patchMessageInCache(activeChatId, { ...saved, mine: saved.authorId === currentUserId });
        bumpInboxPreviewIfLast(activeChatId, saved);
      } catch {
        /* keep old content */
      }
    },
    [activeChatId, currentUserId, patchMessageInCache, bumpInboxPreviewIfLast],
  );

  const handleDelete = useCallback(
    async (messageId: string) => {
      if (!activeChatId) return;
      const prev = queryClient.getQueryData<ChatMessage[]>(messagesKey(activeChatId));
      // Optimistic tombstone.
      queryClient.setQueryData<ChatMessage[]>(messagesKey(activeChatId), (old) =>
        old
          ? old.map((m) =>
              m.id === messageId ? { ...m, deletedAt: new Date().toISOString(), content: null } : m,
            )
          : old,
      );
      try {
        await deleteMessage(messageId);
        const tomb = queryClient
          .getQueryData<ChatMessage[]>(messagesKey(activeChatId))
          ?.find((m) => m.id === messageId);
        if (tomb) bumpInboxPreviewIfLast(activeChatId, tomb);
      } catch {
        if (prev) queryClient.setQueryData(messagesKey(activeChatId), prev);
      }
    },
    [activeChatId, queryClient, bumpInboxPreviewIfLast],
  );

  const handleLoadOlder = useCallback(async () => {
    if (!activeChatId || loadingMore || !hasMore) return;
    const current = queryClient.getQueryData<ChatMessage[]>(messagesKey(activeChatId)) ?? [];
    const oldestReal = current.find((m) => !m.id.startsWith('temp-'));
    if (!oldestReal) return;
    setLoadingMore(true);
    try {
      const older = await getMessages(activeChatId, oldestReal.seq);
      if (older.length === 0) {
        setHasMore(false);
      } else {
        queryClient.setQueryData<ChatMessage[]>(messagesKey(activeChatId), (old) => {
          const existing = old ?? [];
          const ids = new Set(existing.map((m) => m.id));
          const merged = [...older.filter((m) => !ids.has(m.id)), ...existing];
          return merged.sort((a, b) => a.seq - b.seq);
        });
      }
    } catch {
      /* leave hasMore as-is so scrolling retries */
    } finally {
      setLoadingMore(false);
    }
  }, [activeChatId, loadingMore, hasMore, queryClient]);

  // ============================================================
  // Derived presence/typing props for the open chat.
  // ============================================================

  // DM peer presence for the conversation header (null for group/context).
  const activeDetail = detailQuery.data;
  const peerPresence = useMemo<PresenceInfo | null>(() => {
    if (!activeDetail || activeDetail.type !== 'dm' || !activeDetail.peerUserId) return null;
    return presence.get(activeDetail.peerUserId) ?? null;
  }, [activeDetail, presence]);

  // Display names of people currently typing in the active chat (never me).
  const typingUserNames = useMemo<string[]>(() => {
    if (!activeChatId || !activeDetail) return [];
    const ids = typing.get(activeChatId);
    if (!ids || ids.size === 0) return [];
    return Array.from(ids).map((uid) => {
      const p = activeDetail.participants.find((x) => x.userId === uid);
      return p?.name ?? 'кто-то';
    });
  }, [activeChatId, activeDetail, typing]);

  // ============================================================
  // Render
  // ============================================================

  if (!isReady) return <FullScreenLoading />;

  return (
    <div className="min-h-screen" style={{ background: 'var(--surface)' }}>
      {/* Nav — glassmorphism, matches other pages */}
      <nav
        className="fixed top-0 w-full z-50 px-6 py-4"
        style={{ background: 'rgba(245, 245, 220, 0.7)', backdropFilter: 'blur(10px)' }}
      >
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <Link href="/dashboard" className="title-md" style={{ color: 'var(--primary)' }}>
            SuperApp6
          </Link>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)' }}>
            <MentionsNavLink unread={mentionsUnread} />
            <Link href="/circles" className="btn-secondary" style={{ padding: '0.4rem 1rem', fontSize: '0.8rem' }}>
              Окружение
            </Link>
            <Link href="/dashboard" className="btn-secondary" style={{ padding: '0.4rem 1rem', fontSize: '0.8rem' }}>
              Главная
            </Link>
          </div>
        </div>
      </nav>

      <div className="max-w-6xl mx-auto px-6 pt-24" style={{ paddingBottom: 'var(--spacing-8)' }}>
        <h1 className="display-md" style={{ marginBottom: 'var(--spacing-6)', paddingLeft: 'var(--spacing-2)' }}>
          Мессенджер
        </h1>

        {/* Two-pane layout */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(260px, 340px) 1fr',
            gap: 'var(--spacing-6)',
            height: 'calc(100vh - 220px)',
            minHeight: '480px',
          }}
        >
          <GlobalSearch
            onSelectChat={selectChat}
            onSelectPerson={handlePickPerson}
            onSelectMessage={(url) => router.push(url)}
          >
            <ChatList
              chats={chats}
              activeChatId={activeChatId}
              currentUserId={currentUserId}
              loading={chatsQuery.isLoading}
              presence={presence}
              onSelect={selectChat}
              onNewChat={() => setShowNewChat(true)}
              embedded
            />
          </GlobalSearch>

          {activeChatId && detailQuery.data ? (
            <Conversation
              detail={detailQuery.data}
              messages={messages}
              currentUserId={currentUserId}
              loadingMessages={messagesQuery.isLoading}
              hasMore={hasMore}
              loadingMore={loadingMore}
              peerPresence={peerPresence}
              typingUserNames={typingUserNames}
              highlightMessageId={highlightMsgId}
              onHighlightConsumed={() => setHighlightMsgId(null)}
              onTypingChange={handleTypingChange}
              onLoadOlder={handleLoadOlder}
              onSend={handleSend}
              onSendAttachments={handleSendAttachments}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onManage={() => setShowManage(true)}
              onCardUpdated={handleCardUpdated}
              onCardAttached={() =>
                queryClient.invalidateQueries({ queryKey: messagesKey(activeChatId) })
              }
              onMessagesChanged={() =>
                queryClient.invalidateQueries({ queryKey: messagesKey(activeChatId) })
              }
            />
          ) : (
            <EmptyConversation loading={!!activeChatId && detailQuery.isLoading} />
          )}
        </div>
      </div>

      {showNewChat && (
        <NewChatModal
          onClose={() => setShowNewChat(false)}
          onPick={handlePickPerson}
          onCreateGroup={handleCreateGroup}
        />
      )}

      {showManage && activeChatId && detailQuery.data && detailQuery.data.type === 'group' && (
        <GroupManageModal
          detail={detailQuery.data}
          currentUserId={currentUserId}
          onClose={() => setShowManage(false)}
          onRename={(title) => handleRenameGroup(activeChatId, title)}
          onAddMembers={(ids) => handleAddMembers(activeChatId, ids)}
          onRemoveMember={(uid) => handleRemoveMember(activeChatId, uid)}
          onSetAdmin={(uid, admin) => handleSetAdmin(activeChatId, uid, admin)}
          onLeave={() => handleLeaveGroup(activeChatId)}
          onDelete={() => handleDeleteGroup(activeChatId)}
        />
      )}
    </div>
  );
}

// ============================================================
// Placeholders
// ============================================================

function EmptyConversation({ loading }: { loading: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        background: 'var(--surface-container-low)',
        borderRadius: 'var(--radius-md)',
        textAlign: 'center',
        padding: 'var(--spacing-8)',
      }}
    >
      {loading ? (
        <p className="label-md">Загрузка...</p>
      ) : (
        <>
          <div
            style={{
              width: '3.5rem',
              height: '3.5rem',
              borderRadius: 'var(--radius-sketch)',
              background: 'var(--secondary-container)',
              marginBottom: 'var(--spacing-4)',
              opacity: 0.6,
              transform: 'rotate(-4deg)',
            }}
          />
          <p className="title-md" style={{ marginBottom: 'var(--spacing-1)' }}>Выберите чат</p>
          <p className="label-sm" style={{ opacity: 0.7, maxWidth: '20rem' }}>
            Откройте диалог слева или начните новый с кем-то из вашего окружения
          </p>
        </>
      )}
    </div>
  );
}

function FullScreenLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <p className="label-md" style={{ fontSize: '1rem' }}>Загрузка...</p>
    </div>
  );
}
