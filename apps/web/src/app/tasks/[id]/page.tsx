'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { api } from '@/lib/api';
import {
  TASK_STATUS_META,
  TASK_PRIORITY_META,
  TASK_ROLE_LABELS,
  TASK_CREATOR_LABEL,
  PARTICIPANT_STATUS_META,
  type Task,
  type TaskComment,
  type TaskParticipant,
} from '@superapp/shared';

export default function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { isReady } = useRequireAuth();

  const [task, setTask] = useState<Task | null>(null);
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [t, c] = await Promise.all([
        api.get(`/tasks/${id}`),
        api.get(`/tasks/${id}/comments`),
      ]);
      setTask(t.data.data);
      setComments(c.data.data);
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

  const sendComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try {
      await api.post(`/tasks/${id}/comments`, { content: text.trim() });
      setText('');
      const c = await api.get(`/tasks/${id}/comments`);
      setComments(c.data.data);
    } catch {
      setError('Не удалось отправить сообщение');
    } finally { setBusy(false); }
  };

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
          {isCreator && (
            <div style={{ display: 'flex', gap: 'var(--spacing-2)' }}>
              {task.status !== 'cancelled' && task.status !== 'done' && (
                <button onClick={cancel} disabled={busy} className="btn-secondary" style={{ padding: '0.4rem 1rem', fontSize: '0.8rem' }}>Отменить</button>
              )}
              <button onClick={() => { if (confirm('Удалить задачу?')) remove(); }} disabled={busy} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', fontSize: '0.8rem', fontWeight: 600 }}>Удалить</button>
            </div>
          )}
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
          <Meta label={TASK_CREATOR_LABEL} value={task.creatorName} />
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
              <span key={o.id} className="label-sm" style={{ marginRight: 'var(--spacing-2)' }}>{o.name}</span>
            ))}
          </div>
        )}

        {/* Chat */}
        <h2 className="title-md" style={{ margin: 'var(--spacing-8) 0 var(--spacing-3)' }}>Чат задачи</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)', marginBottom: 'var(--spacing-4)' }}>
          {comments.length === 0 && <p className="label-sm">Сообщений пока нет. Обсуждайте задачу здесь.</p>}
          {comments.map((c) => (
            <div key={c.id} className="card" style={{ padding: 'var(--spacing-3) var(--spacing-4)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-1)' }}>
                <Avatar name={c.authorName} />
                <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{c.authorName}</span>
                {c.authorRole && <span className="label-sm" style={{ color: 'var(--secondary)', fontSize: '0.7rem' }}>{roleLabel(c.authorRole)}</span>}
                <span className="label-sm" style={{ marginLeft: 'auto', fontSize: '0.7rem' }}>{new Date(c.createdAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
              </div>
              <p style={{ fontSize: '0.9rem', whiteSpace: 'pre-wrap', paddingLeft: '2.4rem' }}>{c.content}</p>
            </div>
          ))}
        </div>
        <form onSubmit={sendComment} style={{ display: 'flex', gap: 'var(--spacing-2)' }}>
          <input type="text" value={text} onChange={(e) => setText(e.target.value)} placeholder="Написать в чат задачи..." className="input-sketch" style={{ flex: 1 }} />
          <button type="submit" disabled={busy || !text.trim()} className="btn-primary" style={{ fontSize: '0.85rem', opacity: busy || !text.trim() ? 0.6 : 1 }}>Отправить</button>
        </form>
      </div>
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
      <Avatar name={p.name} />
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

function Avatar({ name }: { name: string }) {
  return (
    <div style={{
      width: '2rem', height: '2rem', borderRadius: 'var(--radius-sketch)', flexShrink: 0,
      background: 'var(--secondary-container)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '0.85rem', color: 'var(--secondary)',
    }}>
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

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
