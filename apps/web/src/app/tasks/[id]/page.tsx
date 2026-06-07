'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { api } from '@/lib/api';
import { PersonAvatar } from '../../messenger/messenger-ui';
import { PersonChip } from '../../circles/PersonCard';
import {
  TASK_STATUS_META,
  TASK_PRIORITY_META,
  TASK_ROLE_LABELS,
  TASK_CREATOR_LABEL,
  PARTICIPANT_STATUS_META,
  type Task,
  type TaskParticipant,
  type ChatDetail,
  type ChatMessage,
} from '@superapp/shared';
import {
  getTaskChat,
  getMessages,
  sendMessage,
  editMessage,
  deleteMessage,
  markRead,
} from '@/lib/messenger-api';
import {
  useMessengerSocket,
  type SocketMessageNew,
  type SocketMessageUpdated,
  type SocketMessageDeleted,
  type SocketReceipt,
} from '@/lib/hooks/useMessengerSocket';
import { Conversation } from '../../messenger/Conversation';
import { ShareCardModal } from '../../messenger/ShareCardModal';

const messagesKey = (chatId: string) => ['messenger', 'messages', chatId] as const;

export default function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { isReady, user } = useRequireAuth();
  const currentUserId = user?.id ?? '';
  const queryClient = useQueryClient();

  const [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showForward, setShowForward] = useState(false);

  const load = useCallback(async () => {
    try {
      const t = await api.get(`/tasks/${id}`);
      setTask(t.data.data);
    } catch (err: unknown) {
      const a = err as { response?: { status?: number } };
      setError(a.response?.status === 403 ? 'Нет доступа к этой задаче' : 'Задача не найдена');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { if (isReady) load(); }, [isReady, load]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await fn(); await load(); }
    catch (err: unknown) {
      const a = err as { response?: { data?: { message?: string } } };
      setError(a.response?.data?.message || 'Ошибка');
    } finally { setBusy(false); }
  };

  const start = () => act(() => api.patch(`/tasks/${id}`, { status: 'in_progress' }));
  const submit = () => act(() => api.post(`/tasks/${id}/submit`, {}));
  const accept = (participantUserId?: string) => act(() => api.post(`/tasks/${id}/accept`, { participantUserId }));
  const returnWork = (participantUserId?: string) => act(() => api.post(`/tasks/${id}/return`, { participantUserId }));
  const cancel = () => act(() => api.patch(`/tasks/${id}`, { status: 'cancelled' }));
  const remove = () => act(async () => { await api.delete(`/tasks/${id}`); router.push('/tasks'); });

  // ============================================================
  // Task chat (context chat) — mirrors the /messenger page wiring:
  // get-or-create on load, live socket updates into the react-query
  // message cache, optimistic send / edit / delete, scroll-back.
  // ============================================================

  const chatQuery = useQuery({
    queryKey: ['messenger', 'task-chat', id],
    queryFn: () => getTaskChat(id),
    enabled: isReady && !!task, // wait until the task itself resolved (access)
  });
  const chatDetail = chatQuery.data ?? null;
  const chatId = chatDetail?.id ?? null;

  const messagesQuery = useQuery({
    queryKey: chatId ? messagesKey(chatId) : ['messenger', 'messages', 'none'],
    queryFn: () => getMessages(chatId as string),
    enabled: isReady && !!chatId,
  });
  const messages = useMemo(() => messagesQuery.data ?? [], [messagesQuery.data]);

  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const upsertMessageInCache = useCallback(
    (cid: string, msg: ChatMessage) => {
      queryClient.setQueryData<ChatMessage[]>(messagesKey(cid), (old) => {
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
      queryClient.setQueryData<ChatMessage[]>(messagesKey(cid), (old) =>
        old ? old.map((m) => (m.id === msg.id ? { ...m, ...msg } : m)) : old,
      );
    },
    [queryClient],
  );

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

  const socketRef = useRef<ReturnType<typeof useMessengerSocket> | null>(null);
  const chatIdRef = useRef<string | null>(null);
  chatIdRef.current = chatId;

  const socket = useMessengerSocket({
    onMessageNew: (p: SocketMessageNew) => {
      if (p.chatId !== chatIdRef.current) return;
      const mine = p.message.authorId === currentUserId;
      const msg: ChatMessage = { ...p.message, mine };
      upsertMessageInCache(p.chatId, msg);
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

  // Mark read up to the latest real seq whenever messages grow.
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
    async (content: string) => {
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
      queryClient.setQueryData<ChatMessage[]>(messagesKey(chatId), (old) =>
        old ? [...old, optimistic] : [optimistic],
      );
      try {
        const saved = await sendMessage(chatId, content);
        queryClient.setQueryData<ChatMessage[]>(messagesKey(chatId), (old) => {
          if (!old) return [saved];
          const withoutTemp = old.filter((m) => m.id !== tempId);
          if (withoutTemp.some((m) => m.id === saved.id)) {
            return [...withoutTemp].sort((a, b) => a.seq - b.seq);
          }
          return [...withoutTemp, saved].sort((a, b) => a.seq - b.seq);
        });
      } catch {
        queryClient.setQueryData<ChatMessage[]>(messagesKey(chatId), (old) =>
          old ? old.filter((m) => m.id !== tempId) : old,
        );
      }
    },
    [chatId, currentUserId, user, queryClient],
  );

  const handleEdit = useCallback(
    async (messageId: string, content: string) => {
      if (!chatId) return;
      try {
        const saved = await editMessage(messageId, content);
        patchMessageInCache(chatId, { ...saved, mine: saved.authorId === currentUserId });
      } catch {
        /* keep old content */
      }
    },
    [chatId, currentUserId, patchMessageInCache],
  );

  const handleDelete = useCallback(
    async (messageId: string) => {
      if (!chatId) return;
      const prev = queryClient.getQueryData<ChatMessage[]>(messagesKey(chatId));
      queryClient.setQueryData<ChatMessage[]>(messagesKey(chatId), (old) =>
        old
          ? old.map((m) =>
              m.id === messageId ? { ...m, deletedAt: new Date().toISOString(), content: null } : m,
            )
          : old,
      );
      try {
        await deleteMessage(messageId);
      } catch {
        if (prev) queryClient.setQueryData(messagesKey(chatId), prev);
      }
    },
    [chatId, queryClient],
  );

  const handleLoadOlder = useCallback(async () => {
    if (!chatId || loadingMore || !hasMore) return;
    const current = queryClient.getQueryData<ChatMessage[]>(messagesKey(chatId)) ?? [];
    const oldestReal = current.find((m) => !m.id.startsWith('temp-'));
    if (!oldestReal) return;
    setLoadingMore(true);
    try {
      const older = await getMessages(chatId, oldestReal.seq);
      if (older.length === 0) {
        setHasMore(false);
      } else {
        queryClient.setQueryData<ChatMessage[]>(messagesKey(chatId), (old) => {
          const existing = old ?? [];
          const ids = new Set(existing.map((m) => m.id));
          const merged = [...older.filter((m) => !ids.has(m.id)), ...existing];
          return merged.sort((a, b) => a.seq - b.seq);
        });
      }
    } catch {
      /* leave hasMore as-is */
    } finally {
      setLoadingMore(false);
    }
  }, [chatId, loadingMore, hasMore, queryClient]);

  if (!isReady || loading) {
    return <div className="min-h-screen flex items-center justify-center"><p className="label-md">Загрузка...</p></div>;
  }
  if (!task) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ flexDirection: 'column', gap: '1rem' }}>
        <p className="label-md">{error || 'Задача не найдена'}</p>
        <Link href="/tasks" className="btn-secondary" style={{ padding: '0.4rem 1rem' }}>К задачам</Link>
      </div>
    );
  }

  const st = TASK_STATUS_META[task.status];
  const pr = TASK_PRIORITY_META[task.priority];
  const isCreator = task.myRole === 'creator';
  const isWorker = task.myRole === 'executor' || task.myRole === 'co_executor';
  const isSelfTask = isCreator && !task.assignedCircleId && !task.executor && task.coExecutors.length === 0;
  const canSubmit = (isWorker && (task.myParticipantStatus === 'pending' || task.myParticipantStatus === 'returned'))
    || (isSelfTask && task.status !== 'done');
  const canStart = (isWorker || isSelfTask) && task.status === 'todo';
  const workers: TaskParticipant[] = [...(task.executor ? [task.executor] : []), ...task.coExecutors];

  return (
    <div className="min-h-screen" style={{ background: 'var(--surface)' }}>
      <nav className="fixed top-0 w-full z-50 px-6 py-4" style={{ background: 'rgba(245, 245, 220, 0.7)', backdropFilter: 'blur(10px)' }}>
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <Link href="/tasks" className="title-md" style={{ color: 'var(--primary)' }}>← Задачи</Link>
          <div style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'center' }}>
            <button onClick={() => setShowForward(true)} className="btn-secondary" style={{ padding: '0.4rem 1rem', fontSize: '0.8rem' }}>↗ Переслать в чат</button>
            {isCreator && (
              <>
                {task.status !== 'cancelled' && task.status !== 'done' && (
                  <button onClick={cancel} disabled={busy} className="btn-secondary" style={{ padding: '0.4rem 1rem', fontSize: '0.8rem' }}>Отменить</button>
                )}
                <button onClick={() => { if (confirm('Удалить задачу?')) remove(); }} disabled={busy} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', fontSize: '0.8rem', fontWeight: 600 }}>Удалить</button>
              </>
            )}
          </div>
        </div>
      </nav>

      <div className="max-w-3xl mx-auto px-6 pt-24" style={{ paddingBottom: 'var(--spacing-16)' }}>
        {error && <div className="wash-primary" style={{ padding: 'var(--spacing-3) var(--spacing-4)', marginBottom: 'var(--spacing-4)', color: 'var(--primary)', fontSize: '0.875rem' }}>{error}</div>}

        {/* Header */}
        <div style={{ marginBottom: 'var(--spacing-5)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-2)' }}>
            <span style={{ color: st.color, fontWeight: 600, fontSize: '0.8rem', background: 'var(--surface-container)', padding: '0.15rem 0.6rem', borderRadius: 'var(--radius-sketch)' }}>{st.icon} {st.label}</span>
            <span style={{ color: pr.color, fontWeight: 700, fontSize: '0.75rem' }}>{pr.label} приоритет</span>
          </div>
          <h1 className="display-md" style={{ marginBottom: 'var(--spacing-2)', textDecoration: task.status === 'done' ? 'line-through' : 'none' }}>{task.title}</h1>
          {task.description && <p className="label-md" style={{ fontSize: '0.95rem', whiteSpace: 'pre-wrap' }}>{task.description}</p>}
        </div>

        {/* Meta */}
        <div className="card" style={{ padding: 'var(--spacing-4) var(--spacing-5)', marginBottom: 'var(--spacing-5)', display: 'flex', gap: 'var(--spacing-6)', flexWrap: 'wrap' }}>
          <div>
            <div className="label-sm" style={{ fontSize: '0.7rem', opacity: 0.7, marginBottom: '0.15rem' }}>{TASK_CREATOR_LABEL}</div>
            <PersonChip size="S" userId={task.creatorId} firstName={task.creatorName} avatar={task.creatorAvatar} />
          </div>
          {task.dueDate && <Meta label="Дедлайн" value={formatDue(task.dueDate, task.allDay)} />}
          {task.recurrenceRule && <Meta label="Повтор" value="включён" />}
          {task.coinReward > 0 && <Meta label={task.assignedCircleName ? 'Награда (каждому)' : 'Награда'} value={`${task.coinReward} 🪙`} />}
          {task.progress && <Meta label="Прогресс" value={`${task.progress.accepted} из ${task.progress.total} принято`} />}
        </div>

        {/* My actions */}
        {(canStart || canSubmit) && (
          <div style={{ display: 'flex', gap: 'var(--spacing-3)', marginBottom: 'var(--spacing-5)' }}>
            {canStart && <button onClick={start} disabled={busy} className="btn-secondary" style={{ fontSize: '0.9rem' }}>Взять в работу</button>}
            {canSubmit && <button onClick={submit} disabled={busy} className="btn-primary" style={{ fontSize: '0.9rem' }}>{isSelfTask ? 'Готово' : 'Сдать на проверку'}</button>}
          </div>
        )}
        {isWorker && task.myParticipantStatus === 'submitted' && (
          <p className="wash-secondary" style={{ padding: 'var(--spacing-3) var(--spacing-4)', marginBottom: 'var(--spacing-5)', fontSize: '0.85rem', color: 'var(--secondary)' }}>Сдано — ждёт приёмки Постановщика</p>
        )}

        {/* Roles / participants */}
        <h2 className="title-md" style={{ marginBottom: 'var(--spacing-3)' }}>
          {task.assignedCircleName ? `Исполнитель: Группа «${task.assignedCircleName}»` : 'Участники'}
        </h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-3)' }}>
          {workers.length === 0 && !task.assignedCircleName && (
            <p className="label-sm">Личная задача — без других участников</p>
          )}
          {workers.map((p) => (
            <ParticipantRow key={p.id} p={p} showAccept={isCreator} busy={busy}
              onAccept={() => accept(p.userId)} onReturn={() => returnWork(p.userId)} />
          ))}
        </div>
        {task.observers.length > 0 && (
          <div style={{ marginBottom: 'var(--spacing-3)' }}>
            <span className="label-sm" style={{ fontWeight: 600 }}>{TASK_ROLE_LABELS.observer}и: </span>
            {task.observers.map((o) => (
              <span key={o.id} style={{ display: 'inline-block', marginRight: 'var(--spacing-2)' }}>
                <PersonChip size="S" userId={o.userId} firstName={o.name} avatar={o.avatar} />
              </span>
            ))}
          </div>
        )}

        {/* Chat — the task's context chat in the Messenger */}
        <h2 className="title-md" style={{ margin: 'var(--spacing-8) 0 var(--spacing-3)' }}>Чат задачи</h2>
        <div style={{ height: '520px', minHeight: '380px' }}>
          {chatDetail ? (
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
            />
          ) : (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                background: 'var(--surface-container-low)',
                borderRadius: 'var(--radius-md)',
              }}
            >
              <p className="label-sm">{chatQuery.isError ? 'Не удалось загрузить чат задачи' : 'Загрузка чата...'}</p>
            </div>
          )}
        </div>
      </div>

      {showForward && (
        <ShareCardModal
          refType="task"
          refId={task.id}
          title={task.title}
          onClose={() => setShowForward(false)}
        />
      )}
    </div>
  );
}

