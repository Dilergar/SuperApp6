'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Link from 'next/link';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { api } from '@/lib/api';
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
const canDragItem = (i: CalendarItem): boolean =>
  isTask(i) ? true : !(i as CalendarEventOccurrence).ownerName && !(i as CalendarEventOccurrence).busy;

const VIEWS: { key: CalendarView; label: string }[] = [
  { key: 'month', label: 'Месяц' },
  { key: 'week', label: 'Неделя' },
  { key: 'day', label: 'День' },
  { key: 'agenda', label: 'Повестка' },
];

export default function CalendarPage() {
  const { isReady } = useRequireAuth();
  const [view, setView] = useState<CalendarView>('month');
  const [anchor, setAnchor] = useState(() => new Date());
  const [items, setItems] = useState<CalendarItem[]>([]);
  const [layers, setLayers] = useState({ events: true, tasks: true });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modal, setModal] = useState<ModalTarget | null>(null);
  const [taskSel, setTaskSel] = useState<CalendarTaskItem | null>(null);

  const [meId, setMeId] = useState('');
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
    try { setMeId((await api.get('/users/me')).data.data.id); } catch { /* ignore */ }
    try {
      const acc: Contact[] = [];
      let cursor: string | undefined;
      do {
        const res = await api.get('/contacts', { params: cursor ? { cursor } : undefined });
        acc.push(...res.data.data);
        cursor = res.data.nextCursor ?? undefined;
      } while (cursor);
      setContacts(acc);
    } catch { /* ignore */ }
    try { setCircles((await api.get('/circles')).data.data); } catch { /* ignore */ }
    try { setSources((await api.get('/calendar/shared-with-me')).data.data); } catch { /* ignore */ }
    try { setResources((await api.get('/resources')).data.data); } catch { /* ignore */ }
  }, []);

  const fetchRange = useCallback(async () => {
    setLoading(true);
    try {
      const { from, to } = rangeForView(view, anchor);
      const include = [...overlays];
      const { data } = await api.get('/calendar/events', {
        params: {
          from: from.toISOString(),
          to: to.toISOString(),
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
    () => items.filter((i) => (i.kind === 'event' ? layers.events : layers.tasks)),
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

  if (!isReady) {
    return <div className="min-h-screen flex items-center justify-center"><p className="label-md">Загрузка…</p></div>;
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--surface)' }}>
      <nav className="fixed top-0 w-full z-50 px-6 py-4" style={{ background: 'rgba(245, 245, 220, 0.7)', backdropFilter: 'blur(10px)' }}>
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <Link href="/dashboard" className="title-md" style={{ color: 'var(--primary)' }}>SuperApp6</Link>
          <div style={{ display: 'flex', gap: 'var(--spacing-3)' }}>
            <Link href="/tasks" className="btn-secondary" style={navBtn}>Задачи</Link>
            <Link href="/circles" className="btn-secondary" style={navBtn}>Окружение</Link>
            <Link href="/dashboard" className="btn-secondary" style={navBtn}>Главная</Link>
          </div>
        </div>
      </nav>

      <div className="max-w-6xl mx-auto px-6 pt-24" style={{ paddingBottom: 'var(--spacing-16)' }}>
        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--spacing-4)', flexWrap: 'wrap', marginBottom: 'var(--spacing-5)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)' }}>
            <h1 className="display-md" style={{ fontSize: '2rem', minWidth: 220 }}>{viewLabel(view, anchor)}</h1>
            <div style={{ display: 'flex', gap: 'var(--spacing-1)' }}>
              <button onClick={() => step(-1)} style={navArrow}>‹</button>
              <button onClick={() => setAnchor(new Date())} style={{ ...navArrow, width: 'auto', padding: '0 0.7rem', fontSize: '0.8rem', fontWeight: 600 }}>Сегодня</button>
              <button onClick={() => step(1)} style={navArrow}>›</button>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
            <button onClick={() => setShowSmart(true)} className="btn-secondary" style={{ fontSize: '0.85rem', padding: '0.45rem 1rem' }}>🔎 Подобрать</button>
            <button onClick={() => setShowResources(true)} className="btn-secondary" style={{ fontSize: '0.85rem', padding: '0.45rem 1rem' }}>📦 Ресурсы</button>
            <button onClick={() => setShowGoogle(true)} className="btn-secondary" style={{ fontSize: '0.85rem', padding: '0.45rem 1rem' }}>🔗 Google</button>
            <button onClick={() => setShowShare(true)} className="btn-secondary" style={{ fontSize: '0.85rem', padding: '0.45rem 1rem' }}>↗ Поделиться</button>
            <button onClick={() => createAt(nextHalfHour(), false)} className="btn-primary" style={{ fontSize: '0.9rem', padding: '0.5rem 1.2rem' }}>+ Событие</button>
          </div>
        </div>

        {/* View switch + layer toggles */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--spacing-3)', flexWrap: 'wrap', marginBottom: 'var(--spacing-5)' }}>
          <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
            {VIEWS.map((v) => (
              <button key={v.key} onClick={() => setView(v.key)} style={pill(view === v.key)}>{v.label}</button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 'var(--spacing-2)' }}>
            <button onClick={() => setLayers((l) => ({ ...l, events: !l.events }))} style={layerChip(layers.events, '#326a8b')}>📅 События</button>
            <button onClick={() => setLayers((l) => ({ ...l, tasks: !l.tasks }))} style={layerChip(layers.tasks, '#c61a1e')}>✓ Задачи</button>
          </div>
        </div>

        {sources.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', flexWrap: 'wrap', marginBottom: 'var(--spacing-4)' }}>
            <span className="label-sm" style={{ fontWeight: 700 }}>Чужие календари:</span>
            {sources.map((s) => (
              <button key={s.userId} onClick={() => toggleOverlay(s.userId)} style={layerChip(overlays.has(s.userId), '#7c3aed')}>
                {s.firstName} {s.lastName ?? ''} <span style={{ opacity: 0.6, fontSize: '0.66rem' }}>{s.accessLevel === 'detailed' ? 'детально' : 'занят'}</span>
              </button>
            ))}
          </div>
        )}

        {error && <div className="wash-primary" style={{ padding: 'var(--spacing-3) var(--spacing-4)', marginBottom: 'var(--spacing-4)', color: 'var(--primary)', fontSize: '0.85rem' }}>{error}</div>}

        <div style={{ display: 'flex', gap: 'var(--spacing-4)', alignItems: 'flex-start' }}>
          {showPanel ? (
            <TriagePanel items={visible} undated={undated} onEvent={openEvent} onTask={openTask} onClose={() => setShowPanel(false)} />
          ) : (
            <button onClick={() => setShowPanel(true)} title="Показать планнер" style={{ ...navArrow }}>⟩</button>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            {loading ? (
              <div className="card" style={{ textAlign: 'center', padding: 'var(--spacing-10)', color: 'var(--on-surface-variant)' }}><p className="label-md">Загрузка…</p></div>
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
    </div>
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
    <div className="card" style={{ padding: 'var(--spacing-3)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 'var(--spacing-1)' }}>
        {WEEKDAYS_SHORT.map((w) => (
          <div key={w} className="label-sm" style={{ textAlign: 'center', fontWeight: 700, padding: 'var(--spacing-1)' }}>{w}</div>
        ))}
        {days.map((d) => {
          const inMonth = d.getMonth() === anchor.getMonth();
          const list = byDay.get(dayKey(d)) ?? [];
          return (
            <div
              key={d.toISOString()}
              onClick={() => onDayClick(d)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); onDropDay(d); }}
              style={{
                minHeight: 104, padding: 'var(--spacing-1) var(--spacing-2)', cursor: 'pointer',
                borderRadius: 'var(--radius-sm)',
                background: isToday(d) ? 'var(--secondary-container)' : 'var(--surface-container-low)',
                opacity: inMonth ? 1 : 0.4,
                display: 'flex', flexDirection: 'column', gap: 2,
              }}
            >
              <div style={{ textAlign: 'right', fontSize: '0.78rem', fontWeight: isToday(d) ? 800 : 600, color: isToday(d) ? 'var(--secondary)' : 'var(--on-surface)' }}>{d.getDate()}</div>
              {list.slice(0, 3).map((it, idx) => (
                <ItemChip key={chipKey(it, idx)} item={it} onEvent={onEvent} onTask={onTask} />
              ))}
              {list.length > 3 && <div className="label-sm" style={{ fontSize: '0.68rem' }}>+{list.length - 3} ещё</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ItemChip({ item, onEvent, onTask }: { item: CalendarItem; onEvent: (o: CalendarEventOccurrence) => void; onTask: (t: CalendarTaskItem) => void }) {
  const color = itemColor(item);
  const done = isTask(item) && item.status === 'done';
  const drag = canDragItem(item);
  return (
    <button
      draggable={drag}
      onDragStart={drag ? (e) => { e.stopPropagation(); setDrag(isEvent(item) ? eventDrag(item) : { kind: 'task', id: (item as CalendarTaskItem).taskId, title: item.title }, e); } : undefined}
      onDragEnd={drag ? clearDrag : undefined}
      onClick={(e) => { e.stopPropagation(); if (isEvent(item)) onEvent(item); else onTask(item); }}
      title={item.title}
      style={{
        display: 'flex', alignItems: 'center', gap: 4, width: '100%', textAlign: 'left',
        padding: '1px 5px', borderRadius: 4, border: 'none', cursor: drag ? 'grab' : 'pointer',
        background: isTask(item) ? 'transparent' : color + '22',
        fontSize: '0.7rem', fontWeight: 600, color: 'var(--on-surface)',
        overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
        opacity: done ? 0.55 : 1,
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }} />
      {isTask(item) ? <span style={{ flexShrink: 0 }}>{done ? '✓' : item.overdue ? '⏰' : '○'}</span> : (!item.allDay && <span style={{ opacity: 0.7, flexShrink: 0 }}>{fmtTime(item.start)}</span>)}
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
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      {/* Day headers */}
      <div style={{ display: 'grid', gridTemplateColumns: `52px repeat(${days.length}, 1fr)` }}>
        <div />
        {days.map((d) => {
          const h = fmtDayHeader(d);
          return (
            <div key={d.toISOString()} style={{ textAlign: 'center', padding: 'var(--spacing-2)' }}>
              <div className="label-sm" style={{ fontSize: '0.7rem' }}>{h.weekday}</div>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '1.1rem', color: isToday(d) ? 'var(--secondary)' : 'var(--on-surface)' }}>{h.day}</div>
            </div>
          );
        })}
      </div>

      {/* All-day band */}
      <div style={{ display: 'grid', gridTemplateColumns: `52px repeat(${days.length}, 1fr)`, background: 'var(--surface-container-low)', minHeight: 30 }}>
        <div className="label-sm" style={{ fontSize: '0.62rem', padding: '4px', alignSelf: 'center' }}>весь день</div>
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
              <div key={h} style={{ height: HOUR_PX, textAlign: 'right', paddingRight: 6, fontSize: '0.62rem', color: 'var(--on-surface-variant)', transform: 'translateY(-6px)' }}>
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
              <div key={d.toISOString()} style={{ position: 'relative', borderLeft: '1px solid rgba(187,186,171,0.25)' }}>
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h}
                    onClick={() => onSlot(d, h)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => { e.preventDefault(); onDropSlot(d, h); }}
                    style={{ height: HOUR_PX, borderTop: '1px solid rgba(187,186,171,0.18)', cursor: 'pointer' }} />
                ))}
                {/* now line */}
                {isToday(d) && (
                  <div style={{ position: 'absolute', left: 0, right: 0, top: (minutesFromMidnight(now.toISOString()) / 60) * HOUR_PX, height: 2, background: 'var(--primary)', zIndex: 5 }}>
                    <span style={{ position: 'absolute', left: -4, top: -3, width: 8, height: 8, borderRadius: '50%', background: 'var(--primary)' }} />
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
                        background: color + '26', borderLeft: `3px solid ${color}`, borderRadius: 4,
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
                      style={{ position: 'absolute', top: top - 8, left: 2, right: 2, height: 16, display: 'flex', alignItems: 'center', gap: 4, cursor: 'grab', zIndex: 3, fontSize: '0.66rem', fontWeight: 600, color: 'var(--primary)' }}
                    >
                      <span>✓</span><span style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{t.title}</span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
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
    return <div className="card" style={{ textAlign: 'center', padding: 'var(--spacing-10)', color: 'var(--on-surface-variant)' }}><p className="label-md">На ближайшие 30 дней ничего нет</p></div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)' }}>
      {days.map((d) => {
        const list = [...(byDay.get(dayKey(d)) ?? [])].sort((a, b) => a.start.localeCompare(b.start));
        return (
          <div key={d.toISOString()} className="card" style={{ padding: 'var(--spacing-4)' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-2)' }}>
              <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '1.1rem', color: isToday(d) ? 'var(--secondary)' : 'var(--on-surface)' }}>{d.getDate()}</span>
              <span className="label-sm">{d.toLocaleDateString('ru-RU', { weekday: 'long', month: 'long' })}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-1)' }}>
              {list.map((it, idx) => <AgendaRow key={chipKey(it, idx)} item={it} onEvent={onEvent} onTask={onTask} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AgendaRow({ item, onEvent, onTask }: { item: CalendarItem; onEvent: (o: CalendarEventOccurrence) => void; onTask: (t: CalendarTaskItem) => void }) {
  const color = itemColor(item);
  const done = isTask(item) && item.status === 'done';
  const timeLabel = isAllDayItem(item) ? 'весь день' : fmtTime(item.start);
  return (
    <button
      onClick={() => (isEvent(item) ? onEvent(item) : onTask(item as CalendarTaskItem))}
      style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', padding: '0.4rem 0.5rem', borderRadius: 'var(--radius-sm)', border: 'none', background: 'var(--surface-container-low)', cursor: 'pointer', textAlign: 'left', width: '100%' }}
    >
      <span className="label-sm" style={{ width: 78, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{timeLabel}</span>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <span style={{ flex: 1, fontWeight: 600, fontSize: '0.88rem', textDecoration: done ? 'line-through' : 'none', opacity: done ? 0.6 : 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</span>
      {isTask(item) && <span className="label-sm" style={{ color: item.overdue ? 'var(--primary)' : 'var(--on-surface-variant)', fontSize: '0.68rem', fontWeight: 700 }}>{item.overdue ? 'просрочено' : 'задача'}</span>}
      {isEvent(item) && item.location && <span className="label-sm" style={{ fontSize: '0.68rem' }}>📍 {item.location}</span>}
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
  const canComplete = task.status !== 'done' && task.status !== 'cancelled';

  const complete = async () => {
    setBusy(true);
    try {
      await api.post(`/tasks/${task.taskId}/submit`);
      onClose(true);
    } catch (e: unknown) {
      const a = e as { response?: { data?: { message?: string } } };
      setError(a.response?.data?.message || 'Не получилось отметить выполнение');
      setBusy(false);
    }
  };

  return (
    <div onClick={() => onClose(false)} style={{ position: 'fixed', inset: 0, zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', background: 'rgba(56,57,45,0.28)', backdropFilter: 'blur(3px)' }}>
      <div onClick={(e) => e.stopPropagation()} className="card-elevated" style={{ width: '100%', maxWidth: 420, padding: 'var(--spacing-6)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 'var(--spacing-3)' }}>
          <h3 className="title-md" style={{ flex: 1 }}>{task.title}</h3>
          <button onClick={() => onClose(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1rem', color: 'var(--on-surface-variant)' }}>✕</button>
        </div>
        <div style={{ display: 'flex', gap: 'var(--spacing-3)', flexWrap: 'wrap', marginBottom: 'var(--spacing-4)' }}>
          <span className="label-sm" style={{ color: st.color, fontWeight: 700 }}>{st.icon} {st.label}</span>
          <span className="label-sm" style={{ color: task.overdue ? 'var(--primary)' : 'var(--on-surface-variant)' }}>⏰ {new Date(task.dueDate).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: task.allDay ? undefined : '2-digit', minute: task.allDay ? undefined : '2-digit' })}{task.overdue ? ' · просрочено' : ''}</span>
          {task.coinReward ? <span className="label-sm" style={{ color: 'var(--tertiary)' }}>🪙 {task.coinReward}</span> : null}
        </div>
        {error && <p className="label-sm" style={{ color: 'var(--primary)', marginBottom: 'var(--spacing-3)' }}>{error}</p>}
        <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end' }}>
          <Link href={`/tasks/${task.taskId}`} className="btn-secondary" style={{ padding: '0.5rem 1.2rem', fontSize: '0.85rem' }}>Открыть задачу</Link>
          {canComplete && <button onClick={complete} disabled={busy} className="btn-primary" style={{ padding: '0.5rem 1.4rem', fontSize: '0.85rem', opacity: busy ? 0.6 : 1 }}>{busy ? '…' : '✓ Выполнено'}</button>}
        </div>
      </div>
    </div>
  );
}


function RecurrenceScopeDialog({ onPick, onCancel }: { onPick: (scope: 'this' | 'all') => void; onCancel: () => void }) {
  return (
    <div onClick={onCancel} style={{ position: 'fixed', inset: 0, zIndex: 110, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', background: 'rgba(56,57,45,0.28)', backdropFilter: 'blur(3px)' }}>
      <div onClick={(e) => e.stopPropagation()} className="card-elevated" style={{ width: '100%', maxWidth: 380, padding: 'var(--spacing-6)', textAlign: 'center' }}>
        <h3 className="title-md" style={{ marginBottom: 'var(--spacing-2)' }}>Повторяющееся событие</h3>
        <p className="label-md" style={{ marginBottom: 'var(--spacing-5)' }}>Изменить только это вхождение или всю серию?</p>
        <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'center', flexWrap: 'wrap' }}>
          <button onClick={() => onPick('this')} className="btn-secondary" style={{ padding: '0.5rem 1.2rem', fontSize: '0.85rem' }}>Только это</button>
          <button onClick={() => onPick('all')} className="btn-primary" style={{ padding: '0.5rem 1.2rem', fontSize: '0.85rem' }}>Вся серия</button>
        </div>
        <button onClick={onCancel} style={{ marginTop: 'var(--spacing-4)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--on-surface-variant)', fontSize: '0.8rem' }}>Отмена</button>
      </div>
    </div>
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
  const id = isEvent(item) ? `${item.eventId}-${item.occurrenceStart}` : item.taskId;
  return `${id}-${idx}`;
}

const navBtn: React.CSSProperties = { padding: '0.4rem 1rem', fontSize: '0.8rem' };
const navArrow: React.CSSProperties = { width: 34, height: 34, borderRadius: 'var(--radius-sm)', border: 'none', background: 'var(--surface-container)', cursor: 'pointer', fontSize: '1.1rem', color: 'var(--on-surface)' };

function pill(active: boolean): React.CSSProperties {
  return { padding: '0.35rem 0.9rem', fontSize: '0.82rem', borderRadius: 'var(--radius-sketch)', border: 'none', cursor: 'pointer', fontWeight: 600, background: active ? 'var(--surface-container-lowest)' : 'var(--surface-container)', color: active ? 'var(--on-surface)' : 'var(--on-surface-variant)', boxShadow: active ? '0 2px 12px rgba(56,57,45,0.08)' : 'none' };
}

function layerChip(active: boolean, color: string): React.CSSProperties {
  return { padding: '0.35rem 0.8rem', fontSize: '0.78rem', borderRadius: 'var(--radius-sketch)', border: 'none', cursor: 'pointer', fontWeight: 600, background: active ? color + '22' : 'var(--surface-container)', color: active ? color : 'var(--on-surface-variant)', opacity: active ? 1 : 0.6 };
}
