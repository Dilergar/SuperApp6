'use client';

import {
  Alert, Button, Card, Chip, EmptyState, Icon, IconButton, LoadingBlock, Modal, PageHeader,
  SegmentedControl,
} from '@/components/ui';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { api, apiErrorMessage } from '@/lib/api';
import { contactsKey, circlesKey, fetchAllContacts, fetchCircles } from '@/lib/queries';
import { PersonChip } from '../circles/PersonCard';
import {
  TASK_STATUS_META,
  type CalendarItem,
  type CalendarEventOccurrence,
  type CalendarTaskItem,
  type Contact,
  type Circle,
  type SharedCalendarSource,
  type Resource,
} from '@superapp/shared';
import { EventModal, type ModalTarget } from './EventModal';
import { SharePanel, SmartMatchDialog } from './social';
import { ResourcesPanel } from './resources-ui';
import { GooglePanel } from './google-ui';
import { TriagePanel, type UndatedTask } from './TriagePanel';
import { getDrag, clearDrag, setDrag, type DragItem } from './calendar-dnd';
import {
  type CalendarView,
  HOUR_PX,
  rangeForView,
  viewLabel,
  startOfWeek,
  startOfMonth,
  startOfDay,
  addDays,
  addMonths,
  isToday,
  dayKey,
  fmtTime,
  fmtDayHeader,
  WEEKDAYS_SHORT,
  isEvent,
  isTask,
  isFinance,
  isAllDayItem,
  itemDays,
  itemColor,
  minutesFromMidnight,
  nextHalfHour,
} from './calendar-lib';

type EventDrag = Extract<DragItem, { kind: 'event' }>;
const eventDrag = (o: CalendarEventOccurrence): EventDrag => ({
  kind: 'event', id: o.eventId, seriesId: o.seriesId, recurring: o.recurring,
  occurrenceStart: o.occurrenceStart, start: o.start,
  durationMs: new Date(o.end).getTime() - new Date(o.start).getTime(), title: o.title,
});
/** Own, non-overlay, non-busy items are draggable. */
const canDragItem = (i: CalendarItem): boolean => {
  if (isFinance(i)) return false; // платежи — read-only слой
  return isTask(i) ? true : !(i as CalendarEventOccurrence).ownerName && !(i as CalendarEventOccurrence).busy;
};

const VIEWS: { key: CalendarView; label: string }[] = [
  { key: 'month', label: 'Месяц' },
  { key: 'week', label: 'Неделя' },
  { key: 'day', label: 'День' },
  { key: 'agenda', label: 'Повестка' },
];

