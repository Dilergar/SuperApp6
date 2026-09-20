'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Chip, useConfirm } from '@/components/ui';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api';
import { PersonAvatar } from '../../messenger/messenger-ui';
import { PersonChip } from '../../circles/PersonCard';
import {
  TASK_STATUS_META,
  TASK_PRIORITY_META,
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
  sendAttachmentMessage,
  editMessage,
  deleteMessage,
  markRead,
} from '@/lib/messenger-api';
import { useMessengerSocket } from '@/lib/hooks/useMessengerSocket';
import { NotesPanel } from '@/components/notes/NotesPanel';
import type { WsMessageNew, WsMessageUpdated, WsMessageDeleted, WsReceipt } from '@superapp/shared';
import { TASK_STATUS_ICON, useDueFormat } from '../tasks-ui';
import { Conversation } from '../../messenger/Conversation';
import { ShareCardModal } from '../../messenger/ShareCardModal';
import { AttachmentsSection } from '@/components/files/AttachmentsSection';
import { apiErrorCode, isOutcomeUnknown, toastApiError } from '@/lib/api-errors';
import { useIdempotencyIntent } from '@/lib/useIdempotencyKey';
import { OutcomeUnknownAlert, SlowRequestNote } from '@/components/idempotency/OutcomeUnknownAlert';
import { messengerMessagesKey, taskAttachmentsKey } from '@/lib/queries';
import type { FileDto } from '@superapp/shared';

// Ключ сообщений — общий messengerMessagesKey из lib/queries.ts: чат задачи делит
// кэш со страницей /messenger (локальная копия литерала молча разорвала бы его)

