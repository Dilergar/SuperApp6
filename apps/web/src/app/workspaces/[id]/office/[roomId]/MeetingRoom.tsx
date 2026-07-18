'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { apiErrorMessage } from '@/lib/api';
import { fetchOfficeRoom, messengerMessagesKey, officeRoomKey, officeRoomsKey } from '@/lib/queries';
import { endCallSession, getCallToken } from '@/lib/calls-api';
import { CallRoomShell, type CallLeaveReason } from '@/components/calls/CallRoomShell';
import { PreJoin, type PreJoinChoice } from '@/components/calls/PreJoin';
import { CallStage } from '@/components/calls/CallStage';
import { ControlsBar } from '@/components/calls/ControlsBar';
import { ParticipantsPanel } from '@/components/calls/ParticipantsPanel';
import { Conversation } from '@/app/messenger/Conversation';
import {
  getOfficeRoomChat,
  getMessages,
  sendMessage,
  sendAttachmentMessage,
  editMessage,
  deleteMessage,
  markRead,
} from '@/lib/messenger-api';
import {
  useMessengerSocket,
  type SocketMessageDeleted,
  type SocketMessageNew,
  type SocketMessageUpdated,
  type SocketReceipt,
} from '@/lib/hooks/useMessengerSocket';
import type { CallTokenDto, ChatMessage } from '@superapp/shared';

// Ключ сообщений — общий messengerMessagesKey из lib/queries.ts (кэш чата встречи
// делится со страницей /messenger; локальная копия литерала разорвала бы его)

type Phase = 'prejoin' | 'joining' | 'incall' | 'left' | 'kicked' | 'callEnded';

/**
 * Комната встречи «Виртуального офиса»: prejoin (превью/устройства) → звонок
 * (грид тайлов + демонстрация экрана + панель Участники|Чат) → выход/завершение.
 * Чат — контекстный чат мессенджера (история живёт после встречи); обвязка
 * скопирована с детальки задачи (единственный существующий паттерн встраивания).
 */