export default function CalendarPage() {
  const { isReady, user } = useRequireAuth();
  const queryClient = useQueryClient();
  const [view, setView] = useState<CalendarView>('month');
  const [anchor, setAnchor] = useState(() => new Date());
  const [items, setItems] = useState<CalendarItem[]>([]);
  const [layers, setLayers] = useState({ events: true, tasks: true, finance: true });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modal, setModal] = useState<ModalTarget | null>(null);
  const [taskSel, setTaskSel] = useState<CalendarTaskItem | null>(null);

  const meId = user?.id ?? '';
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [circles, setCircles] = useState<Circle[]>([]);
  const [sources, setSources] = useState<SharedCalendarSource[]>([]);
  const [overlays, setOverlays] = useState<Set<string>>(new Set());
  const [showShare, setShowShare] = useState(false);
  const [showSmart, setShowSmart] = useState(false);
  const [resources, setResources] = useState<Resource[]>([]);
  const [showResources, setShowResources] = useState(false);
  const [undated, setUndated] = useState<UndatedTask[]>([]);
  const [showGoogle, setShowGoogle] = useState(false);
  const [showPanel, setShowPanel] = useState(true);
  const [pendingMove, setPendingMove] = useState<{ item: EventDrag; mode: 'move' | 'resize'; newStart?: Date; newEnd?: Date } | null>(null);

  const fetchMeta = useCallback(async () => {
    // Parallel (the old version awaited 5 requests strictly in a row — the review's
    // "waterfall") + meId comes from the auth store (no duplicate /users/me) +
    // contacts/circles go through the SHARED query cache (reused from /circles, /tasks).
    const [c, g, src, res] = await Promise.allSettled([
      queryClient.fetchQuery({ queryKey: contactsKey, queryFn: fetchAllContacts, staleTime: 60_000 }),
      queryClient.fetchQuery({ queryKey: circlesKey, queryFn: fetchCircles, staleTime: 60_000 }),
      api.get('/calendar/shared-with-me'),
      api.get('/resources'),
    ]);
    if (c.status === 'fulfilled') setContacts(c.value);
    if (g.status === 'fulfilled') setCircles(g.value);
    if (src.status === 'fulfilled') setSources(src.value.data.data);
    if (res.status === 'fulfilled') setResources(res.value.data.data);
  }, [queryClient]);

  const fetchRange = useCallback(async () => {
    setLoading(true);
    try {
      const { from, to } = rangeForView(view, anchor);
      const include = [...overlays];
      const { data } = await api.get('/calendar/events', {
        params: {
          from: from.toISOString(),
          to: to.toISOString(),
          layers: 'events,tasks,finance',
          ...(include.length ? { include: include.join(',') } : {}),
        },
      });
      setItems(data.data.items);
      setError('');
    } catch {
      setError('Не удалось загрузить календарь');
    } finally {
      setLoading(false);
    }
  }, [view, anchor, overlays]);

  const fetchUndated = useCallback(async () => {
    try {
      const { data } = await api.get('/tasks', { params: { limit: 100 } });
      const list: UndatedTask[] = (data.data as Array<{ id: string; title: string; status: string; priority: string; dueDate: string | null }>)
        .filter((t) => !t.dueDate)
        .map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority }));
      setUndated(list);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { if (isReady) fetchMeta(); }, [isReady, fetchMeta]);
  useEffect(() => { if (isReady) fetchRange(); }, [isReady, fetchRange]);
  useEffect(() => { if (isReady) fetchUndated(); }, [isReady, fetchUndated]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (new URLSearchParams(window.location.search).get('google')) {
      setShowGoogle(true);
      window.history.replaceState({}, '', '/calendar');
    }
  }, []);

  const visible = useMemo(
    () => items.filter((i) => (i.kind === 'event' ? layers.events : i.kind === 'task' ? layers.tasks : layers.finance)),
    [items, layers],
  );

  const step = (dir: 1 | -1) => {
    setAnchor((a) =>
      view === 'month' ? addMonths(a, dir)
      : view === 'week' ? addDays(a, 7 * dir)
      : view === 'day' ? addDays(a, dir)
      : addDays(a, 30 * dir),
    );
  };

  const openEvent = (occ: CalendarEventOccurrence) => {
    if (occ.busy) return; // opaque "Занят" overlay block — nothing to open
    setModal({ mode: 'event', occurrence: occ });
  };
  const openTask = (t: CalendarTaskItem) => setTaskSel(t);
  const createAt = (start: Date, allDay: boolean) => setModal({ mode: 'create', start, allDay });

  const toggleOverlay = (uid: string) =>
    setOverlays((cur) => {
      const next = new Set(cur);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });

  const closeModal = (changed: boolean) => {
    setModal(null);
    if (changed) { fetchRange(); fetchUndated(); }
  };

  // ---- drag & drop ----
  const reschedule = async (taskId: string, due: Date, allDay: boolean) => {
    try { await api.patch(`/tasks/${taskId}`, { dueDate: due.toISOString(), allDay }); await fetchRange(); await fetchUndated(); } catch { /* ignore */ }
  };
  const moveEventNow = async (item: EventDrag, newStart: Date, scope: 'this' | 'all') => {
    const body: Record<string, unknown> = {
      startTime: newStart.toISOString(),
      endTime: new Date(+newStart + item.durationMs).toISOString(),
      editScope: scope,
    };
    if (scope !== 'all') body.occurrenceStart = item.occurrenceStart;
    try { await api.patch(`/calendar/events/${item.id}`, body); await fetchRange(); } catch { /* ignore */ }
  };
  const resizeNow = async (item: EventDrag, newEnd: Date, scope: 'this' | 'all') => {
    const body: Record<string, unknown> = { endTime: newEnd.toISOString(), editScope: scope };
    if (scope !== 'all') body.occurrenceStart = item.occurrenceStart;
    try { await api.patch(`/calendar/events/${item.id}`, body); await fetchRange(); } catch { /* ignore */ }
  };
  const applyDrop = (d: DragItem, newStart: Date) => {
    if (d.kind === 'task') { reschedule(d.id, newStart, false); return; }
    if (d.recurring) setPendingMove({ item: d, mode: 'move', newStart });
    else moveEventNow(d, newStart, 'all');
  };
  const onDropDay = (day: Date) => {
    const d = getDrag(); clearDrag(); if (!d) return;
    const newStart = d.kind === 'event'
      ? (() => { const s = new Date(d.start); return new Date(day.getFullYear(), day.getMonth(), day.getDate(), s.getHours(), s.getMinutes()); })()
      : new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12, 0);
    applyDrop(d, newStart);
  };
  const onDropSlot = (day: Date, hour: number) => {
    const d = getDrag(); clearDrag(); if (!d) return;
    applyDrop(d, new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, 0));
  };
  const onResize = (item: EventDrag, newEnd: Date) => {
    if (item.recurring) setPendingMove({ item, mode: 'resize', newEnd });
    else resizeNow(item, newEnd, 'all');
  };

  if (!isReady) return <LoadingBlock />;

  return (
    <>
      <PageHeader
        breadcrumb="Календарь"
        title={viewLabel(view, anchor)}
        actions={
          <>
            <IconButton icon="caretLeft" label="Предыдущий период" size={34} variant="outline" round={false} onClick={() => step(-1)} />
            <Button size="sm" variant="outline" onClick={() => setAnchor(new Date())}>Сегодня</Button>
            <IconButton icon="caretRight" label="Следующий период" size={34} variant="outline" round={false} onClick={() => step(1)} />
            <Button variant="primary" tone="success" icon="add" onClick={() => createAt(nextHalfHour(), false)}>Событие</Button>
          </>
        }
      />

      <div style={{ display: 'grid', gap: 'var(--spacing-3)', marginBottom: 'var(--gap-grid)' }}>
        {/* Вид + слои + инструменты — одна полоса управления над сеткой */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
          <SegmentedControl items={VIEWS.map((v) => ({ key: v.key, label: v.label }))} value={view} onChange={(k) => setView(k as typeof view)} aria-label="Вид календаря" />
          <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap' }}>
            <Chip tone="accent" icon="calendar" selected={layers.events} onClick={() => setLayers((l) => ({ ...l, events: !l.events }))}>События</Chip>
            <Chip tone="danger" icon="tasks" selected={layers.tasks} onClick={() => setLayers((l) => ({ ...l, tasks: !l.tasks }))}>Задачи</Chip>
            <Chip tone="warning" icon="finance" selected={layers.finance} onClick={() => setLayers((l) => ({ ...l, finance: !l.finance }))}>Платежи</Chip>
          </div>
          <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
            <Button size="sm" variant="ghost" icon="target" onClick={() => setShowSmart(true)}>Подобрать</Button>
            <Button size="sm" variant="ghost" icon="folder" onClick={() => setShowResources(true)}>Ресурсы</Button>
            <Button size="sm" variant="ghost" icon="link" onClick={() => setShowGoogle(true)}>Google</Button>
            <Button size="sm" variant="ghost" icon="share" onClick={() => setShowShare(true)}>Поделиться</Button>
          </div>
        </div>

        {sources.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', flexWrap: 'wrap' }}>
            <span className="label-caps">Чужие календари</span>
            {sources.map((s) => {
              const on = overlays.has(s.userId);
              return (
                <button
                  key={s.userId}
                  type="button"
                  onClick={() => toggleOverlay(s.userId)}
                  aria-pressed={on}
                  title={on ? 'Скрыть слой' : 'Показать слой'}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: '0.3rem', cursor: 'pointer',
                    padding: '0.1875rem 0.5rem 0.1875rem 0.25rem', borderRadius: 'var(--radius-pill)',
                    background: on ? 'var(--secondary-container)' : 'transparent',
                    border: `1px solid ${on ? 'var(--primary)' : 'var(--border)'}`,
                  }}
                >
                  <PersonChip size="S" userId={s.userId} firstName={s.firstName} lastName={s.lastName ?? null} />
                  <span className="label-sm">{s.accessLevel === 'detailed' ? 'детально' : 'занят'}</span>
                </button>
              );
            })}
          </div>
        )}

        {error && <Alert tone="danger" onClose={() => setError('')}>{error}</Alert>}
      </div>

      <div style={{ display: 'flex', gap: 'var(--gap-grid)', alignItems: 'flex-start' }}>
          {showPanel ? (
            <TriagePanel items={visible} undated={undated} onEvent={openEvent} onTask={openTask} onClose={() => setShowPanel(false)} />
          ) : (
            <IconButton icon="caretRight" label="Показать планнер" size={34} variant="outline" round={false} onClick={() => setShowPanel(true)} />
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            {loading ? (
              <Card><LoadingBlock /></Card>
            ) : view === 'month' ? (
              <MonthView anchor={anchor} items={visible} onDayClick={(d) => createAt(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12), false)} onEvent={openEvent} onTask={openTask} onDropDay={onDropDay} />
            ) : view === 'agenda' ? (
              <AgendaView anchor={anchor} items={visible} onEvent={openEvent} onTask={openTask} />
            ) : (
              <TimeGridView
                days={view === 'day' ? [startOfDay(anchor)] : Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor), i))}
                items={visible}
                onEvent={openEvent}
                onTask={openTask}
                onSlot={(d, h) => createAt(new Date(d.getFullYear(), d.getMonth(), d.getDate(), h), false)}
                onAllDay={(d) => createAt(startOfDay(d), true)}
                onDropSlot={onDropSlot}
                onResize={onResize}
              />
            )}
          </div>
      </div>

      {modal && <EventModal target={modal} meId={meId} contacts={contacts} circles={circles} resources={resources} onClose={closeModal} />}
      {taskSel && <TaskPopover task={taskSel} onClose={(changed) => { setTaskSel(null); if (changed) fetchRange(); }} />}
      {showShare && <SharePanel contacts={contacts} onClose={() => { setShowShare(false); fetchMeta(); }} />}
      {showResources && <ResourcesPanel contacts={contacts} circles={circles} onClose={(changed) => { setShowResources(false); fetchMeta(); if (changed) fetchRange(); }} />}
      {showGoogle && <GooglePanel onClose={(changed) => { setShowGoogle(false); if (changed) { fetchRange(); fetchUndated(); } }} />}
      {showSmart && (
        <SmartMatchDialog
          sources={sources}
          onClose={() => setShowSmart(false)}
          onPick={(startIso, userIds) => { setShowSmart(false); setModal({ mode: 'create', start: new Date(startIso), allDay: false, participantUserIds: userIds }); }}
        />
      )}
      {pendingMove && (
        <RecurrenceScopeDialog
          onPick={(scope) => {
            const pm = pendingMove;
            setPendingMove(null);
            if (pm.mode === 'move' && pm.newStart) moveEventNow(pm.item, pm.newStart, scope);
            else if (pm.mode === 'resize' && pm.newEnd) resizeNow(pm.item, pm.newEnd, scope);
          }}
          onCancel={() => setPendingMove(null)}
        />
      )}
    </>
  );
}

