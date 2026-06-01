'use client';

import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api';
import {
  CALENDAR_RECURRENCE_PRESETS,
  CALENDAR_REMINDER_PRESETS,
  CALENDAR_EVENT_COLORS,
  DEFAULT_EVENT_COLOR,
  DEFAULT_REMINDER_OFFSETS,
  EVENT_VISIBILITY_OPTIONS,
  RSVP_META,
  RESOURCE_BOOKING_STATUS_META,
  type CalendarEventOccurrence,
  type CalendarEventDetail,
  type CalendarEventVisibility,
  type RecurrenceEditScope,
  type RsvpStatus,
  type Contact,
  type Circle,
  type Resource,
} from '@superapp/shared';
import { toInputValue, fromInputValue, startOfDay, endOfDay } from './calendar-lib';
import { ShareCardModal } from '../messenger/ShareCardModal';

export type ModalTarget =
  | { mode: 'create'; start: Date; allDay: boolean; participantUserIds?: string[] }
  | { mode: 'event'; occurrence: CalendarEventOccurrence };

export function EventModal({
  target,
  meId,
  contacts,
  circles,
  resources,
  onClose,
}: {
  target: ModalTarget;
  meId: string;
  contacts: Contact[];
  circles: Circle[];
  resources: Resource[];
  onClose: (changed: boolean) => void;
}) {
  const creating = target.mode === 'create';
  const occ = target.mode === 'event' ? target.occurrence : null;
  const eventId = occ?.eventId ?? null;
  const isSeries = !!occ?.recurring;

  const [detail, setDetail] = useState<CalendarEventDetail | null>(null);
  const [loading, setLoading] = useState(!creating);
  const [busyAction, setBusyAction] = useState(false);
  const [error, setError] = useState('');
  const [changed, setChanged] = useState(false); // any server mutation happened

  // form fields
  const initStart = creating ? target.start : new Date(occ!.start);
  const initEnd = creating ? new Date(+target.start + 3_600_000) : new Date(occ!.end);
  const initAllDay = creating ? target.allDay : occ!.allDay;
  const [title, setTitle] = useState(occ?.title ?? '');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState(occ?.location ?? '');
  const [allDay, setAllDay] = useState(initAllDay);
  const [startInput, setStartInput] = useState(toInputValue(initStart, initAllDay));
  const [endInput, setEndInput] = useState(toInputValue(initEnd, initAllDay));
  const [color, setColor] = useState(occ?.color ?? DEFAULT_EVENT_COLOR);
  const [recurrence, setRecurrence] = useState<string | null>(occ?.recurrenceRule ?? null);
  const [reminders, setReminders] = useState<number[]>(
    occ?.reminderOffsets ?? [...DEFAULT_REMINDER_OFFSETS],
  );
  const [visibility, setVisibility] = useState<CalendarEventVisibility>(occ?.visibility ?? 'inherit');
  const [scope, setScope] = useState<RecurrenceEditScope>('all');
  const [resourceId, setResourceId] = useState<string | null>(occ?.resourceId ?? null);
  const [initialResourceId, setInitialResourceId] = useState<string | null>(occ?.resourceId ?? null);
  // participant picker (create mode accumulates; edit mode invites immediately)
  const [pendingUserIds, setPendingUserIds] = useState<string[]>(
    target.mode === 'create' ? target.participantUserIds ?? [] : [],
  );
  const [pendingCircleId, setPendingCircleId] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [showForward, setShowForward] = useState(false);

  const isOrganizer = creating || !!detail?.isOrganizer;
  const myRsvp = detail?.myRsvp ?? null;
  const isParticipant = !creating && !isOrganizer && myRsvp !== null;
  const canEdit = isOrganizer;

  const loadDetail = useCallback(async () => {
    if (creating || !eventId) return;
    setLoading(true);
    try {
      const { data } = await api.get(`/calendar/events/${eventId}`);
      const d: CalendarEventDetail = data.data;
      setDetail(d);
      setTitle(d.title);
      setDescription(d.description ?? '');
      setLocation(d.location ?? '');
      setAllDay(d.allDay);
      setStartInput(toInputValue(new Date(d.startTime), d.allDay));
      setEndInput(toInputValue(new Date(d.endTime), d.allDay));
      setColor(d.color ?? DEFAULT_EVENT_COLOR);
      setRecurrence(d.recurrenceRule);
      setReminders(d.reminderOffsets);
      setVisibility(d.visibility);
      setResourceId(d.resourceId);
      setInitialResourceId(d.resourceId);
      setError('');
    } catch (e: unknown) {
      const a = e as { response?: { data?: { message?: string } } };
      setError(a.response?.data?.message || 'Не удалось загрузить событие');
    } finally {
      setLoading(false);
    }
  }, [creating, eventId]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  const close = () => onClose(changed);

  const toggleAllDay = () => {
    const s = fromInputValue(startInput, allDay);
    const en = fromInputValue(endInput, allDay);
    const next = !allDay;
    setAllDay(next);
    setStartInput(toInputValue(isNaN(+s) ? new Date() : s, next));
    setEndInput(toInputValue(isNaN(+en) ? new Date() : en, next));
  };

  const toggleReminder = (m: number) =>
    setReminders((cur) => (cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m].sort((a, b) => b - a)));

  const buildTimes = () => {
    let s = fromInputValue(startInput, allDay);
    let en = fromInputValue(endInput, allDay);
    if (allDay) {
      s = startOfDay(s);
      en = endOfDay(en < s ? s : en);
    } else if (en <= s) {
      en = new Date(+s + 3_600_000);
    }
    return { s, en };
  };

  const save = async () => {
    if (!title.trim()) {
      setError('Введите название');
      return;
    }
    setBusyAction(true);
    setError('');
    const { s, en } = buildTimes();
    try {
      if (creating) {
        const payload: Record<string, unknown> = {
          title: title.trim(), startTime: s.toISOString(), endTime: en.toISOString(),
          allDay, color, visibility, reminderOffsets: reminders,
        };
        if (description.trim()) payload.description = description.trim();
        if (location.trim()) payload.location = location.trim();
        if (recurrence) payload.recurrenceRule = recurrence;
        if (pendingUserIds.length) payload.participantUserIds = pendingUserIds;
        if (pendingCircleId) payload.participantCircleId = pendingCircleId;
        if (resourceId) payload.resourceId = resourceId;
        await api.post('/calendar/events', payload);
      } else {
        const payload: Record<string, unknown> = {
          title: title.trim(), description: description.trim() || null, location: location.trim() || null,
          startTime: s.toISOString(), endTime: en.toISOString(), allDay, color, visibility, reminderOffsets: reminders,
        };
        if (isSeries) { payload.editScope = scope; payload.occurrenceStart = occ!.occurrenceStart; }
        else { payload.recurrenceRule = recurrence; payload.editScope = 'all'; }
        if (resourceId !== initialResourceId) payload.resourceId = resourceId;
        await api.patch(`/calendar/events/${eventId}`, payload);
      }
      onClose(true);
    } catch (e: unknown) {
      const a = e as { response?: { data?: { message?: string } } };
      setError(a.response?.data?.message || 'Не удалось сохранить');
      setBusyAction(false);
    }
  };

  const remove = async () => {
    if (!eventId) return;
    setBusyAction(true);
    try {
      const params: Record<string, string> = {};
      if (isSeries) { params.editScope = scope; params.occurrenceStart = occ!.occurrenceStart; }
      await api.delete(`/calendar/events/${eventId}`, { params });
      onClose(true);
    } catch {
      setError('Не удалось удалить');
      setBusyAction(false);
    }
  };

  const doRsvp = async (status: RsvpStatus) => {
    if (!eventId) return;
    setBusyAction(true);
    try {
      await api.post(`/calendar/events/${eventId}/rsvp`, { status });
      setChanged(true);
      await loadDetail();
    } catch {
      setError('Не удалось ответить');
    } finally {
      setBusyAction(false);
    }
  };

  const saveMyReminders = async () => {
    if (!eventId) return;
    setBusyAction(true);
    try {
      await api.post(`/calendar/events/${eventId}/reminders`, { offsets: reminders });
      setChanged(true);
    } catch {
      setError('Не удалось сохранить напоминания');
    } finally {
      setBusyAction(false);
    }
  };

  const inviteNow = async (userIds: string[], circleId: string | null) => {
    if (!eventId) return;
    setBusyAction(true);
    try {
      await api.post(`/calendar/events/${eventId}/participants`, circleId ? { circleId } : { userIds });
      setChanged(true);
      setShowInvite(false);
      await loadDetail();
    } catch (e: unknown) {
      const a = e as { response?: { data?: { message?: string } } };
      setError(a.response?.data?.message || 'Не удалось пригласить');
    } finally {
      setBusyAction(false);
    }
  };

  const removeParticipant = async (uid: string) => {
    if (!eventId) return;
    setBusyAction(true);
    try {
      await api.delete(`/calendar/events/${eventId}/participants/${uid}`);
      setChanged(true);
      await loadDetail();
    } catch {
      setError('Не удалось убрать участника');
    } finally {
      setBusyAction(false);
    }
  };

  const bookingAction = async (action: 'confirm' | 'reject') => {
    if (!eventId) return;
    setBusyAction(true);
    try {
      await api.post(`/resources/bookings/${eventId}/${action}`);
      setChanged(true);
      await loadDetail();
    } catch {
      setError('Не удалось обработать бронь');
    } finally {
      setBusyAction(false);
    }
  };

  const participants = detail?.participants ?? [];
  const bookable = resources.filter((r) => r.canBook || r.id === resourceId);

  return (
    <div onClick={close} style={overlay}>
      <div onClick={(e) => e.stopPropagation()} className="card-elevated" style={{ width: '100%', maxWidth: 560, padding: 'var(--spacing-6)', maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-4)' }}>
          <h3 className="title-md">{creating ? 'Новое событие' : canEdit ? 'Событие' : 'Приглашение'}</h3>
          <button onClick={close} style={iconBtn}>✕</button>
        </div>

        {error && <div className="wash-primary" style={{ padding: 'var(--spacing-2) var(--spacing-3)', marginBottom: 'var(--spacing-3)', color: 'var(--primary)', fontSize: '0.8rem' }}>{error}</div>}

        {loading ? (
          <p className="label-md" style={{ padding: 'var(--spacing-6)', textAlign: 'center' }}>Загрузка…</p>
        ) : canEdit ? (
          <>
            <input autoFocus type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Название события" className="input-sketch" style={{ fontSize: '1.05rem', fontWeight: 600, marginBottom: 'var(--spacing-4)' }} />

            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-2)' }}>
              <label className="label-md">Когда</label>
              <button type="button" onClick={toggleAllDay} style={linkBtn}>{allDay ? '🕒 со временем' : '📅 весь день'}</button>
            </div>
            <div style={{ display: 'flex', gap: 'var(--spacing-3)', flexWrap: 'wrap', marginBottom: 'var(--spacing-4)' }}>
              <input type={allDay ? 'date' : 'datetime-local'} value={startInput} onChange={(e) => setStartInput(e.target.value)} className="input-sketch" style={{ flex: 1, minWidth: 170 }} />
              <span style={{ alignSelf: 'center', color: 'var(--on-surface-variant)' }}>→</span>
              <input type={allDay ? 'date' : 'datetime-local'} value={endInput} onChange={(e) => setEndInput(e.target.value)} className="input-sketch" style={{ flex: 1, minWidth: 170 }} />
            </div>

            {!isSeries && (
              <div style={{ marginBottom: 'var(--spacing-4)' }}>
                <label className="label-md" style={lblBlock}>Повтор</label>
                <select className="input-sketch" value={recurrence ?? ''} onChange={(e) => { const v = e.target.value || null; setRecurrence(v); if (v) setResourceId(null); }}>
                  {CALENDAR_RECURRENCE_PRESETS.map((r) => <option key={r.label} value={r.rule ?? ''}>{r.label}</option>)}
                </select>
              </div>
            )}
            {isSeries && (
              <div className="wash-secondary" style={{ padding: 'var(--spacing-3)', marginBottom: 'var(--spacing-4)' }}>
                <label className="label-md" style={{ ...lblBlock, color: 'var(--secondary)' }}>Применить к:</label>
                <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
                  {([['this', 'Только это'], ['this_and_following', 'Это и следующие'], ['all', 'Вся серия']] as [RecurrenceEditScope, string][]).map(([v, l]) => (
                    <button key={v} type="button" onClick={() => setScope(v)} style={chip(scope === v)}>{l}</button>
                  ))}
                </div>
              </div>
            )}

            {/* Resource booking — non-recurring events only */}
            {!isSeries && !recurrence && (bookable.length > 0 || resourceId) && (
              <div style={{ marginBottom: 'var(--spacing-4)' }}>
                <label className="label-md" style={lblBlock}>Ресурс</label>
                <select className="input-sketch" value={resourceId ?? ''} onChange={(e) => setResourceId(e.target.value || null)}>
                  <option value="">— без ресурса —</option>
                  {bookable.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
                {detail?.resourceStatus && (
                  <p className="label-sm" style={{ marginTop: 4, color: RESOURCE_BOOKING_STATUS_META[detail.resourceStatus].color, fontWeight: 600 }}>
                    Бронь: {RESOURCE_BOOKING_STATUS_META[detail.resourceStatus].label}
                  </p>
                )}
                {detail?.isResourceOwner && detail.resourceStatus === 'pending' && (
                  <div style={{ display: 'flex', gap: 'var(--spacing-2)', marginTop: 'var(--spacing-2)' }}>
                    <button onClick={() => bookingAction('confirm')} disabled={busyAction} className="btn-primary" style={{ padding: '0.35rem 0.9rem', fontSize: '0.8rem' }}>Подтвердить</button>
                    <button onClick={() => bookingAction('reject')} disabled={busyAction} style={{ ...chip(false), color: 'var(--primary)' }}>Отклонить</button>
                  </div>
                )}
              </div>
            )}

            {/* Participants */}
            <label className="label-md" style={lblBlock}>Участники</label>
            <ParticipantBlocks participants={participants} pendingIds={creating ? pendingUserIds : []} contacts={contacts} canManage onRemove={creating ? undefined : removeParticipant} />
            <div style={{ marginTop: 'var(--spacing-2)', marginBottom: 'var(--spacing-4)' }}>
              <button type="button" onClick={() => setShowInvite((v) => !v)} style={chip(showInvite)}>+ Позвать</button>
              {showInvite && (
                <InvitePicker
                  contacts={contacts} circles={circles}
                  onPick={(userIds, circleId) => {
                    if (creating) { setPendingUserIds((c) => [...new Set([...c, ...userIds])]); setPendingCircleId(circleId); setShowInvite(false); }
                    else inviteNow(userIds, circleId);
                  }}
                />
              )}
            </div>

            <label className="label-md" style={lblBlock}>Мои напоминания</label>
            <div style={{ display: 'flex', gap: 'var(--spacing-1)', flexWrap: 'wrap', marginBottom: 'var(--spacing-4)' }}>
              {CALENDAR_REMINDER_PRESETS.map((r) => <button key={r.minutesBefore} type="button" onClick={() => toggleReminder(r.minutesBefore)} style={chip(reminders.includes(r.minutesBefore))}>{r.label}</button>)}
            </div>

            <label className="label-md" style={lblBlock}>Цвет</label>
            <div style={{ display: 'flex', gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-4)' }}>
              {CALENDAR_EVENT_COLORS.map((c) => (
                <button key={c.value} type="button" title={c.name} onClick={() => setColor(c.value)} style={{ width: 26, height: 26, borderRadius: '0.4rem 0.6rem 0.5rem 0.55rem', cursor: 'pointer', background: c.value, border: 'none', boxShadow: color === c.value ? `0 0 0 2px var(--surface-container-lowest), 0 0 0 4px ${c.value}` : 'none' }} />
              ))}
            </div>

            <input type="text" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="📍 Место (необязательно)" className="input-sketch" style={{ marginBottom: 'var(--spacing-3)' }} />
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Заметки (необязательно)" rows={2} className="input-sketch" style={{ resize: 'vertical', marginBottom: 'var(--spacing-4)' }} />

            <label className="label-md" style={lblBlock}>Приватность</label>
            <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap', marginBottom: 'var(--spacing-5)' }}>
              {EVENT_VISIBILITY_OPTIONS.map((v) => <button key={v.value} type="button" onClick={() => setVisibility(v.value)} title={v.hint} style={chip(visibility === v.value)}>{v.label}</button>)}
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--spacing-3)' }}>
              <div style={{ display: 'flex', gap: 'var(--spacing-3)', alignItems: 'center' }}>
                {!creating && <button onClick={remove} disabled={busyAction} style={{ ...linkBtn, color: 'var(--primary)', fontWeight: 700 }}>Удалить</button>}
                {!creating && eventId && <button onClick={() => setShowForward(true)} style={{ ...linkBtn, color: 'var(--secondary)', fontWeight: 700 }}>↗ Переслать в чат</button>}
              </div>
              <div style={{ display: 'flex', gap: 'var(--spacing-3)' }}>
                <button onClick={close} className="btn-secondary" style={smallBtn}>Отмена</button>
                <button onClick={save} disabled={busyAction} className="btn-primary" style={{ ...smallBtn, opacity: busyAction ? 0.6 : 1 }}>{busyAction ? '…' : 'Сохранить'}</button>
              </div>
            </div>
          </>
        ) : (
          /* Respond / view mode (not organizer) */
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-2)' }}>
              <span style={{ width: 12, height: 12, borderRadius: '50%', background: detail?.color ?? DEFAULT_EVENT_COLOR }} />
              <h2 className="title-md" style={{ fontFamily: 'var(--font-display)' }}>{detail?.title}</h2>
            </div>
            <p className="label-md" style={{ marginBottom: 'var(--spacing-1)' }}>{whenLabel(detail)}</p>
            {occ?.ownerName && <p className="label-sm">Организатор: {occ.ownerName}</p>}
            {detail?.location && <p className="label-sm" style={{ marginTop: 'var(--spacing-1)' }}>📍 {detail.location}</p>}
            {occ?.resourceName && <p className="label-sm" style={{ marginTop: 'var(--spacing-1)' }}>📦 {occ.resourceName}{occ.resourceStatus ? ` · ${RESOURCE_BOOKING_STATUS_META[occ.resourceStatus].label}` : ''}</p>}
            {detail?.description && <p className="label-md" style={{ marginTop: 'var(--spacing-2)' }}>{detail.description}</p>}

            <div style={{ margin: 'var(--spacing-4) 0' }}>
              <ParticipantBlocks participants={participants} pendingIds={[]} contacts={contacts} canManage={false} />
            </div>

            {isParticipant && (
              <>
                <label className="label-md" style={lblBlock}>Ваш ответ</label>
                <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap', marginBottom: 'var(--spacing-4)' }}>
                  {(['accepted', 'tentative', 'declined'] as RsvpStatus[]).map((s) => (
                    <button key={s} onClick={() => doRsvp(s)} disabled={busyAction}
                      style={{ ...chip(myRsvp === s), background: myRsvp === s ? RSVP_META[s].color : 'var(--surface-container)', color: myRsvp === s ? '#fff' : 'var(--on-surface-variant)', padding: '0.4rem 0.9rem' }}>
                      {RSVP_META[s].icon} {RSVP_META[s].label}
                    </button>
                  ))}
                </div>

                <label className="label-md" style={lblBlock}>Мои напоминания</label>
                <div style={{ display: 'flex', gap: 'var(--spacing-1)', flexWrap: 'wrap', marginBottom: 'var(--spacing-3)' }}>
                  {CALENDAR_REMINDER_PRESETS.map((r) => <button key={r.minutesBefore} type="button" onClick={() => toggleReminder(r.minutesBefore)} style={chip(reminders.includes(r.minutesBefore))}>{r.label}</button>)}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--spacing-3)' }}>
                  {eventId ? <button onClick={() => setShowForward(true)} style={{ ...linkBtn, color: 'var(--secondary)', fontWeight: 700 }}>↗ Переслать в чат</button> : <span />}
                  <div style={{ display: 'flex', gap: 'var(--spacing-3)' }}>
                    <button onClick={() => removeParticipant(meId)} disabled={busyAction} style={{ ...linkBtn, color: 'var(--primary)' }}>Убрать из календаря</button>
                    <button onClick={saveMyReminders} disabled={busyAction} className="btn-secondary" style={smallBtn}>Сохранить напоминания</button>
                  </div>
                </div>
              </>
            )}
            {!isParticipant && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                {eventId ? <button onClick={() => setShowForward(true)} style={{ ...linkBtn, color: 'var(--secondary)', fontWeight: 700 }}>↗ Переслать в чат</button> : <span />}
                <button onClick={close} className="btn-secondary" style={smallBtn}>Закрыть</button>
              </div>
            )}
          </>
        )}
      </div>

      {showForward && eventId && (
        <ShareCardModal
          refType="event"
          refId={eventId}
          title={detail?.title || title || occ?.title || 'Событие'}
          onClose={() => setShowForward(false)}
        />
      )}
    </div>
  );
}

