'use client';

// ============================================================
// «Входящие» — GTD-разборная папка (Todoist Inbox / Things 3 / Linear Triage).
// Каждая запись — НАСТОЯЩАЯ Task (само-задача с inbox=true), поэтому её видно
// в календарном слое/чате/rich-cards как любую задачу. Разбор (clarify):
//  • «Срок» → PATCH {dueDate} — флаг снимается сервером сам;
//  • «Поручить» → PATCH {executorId} — тоже авто-уточнение;
//  • «Разобрано» → PATCH {inbox:false} — остаётся бессрочной само-задачей;
//  • чекбокс — submit само-задачи → сразу «Готово».
// ============================================================

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { contactsKey, fetchAllContacts } from '@/lib/queries';
import { EntitySelector } from '@/components/EntitySelector';
import { useTasksService } from '../tasks-shell';
import { QuickAdd, SectionTitle, formatDue } from '../tasks-ui';
import { TaskListSection } from '../TaskListSection';
import type { Contact, Task } from '@superapp/shared';

export default function TasksInboxPage() {
  const { invalidate } = useTasksService();
  const contactsQ = useQuery({ queryKey: contactsKey, queryFn: fetchAllContacts, staleTime: 60_000 });
  const contacts = contactsQ.data ?? [];

  return (
    <div style={{ maxWidth: 920 }}>
      <SectionTitle
        title="Входящие"
        subtitle="Быстрые записи себе. Разберите: задайте срок, поручите человеку или отметьте «Разобрано»."
      />

      <div className="card" style={{ padding: 'var(--spacing-4) var(--spacing-5)', marginBottom: 'var(--spacing-5)' }}>
        <QuickAdd autoFocus />
      </div>

      <TaskListSection
        filter={{ smartList: 'inbox' }}
        emptyText="Входящие пусты"
        emptyHint="Пришла мысль? Запишите одной строкой выше — детали разберёте потом"
        renderRow={(t) => <InboxRow task={t} contacts={contacts} onChanged={invalidate} />}
      />
    </div>
  );
}

// ------------------------------------------------------------
// Строка Входящих: чекбокс «выполнить» + название + действия разбора
// ------------------------------------------------------------

function InboxRow({ task, contacts, onChanged }: { task: Task; contacts: Contact[]; onChanged: () => void }) {
  const [panel, setPanel] = useState<null | 'date' | 'assign'>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const [withTime, setWithTime] = useState(false);
  const [due, setDue] = useState('');
  const [executorId, setExecutorId] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await fn();
      onChanged();
    } catch (err: unknown) {
      const a = err as { response?: { data?: { message?: string } } };
      setError(a.response?.data?.message || 'Не получилось — попробуйте ещё раз');
    } finally {
      setBusy(false);
    }
  };

  const complete = () => run(() => api.post(`/tasks/${task.id}/submit`));
  const markSorted = () => run(() => api.patch(`/tasks/${task.id}`, { inbox: false }));
  const saveDue = () => {
    if (!due) return;
    const d = withTime ? new Date(due) : new Date(`${due}T00:00:00`);
    if (Number.isNaN(d.getTime())) return;
    return run(() => api.patch(`/tasks/${task.id}`, { dueDate: d.toISOString(), allDay: !withTime }));
  };
  const saveExecutor = () => {
    if (!executorId) return;
    return run(() => api.patch(`/tasks/${task.id}`, { executorId }));
  };

  const actionStyle: React.CSSProperties = {
    background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600,
    fontSize: '0.78rem', color: 'var(--secondary)', padding: '0.2rem 0.35rem', whiteSpace: 'nowrap',
  };

  return (
    <div className="card" style={{ padding: 'var(--spacing-3) var(--spacing-4)', opacity: busy ? 0.6 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)' }}>
        <button
          onClick={complete}
          disabled={busy}
          aria-label="Выполнить"
          title="Выполнить"
          style={{
            width: 24, height: 24, minWidth: 24, borderRadius: '50% 45% 55% 48%', cursor: 'pointer',
            border: '2px solid var(--on-surface-variant)', background: 'transparent',
            color: 'transparent', fontSize: '0.8rem', lineHeight: 1,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--success, #16a34a)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'transparent'; }}
        >
          ✓
        </button>

        <div style={{ flex: 1, minWidth: 0 }}>
          <Link href={`/tasks/${task.id}`} style={{ textDecoration: 'none', color: 'inherit', fontWeight: 600, fontSize: '0.95rem' }}>
            {task.title}
          </Link>
          <div className="label-sm" style={{ marginTop: 2, opacity: 0.75 }}>
            добавлено {formatDue(task.createdAt, false)}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-1)', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button style={actionStyle} onClick={() => setPanel(panel === 'date' ? null : 'date')}>📅 Срок</button>
          <button style={actionStyle} onClick={() => setPanel(panel === 'assign' ? null : 'assign')}>👤 Поручить</button>
          <button style={{ ...actionStyle, color: 'var(--on-surface-variant)' }} onClick={markSorted} title="Убрать из Входящих, оставить задачей без срока">✓ Разобрано</button>
        </div>
      </div>

      {panel === 'date' && (
        <div style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'center', marginTop: 'var(--spacing-3)', flexWrap: 'wrap' }}>
          <input
            type={withTime ? 'datetime-local' : 'date'}
            value={due}
            onChange={(e) => setDue(e.target.value)}
            className="input-sketch"
            style={{ maxWidth: 230 }}
          />
          <button
            type="button"
            onClick={() => { setWithTime(!withTime); setDue(''); }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.75rem', color: 'var(--secondary)', fontWeight: 600 }}
          >
            {withTime ? '📅 весь день' : '🕒 со временем'}
          </button>
          <button className="btn-primary" style={{ fontSize: '0.8rem', padding: '0.4rem 0.9rem', opacity: due ? 1 : 0.6 }} disabled={!due || busy} onClick={saveDue}>
            Сохранить
          </button>
        </div>
      )}

      {panel === 'assign' && (
        <div style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'center', marginTop: 'var(--spacing-3)', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <EntitySelector
              types={['user']}
              multi={false}
              options={contacts.map((c) => ({ type: 'user', id: c.them.id, title: `${c.them.firstName} ${c.them.lastName ?? ''}`.trim(), firstName: c.them.firstName, lastName: c.them.lastName, role: c.myRole }))}
              value={executorId ? [{ type: 'user', id: executorId }] : []}
              onChange={(p) => setExecutorId(p[0]?.id ?? null)}
              placeholder="Кому поручить…"
            />
          </div>
          <button className="btn-primary" style={{ fontSize: '0.8rem', padding: '0.4rem 0.9rem', opacity: executorId ? 1 : 0.6 }} disabled={!executorId || busy} onClick={saveExecutor}>
            Поручить
          </button>
        </div>
      )}

      {error && <p className="label-sm" style={{ color: 'var(--primary)', marginTop: 'var(--spacing-2)' }}>{error}</p>}
    </div>
  );
}