// ============================================================
// Month view
// ============================================================

function MonthView({
  anchor, items, onDayClick, onEvent, onTask, onDropDay,
}: {
  anchor: Date;
  items: CalendarItem[];
  onDayClick: (d: Date) => void;
  onEvent: (o: CalendarEventOccurrence) => void;
  onTask: (t: CalendarTaskItem) => void;
  onDropDay: (d: Date) => void;
}) {
  const start = startOfWeek(startOfMonth(anchor));
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const byDay = groupByDay(items);

  return (
    <Card className="density-compact" style={{ padding: 'var(--spacing-3)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '0.25rem' }}>
        {WEEKDAYS_SHORT.map((w) => (
          <div key={w} className="label-caps" style={{ textAlign: 'center', padding: '0.25rem 0 0.375rem' }}>{w}</div>
        ))}
        {days.map((d) => {
          const inMonth = d.getMonth() === anchor.getMonth();
          const today = isToday(d);
          const list = byDay.get(dayKey(d)) ?? [];
          return (
            <div
              key={d.toISOString()}
              onClick={() => onDayClick(d)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); onDropDay(d); }}
              style={{
                minHeight: 104, padding: '0.25rem 0.375rem', cursor: 'pointer',
                borderRadius: 'var(--radius-md)',
                border: `1px solid ${today ? 'var(--primary)' : 'var(--divider)'}`,
                background: today ? 'var(--secondary-container)' : 'transparent',
                opacity: inMonth ? 1 : 0.45,
                display: 'flex', flexDirection: 'column', gap: 2,
              }}
            >
              <div
                style={{
                  textAlign: 'right', fontSize: '0.8125rem',
                  fontWeight: today ? 800 : 600,
                  color: today ? 'var(--primary-dim)' : 'var(--on-surface)',
                }}
              >
                {d.getDate()}
              </div>
              {list.slice(0, 3).map((it, idx) => (
                <ItemChip key={chipKey(it, idx)} item={it} onEvent={onEvent} onTask={onTask} />
              ))}
              {list.length > 3 && <div className="label-sm">+{list.length - 3} ещё</div>}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function ItemChip({ item, onEvent, onTask }: { item: CalendarItem; onEvent: (o: CalendarEventOccurrence) => void; onTask: (t: CalendarTaskItem) => void }) {
  const router = useRouter();
  const color = itemColor(item);
  const done = isTask(item) && item.status === 'done';
  const drag = canDragItem(item);
  return (
    <button
      draggable={drag}
      onDragStart={drag ? (e) => { e.stopPropagation(); setDrag(isEvent(item) ? eventDrag(item) : { kind: 'task', id: (item as CalendarTaskItem).taskId, title: item.title }, e); } : undefined}
      onDragEnd={drag ? clearDrag : undefined}
      onClick={(e) => { e.stopPropagation(); if (isEvent(item)) onEvent(item); else if (isTask(item)) onTask(item); else router.push('/finance'); }}
      title={item.title}
      style={{
        display: 'flex', alignItems: 'center', gap: 4, width: '100%', textAlign: 'left',
        padding: '1px 5px', borderRadius: 'var(--radius-sm)', border: 'none', cursor: drag ? 'grab' : 'pointer',
        background: isTask(item) ? 'transparent' : color + '22',
        fontSize: '0.7rem', fontWeight: 600, color: 'var(--on-surface)',
        overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
        opacity: done ? 0.55 : 1,
      }}
    >
      <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }} />
      {/* Значок рисует клиент по виду записи: в тексте с сервера эмодзи нет */}
      {isTask(item) ? (
        <Icon name={done ? 'check' : item.overdue ? 'overdue' : 'tasks'} size={13} />
      ) : isFinance(item) ? (
        <Icon name="finance" size={13} />
      ) : (
        !item.allDay && <span style={{ opacity: 0.7, flexShrink: 0 }}>{fmtTime(item.start)}</span>
      )}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', textDecoration: done ? 'line-through' : 'none' }}>{item.title}</span>
    </button>
  );
}

// ============================================================
// Week / Day time grid
// ============================================================

function TimeGridView({
  days, items, onEvent, onTask, onSlot, onAllDay, onDropSlot, onResize,
}: {
  days: Date[];
  items: CalendarItem[];
  onEvent: (o: CalendarEventOccurrence) => void;
  onTask: (t: CalendarTaskItem) => void;
  onSlot: (d: Date, hour: number) => void;
  onAllDay: (d: Date) => void;
  onDropSlot: (d: Date, hour: number) => void;
  onResize: (item: EventDrag, newEnd: Date) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 7 * HOUR_PX; // open around 07:00
  }, []);

  const [resizePreview, setResizePreview] = useState<{ key: string; durMin: number } | null>(null);
  const resizeRef = useRef<{ item: CalendarEventOccurrence; startY: number; origDurMin: number } | null>(null);

  const startResize = (item: CalendarEventOccurrence, e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const origDurMin = (new Date(item.end).getTime() - new Date(item.start).getTime()) / 60000;
    resizeRef.current = { item, startY: e.clientY, origDurMin };
    const calc = (clientY: number) => {
      const r = resizeRef.current!;
      const delta = ((clientY - r.startY) / HOUR_PX) * 60;
      return Math.max(15, Math.round((r.origDurMin + delta) / 15) * 15);
    };
    const move = (ev: PointerEvent) => {
      const r = resizeRef.current;
      if (r) setResizePreview({ key: r.item.eventId + r.item.occurrenceStart, durMin: calc(ev.clientY) });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const r = resizeRef.current;
      resizeRef.current = null;
      setResizePreview(null);
      if (r) onResize(eventDrag(r.item), new Date(+new Date(r.item.start) + calc(ev.clientY) * 60000));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const byDay = groupByDay(items);
  const now = new Date();

  return (
    <Card className="density-compact" style={{ padding: 0, overflow: 'hidden' }}>
      {/* Day headers */}
      <div style={{ display: 'grid', gridTemplateColumns: `52px repeat(${days.length}, 1fr)` }}>
        <div />
        {days.map((d) => {
          const h = fmtDayHeader(d);
          return (
            <div key={d.toISOString()} style={{ textAlign: 'center', padding: 'var(--spacing-2)' }}>
              <div className="label-caps">{h.weekday}</div>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '1.125rem', color: isToday(d) ? 'var(--primary-dim)' : 'var(--on-surface)' }}>{h.day}</div>
            </div>
          );
        })}
      </div>

      {/* All-day band */}
      <div style={{ display: 'grid', gridTemplateColumns: `52px repeat(${days.length}, 1fr)`, borderTop: '1px solid var(--divider)', borderBottom: '1px solid var(--divider)', minHeight: 30 }}>
        <div className="label-caps" style={{ padding: '4px 6px', alignSelf: 'center' }}>весь день</div>
        {days.map((d) => {
          const all = (byDay.get(dayKey(d)) ?? []).filter(isAllDayItem);
          return (
            <div key={d.toISOString()} onClick={() => onAllDay(d)} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); onDropSlot(d, 9); }} style={{ padding: 3, display: 'flex', flexDirection: 'column', gap: 2, cursor: 'pointer', minHeight: 26 }}>
              {all.map((it, idx) => <ItemChip key={chipKey(it, idx)} item={it} onEvent={onEvent} onTask={onTask} />)}
            </div>
          );
        })}
      </div>

      {/* Hour grid */}
      <div ref={scroller} style={{ maxHeight: '62vh', overflowY: 'auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: `52px repeat(${days.length}, 1fr)`, position: 'relative' }}>
          {/* hour gutter */}
          <div>
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="meta" style={{ height: HOUR_PX, textAlign: 'right', paddingRight: 6, color: 'var(--muted)', transform: 'translateY(-6px)' }}>
                {h > 0 ? `${String(h).padStart(2, '0')}:00` : ''}
              </div>
            ))}
          </div>
          {/* day columns */}
          {days.map((d) => {
            const dayItems = byDay.get(dayKey(d)) ?? [];
            const timedEvents = dayItems.filter((i) => isEvent(i) && !i.allDay) as CalendarEventOccurrence[];
            const timedTasks = dayItems.filter((i) => isTask(i) && !i.allDay && !i.overdue) as CalendarTaskItem[];
            const laid = layoutColumns(timedEvents);
            return (
              <div key={d.toISOString()} style={{ position: 'relative', borderLeft: '1px solid var(--divider)' }}>
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h}
                    onClick={() => onSlot(d, h)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => { e.preventDefault(); onDropSlot(d, h); }}
                    style={{ height: HOUR_PX, borderTop: '1px solid var(--divider)', cursor: 'pointer' }} />
                ))}
                {/* now line */}
                {isToday(d) && (
                  <div aria-hidden style={{ position: 'absolute', left: 0, right: 0, top: (minutesFromMidnight(now.toISOString()) / 60) * HOUR_PX, height: 2, background: 'var(--danger-base)', zIndex: 5 }}>
                    <span style={{ position: 'absolute', left: -4, top: -3, width: 8, height: 8, borderRadius: '50%', background: 'var(--danger-base)' }} />
                  </div>
                )}
                {laid.map(({ item, col, cols }, idx) => {
                  const top = (minutesFromMidnight(item.start) / 60) * HOUR_PX;
                  const baseDur = Math.max((new Date(item.end).getTime() - new Date(item.start).getTime()) / 60000, 30);
                  const pv = resizePreview && resizePreview.key === item.eventId + item.occurrenceStart ? resizePreview.durMin : null;
                  const durMin = pv ?? baseDur;
                  const height = Math.max((durMin / 60) * HOUR_PX - 2, 18);
                  const color = itemColor(item);
                  const drag = canDragItem(item);
                  return (
                    <div
                      key={chipKey(item, idx)}
                      draggable={drag}
                      onDragStart={drag ? (e) => setDrag(eventDrag(item), e) : undefined}
                      onDragEnd={drag ? clearDrag : undefined}
                      onClick={() => onEvent(item)}
                      title={item.title}
                      style={{
                        position: 'absolute', top, height,
                        left: `calc(${(col / cols) * 100}% + 2px)`, width: `calc(${100 / cols}% - 4px)`,
                        background: color + '26', borderLeft: `3px solid ${color}`, borderRadius: 'var(--radius-sm)',
                        padding: '2px 4px', textAlign: 'left', cursor: drag ? 'grab' : 'pointer', overflow: 'hidden',
                        fontSize: '0.7rem', color: 'var(--on-surface)', zIndex: pv ? 6 : 2,
                      }}
                    >
                      <div style={{ fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.title}</div>
                      <div style={{ fontSize: '0.62rem', opacity: 0.75 }}>{fmtTime(item.start)}</div>
                      {drag && (
                        <div
                          onPointerDown={(e) => startResize(item, e)}
                          onClick={(e) => e.stopPropagation()}
                          title="Потяни, чтобы изменить длительность"
                          style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 7, cursor: 'ns-resize' }}
                        />
                      )}
                    </div>
                  );
                })}
                {timedTasks.map((t, idx) => {
                  const top = (minutesFromMidnight(t.start) / 60) * HOUR_PX;
                  return (
                    <div
                      key={chipKey(t, idx)}
                      draggable
                      onDragStart={(e) => setDrag({ kind: 'task', id: t.taskId, title: t.title }, e)}
                      onDragEnd={clearDrag}
                      onClick={() => onTask(t)}
                      title={t.title}
                      style={{ position: 'absolute', top: top - 8, left: 2, right: 2, height: 16, display: 'flex', alignItems: 'center', gap: 4, cursor: 'grab', zIndex: 3, fontSize: '0.6875rem', fontWeight: 600, color: 'var(--danger)' }}
                    >
                      <Icon name="tasks" size={13} />
                      <span style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{t.title}</span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

// ============================================================
// Agenda view
// ============================================================

function AgendaView({
  anchor, items, onEvent, onTask,
}: {
  anchor: Date;
  items: CalendarItem[];
  onEvent: (o: CalendarEventOccurrence) => void;
  onTask: (t: CalendarTaskItem) => void;
}) {
  const byDay = groupByDay(items);
  const days = Array.from({ length: 31 }, (_, i) => addDays(startOfDay(anchor), i)).filter((d) => (byDay.get(dayKey(d)) ?? []).length > 0);

  if (days.length === 0) {
    return (
      <Card>
        <EmptyState icon="calendar" title="На ближайшие 30 дней ничего нет" description="Свободный месяц — или пора что-нибудь запланировать." />
      </Card>
    );
  }

  return (
    <div className="density-compact" style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
      {days.map((d) => {
        const list = [...(byDay.get(dayKey(d)) ?? [])].sort((a, b) => a.start.localeCompare(b.start));
        return (
          <Card key={d.toISOString()} small>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', marginBottom: 'var(--spacing-2)' }}>
              <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '1.125rem', color: isToday(d) ? 'var(--primary-dim)' : 'var(--on-surface)' }}>{d.getDate()}</span>
              <span className="label-sm">{d.toLocaleDateString('ru-RU', { weekday: 'long', month: 'long' })}</span>
              {isToday(d) && <Chip size="sm" tone="accent">сегодня</Chip>}
            </div>
            <div style={{ display: 'grid', gap: '0.25rem' }}>
              {list.map((it, idx) => <AgendaRow key={chipKey(it, idx)} item={it} onEvent={onEvent} onTask={onTask} />)}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function AgendaRow({ item, onEvent, onTask }: { item: CalendarItem; onEvent: (o: CalendarEventOccurrence) => void; onTask: (t: CalendarTaskItem) => void }) {
  const router = useRouter();
  const color = itemColor(item);
  const done = isTask(item) && item.status === 'done';
  const timeLabel = isAllDayItem(item) ? 'весь день' : fmtTime(item.start);
  return (
    <button
      onClick={() => { if (isEvent(item)) onEvent(item); else if (isTask(item)) onTask(item); else router.push('/finance'); }}
      style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', padding: '0.4375rem 0.5rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--divider)', background: 'transparent', cursor: 'pointer', textAlign: 'left', width: '100%' }}
    >
      <span className="label-sm" style={{ width: 78, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{timeLabel}</span>
      <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
      {isFinance(item) && <Icon name="finance" size={14} style={{ color: 'var(--muted)' }} />}
      <span className="title-sm" style={{ flex: 1, textDecoration: done ? 'line-through' : 'none', opacity: done ? 0.6 : 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</span>
      {isTask(item) && (
        <Chip size="sm" tone={item.overdue ? 'danger' : 'neutral'}>{item.overdue ? 'просрочено' : 'задача'}</Chip>
      )}
      {isEvent(item) && item.location && (
        <span className="label-sm" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
          <Icon name="location" size={13} />
          {item.location}
        </span>
      )}
    </button>
  );
}

// ============================================================
// Task quick actions
// ============================================================

function TaskPopover({ task, onClose }: { task: CalendarTaskItem; onClose: (changed: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const st = TASK_STATUS_META[task.status];
  const statusTone: Record<string, 'accent' | 'success' | 'warning' | 'danger' | 'neutral'> = {
    todo: 'neutral', in_progress: 'accent', on_review: 'warning', done: 'success', cancelled: 'neutral',
  };
  const canComplete = task.status !== 'done' && task.status !== 'cancelled';

  const complete = async () => {
    setBusy(true);
    try {
      await api.post(`/tasks/${task.taskId}/submit`);
      onClose(true);
    } catch (e) {
      setError(apiErrorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={() => onClose(false)}
      title={task.title}
      size="sm"
      footer={
        <>
          <Button variant="outline" icon="tasks" href={`/tasks/${task.taskId}`}>Открыть задачу</Button>
          {canComplete && (
            <Button variant="primary" tone="success" icon="check" loading={busy} onClick={complete}>Выполнено</Button>
          )}
        </>
      }
    >
      <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
        {error && <Alert tone="danger" onClose={() => setError('')}>{error}</Alert>}
        <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap' }}>
          <Chip size="sm" tone={statusTone[task.status] ?? 'neutral'}>{st.label}</Chip>
          <Chip size="sm" tone={task.overdue ? 'danger' : 'neutral'} icon="clock">
            {new Date(task.dueDate).toLocaleString('ru-RU', {
              day: 'numeric',
              month: 'short',
              hour: task.allDay ? undefined : '2-digit',
              minute: task.allDay ? undefined : '2-digit',
            })}
            {task.overdue ? ' · просрочено' : ''}
          </Chip>
          {task.coinReward ? <Chip size="sm" tone="warning" icon="coins">{task.coinReward}</Chip> : null}
        </div>
      </div>
    </Modal>
  );
}

function RecurrenceScopeDialog({ onPick, onCancel }: { onPick: (scope: 'this' | 'all') => void; onCancel: () => void }) {
  return (
    <Modal
      open
      onClose={onCancel}
      title="Повторяющееся событие"
      subtitle="Изменить только это вхождение или всю серию?"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>Отмена</Button>
          <Button variant="outline" onClick={() => onPick('this')}>Только это</Button>
          <Button variant="primary" onClick={() => onPick('all')}>Вся серия</Button>
        </>
      }
    >
      <p className="body-md" style={{ margin: 0 }}>
        «Только это» создаст исключение в серии — остальные вхождения останутся на своих местах.
      </p>
    </Modal>
  );
}

// ============================================================
// Helpers
// ============================================================

function groupByDay(items: CalendarItem[]): Map<string, CalendarItem[]> {
  const map = new Map<string, CalendarItem[]>();
  for (const it of items) {
    for (const d of itemDays(it)) {
      const k = dayKey(d);
      const arr = map.get(k);
      if (arr) arr.push(it);
      else map.set(k, [it]);
    }
  }
  // all-day first, then by start time
  for (const arr of map.values()) {
    arr.sort((a, b) => {
      const aa = isAllDayItem(a) ? 0 : 1;
      const bb = isAllDayItem(b) ? 0 : 1;
      return aa !== bb ? aa - bb : a.start.localeCompare(b.start);
    });
  }
  return map;
}

/** Greedy overlap layout for timed events within one day column. */
function layoutColumns(events: CalendarEventOccurrence[]): Array<{ item: CalendarEventOccurrence; col: number; cols: number }> {
  const sorted = [...events].sort((a, b) => a.start.localeCompare(b.start));
  const result: Array<{ item: CalendarEventOccurrence; col: number; cols: number }> = [];
  let cluster: CalendarEventOccurrence[] = [];
  let colEnds: number[] = [];
  let clusterMaxEnd = -Infinity;

  const flush = () => {
    const cols = colEnds.length || 1;
    for (const ev of cluster) {
      const r = result.find((x) => x.item === ev);
      if (r) r.cols = cols;
    }
    cluster = [];
    colEnds = [];
    clusterMaxEnd = -Infinity;
  };

  for (const ev of sorted) {
    const s = new Date(ev.start).getTime();
    const e = new Date(ev.end).getTime();
    if (cluster.length && s >= clusterMaxEnd) flush();
    let col = colEnds.findIndex((end) => end <= s);
    if (col === -1) {
      col = colEnds.length;
      colEnds.push(e);
    } else {
      colEnds[col] = e;
    }
    cluster.push(ev);
    clusterMaxEnd = Math.max(clusterMaxEnd, e);
    result.push({ item: ev, col, cols: 1 });
  }
  flush();
  return result;
}

function chipKey(item: CalendarItem, idx: number): string {
  const id = isEvent(item) ? `${item.eventId}-${item.occurrenceStart}` : isTask(item) ? item.taskId : item.id;
  return `${id}-${idx}`;
}

