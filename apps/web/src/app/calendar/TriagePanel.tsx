'use client';

import {
  TASK_STATUS_META,
  type CalendarItem,
  type CalendarEventOccurrence,
  type CalendarTaskItem,
} from '@superapp/shared';
import { isEvent, isTask, isFinance, isToday, startOfDay, fmtTime, itemColor } from './calendar-lib';
import { setDrag, clearDrag } from './calendar-dnd';

export interface UndatedTask {
  id: string;
  title: string;
  status: string;
  priority: string;
}

/**
 * Left triage panel: everything from the calendar grouped by meaning. Tasks are
 * draggable onto the grid to (re)schedule them; events open on click.
 */
export function TriagePanel({
  items,
  undated,
  onEvent,
  onTask,
  onClose,
}: {
  items: CalendarItem[];
  undated: UndatedTask[];
  onEvent: (o: CalendarEventOccurrence) => void;
  onTask: (t: CalendarTaskItem) => void;
  onClose: () => void;
}) {
  const overdue = items.filter((i) => isTask(i) && i.overdue) as CalendarTaskItem[];
  const today = items.filter((i) => !(isTask(i) && i.overdue) && isToday(new Date(i.start)));
  const upcoming = items.filter(
    (i) => !(isTask(i) && i.overdue) && startOfDay(new Date(i.start)) > startOfDay(new Date()),
  );

  return (
    <div className="card" style={{ width: 280, flexShrink: 0, padding: 'var(--spacing-3)', maxHeight: '78vh', overflowY: 'auto', alignSelf: 'flex-start' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-2)' }}>
        <span className="title-md" style={{ fontSize: '1rem' }}>Планнер</span>
        <button onClick={onClose} title="Скрыть панель" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--on-surface-variant)', fontSize: '0.9rem' }}>⟨</button>
      </div>
      <p className="label-sm" style={{ marginBottom: 'var(--spacing-3)', fontSize: '0.68rem' }}>Тащи задачи на сетку, чтобы назначить день/время.</p>

      <Group title="Просрочено" color="#c61a1e" count={overdue.length}>
        {overdue.map((t) => <TaskCard key={t.taskId} t={t} onTask={onTask} />)}
      </Group>
      <Group title="Без даты" color="#7c5800" count={undated.length}>
        {undated.map((t) => <UndatedCard key={t.id} t={t} />)}
      </Group>
      <Group title="Сегодня" color="#326a8b" count={today.length}>
        {today.map((i, idx) => <Row key={rk(i, idx)} i={i} onEvent={onEvent} onTask={onTask} />)}
      </Group>
      <Group title="Предстоящие" color="#16a34a" count={upcoming.length}>
        {upcoming.slice(0, 40).map((i, idx) => <Row key={rk(i, idx)} i={i} onEvent={onEvent} onTask={onTask} withDay />)}
      </Group>
    </div>
  );
}

function Group({ title, color, count, children }: { title: string; color: string; count: number; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 'var(--spacing-3)' }}>
      <div className="label-sm" style={{ fontWeight: 700, color, marginBottom: 'var(--spacing-1)', textTransform: 'uppercase', fontSize: '0.66rem', letterSpacing: '0.04em' }}>
        {title} {count > 0 && <span style={{ opacity: 0.6 }}>· {count}</span>}
      </div>
      {count === 0 ? <p className="label-sm" style={{ fontSize: '0.7rem', opacity: 0.5 }}>—</p> : <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</div>}
    </div>
  );
}

function TaskCard({ t, onTask }: { t: CalendarTaskItem; onTask: (t: CalendarTaskItem) => void }) {
  return (
    <div
      draggable
      onDragStart={(e) => setDrag({ kind: 'task', id: t.taskId, title: t.title }, e)}
      onDragEnd={clearDrag}
      onClick={() => onTask(t)}
      title="Перетащи на день/время"
      style={cardStyle(itemColor(t))}
    >
      <span style={{ fontSize: '0.7rem' }}>✓</span>
      <span style={ellipsis}>{t.title}</span>
    </div>
  );
}

function UndatedCard({ t }: { t: UndatedTask }) {
  const st = TASK_STATUS_META[t.status as keyof typeof TASK_STATUS_META];
  return (
    <div
      draggable
      onDragStart={(e) => setDrag({ kind: 'task', id: t.id, title: t.title }, e)}
      onDragEnd={clearDrag}
      title="Перетащи на день/время, чтобы назначить срок"
      style={cardStyle(st?.color ?? '#326a8b')}
    >
      <span style={{ fontSize: '0.7rem' }}>✓</span>
      <span style={ellipsis}>{t.title}</span>
    </div>
  );
}

function Row({ i, onEvent, onTask, withDay }: { i: CalendarItem; onEvent: (o: CalendarEventOccurrence) => void; onTask: (t: CalendarTaskItem) => void; withDay?: boolean }) {
  const color = itemColor(i);
  const time = withDay
    ? new Date(i.start).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
    : fmtTime(i.start);
  const draggableTask = isTask(i);
  return (
    <div
      draggable={draggableTask}
      onDragStart={draggableTask ? (e) => setDrag({ kind: 'task', id: (i as CalendarTaskItem).taskId, title: i.title }, e) : undefined}
      onDragEnd={draggableTask ? clearDrag : undefined}
      onClick={() => { if (isEvent(i)) onEvent(i); else if (isTask(i)) onTask(i); else window.location.href = '/finance'; }}
      style={cardStyle(color)}
    >
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <span className="label-sm" style={{ fontSize: '0.66rem', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{time}</span>
      <span style={ellipsis}>{i.title}</span>
    </div>
  );
}

function rk(i: CalendarItem, idx: number): string {
  const id = isEvent(i) ? `${i.eventId}-${i.occurrenceStart}` : isTask(i) ? i.taskId : i.id;
  return `${id}-${idx}`;
}

const ellipsis: React.CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600, fontSize: '0.78rem' };

function cardStyle(color: string): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: 6, padding: '0.3rem 0.5rem',
    background: 'var(--surface-container-low)', borderLeft: `3px solid ${color}`,
    borderRadius: 4, cursor: 'grab', userSelect: 'none',
  };
}
