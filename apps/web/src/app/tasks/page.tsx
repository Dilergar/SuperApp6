'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { api } from '@/lib/api';
import {
  TASK_STATUS_META,
  TASK_PRIORITY_META,
  TASK_ROLE_LABELS,
  TASK_RECURRENCE_PRESETS,
  TASK_REMINDER_PRESETS,
  type Task,
  type Contact,
  type Circle,
  type TaskSmartList,
} from '@superapp/shared';

const SMART_LISTS: { key: TaskSmartList | 'all'; label: string }[] = [
  { key: 'today', label: 'Сегодня' },
  { key: 'upcoming', label: 'Предстоящие' },
  { key: 'overdue', label: 'Просрочено' },
  { key: 'assigned_to_me', label: 'Мне поставили' },
  { key: 'created_by_me', label: 'Я поставил' },
  { key: 'on_review', label: 'На проверке' },
  { key: 'all', label: 'Все' },
];

export default function TasksPage() {
  const { isReady } = useRequireAuth();

  const [tasks, setTasks] = useState<Task[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [circles, setCircles] = useState<Circle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [smart, setSmart] = useState<TaskSmartList | 'all'>('today');
  const [showCreate, setShowCreate] = useState(false);

  const clear = () => { setError(''); setSuccess(''); };

  const fetchTasks = useCallback(async (list: TaskSmartList | 'all') => {
    setLoading(true);
    try {
      const params = list === 'all' ? {} : { smartList: list };
      const { data } = await api.get('/tasks', { params });
      setTasks(data.data);
    } catch {
      setError('Не удалось загрузить задачи');
    } finally {
      setLoading(false);
    }
  }, []);

  // People + groups for the create form's pickers (loaded once).
  const fetchPeople = useCallback(async () => {
    try {
      const loadAll = async (): Promise<Contact[]> => {
        const acc: Contact[] = [];
        let cursor: string | undefined;
        do {
          const res = await api.get('/contacts', { params: cursor ? { cursor } : undefined });
          acc.push(...res.data.data);
          cursor = res.data.nextCursor ?? undefined;
        } while (cursor);
        return acc;
      };
      const [c, f] = await Promise.all([loadAll(), api.get('/circles')]);
      setContacts(c);
      setCircles(f.data.data);
    } catch {
      /* pickers just stay empty */
    }
  }, []);

  useEffect(() => {
    if (isReady) { fetchTasks(smart); fetchPeople(); }
  }, [isReady, smart, fetchTasks, fetchPeople]);

  const handleCreate = async (payload: Record<string, unknown>) => {
    clear();
    try {
      await api.post('/tasks', payload);
      setSuccess('Задача создана');
      setShowCreate(false);
      await fetchTasks(smart);
    } catch (err: unknown) {
      const a = err as { response?: { data?: { message?: string } } };
      setError(a.response?.data?.message || 'Ошибка создания задачи');
    }
  };

  if (!isReady || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="label-md" style={{ fontSize: '1rem' }}>Загрузка...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--surface)' }}>
      <nav className="fixed top-0 w-full z-50 px-6 py-4" style={{ background: 'rgba(245, 245, 220, 0.7)', backdropFilter: 'blur(10px)' }}>
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <Link href="/dashboard" className="title-md" style={{ color: 'var(--primary)' }}>SuperApp6</Link>
          <div style={{ display: 'flex', gap: 'var(--spacing-3)' }}>
            <Link href="/circles" className="btn-secondary" style={{ padding: '0.4rem 1rem', fontSize: '0.8rem' }}>Окружение</Link>
            <Link href="/dashboard" className="btn-secondary" style={{ padding: '0.4rem 1rem', fontSize: '0.8rem' }}>Главная</Link>
          </div>
        </div>
      </nav>

      <div className="max-w-4xl mx-auto px-6 pt-24" style={{ paddingBottom: 'var(--spacing-16)' }}>
        <div style={{ marginBottom: 'var(--spacing-6)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h1 className="display-md" style={{ marginBottom: 'var(--spacing-2)' }}>Задачи</h1>
            <p className="label-md" style={{ fontSize: '0.95rem' }}>Ставьте задачи себе и людям из окружения</p>
          </div>
          <button onClick={() => { setShowCreate(!showCreate); clear(); }} className="btn-primary" style={{ fontSize: '0.9rem', padding: '0.5rem 1.2rem' }}>
            {showCreate ? 'Отмена' : '+ Новая задача'}
          </button>
        </div>

        {error && <div className="wash-primary" style={{ padding: 'var(--spacing-3) var(--spacing-4)', marginBottom: 'var(--spacing-4)', color: 'var(--primary)', fontSize: '0.875rem' }}>{error}</div>}
        {success && <div className="wash-secondary" style={{ padding: 'var(--spacing-3) var(--spacing-4)', marginBottom: 'var(--spacing-4)', color: 'var(--secondary)', fontSize: '0.875rem' }}>{success}</div>}

        {showCreate && (
          <TaskCreateForm contacts={contacts} circles={circles} onCreate={handleCreate} />
        )}

        {/* Smart list chips */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', margin: 'var(--spacing-6) 0 var(--spacing-4)', flexWrap: 'wrap' }}>
          {SMART_LISTS.map((s) => (
            <button
              key={s.key}
              onClick={() => setSmart(s.key)}
              style={{
                padding: '0.3rem 0.8rem', fontSize: '0.8rem', borderRadius: 'var(--radius-sketch)',
                border: 'none', cursor: 'pointer', fontWeight: 600,
                background: smart === s.key ? 'var(--surface-container-lowest)' : 'var(--surface-container)',
                color: smart === s.key ? 'var(--on-surface)' : 'var(--on-surface-variant)',
                boxShadow: smart === s.key ? '0 2px 12px rgba(56, 57, 45, 0.08)' : 'none',
              }}
            >
              {s.label}
            </button>
          ))}
        </div>

        {tasks.length === 0 ? (
          <div className="card" style={{ textAlign: 'center', padding: 'var(--spacing-10)', color: 'var(--on-surface-variant)' }}>
            <p className="label-md">Здесь пусто</p>
            <p className="label-sm" style={{ marginTop: 'var(--spacing-2)' }}>Нажмите «+ Новая задача», чтобы начать</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)' }}>
            {tasks.map((t) => <TaskRow key={t.id} task={t} />)}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Task row (list item)
// ============================================================

function TaskRow({ task }: { task: Task }) {
  const st = TASK_STATUS_META[task.status];
  const pr = TASK_PRIORITY_META[task.priority];
  const assigneeLabel = task.assignedCircleName
    ? `Группа «${task.assignedCircleName}»`
    : task.executor?.name ?? (task.myRole === 'creator' ? 'Себе' : '—');

  return (
    <Link
      href={`/tasks/${task.id}`}
      className="card"
      style={{ display: 'block', padding: 'var(--spacing-4) var(--spacing-5)', textDecoration: 'none', color: 'inherit' }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--spacing-3)' }}>
        <span title={st.label} style={{ color: st.color, fontSize: '1.1rem', lineHeight: 1.4 }}>{st.icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, fontSize: '0.95rem', textDecoration: task.status === 'done' ? 'line-through' : 'none', opacity: task.status === 'done' ? 0.6 : 1 }}>
              {task.title}
            </span>
            <span style={{ fontSize: '0.68rem', fontWeight: 700, color: pr.color, background: 'var(--surface-container)', padding: '0.05rem 0.4rem', borderRadius: 'var(--radius-sm)' }}>
              {pr.label}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 'var(--spacing-3)', marginTop: 'var(--spacing-1)', flexWrap: 'wrap' }}>
            <span className="label-sm">{assigneeLabel}</span>
            {task.progress && <span className="label-sm" style={{ color: 'var(--secondary)' }}>{task.progress.accepted} из {task.progress.total} принято</span>}
            {task.dueDate && <span className="label-sm" style={{ color: isOverdue(task) ? 'var(--primary)' : 'var(--on-surface-variant)' }}>⏰ {formatDue(task.dueDate, task.allDay)}</span>}
            {task.coinReward > 0 && <span className="label-sm" style={{ color: 'var(--tertiary)' }}>🪙 {task.coinReward}{task.assignedCircleName ? '/чел' : ''}</span>}
            {task.commentsCount > 0 && <span className="label-sm">💬 {task.commentsCount}</span>}
          </div>
        </div>
        <span className="label-sm" style={{ color: st.color, fontWeight: 600, whiteSpace: 'nowrap' }}>{st.label}</span>
      </div>
    </Link>
  );
}

// ============================================================
// Create form
// ============================================================

type AssignMode = 'self' | 'person' | 'group';

function TaskCreateForm({
  contacts, circles, onCreate,
}: {
  contacts: Contact[];
  circles: Circle[];
  onCreate: (payload: Record<string, unknown>) => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Task['priority']>('medium');
  const [dueDate, setDueDate] = useState('');
  const [allDay, setAllDay] = useState(false);
  const [reminderMin, setReminderMin] = useState<number | null>(null);
  const [recurrence, setRecurrence] = useState<string | null>(null);
  const [coinReward, setCoinReward] = useState(0);

  const [mode, setMode] = useState<AssignMode>('self');
  const [executorId, setExecutorId] = useState<string | null>(null);
  const [coExecutorIds, setCoExecutorIds] = useState<string[]>([]);
  const [observerIds, setObserverIds] = useState<string[]>([]);
  const [circleId, setCircleId] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);

  const selectedCircle = circles.find((c) => c.id === circleId);

  const toIso = (local: string, allDayFlag: boolean): string | undefined => {
    if (!local) return undefined;
    const d = allDayFlag ? new Date(`${local}T00:00:00`) : new Date(local);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setSubmitting(true);

    const dueIso = toIso(dueDate, allDay);
    const payload: Record<string, unknown> = {
      title: title.trim(),
      priority,
      allDay,
    };
    if (description.trim()) payload.description = description.trim();
    if (dueIso) payload.dueDate = dueIso;
    if (recurrence) payload.recurrenceRule = recurrence;
    if (coinReward > 0) payload.coinReward = coinReward;
    if (dueIso && reminderMin != null) {
      payload.reminderAt = new Date(new Date(dueIso).getTime() - reminderMin * 60_000).toISOString();
    }

    if (mode === 'person' && executorId) {
      payload.executorId = executorId;
      if (coExecutorIds.length) payload.coExecutorIds = coExecutorIds;
    } else if (mode === 'group' && circleId) {
      payload.assignedCircleId = circleId;
    }
    if (observerIds.length) payload.observerIds = observerIds;

    await onCreate(payload);
    setSubmitting(false);
  };

  const canSubmit =
    title.trim().length > 0 &&
    !submitting &&
    (mode === 'self' || (mode === 'person' && !!executorId) || (mode === 'group' && !!circleId));

  return (
    <form onSubmit={submit} className="card-elevated" style={{ padding: 'var(--spacing-6)', marginBottom: 'var(--spacing-6)' }}>
      <h3 className="title-md" style={{ marginBottom: 'var(--spacing-4)' }}>Новая задача</h3>

      <input
        type="text" value={title} onChange={(e) => setTitle(e.target.value)}
        placeholder="Что нужно сделать?" className="input-sketch" autoFocus
        style={{ marginBottom: 'var(--spacing-3)', fontSize: '1rem', fontWeight: 600 }}
      />
      <textarea
        value={description} onChange={(e) => setDescription(e.target.value)}
        placeholder="Описание (необязательно)" className="input-sketch" rows={2}
        style={{ marginBottom: 'var(--spacing-4)', resize: 'vertical' }}
      />

      {/* Assignment mode */}
      <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>Кому</label>
      <div style={{ display: 'flex', gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-3)', flexWrap: 'wrap' }}>
        {([['self', 'Себе'], ['person', 'Человеку'], ['group', 'Группе']] as [AssignMode, string][]).map(([m, lbl]) => (
          <Chip key={m} active={mode === m} onClick={() => setMode(m)}>{lbl}</Chip>
        ))}
      </div>

      {mode === 'person' && (
        <div style={{ marginBottom: 'var(--spacing-4)' }}>
          <PeoplePicker
            label="Исполнитель (1 ответственный)"
            contacts={contacts}
            selected={executorId ? [executorId] : []}
            onToggle={(id) => setExecutorId((cur) => (cur === id ? null : id))}
            single
          />
          <div style={{ marginTop: 'var(--spacing-3)' }}>
            <PeoplePicker
              label="Соисполнители (помогают)"
              contacts={contacts.filter((c) => c.them.id !== executorId)}
              selected={coExecutorIds}
              onToggle={(id) => setCoExecutorIds((cur) => toggle(cur, id))}
            />
          </div>
        </div>
      )}

      {mode === 'group' && (
        <div style={{ marginBottom: 'var(--spacing-4)' }}>
          <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>Группа из окружения</label>
          {circles.length === 0 ? (
            <p className="label-sm">Сначала создайте группу на странице «Моё окружение»</p>
          ) : (
            <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
              {circles.map((c) => (
                <Chip key={c.id} active={circleId === c.id} color={c.color ?? undefined} onClick={() => setCircleId((cur) => (cur === c.id ? null : c.id))}>
                  {c.name} <span style={{ opacity: 0.6, fontSize: '0.7rem' }}>{c.membersCount}</span>
                </Chip>
              ))}
            </div>
          )}
          {selectedCircle && (
            <p className="label-sm" style={{ marginTop: 'var(--spacing-2)', color: 'var(--secondary)' }}>
              Все из «{selectedCircle.name}» станут Соисполнителями, у каждого свой статус и приёмка.
            </p>
          )}
        </div>
      )}

      {mode !== 'self' && (
        <div style={{ marginBottom: 'var(--spacing-4)' }}>
          <PeoplePicker
            label="Наблюдатели (видят прогресс и чат)"
            contacts={contacts.filter((c) => c.them.id !== executorId && !coExecutorIds.includes(c.them.id))}
            selected={observerIds}
            onToggle={(id) => setObserverIds((cur) => toggle(cur, id))}
          />
        </div>
      )}

      {/* Deadline + reminder + recurrence */}
      <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-4)', marginBottom: 'var(--spacing-4)' }}>
        <div>
          <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>
            Дедлайн
            <button type="button" onClick={() => { setAllDay(!allDay); setDueDate(''); }} style={{ marginLeft: '0.5rem', background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.75rem', color: 'var(--secondary)', fontWeight: 600 }}>
              {allDay ? '🕒 со временем' : '📅 весь день'}
            </button>
          </label>
          <input
            type={allDay ? 'date' : 'datetime-local'}
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="input-sketch"
          />
        </div>
        <div>
          <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>Приоритет</label>
          <div style={{ display: 'flex', gap: 'var(--spacing-1)', flexWrap: 'wrap' }}>
            {(Object.keys(TASK_PRIORITY_META) as Task['priority'][]).map((p) => (
              <Chip key={p} active={priority === p} color={TASK_PRIORITY_META[p].color} onClick={() => setPriority(p)}>
                {TASK_PRIORITY_META[p].label}
              </Chip>
            ))}
          </div>
        </div>
      </div>

      <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-4)', marginBottom: 'var(--spacing-4)' }}>
        <div>
          <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>Напоминание</label>
          <select className="input-sketch" value={reminderMin ?? ''} onChange={(e) => setReminderMin(e.target.value === '' ? null : Number(e.target.value))} disabled={!dueDate}>
            {TASK_REMINDER_PRESETS.map((r) => (
              <option key={r.label} value={r.minutesBefore ?? ''}>{r.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>Повтор</label>
          <select className="input-sketch" value={recurrence ?? ''} onChange={(e) => setRecurrence(e.target.value === '' ? null : e.target.value)}>
            {TASK_RECURRENCE_PRESETS.map((r) => (
              <option key={r.label} value={r.rule ?? ''}>{r.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Reward */}
      <div style={{ marginBottom: 'var(--spacing-5)' }}>
        <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>
          Награда коинами {mode === 'group' && selectedCircle ? '(каждому)' : ''}
        </label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)' }}>
          <input
            type="number" min={0} value={coinReward}
            onChange={(e) => setCoinReward(Math.max(0, Number(e.target.value) || 0))}
            className="input-sketch" style={{ maxWidth: '140px' }}
          />
          {mode === 'group' && selectedCircle && coinReward > 0 && (
            <span className="label-sm" style={{ color: 'var(--tertiary)' }}>
              Каждому по {coinReward} 🪙 · итого {coinReward * selectedCircle.membersCount}
            </span>
          )}
        </div>
        <p className="label-sm" style={{ marginTop: 'var(--spacing-1)', opacity: 0.7 }}>
          Пока отображается как намерение — настоящий баланс появится с Магазином.
        </p>
      </div>

      <button type="submit" disabled={!canSubmit} className="btn-primary" style={{ fontSize: '0.9rem', opacity: canSubmit ? 1 : 0.6 }}>
        {submitting ? 'Создание...' : 'Создать задачу'}
      </button>
    </form>
  );
}

// ============================================================
// Pickers & shared bits
// ============================================================

function PeoplePicker({
  label, contacts, selected, onToggle, single = false,
}: {
  label: string;
  contacts: Contact[];
  selected: string[];
  onToggle: (id: string) => void;
  single?: boolean;
}) {
  return (
    <div>
      <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>{label}</label>
      {contacts.length === 0 ? (
        <p className="label-sm">В окружении пока никого — добавьте людей на странице «Моё окружение»</p>
      ) : (
        <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
          {contacts.map((c) => {
            const on = selected.includes(c.them.id);
            return (
              <button key={c.linkId} type="button" onClick={() => onToggle(c.them.id)}
                style={{
                  padding: '0.3rem 0.7rem', fontSize: '0.8rem', borderRadius: 'var(--radius-sketch)',
                  border: 'none', cursor: 'pointer', fontWeight: 500,
                  background: on ? 'var(--secondary-container)' : 'var(--surface-container-low)',
                  color: on ? 'var(--secondary)' : 'var(--on-surface-variant)',
                }}
              >
                {single && on ? '● ' : ''}{c.them.firstName} {c.them.lastName ?? ''}
                {c.myRole && <span style={{ opacity: 0.55, marginLeft: '0.3rem', fontSize: '0.7rem' }}>{c.myRole}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Chip({ active, color, onClick, children }: { active: boolean; color?: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      style={{
        padding: '0.3rem 0.7rem', fontSize: '0.8rem', borderRadius: 'var(--radius-sketch)',
        border: 'none', cursor: 'pointer', fontWeight: 600,
        background: active ? (color ?? 'var(--secondary-container)') : 'var(--surface-container)',
        color: active ? (color ? '#fff' : 'var(--secondary)') : 'var(--on-surface-variant)',
      }}
    >
      {children}
    </button>
  );
}

function toggle(arr: string[], id: string): string[] {
  return arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id];
}

function isOverdue(t: Task): boolean {
  return !!t.dueDate && t.status !== 'done' && t.status !== 'cancelled' && new Date(t.dueDate) < new Date();
}

function formatDue(iso: string, allDay: boolean): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  if (allDay) return date;
  return `${date}, ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
}
