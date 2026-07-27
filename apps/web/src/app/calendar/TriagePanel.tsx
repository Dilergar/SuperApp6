'use client';

import { useRouter } from 'next/navigation';
import { Badge, Card, CardHeader, Icon, IconButton, StatusDot, type Tone } from '@/components/ui';
import {
  TASK_STATUS_META,
  type CalendarItem,
  type CalendarEventOccurrence,
  type CalendarTaskItem,
} from '@superapp/shared';
import { isEvent, isTask, isToday, startOfDay, fmtTime, itemColor } from './calendar-lib';
import { setDrag, clearDrag } from './calendar-dnd';

export interface UndatedTask {
  id: string;
  title: string;
  status: string;
  priority: string;
}

/**
 * Левая панель-планнер: всё из календаря, сгруппированное по смыслу. Задачи
 * тащатся на сетку, чтобы назначить срок; события открываются по клику.
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
    <Card
      className="density-compact"
      style={{ width: 280, flexShrink: 0, maxHeight: '78vh', overflowY: 'auto', alignSelf: 'flex-start' }}
    >
      <CardHeader
        title="Планнер"
        subtitle="Тащи задачи на сетку, чтобы назначить день и время"
        actions={<IconButton icon="caretLeft" label="Скрыть планнер" size={28} onClick={onClose} />}
      />

      <Group title="Просрочено" tone="danger" count={overdue.length}>
        {overdue.map((t) => <TaskCard key={t.taskId} t={t} onTask={onTask} />)}
      </Group>
      <Group title="Без даты" tone="warning" count={undated.length}>
        {undated.map((t) => <UndatedCard key={t.id} t={t} />)}
      </Group>
      <Group title="Сегодня" tone="accent" count={today.length}>
        {today.map((i, idx) => <Row key={rk(i, idx)} i={i} onEvent={onEvent} onTask={onTask} />)}
      </Group>
      <Group title="Предстоящие" tone="success" count={upcoming.length}>
        {upcoming.slice(0, 40).map((i, idx) => <Row key={rk(i, idx)} i={i} onEvent={onEvent} onTask={onTask} withDay />)}
      </Group>
    </Card>
  );
}

function Group({ title, tone, count, children }: { title: string; tone: Tone; count: number; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 'var(--spacing-4)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', marginBottom: '0.375rem' }}>
        <StatusDot tone={tone} size={7} />
        <span className="label-caps">{title}</span>
        {count > 0 && <Badge tone={tone}>{count}</Badge>}
      </div>
      {count === 0 ? (
        <p className="label-sm" style={{ margin: 0, color: 'var(--muted)' }}>—</p>
      ) : (
        <div style={{ display: 'grid', gap: '0.25rem' }}>{children}</div>
      )}
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
      title="Перетащи на день или время"
      style={cardStyle(itemColor(t))}
    >
      <Icon name="tasks" size={13} style={{ color: 'var(--muted)' }} />
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
      title="Перетащи на день или время, чтобы назначить срок"
      style={cardStyle(st?.color ?? 'var(--primary)')}
    >
      <Icon name="tasks" size={13} style={{ color: 'var(--muted)' }} />
      <span style={ellipsis}>{t.title}</span>
    </div>
  );
}

function Row({ i, onEvent, onTask, withDay }: { i: CalendarItem; onEvent: (o: CalendarEventOccurrence) => void; onTask: (t: CalendarTaskItem) => void; withDay?: boolean }) {
  const router = useRouter();
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
      onClick={() => { if (isEvent(i)) onEvent(i); else if (isTask(i)) onTask(i); else router.push('/finance'); }}
      style={cardStyle(color)}
    >
      <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <span className="label-sm" style={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{time}</span>
      <span style={ellipsis}>{i.title}</span>
    </div>
  );
}

function rk(i: CalendarItem, idx: number): string {
  const id = isEvent(i) ? `${i.eventId}-${i.occurrenceStart}` : isTask(i) ? i.taskId : i.id;
  return `${id}-${idx}`;
}

const ellipsis: React.CSSProperties = {
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600, fontSize: '0.8125rem',
};

function cardStyle(color: string): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: 6, padding: '0.3125rem 0.5rem',
    border: '1px solid var(--divider)', borderLeft: `3px solid ${color}`,
    borderRadius: 'var(--radius-sm)', cursor: 'grab', userSelect: 'none',
  };
}
