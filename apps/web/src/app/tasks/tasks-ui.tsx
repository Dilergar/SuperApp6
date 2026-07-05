'use client';

// ============================================================
// Общие кирпичики сервиса «Задачи»: строка задачи, чип-фильтр,
// быстрый ввод во «Входящие», хелперы дат.
// Вынесены из старого монолитного page.tsx при переезде на ServiceShell.
// ============================================================

import { useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { PersonChip } from '../circles/PersonCard';
import { TASK_STATUS_META, TASK_PRIORITY_META, type Task } from '@superapp/shared';

// ------------------------------------------------------------
// Строка задачи (списки всех разделов)
// ------------------------------------------------------------

export function TaskRow({ task, extra }: { task: Task; extra?: React.ReactNode }) {
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
          <div style={{ display: 'flex', gap: 'var(--spacing-3)', marginTop: 'var(--spacing-1)', flexWrap: 'wrap', alignItems: 'center' }}>
            {task.executor && !task.assignedCircleName ? (
              <PersonChip size="S" userId={task.executor.userId} firstName={task.executor.name} avatar={task.executor.avatar} />
            ) : (
              <span className="label-sm">{assigneeLabel}</span>
            )}
            {task.progress && <span className="label-sm" style={{ color: 'var(--secondary)' }}>{task.progress.accepted} из {task.progress.total} принято</span>}
            {task.dueDate && <span className="label-sm" style={{ color: isOverdue(task) ? 'var(--primary)' : 'var(--on-surface-variant)' }}>⏰ {formatDue(task.dueDate, task.allDay)}</span>}
            {task.coinReward > 0 && <span className="label-sm" style={{ color: 'var(--tertiary)' }}>🪙 {task.coinReward}{task.assignedCircleName ? '/чел' : ''}</span>}
          </div>
          {extra}
        </div>
        <span className="label-sm" style={{ color: st.color, fontWeight: 600, whiteSpace: 'nowrap' }}>{st.label}</span>
      </div>
    </Link>
  );
}

// ------------------------------------------------------------
// Чип-переключатель (фильтры, режимы формы)
// ------------------------------------------------------------

export function Chip({ active, color, onClick, children }: { active: boolean; color?: string; onClick: () => void; children: React.ReactNode }) {
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

// ------------------------------------------------------------
// Быстрый ввод во «Входящие» (Todoist quick-add): одна строка → настоящая
// Task (само-задача, inbox=true). Разбор — потом, в разделе «Входящие».
// Самодостаточен: инвалидирует корень ['tasks'] сам (списки+счётчики+бейджи).
// ------------------------------------------------------------

export function QuickAdd({ placeholder = 'Быстрая задачка себе… (Enter)', autoFocus }: { placeholder?: string; autoFocus?: boolean }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.post('/tasks', { title: t, inbox: true });
      setTitle('');
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    } catch (err: unknown) {
      const a = err as { response?: { data?: { message?: string } } };
      setError(a.response?.data?.message || 'Не удалось добавить');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <div style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'center' }}>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={placeholder}
          className="input-sketch"
          autoFocus={autoFocus}
          style={{ flex: 1, fontSize: '0.95rem' }}
          maxLength={500}
        />
        <button type="submit" disabled={!title.trim() || busy} className="btn-primary" style={{ fontSize: '0.85rem', padding: '0.5rem 1rem', opacity: !title.trim() || busy ? 0.6 : 1, whiteSpace: 'nowrap' }}>
          {busy ? '…' : '+ Во Входящие'}
        </button>
      </div>
      {error && <p className="label-sm" style={{ color: 'var(--primary)', marginTop: 'var(--spacing-1)' }}>{error}</p>}
    </form>
  );
}

// ------------------------------------------------------------
// Заголовок раздела (единый вид всех страниц сервиса)
// ------------------------------------------------------------

export function SectionTitle({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 'var(--spacing-5)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
      <div>
        <h1 className="display-md" style={{ marginBottom: 'var(--spacing-1)' }}>{title}</h1>
        {subtitle && <p className="label-md" style={{ fontSize: '0.95rem' }}>{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

// ------------------------------------------------------------
// Хелперы дат
// ------------------------------------------------------------

/** Просрочка глазами клиента — та же семантика, что smartList=overdue на бэке:
 *  задача «весь день» на сегодня НЕ просрочена до конца дня (Todoist). */
export function isOverdue(t: Task): boolean {
  if (!t.dueDate || t.status === 'done' || t.status === 'cancelled') return false;
  const due = new Date(t.dueDate);
  if (t.allDay) {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    return due < startOfToday;
  }
  return due < new Date();
}

export function formatDue(iso: string, allDay: boolean): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  if (allDay) return date;
  return `${date}, ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
}