export default function MeetingRoom() {
  const { isReady, user } = useRequireAuth();
  const { id: wsId, roomId } = useParams<{ id: string; roomId: string }>();
  const queryClient = useQueryClient();
  const currentUserId = user?.id ?? '';

  const roomQ = useQuery({
    queryKey: officeRoomKey(wsId, roomId),
    queryFn: () => fetchOfficeRoom(wsId, roomId),
    enabled: isReady,
    retry: false,
  });
  const room = roomQ.data ?? null;

  const [phase, setPhase] = useState<Phase>('prejoin');
  const [joinError, setJoinError] = useState<string | null>(null);
  const [call, setCall] = useState<CallTokenDto | null>(null);
  const [choice, setChoice] = useState<PreJoinChoice | null>(null);
  const [rightTab, setRightTab] = useState<'people' | 'chat'>('people');

  const handleJoin = async (c: PreJoinChoice) => {
    setChoice(c);
    setJoinError(null);
    setPhase('joining');
    try {
      const t = await getCallToken({ refType: 'office_room', refId: roomId });
      setCall(t);
      setPhase('incall');
    } catch (e) {
      setJoinError(apiErrorMessage(e));
      setPhase('prejoin');
    }
  };

  const handleLeft = useCallback(
    (reason: CallLeaveReason) => {
      setCall(null);
      void queryClient.invalidateQueries({ queryKey: officeRoomKey(wsId, roomId) });
      void queryClient.invalidateQueries({ queryKey: officeRoomsKey(wsId) });
      if (reason === 'ended') setPhase('callEnded');
      else if (reason === 'kicked') setPhase('kicked');
      else if (reason === 'error') {
        setJoinError('Соединение прервалось — попробуйте снова');
        setPhase('prejoin');
      } else setPhase('left');
    },
    [queryClient, wsId, roomId],
  );

  // ============================================================
  // Чат встречи (контекстный чат мессенджера) — обвязка как в /tasks/[id]
  // ============================================================

  const chatQuery = useQuery({
    queryKey: ['messenger', 'office-chat', roomId],
    queryFn: () => getOfficeRoomChat(roomId),
    enabled: isReady && !!room,
    retry: false, // 403 у не-участника завершённой встречи — не долбить повторами
  });
  const chatDetail = chatQuery.data ?? null;
  const chatId = chatDetail?.id ?? null;

  const messagesQuery = useQuery({
    queryKey: chatId ? messengerMessagesKey(chatId) : ['messenger', 'messages', 'none'],
    queryFn: () => getMessages(chatId as string),
    enabled: isReady && !!chatId,
  });
  const messages = useMemo(() => messagesQuery.data ?? [], [messagesQuery.data]);

  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const upsertMessageInCache = useCallback(
    (cid: string, msg: ChatMessage) => {
      queryClient.setQueryData<ChatMessage[]>(messengerMessagesKey(cid), (old) => {
        const list = old ? [...old] : [];
        const byId = list.findIndex((m) => m.id === msg.id);
        if (byId >= 0) {
          list[byId] = { ...list[byId], ...msg };
          return list;
        }
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
    (cid: string, msg: ChatMessage) => {
      queryClient.setQueryData<ChatMessage[]>(messengerMessagesKey(cid), (old) =>
        old ? old.map((m) => (m.id === msg.id ? { ...m, ...msg } : m)) : old,
      );
    },
    [queryClient],
  );

  const applyReceiptToCache = useCallback(
    (r: SocketReceipt) => {
      queryClient.setQueryData<ChatMessage[]>(messengerMessagesKey(r.chatId), (old) => {
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

  const socketRef = useRef<ReturnType<typeof useMessengerSocket> | null>(null);
  const chatIdRef = useRef<string | null>(null);
  chatIdRef.current = chatId;

  const socket = useMessengerSocket({
    onMessageNew: (p: SocketMessageNew) => {
      if (p.chatId !== chatIdRef.current) return;
      const mine = p.message.authorId === currentUserId;
      upsertMessageInCache(p.chatId, { ...p.message, mine });
      if (!mine) {
        socketRef.current?.emitDelivered(p.chatId, p.message.seq);
        markRead(p.chatId, p.message.seq).catch(() => {});
        socketRef.current?.emitRead(p.chatId, p.message.seq);
      }
    },
    onMessageUpdated: (p: SocketMessageUpdated) => {
      if (p.chatId !== chatIdRef.current) return;
      patchMessageInCache(p.chatId, { ...p.message, mine: p.message.authorId === currentUserId });
    },
    onMessageDeleted: (p: SocketMessageDeleted) => {
      if (p.chatId !== chatIdRef.current) return;
      patchMessageInCache(p.chatId, { ...p.message, mine: p.message.authorId === currentUserId });
    },
    onReceipt: (p: SocketReceipt) => {
      if (p.chatId !== chatIdRef.current) return;
      applyReceiptToCache(p);
    },
  });
  socketRef.current = socket;

  const latestRealSeq = useMemo(() => {
    let max = 0;
    for (const m of messages) {
      if (m.id.startsWith('temp-')) continue;
      if (m.seq !== Number.MAX_SAFE_INTEGER && m.seq > max) max = m.seq;
    }
    return max;
  }, [messages]);

  useEffect(() => {
    if (!chatId || !latestRealSeq) return;
    markRead(chatId, latestRealSeq).catch(() => {});
    socketRef.current?.emitRead(chatId, latestRealSeq);
  }, [chatId, latestRealSeq]);

  const handleSend = useCallback(
    async (content: string, replyToId?: string) => {
      if (!chatId) return;
      const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const optimistic: ChatMessage = {
        id: tempId,
        chatId,
        authorId: currentUserId,
        authorName: user?.firstName ?? null,
        authorAvatar: user?.avatar ?? null,
        type: 'text',
        content,
        payload: null,
        seq: Number.MAX_SAFE_INTEGER,
        editedAt: null,
        deletedAt: null,
        createdAt: new Date().toISOString(),
        mine: true,
        status: 'sent',
      };
      queryClient.setQueryData<ChatMessage[]>(messengerMessagesKey(chatId), (old) =>
        old ? [...old, optimistic] : [optimistic],
      );
      try {
        const saved = await sendMessage(chatId, content, replyToId);
        queryClient.setQueryData<ChatMessage[]>(messengerMessagesKey(chatId), (old) => {
          if (!old) return [saved];
          const withoutTemp = old.filter((m) => m.id !== tempId);
          if (withoutTemp.some((m) => m.id === saved.id)) {
            return [...withoutTemp].sort((a, b) => a.seq - b.seq);
          }
          return [...withoutTemp, saved].sort((a, b) => a.seq - b.seq);
        });
      } catch {
        queryClient.setQueryData<ChatMessage[]>(messengerMessagesKey(chatId), (old) =>
          old ? old.filter((m) => m.id !== tempId) : old,
        );
      }
    },
    [chatId, currentUserId, user, queryClient],
  );

  const handleSendAttachments = useCallback(
    async (fileIds: string[], caption: string, replyToId?: string) => {
      if (!chatId) return;
      try {
        const saved = await sendAttachmentMessage(chatId, fileIds, caption || undefined, replyToId);
        upsertMessageInCache(chatId, saved);
      } catch (e) {
        console.error('Не удалось отправить вложения', e);
      }
    },
    [chatId, upsertMessageInCache],
  );

  const handleEdit = useCallback(
    async (messageId: string, content: string) => {
      if (!chatId) return;
      try {
        const saved = await editMessage(messageId, content);
        patchMessageInCache(chatId, { ...saved, mine: saved.authorId === currentUserId });
      } catch {
        /* оставляем старый текст */
      }
    },
    [chatId, currentUserId, patchMessageInCache],
  );

  const handleDelete = useCallback(
    async (messageId: string) => {
      if (!chatId) return;
      const prev = queryClient.getQueryData<ChatMessage[]>(messengerMessagesKey(chatId));
      queryClient.setQueryData<ChatMessage[]>(messengerMessagesKey(chatId), (old) =>
        old
          ? old.map((m) =>
              m.id === messageId ? { ...m, deletedAt: new Date().toISOString(), content: null } : m,
            )
          : old,
      );
      try {
        await deleteMessage(messageId);
      } catch {
        if (prev) queryClient.setQueryData(messengerMessagesKey(chatId), prev);
      }
    },
    [chatId, queryClient],
  );

  const handleLoadOlder = useCallback(async () => {
    if (!chatId || loadingMore || !hasMore) return;
    const current = queryClient.getQueryData<ChatMessage[]>(messengerMessagesKey(chatId)) ?? [];
    const oldestReal = current.find((m) => !m.id.startsWith('temp-'));
    if (!oldestReal) return;
    setLoadingMore(true);
    try {
      const older = await getMessages(chatId, oldestReal.seq);
      if (older.length === 0) {
        setHasMore(false);
      } else {
        queryClient.setQueryData<ChatMessage[]>(messengerMessagesKey(chatId), (old) => {
          const existing = old ?? [];
          const ids = new Set(existing.map((m) => m.id));
          const merged = [...older.filter((m) => !ids.has(m.id)), ...existing];
          return merged.sort((a, b) => a.seq - b.seq);
        });
      }
    } catch {
      /* hasMore не трогаем */
    } finally {
      setLoadingMore(false);
    }
  }, [chatId, loadingMore, hasMore, queryClient]);

  // ============================================================
  // Рендер
  // ============================================================

  if (!isReady || roomQ.isLoading) return <p className="label-md">Загрузка…</p>;

  if (!room) {
    return (
      <div style={{ textAlign: 'center', paddingTop: 'var(--spacing-12)' }}>
        <p className="title-md" style={{ marginBottom: 'var(--spacing-3)' }}>Встреча не найдена или нет доступа</p>
        <Link href={`/workspaces/${wsId}/office`} className="btn-secondary" style={{ padding: '0.5rem 1.2rem', textDecoration: 'none' }}>← К встречам</Link>
      </div>
    );
  }

  if (room.status === 'ended') {
    // Завершённая встреча = её история: заголовок + живой чат (переписка, а в Ф3 сюда же
    // придут транскрипция и протокол собрания). Чат — только участникам (office_room.view).
    return (
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        <Link
          href={`/workspaces/${wsId}/office`}
          className="label-md"
          style={{ color: 'var(--secondary)', fontWeight: 600, textDecoration: 'none', display: 'inline-block', marginBottom: 'var(--spacing-4)' }}
        >
          ← Встречи
        </Link>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--spacing-3)', flexWrap: 'wrap', marginBottom: 'var(--spacing-4)' }}>
          <h1 className="title-lg" style={{ fontSize: '1.2rem' }}>🏁 {room.name}</h1>
          <span className="label-sm" style={{ opacity: 0.7 }}>
            Завершена{room.endedAt ? ` ${new Date(room.endedAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}
          </span>
        </div>
        {chatQuery.isError ? (
          <div className="card" style={{ padding: 'var(--spacing-6)', textAlign: 'center' }}>
            <p className="label-md">Чат встречи доступен только её участникам</p>
          </div>
        ) : chatDetail ? (
          <div
            className="card"
            style={{ padding: 'var(--spacing-3)', height: 'calc(100vh - 250px)', minHeight: 380, display: 'flex', flexDirection: 'column' }}
          >
            <Conversation
              detail={chatDetail}
              messages={messages}
              currentUserId={currentUserId}
              loadingMessages={messagesQuery.isLoading}
              hasMore={hasMore}
              loadingMore={loadingMore}
              onLoadOlder={handleLoadOlder}
              onSend={handleSend}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onSendAttachments={handleSendAttachments}
            />
          </div>
        ) : (
          <p className="label-md">Загрузка чата…</p>
        )}
      </div>
    );
  }

  if (phase === 'left' || phase === 'callEnded' || phase === 'kicked') {
    return (
      <FinalScreen
        icon={phase === 'kicked' ? '🚪' : phase === 'callEnded' ? '🏁' : '👋'}
        title={
          phase === 'kicked'
            ? 'Вас исключили из звонка'
            : phase === 'callEnded'
              ? 'Звонок завершён'
              : 'Вы покинули встречу'
        }
        note={phase === 'callEnded' ? 'Ссылка встречи продолжает работать — можно созвониться снова' : undefined}
        wsId={wsId}
        onRejoin={phase === 'kicked' ? undefined : () => setPhase('prejoin')}
      />
    );
  }

  if (phase === 'prejoin' || phase === 'joining') {
    return (
      <div>
        <Link href={`/workspaces/${wsId}/office`} className="label-md" style={{ color: 'var(--secondary)', fontWeight: 600, textDecoration: 'none', display: 'inline-block', marginBottom: 'var(--spacing-5)' }}>
          ← Встречи
        </Link>
        <PreJoin title={room.name} joining={phase === 'joining'} error={joinError} onJoin={handleJoin} />
        {room.live && (
          <p className="label-md" style={{ textAlign: 'center', marginTop: 'var(--spacing-4)' }}>
            Сейчас в звонке: {room.live.participantCount}
          </p>
        )}
      </div>
    );
  }

  // incall
  if (!call || !choice) return null;
  return (
    <CallRoomShell
      token={call.token}
      wsUrl={call.wsUrl}
      audioEnabled={choice.audioEnabled}
      videoEnabled={choice.videoEnabled}
      audioDeviceId={choice.audioDeviceId}
      videoDeviceId={choice.videoDeviceId}
      onLeft={handleLeft}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-3)', flexWrap: 'wrap' }}>
        <div className="title-lg" style={{ fontSize: '1.1rem' }}>🎥 {room.name}</div>
        <div style={{ display: 'flex', gap: 'var(--spacing-2)' }}>
          <TabButton active={rightTab === 'people'} onClick={() => setRightTab('people')}>Участники</TabButton>
          <TabButton active={rightTab === 'chat'} onClick={() => setRightTab('chat')}>Чат</TabButton>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 'var(--spacing-4)', alignItems: 'stretch', height: 'calc(100vh - 220px)', minHeight: 420 }}>
        {/* Сцена + контролы */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)' }}>
          <CallStage />
          <ControlsBar
            moderator={call.moderator}
            onEndForAll={() => {
              if (confirm('Завершить звонок для всех участников?')) {
                endCallSession(call.sessionId).catch((e) => alert(apiErrorMessage(e)));
              }
            }}
          />
        </div>

        {/* Правая панель: Участники | Чат */}
        <aside
          style={{
            width: 330,
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            borderRadius: 'var(--radius-sketch)',
            background: 'var(--surface-container-low)',
            padding: 'var(--spacing-3)',
            minHeight: 0,
          }}
        >
          {rightTab === 'people' ? (
            <div style={{ overflowY: 'auto', minHeight: 0 }}>
              <ParticipantsPanel sessionId={call.sessionId} moderator={call.moderator} currentUserId={currentUserId} />
            </div>
          ) : chatDetail ? (
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <Conversation
                detail={chatDetail}
                messages={messages}
                currentUserId={currentUserId}
                loadingMessages={messagesQuery.isLoading}
                hasMore={hasMore}
                loadingMore={loadingMore}
                onLoadOlder={handleLoadOlder}
                onSend={handleSend}
                onEdit={handleEdit}
                onDelete={handleDelete}
                onSendAttachments={handleSendAttachments}
              />
            </div>
          ) : (
            <p className="label-md">Загрузка чата…</p>
          )}
        </aside>
      </div>
    </CallRoomShell>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '0.35rem 1rem',
        fontSize: '0.82rem',
        fontWeight: 600,
        border: 'none',
        cursor: 'pointer',
        borderRadius: '0.7rem 0.5rem 0.65rem 0.55rem',
        background: active ? 'var(--secondary-container)' : 'var(--surface-container)',
        color: active ? 'var(--secondary)' : 'inherit',
      }}
    >
      {children}
    </button>
  );
}

function FinalScreen({
  icon,
  title,
  note,
  wsId,
  onRejoin,
}: {
  icon: string;
  title: string;
  note?: string;
  wsId: string;
  onRejoin?: () => void;
}) {
  return (
    <div style={{ textAlign: 'center', paddingTop: 'var(--spacing-12)' }}>
      <div style={{ fontSize: '2.6rem', marginBottom: 'var(--spacing-3)' }}>{icon}</div>
      <p className="title-lg" style={{ marginBottom: 'var(--spacing-2)' }}>{title}</p>
      {note && <p className="label-md" style={{ marginBottom: 'var(--spacing-2)' }}>{note}</p>}
      <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'center', marginTop: 'var(--spacing-5)' }}>
        {onRejoin && (
          <button className="btn-primary" style={{ padding: '0.55rem 1.5rem' }} onClick={onRejoin}>
            Присоединиться снова
          </button>
        )}
        <Link href={`/workspaces/${wsId}/office`} className="btn-secondary" style={{ padding: '0.55rem 1.3rem', textDecoration: 'none' }}>
          ← К встречам
        </Link>
      </div>
    </div>
  );
}