export default function TaskDetailPage() {
  const t = useTranslations('tasks');
  const tc = useTranslations('common');
  const formatDue = useDueFormat();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { isReady, user } = useRequireAuth();
  const currentUserId = user?.id ?? '';
  const queryClient = useQueryClient();

  const [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, confirmUI] = useConfirm();
  const [showForward, setShowForward] = useState(false);

  const load = useCallback(async () => {
    try {
      setTask(await apiGet<Task>(`/tasks/${id}`));
    } catch (err: unknown) {
      const a = err as { response?: { status?: number } };
      setError(a.response?.status === 403 ? t('detail.noAccess') : t('detail.notFound'));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { if (isReady) load(); }, [isReady, load]);

  // Приёмка работы ВЫПЛАЧИВАЕТ награду из эскроу — это деньги, и повтор обязан
  // быть одной выплатой. Ключ намерения — на пару «эта попытка × этот исполнитель»
  // (кнопка стоит у каждого участника, поэтому хук на форму здесь не подходит).
  const reviewIntent = useIdempotencyIntent();
  // «Исход неизвестен» за кнопкой приёмки тостом не показывают: выплата могла пройти
  const [unknownOutcome, setUnknownOutcome] = useState<unknown>(null);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(''); setUnknownOutcome(null);
    try { await fn(); await load(); }
    catch (err: unknown) {
      // «Могло пройти» — награда могла уйти: веди смотреть карточку, а не пугай
      if (isOutcomeUnknown(err)) { setUnknownOutcome(err); return; }
      // Исходы движка повторов несут СВОЙ тон: «уже принято» — успех, а не беда
      if (apiErrorCode(err)?.startsWith('idempotency.')) { toastApiError(err); await load(); return; }
      const a = err as { response?: { data?: { message?: string } } };
      setError(a.response?.data?.message || tc('state.error'));
    } finally { setBusy(false); }
  };

  const start = () => act(() => apiPatch(`/tasks/${id}`, { status: 'in_progress' }));
  const submit = () => act(() => apiPost(`/tasks/${id}/submit`, {}));
  const accept = (participantUserId?: string) =>
    act(async () => {
      await apiPost(`/tasks/${id}/accept`, { participantUserId }, {
        idempotencyKey: reviewIntent.keyFor('accept', id, participantUserId),
      });
      reviewIntent.reset();
    });
  const returnWork = (participantUserId?: string) =>
    act(async () => {
      await apiPost(`/tasks/${id}/return`, { participantUserId }, {
        idempotencyKey: reviewIntent.keyFor('return', id, participantUserId),
      });
      reviewIntent.reset();
    });
  const cancel = () => act(() => apiPatch(`/tasks/${id}`, { status: 'cancelled' }));
  const remove = () => act(async () => { await apiDelete(`/tasks/${id}`); router.push('/tasks'); });

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
    (r: WsReceipt) => {
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
    onMessageNew: (p: WsMessageNew) => {
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
    onMessageUpdated: (p: WsMessageUpdated) => {
      if (p.chatId !== chatIdRef.current) return;
      patchMessageInCache(p.chatId, { ...p.message, mine: p.message.authorId === currentUserId });
    },
    onMessageDeleted: (p: WsMessageDeleted) => {
      if (p.chatId !== chatIdRef.current) return;
      patchMessageInCache(p.chatId, { ...p.message, mine: p.message.authorId === currentUserId });
    },
    onReceipt: (p: WsReceipt) => {
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
      queryClient.setQueryData<ChatMessage[]>(messengerMessagesKey(chatId), (old) =>
        old ? [...old, optimistic] : [optimistic],
      );
      try {
        const saved = await sendMessage(chatId, content);
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

  // Ф9: вложения в чате задачи — без temp-пузыря (id-дедуп против socket-эха уже есть)
  const handleSendAttachments = useCallback(
    async (fileIds: string[], caption: string, replyToId?: string) => {
      if (!chatId) return;
      try {
        const saved = await sendAttachmentMessage(chatId, fileIds, caption || undefined, replyToId);
        upsertMessageInCache(chatId, saved);
      } catch (e) {
        console.error('Failed to send the attachments', e);
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
        /* keep old content */
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
      /* leave hasMore as-is */
    } finally {
      setLoadingMore(false);
    }
  }, [chatId, loadingMore, hasMore, queryClient]);

  if (!isReady || loading) {
    return <div className="min-h-screen flex items-center justify-center"><p className="label-md">{tc('state.loading')}</p></div>;
  }
  if (!task) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ flexDirection: 'column', gap: '1rem' }}>
        <p className="label-md">{error || t('detail.notFound')}</p>
        <Link href="/tasks" className="btn-secondary" style={{ padding: '0.4rem 1rem' }}>{t('detail.backToList')}</Link>
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
    <div style={{ maxWidth: 800 }}>
      {/* Топбар и сайдбар теперь даёт ServiceShell — здесь только строка действий */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-5)', flexWrap: 'wrap' }}>
        <Link href="/tasks" className="label-md" style={{ color: 'var(--secondary)', fontWeight: 600, textDecoration: 'none' }}>← {t('breadcrumb')}</Link>
        <div style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={() => setShowForward(true)} className="btn-ghost-inline" style={{ padding: '0.4rem 1rem', fontSize: '0.8rem' }}>↗ {t('detail.forward')}</button>
          {isCreator && (
            <>
              {task.status !== 'cancelled' && task.status !== 'done' && (
                <button onClick={cancel} disabled={busy} className="btn-ghost-inline" style={{ padding: '0.4rem 1rem', fontSize: '0.8rem' }}>{t('detail.cancel')}</button>
              )}
              <button
                onClick={() => confirm(
                  { title: t('detail.deleteConfirm.title'), message: t('detail.deleteConfirm.message'), confirmLabel: tc('actions.delete'), danger: true },
                  remove,
                )}
                disabled={busy}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', fontSize: '0.8rem', fontWeight: 600 }}
              >{tc('actions.delete')}</button>
            </>
          )}
        </div>
      </div>

      <div style={{ paddingBottom: 'var(--spacing-16)' }}>
        {unknownOutcome != null && (
          <div style={{ marginBottom: 'var(--spacing-4)' }}>
            {/* Приёмка МОГЛА пройти (награда ушла): плашка ведёт перечитать карточку,
                а не подталкивает нажать «Принять» второй раз. */}
            <OutcomeUnknownAlert
              error={unknownOutcome}
              onOpenHistory={() => { setUnknownOutcome(null); void load(); }}
              onDismiss={() => setUnknownOutcome(null)}
            />
          </div>
        )}
        <SlowRequestNote pending={busy} />
        {error && <div className="alert-neutral-inline" style={{ padding: 'var(--spacing-3) var(--spacing-4)', marginBottom: 'var(--spacing-4)', color: 'var(--primary)', fontSize: '0.875rem' }}>{error}</div>}

        {/* Header */}
        <div style={{ marginBottom: 'var(--spacing-5)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-2)' }}>
            {/* Те же чипы, что в строке списка (`tasks-ui.tsx`) — статус в одном
                месте не имеет права выглядеть иначе, чем в другом. */}
            <Chip tone={st.tone} icon={TASK_STATUS_ICON[task.status]}>{t(`status.${task.status}`)}</Chip>
            <Chip size="sm" tone={pr.tone}>{t('detail.priorityChip', { priority: t(`priority.${task.priority}`) })}</Chip>
          </div>
          <h1 className="title-lg" style={{ marginBottom: 'var(--spacing-2)', textDecoration: task.status === 'done' ? 'line-through' : 'none' }}>{task.title}</h1>
          {task.description && <p className="label-md" style={{ fontSize: '0.95rem', whiteSpace: 'pre-wrap' }}>{task.description}</p>}
        </div>

        {/* Meta */}
        <div className="card" style={{ padding: 'var(--spacing-4) var(--spacing-5)', marginBottom: 'var(--spacing-5)', display: 'flex', gap: 'var(--spacing-6)', flexWrap: 'wrap' }}>
          <div>
            <div className="label-sm" style={{ fontSize: '0.7rem', opacity: 0.7, marginBottom: '0.15rem' }}>{t('role.creator')}</div>
            <PersonChip size="S" userId={task.creatorId} firstName={task.creatorName} avatar={task.creatorAvatar} />
          </div>
          {task.dueDate && <Meta label={t('detail.due')} value={formatDue(task.dueDate, task.allDay, true)} />}
          {task.recurrenceRule && <Meta label={t('detail.recurrence')} value={t('recurrence.on')} />}
          {task.coinReward > 0 && <Meta label={task.assignedCircleName ? t('detail.rewardEach') : t('detail.reward')} value={`${task.coinReward}`} />}
          {task.progress && <Meta label={t('detail.progress')} value={t('row.progress', { accepted: task.progress.accepted, total: task.progress.total })} />}
        </div>

        {/* My actions */}
        {(canStart || canSubmit) && (
          <div style={{ display: 'flex', gap: 'var(--spacing-3)', marginBottom: 'var(--spacing-5)' }}>
            {canStart && <button onClick={start} disabled={busy} className="btn-ghost-inline" style={{ fontSize: '0.9rem' }}>{t('detail.take')}</button>}
            {canSubmit && <button onClick={submit} disabled={busy} className="btn-primary" style={{ fontSize: '0.9rem' }}>{isSelfTask ? t('detail.markDone') : t('detail.submit')}</button>}
          </div>
        )}
        {isWorker && task.myParticipantStatus === 'submitted' && (
          <p className="alert-accent-inline" style={{ padding: 'var(--spacing-3) var(--spacing-4)', marginBottom: 'var(--spacing-5)', fontSize: '0.85rem', color: 'var(--secondary)' }}>{t('detail.submittedWaiting')}</p>
        )}

        {/* Roles / participants */}
        <h2 className="title-md" style={{ marginBottom: 'var(--spacing-3)' }}>
          {task.assignedCircleName ? t('detail.circleExecutor', { name: task.assignedCircleName }) : t('detail.participants')}
        </h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-3)' }}>
          {workers.length === 0 && !task.assignedCircleName && (
            <p className="label-sm">{t('detail.noParticipants')}</p>
          )}
          {workers.map((p) => (
            <ParticipantRow key={p.id} p={p} showAccept={isCreator} busy={busy} t={t}
              onAccept={() => accept(p.userId)} onReturn={() => returnWork(p.userId)} />
          ))}
        </div>
        {task.observers.length > 0 && (
          <div style={{ marginBottom: 'var(--spacing-3)' }}>
            <span className="label-sm" style={{ fontWeight: 600 }}>{t('detail.observers')} </span>
            {task.observers.map((o) => (
              <span key={o.id} style={{ display: 'inline-block', marginRight: 'var(--spacing-2)' }}>
                <PersonChip size="S" userId={o.userId} firstName={o.name} avatar={o.avatar} />
              </span>
            ))}
          </div>
        )}

        {/* Вложения задачи (движок файлов) — постановщик и участники могут прикреплять */}
        <h2 className="title-md" style={{ margin: 'var(--spacing-8) 0 var(--spacing-3)' }}>{t('detail.attachments')}</h2>
        <TaskAttachments taskId={task.id} canEdit={isCreator || isWorker} />

        {/* Заметки о задаче (сервис «Заметки», привязка related): стикер создаётся уже привязанным */}
        <h2 className="title-md" style={{ margin: 'var(--spacing-8) 0 var(--spacing-3)' }}>{t('detail.notes')}</h2>
        <NotesPanel target={{ type: 'task', id: task.id }} scope={task.workspaceId ? { workspaceId: task.workspaceId } : {}} />

        {/* Chat — the task's context chat in the Messenger */}
        <h2 className="title-md" style={{ margin: 'var(--spacing-8) 0 var(--spacing-3)' }}>{t('detail.chat')}</h2>
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
              onSendAttachments={handleSendAttachments}
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
              <p className="label-sm">{chatQuery.isError ? t('detail.chatFailed') : t('detail.chatLoading')}</p>
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
      {confirmUI}
    </div>
  );
}

function ParticipantRow({ p, showAccept, busy, onAccept, onReturn, t }: {
  p: TaskParticipant; showAccept: boolean; busy: boolean;
  onAccept: () => void; onReturn: () => void;
  /** Переводчик неймспейса `tasks` передаётся сверху: хук зовём в одном месте. */
  t: (key: string, values?: Record<string, string | number>) => string;
}) {
  const stat = PARTICIPANT_STATUS_META[p.status];
  return (
    <div className="card" style={{ padding: 'var(--spacing-3) var(--spacing-4)', display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)' }}>
      <PersonAvatar userId={p.userId} name={p.name} size="sm" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>{p.name}</div>
        <span className="label-sm" style={{ fontSize: '0.7rem' }}>{t(`role.${p.role}`)}</span>
      </div>
      {/* Статус — матовый чип, а не покрашенный текст: цветное слово без своей
          подложки читается как ссылка-действие (DESIGN.md §1 «Статус — чип»). */}
      <Chip size="sm" tone={stat.tone}>{t(`participantStatus.${p.status}`)}</Chip>
      {showAccept && p.status === 'submitted' && (
        <div style={{ display: 'flex', gap: 'var(--spacing-1)' }}>
          <button onClick={onAccept} disabled={busy} className="btn-success" style={{ padding: '0.25rem 0.7rem', fontSize: '0.75rem' }}>{t('detail.accept')}</button>
          <button onClick={onReturn} disabled={busy} className="btn-ghost-inline" style={{ padding: '0.25rem 0.7rem', fontSize: '0.75rem' }}>{t('detail.return')}</button>
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

/** Вложения задачи: тянет список движка и даёт AttachmentsSection управлять им. */
function TaskAttachments({ taskId, canEdit }: { taskId: string; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const { data: files = [] } = useQuery<FileDto[]>({
    queryKey: taskAttachmentsKey(taskId),
    queryFn: async () => await apiGet(`/tasks/${taskId}/attachments`),
  });
  const attach = async (file: FileDto) => {
    await apiPost(`/tasks/${taskId}/attachments`, { fileId: file.id });
    queryClient.invalidateQueries({ queryKey: taskAttachmentsKey(taskId) });
  };
  const remove = async (fileId: string) => {
    await apiDelete(`/tasks/${taskId}/attachments/${fileId}`);
    queryClient.invalidateQueries({ queryKey: taskAttachmentsKey(taskId) });
  };
  return (
    <AttachmentsSection
      files={files}
      canEdit={canEdit}
      // Место вложения: от задачи наследуется право ПРАВИТЬ документ — «внесите свои
      // дни рождения» правят все участники, а не только приложивший файл.
      docPlace={{ refType: 'task', refId: taskId }}
      onAttach={attach}
      onRemove={remove}
    />
  );
}

// (local Avatar removed — people now render via the shared skin-aware PersonAvatar)
