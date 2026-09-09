'use client';

// ============================================================
// Общие кирпичики сервиса «Задачи»: строка задачи, чип-фильтр,
// быстрый ввод во «Входящие», хелперы дат.
// ============================================================

import { useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { apiErrorMessage, apiPost } from '@/lib/api';
import { useFormatters } from '@/lib/format';
import { PersonChip } from '../circles/PersonCard';
import { TASK_STATUS_META, TASK_PRIORITY_META, type Task, type TaskStatus, type TaskPriority } from '@superapp/shared';
import {
  Button, Chip as KitChip, Icon, Input,
  type IconName, type Tone,
} from '@/components/ui';

/**
 * Статус задачи → ИКОНКА. Только иконка: имена берутся из веб-реестра `ICONS`,
 * которого нет в общем пакете. Тон сюда больше не дублируется — он приходит из
 * `TASK_STATUS_META[...].tone`, одним источником на API, веб и мобильный
 * (раньше та же карта тонов лежала ещё и здесь, и в календаре), а подпись —
 * из каталога (`tasks.status.<status>`).
 */
export const TASK_STATUS_ICON: Record<TaskStatus, IconName> = {
  todo: 'tasks',
  in_progress: 'inProgress',
  on_review: 'eye',
  done: 'checkCircle',
  cancelled: 'blocked',
};

// ------------------------------------------------------------
// Хелперы дат
//
// Формат берётся у форматтеров языка и региона: `toLocaleDateString('ru-RU')`
// зашивал бы и язык, и страну навсегда — человек, выбравший English, всё равно
// читал бы «3 сент.».
// ------------------------------------------------------------

/** Срок задачи в правилах зрителя: «весь день» — без часов. */
export function useDueFormat(): (iso: string, allDay: boolean, withYear?: boolean) => string {
  const f = useFormatters();
  return (iso, allDay, withYear = false) => {
    const style = withYear ? 'long' : 'dayMonthLong';
    return allDay ? f.date(iso, style) : f.dateTime(iso, style);
  };
}

// ------------------------------------------------------------
// Строка задачи (списки всех разделов)
// ------------------------------------------------------------

export function TaskRow({ task, extra }: { task: Task; extra?: React.ReactNode }) {
  const t = useTranslations('tasks');
  const tc = useTranslations('common');
  const formatDue = useDueFormat();
  const st = TASK_STATUS_META[task.status];
  const pr = TASK_PRIORITY_META[task.priority];
  const statusLabel = t(`status.${task.status}`);
  const done = task.status === 'done';
  const assigneeLabel = task.assignedCircleName
    ? t('row.circle', { name: task.assignedCircleName })
    : task.executor?.name ?? (task.myRole === 'creator' ? t('row.self') : tc('labels.dash'));

  return (
    <Link
      href={`/tasks/${task.id}`}
      className="card-sm"
      style={{ display: 'block', color: 'inherit', border: '1px solid var(--border)' }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--spacing-3)' }}>
        <Icon name={TASK_STATUS_ICON[task.status]} size={18} style={{ marginTop: 2, color: 'var(--muted)' }} label={statusLabel} />

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <span
              className="title-sm"
              style={{ textDecoration: done ? 'line-through' : 'none', opacity: done ? 0.6 : 1 }}
            >
              {task.title}
            </span>
            {task.priority !== 'medium' && (
              <KitChip size="sm" tone={pr.tone}>{t(`priority.${task.priority}`)}</KitChip>
            )}
          </div>

          <div style={{ display: 'flex', gap: 'var(--spacing-3)', marginTop: '0.375rem', flexWrap: 'wrap', alignItems: 'center' }}>
            {task.executor && !task.assignedCircleName ? (
              <PersonChip size="S" userId={task.executor.userId} firstName={task.executor.name} avatar={task.executor.avatar} />
            ) : (
              <span className="meta">{assigneeLabel}</span>
            )}
            {task.progress && (
              <span className="meta" style={{ color: 'var(--primary-dim)' }}>
                {t('row.progress', { accepted: task.progress.accepted, total: task.progress.total })}
              </span>
            )}
            {task.dueDate && (
              <span
                className="meta"
                style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', color: isOverdue(task) ? 'var(--danger)' : undefined }}
              >
                <Icon name={isOverdue(task) ? 'overdue' : 'clock'} size={13} />
                {formatDue(task.dueDate, task.allDay)}
              </span>
            )}
            {task.coinReward > 0 && (
              <span className="meta" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', color: 'var(--warning)' }}>
                <Icon name="coins" size={13} />
                {task.coinReward}{task.assignedCircleName ? t('row.perPerson') : ''}
              </span>
            )}
          </div>
          {extra}
        </div>

        <KitChip size="sm" tone={st.tone}>{statusLabel}</KitChip>
      </div>
    </Link>
  );
}

// ------------------------------------------------------------
// Чип-переключатель (фильтры, режимы формы)
// Тонкая обёртка над китом: имя сохранено, чтобы не трогать все вызовы.
// ------------------------------------------------------------

export function Chip({
  active,
  tone = 'accent',
  onClick,
  children,
}: {
  active: boolean;
  tone?: Tone;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <KitChip size="sm" tone={tone} selected={active} onClick={onClick}>
      {children}
    </KitChip>
  );
}

// ------------------------------------------------------------
// Быстрый ввод во «Входящие» (Todoist quick-add): одна строка → настоящая
// Task (само-задача, inbox=true). Разбор — потом, в разделе «Входящие».
// Самодостаточен: инвалидирует корень ['tasks'] сам (списки+счётчики+бейджи).
// ------------------------------------------------------------

export function QuickAdd({ placeholder, autoFocus }: { placeholder?: string; autoFocus?: boolean }) {
  const t = useTranslations('tasks');
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = title.trim();
    if (!value || busy) return;
    setBusy(true);
    setError('');
    try {
      await apiPost('/tasks', { title: value, inbox: true });
      setTitle('');
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    } catch (err: unknown) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={placeholder ?? t('quickAdd.placeholder')}
          icon="add"
          autoFocus={autoFocus}
          maxLength={500}
          error={error || null}
          wrapClassName="quick-add-field"
        />
        <Button type="submit" variant="primary" tone="success" icon="add" disabled={!title.trim()} loading={busy}>
          {t('quickAdd.submit')}
        </Button>
      </div>
    </form>
  );
}

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