function ParticipantRow({ p, showAccept, busy, onAccept, onReturn }: {
  p: TaskParticipant; showAccept: boolean; busy: boolean;
  onAccept: () => void; onReturn: () => void;
}) {
  const stat = PARTICIPANT_STATUS_META[p.status];
  return (
    <div className="card" style={{ padding: 'var(--spacing-3) var(--spacing-4)', display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)' }}>
      <PersonAvatar userId={p.userId} name={p.name} size="sm" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>{p.name}</div>
        <span className="label-sm" style={{ fontSize: '0.7rem' }}>{roleLabel(p.role)}</span>
      </div>
      <span className="label-sm" style={{ color: stat.color, fontWeight: 600, fontSize: '0.78rem' }}>{stat.label}</span>
      {showAccept && p.status === 'submitted' && (
        <div style={{ display: 'flex', gap: 'var(--spacing-1)' }}>
          <button onClick={onAccept} disabled={busy} className="btn-primary" style={{ padding: '0.25rem 0.7rem', fontSize: '0.75rem' }}>Принять</button>
          <button onClick={onReturn} disabled={busy} className="btn-secondary" style={{ padding: '0.25rem 0.7rem', fontSize: '0.75rem' }}>Вернуть</button>
        </div>
      )}
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="label-sm" style={{ fontSize: '0.7rem', opacity: 0.7 }}>{label}</div>
      <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>{value}</div>
    </div>
  );
}

// (local Avatar removed — people now render via the shared skin-aware PersonAvatar)

function roleLabel(role: string): string {
  if (role === 'creator') return TASK_CREATOR_LABEL;
  return TASK_ROLE_LABELS[role as keyof typeof TASK_ROLE_LABELS] ?? role;
}

function formatDue(iso: string, allDay: boolean): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
  if (allDay) return date;
  return `${date}, ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
}