// ---- Participant RSVP blocks ----

function ParticipantBlocks({
  participants, pendingIds, contacts, canManage, onRemove,
}: {
  participants: CalendarEventDetail['participants'];
  pendingIds: string[];
  contacts: Contact[];
  canManage: boolean;
  onRemove?: (uid: string) => void;
}) {
  const pendingPeople = pendingIds.map((id) => {
    const c = contacts.find((x) => x.them.id === id);
    return { userId: id, firstName: c?.them.firstName ?? '?', lastName: c?.them.lastName ?? null, rsvp: 'pending' as RsvpStatus };
  });
  const all = [...participants, ...pendingPeople];
  if (all.length === 0) return <p className="label-sm">Пока никого</p>;

  const groups: RsvpStatus[] = ['accepted', 'tentative', 'pending', 'declined'];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
      {groups.map((g) => {
        const list = all.filter((p) => p.rsvp === g);
        if (!list.length) return null;
        return (
          <div key={g} style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
            <span className="label-sm" style={{ color: RSVP_META[g].color, fontWeight: 700, minWidth: 92 }}>{RSVP_META[g].icon} {RSVP_META[g].group}</span>
            {list.map((p) => (
              <span key={p.userId} title={`${p.firstName} ${p.lastName ?? ''}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'var(--surface-container)', borderRadius: 'var(--radius-sketch)', padding: '0.15rem 0.5rem', fontSize: '0.78rem' }}>
                <span style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--secondary-container)', color: 'var(--secondary)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.62rem', fontWeight: 700 }}>{(p.firstName[0] ?? '?').toUpperCase()}</span>
                {p.firstName}
                {canManage && onRemove && <button onClick={() => onRemove(p.userId)} title="Убрать" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--on-surface-variant)', fontSize: '0.7rem' }}>✕</button>}
              </span>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ---- Invite picker (people + groups) ----

function InvitePicker({
  contacts, circles, onPick,
}: {
  contacts: Contact[];
  circles: Circle[];
  onPick: (userIds: string[], circleId: string | null) => void;
}) {
  const [sel, setSel] = useState<string[]>([]);
  return (
    <div className="card" style={{ marginTop: 'var(--spacing-2)', padding: 'var(--spacing-3)' }}>
      {circles.length > 0 && (
        <>
          <label className="label-sm" style={lblBlock}>Группой</label>
          <div style={{ display: 'flex', gap: 'var(--spacing-1)', flexWrap: 'wrap', marginBottom: 'var(--spacing-3)' }}>
            {circles.map((c) => <button key={c.id} type="button" onClick={() => onPick([], c.id)} style={chip(false)}>{c.name} <span style={{ opacity: 0.6 }}>{c.membersCount}</span></button>)}
          </div>
        </>
      )}
      <label className="label-sm" style={lblBlock}>Людьми</label>
      {contacts.length === 0 ? <p className="label-sm">В окружении пока никого</p> : (
        <div style={{ display: 'flex', gap: 'var(--spacing-1)', flexWrap: 'wrap', marginBottom: 'var(--spacing-3)' }}>
          {contacts.map((c) => {
            const on = sel.includes(c.them.id);
            return <button key={c.linkId} type="button" onClick={() => setSel((cur) => on ? cur.filter((x) => x !== c.them.id) : [...cur, c.them.id])} style={chip(on)}>{c.them.firstName} {c.them.lastName ?? ''}</button>;
          })}
        </div>
      )}
      {sel.length > 0 && <button type="button" onClick={() => onPick(sel, null)} className="btn-primary" style={{ ...smallBtn, fontSize: '0.8rem' }}>Добавить ({sel.length})</button>}
    </div>
  );
}

function whenLabel(d: CalendarEventDetail | null): string {
  if (!d) return '';
  const s = new Date(d.startTime);
  const opts: Intl.DateTimeFormatOptions = d.allDay
    ? { day: 'numeric', month: 'long', weekday: 'long' }
    : { day: 'numeric', month: 'long', weekday: 'long', hour: '2-digit', minute: '2-digit' };
  return s.toLocaleDateString('ru-RU', opts);
}

const overlay: React.CSSProperties = { position: 'fixed', inset: 0, zIndex: 100, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '5vh 1rem', background: 'rgba(56,57,45,0.28)', backdropFilter: 'blur(3px)', overflowY: 'auto' };
const iconBtn: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', fontSize: '1rem', color: 'var(--on-surface-variant)' };
const linkBtn: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.8rem', color: 'var(--secondary)', fontWeight: 600 };
const lblBlock: React.CSSProperties = { display: 'block', marginBottom: 'var(--spacing-2)' };
const smallBtn: React.CSSProperties = { padding: '0.5rem 1.3rem', fontSize: '0.85rem' };

function chip(active: boolean): React.CSSProperties {
  return { padding: '0.3rem 0.7rem', fontSize: '0.78rem', borderRadius: 'var(--radius-sketch)', border: 'none', cursor: 'pointer', fontWeight: 600, background: active ? 'var(--secondary-container)' : 'var(--surface-container)', color: active ? 'var(--secondary)' : 'var(--on-surface-variant)' };
}
