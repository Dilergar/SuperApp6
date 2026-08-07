'use client';

import { useState, useEffect, useCallback } from 'react';
import { apiDelete, apiErrorMessage, apiGet, apiPatch, apiPost } from '@/lib/api';
import { EntitySelector } from '@/components/EntitySelector';
import type { Principal } from '@/lib/entities';
import { PersonChip } from '../circles/PersonCard';
import {
  Alert, Button, Card, Chip, Field, Glyph, GlyphField, Icon, IconButton, Input, LoadingBlock, Modal,
  SegmentedControl, Select, Textarea, type Tone,
} from '@/components/ui';
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
  type ResourceBookingStatus,
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

/** Тон статуса RSVP/брони — цвет берём из системы, а не из хардкода констант. */
const RSVP_TONE: Record<RsvpStatus, Tone> = {
  pending: 'waiting',   // ещё не ответил — ждём человека
  accepted: 'success',
  declined: 'danger',
  tentative: 'warning',
};
const BOOKING_TONE: Record<ResourceBookingStatus, Tone> = {
  pending: 'waiting',   // заявка ушла владельцу ресурса — ждём решения
  confirmed: 'success',
  rejected: 'danger',
};

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
  const [icon, setIcon] = useState<string | null>(occ?.icon ?? null);
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
      const d = await apiGet<CalendarEventDetail>(`/calendar/events/${eventId}`);
      setDetail(d);
      setTitle(d.title);
      setDescription(d.description ?? '');
      setLocation(d.location ?? '');
      setAllDay(d.allDay);
      setStartInput(toInputValue(new Date(d.startTime), d.allDay));
      setEndInput(toInputValue(new Date(d.endTime), d.allDay));
      setColor(d.color ?? DEFAULT_EVENT_COLOR);
      setIcon(d.icon ?? null);
      setRecurrence(d.recurrenceRule);
      setReminders(d.reminderOffsets);
      setVisibility(d.visibility);
      setResourceId(d.resourceId);
      setInitialResourceId(d.resourceId);
      setError('');
    } catch (e) {
      setError(apiErrorMessage(e));
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
        if (icon) payload.icon = icon;
        if (description.trim()) payload.description = description.trim();
        if (location.trim()) payload.location = location.trim();
        if (recurrence) payload.recurrenceRule = recurrence;
        if (pendingUserIds.length) payload.participantUserIds = pendingUserIds;
        if (pendingCircleId) payload.participantCircleId = pendingCircleId;
        if (resourceId) payload.resourceId = resourceId;
        await apiPost('/calendar/events', payload);
      } else {
        const payload: Record<string, unknown> = {
          title: title.trim(), description: description.trim() || null, location: location.trim() || null,
          startTime: s.toISOString(), endTime: en.toISOString(), allDay, color, icon, visibility, reminderOffsets: reminders,
        };
        if (isSeries) { payload.editScope = scope; payload.occurrenceStart = occ!.occurrenceStart; }
        else { payload.recurrenceRule = recurrence; payload.editScope = 'all'; }
        if (resourceId !== initialResourceId) payload.resourceId = resourceId;
        await apiPatch(`/calendar/events/${eventId}`, payload);
      }
      onClose(true);
    } catch (e) {
      setError(apiErrorMessage(e));
      setBusyAction(false);
    }
  };

  const remove = async () => {
    if (!eventId) return;
    setBusyAction(true);
    try {
      const params: Record<string, string> = {};
      if (isSeries) { params.editScope = scope; params.occurrenceStart = occ!.occurrenceStart; }
      await apiDelete(`/calendar/events/${eventId}`, { params });
      onClose(true);
    } catch (e) {
      setError(apiErrorMessage(e));
      setBusyAction(false);
    }
  };

  const doRsvp = async (status: RsvpStatus) => {
    if (!eventId) return;
    setBusyAction(true);
    try {
      await apiPost(`/calendar/events/${eventId}/rsvp`, { status });
      setChanged(true);
      await loadDetail();
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusyAction(false);
    }
  };

  const saveMyReminders = async () => {
    if (!eventId) return;
    setBusyAction(true);
    try {
      await apiPost(`/calendar/events/${eventId}/reminders`, { offsets: reminders });
      setChanged(true);
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusyAction(false);
    }
  };

  const inviteNow = async (userIds: string[], circleId: string | null) => {
    if (!eventId) return;
    setBusyAction(true);
    try {
      await apiPost(`/calendar/events/${eventId}/participants`, circleId ? { circleId } : { userIds });
      setChanged(true);
      setShowInvite(false);
      await loadDetail();
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusyAction(false);
    }
  };

  const removeParticipant = async (uid: string) => {
    if (!eventId) return;
    setBusyAction(true);
    try {
      await apiDelete(`/calendar/events/${eventId}/participants/${uid}`);
      setChanged(true);
      await loadDetail();
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusyAction(false);
    }
  };

  const bookingAction = async (action: 'confirm' | 'reject') => {
    if (!eventId) return;
    setBusyAction(true);
    try {
      await apiPost(`/resources/bookings/${eventId}/${action}`);
      setChanged(true);
      await loadDetail();
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusyAction(false);
    }
  };

  const participants = detail?.participants ?? [];
  const bookable = resources.filter((r) => r.canBook || r.id === resourceId);

  const footer = loading ? undefined : canEdit ? (
    <>
      {!creating && (
        <Button variant="ghost" tone="danger" icon="delete" disabled={busyAction} onClick={remove}>Удалить</Button>
      )}
      {!creating && eventId && (
        <Button variant="ghost" icon="share" onClick={() => setShowForward(true)}>В чат</Button>
      )}
      <Button variant="ghost" onClick={close}>Отмена</Button>
      <Button variant="primary" tone="success" icon="save" loading={busyAction} onClick={save}>Сохранить</Button>
    </>
  ) : isParticipant ? (
    <>
      {eventId && <Button variant="ghost" icon="share" onClick={() => setShowForward(true)}>В чат</Button>}
      <Button variant="ghost" tone="danger" icon="close" disabled={busyAction} onClick={() => removeParticipant(meId)}>
        Убрать из календаря
      </Button>
      <Button variant="primary" tone="success" icon="save" loading={busyAction} onClick={saveMyReminders}>
        Сохранить напоминания
      </Button>
    </>
  ) : (
    <>
      {eventId && <Button variant="ghost" icon="share" onClick={() => setShowForward(true)}>В чат</Button>}
      <Button variant="ghost" onClick={close}>Закрыть</Button>
    </>
  );

  return (
    <>
      <Modal
        open
        onClose={close}
        title={creating ? 'Новое событие' : canEdit ? 'Событие' : 'Приглашение'}
        size="md"
        footer={footer}
      >
        {error && (
          <div style={{ marginBottom: 'var(--spacing-4)' }}>
            <Alert tone="danger" onClose={() => setError('')}>{error}</Alert>
          </div>
        )}

        {loading ? (
          <LoadingBlock />
        ) : canEdit ? (
          <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
            <div style={{ display: 'flex', gap: 'var(--spacing-3)', alignItems: 'flex-end' }}>
              {/* Значок — данные события: выбирает GlyphField, рисует Glyph (глиф-пак) */}
              <GlyphField label="Значок" value={icon} onChange={setIcon} suggest={title} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <Input
                  autoFocus
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Название события"
                  aria-label="Название события"
                  style={{ fontSize: '1.05rem', fontWeight: 600 }}
                />
              </div>
            </div>

            <Field label="Когда">
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 165 }}>
                  <Input
                    type={allDay ? 'date' : 'datetime-local'}
                    value={startInput}
                    onChange={(e) => setStartInput(e.target.value)}
                    aria-label="Начало"
                  />
                </div>
                <Icon name="arrowRight" size={15} style={{ color: 'var(--muted)' }} />
                <div style={{ flex: 1, minWidth: 165 }}>
                  <Input
                    type={allDay ? 'date' : 'datetime-local'}
                    value={endInput}
                    onChange={(e) => setEndInput(e.target.value)}
                    aria-label="Конец"
                  />
                </div>
                <Chip tone="accent" icon="clock" selected={allDay} onClick={toggleAllDay}>
                  весь день
                </Chip>
              </div>
            </Field>

            {!isSeries && (
              <Select
                label="Повтор"
                value={recurrence ?? ''}
                onChange={(v) => { const next = v || null; setRecurrence(next); if (next) setResourceId(null); }}
                options={CALENDAR_RECURRENCE_PRESETS.map((r) => ({
                  value: r.rule ?? '',
                  label: r.label,
                  icon: r.rule ? 'refresh' : undefined,
                }))}
              />
            )}
            {isSeries && (
              <Field label="Применить к" hint="Правка серии затрагивает и будущие вхождения">
                <SegmentedControl
                  aria-label="Область правки серии"
                  value={scope}
                  onChange={setScope}
                  items={[
                    { key: 'this', label: 'Только это' },
                    { key: 'this_and_following', label: 'Это и следующие' },
                    { key: 'all', label: 'Вся серия' },
                  ]}
                />
              </Field>
            )}

            {/* Бронь ресурса — только у разовых событий */}
            {!isSeries && !recurrence && (bookable.length > 0 || resourceId) && (
              <div>
                <Select
                  label="Ресурс"
                  value={resourceId ?? ''}
                  onChange={(v) => setResourceId(v || null)}
                  options={[
                    { value: '', label: 'Без ресурса' },
                    ...bookable.map((r) => ({ value: r.id, label: r.name, icon: 'folder' as const })),
                  ]}
                />
                {detail?.resourceStatus && (
                  <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                    <Chip size="sm" tone={BOOKING_TONE[detail.resourceStatus]}>
                      Бронь: {RESOURCE_BOOKING_STATUS_META[detail.resourceStatus].label}
                    </Chip>
                    {detail.isResourceOwner && detail.resourceStatus === 'pending' && (
                      <>
                        <Button variant="primary" tone="success" size="sm" icon="check" disabled={busyAction} onClick={() => bookingAction('confirm')}>
                          Подтвердить
                        </Button>
                        <Button variant="matte" tone="danger" size="sm" icon="close" disabled={busyAction} onClick={() => bookingAction('reject')}>
                          Отклонить
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Участники */}
            <Field label="Участники">
              <ParticipantBlocks
                participants={participants}
                pendingIds={creating ? pendingUserIds : []}
                contacts={contacts}
                canManage
                onRemove={creating ? undefined : removeParticipant}
              />
              <div style={{ marginTop: 'var(--spacing-2)' }}>
                <Button variant="ghost" size="sm" icon="userAdd" onClick={() => setShowInvite((v) => !v)}>
                  {showInvite ? 'Скрыть' : 'Позвать'}
                </Button>
                {showInvite && (
                  <InvitePicker
                    contacts={contacts}
                    circles={circles}
                    onPick={(userIds, circleId) => {
                      if (creating) {
                        setPendingUserIds((c) => [...new Set([...c, ...userIds])]);
                        setPendingCircleId(circleId);
                        setShowInvite(false);
                      } else inviteNow(userIds, circleId);
                    }}
                  />
                )}
              </div>
            </Field>

            <Field label="Мои напоминания">
              <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
                {CALENDAR_REMINDER_PRESETS.map((r) => (
                  <Chip
                    key={r.minutesBefore}
                    size="sm"
                    tone="accent"
                    selected={reminders.includes(r.minutesBefore)}
                    onClick={() => toggleReminder(r.minutesBefore)}
                  >
                    {r.label}
                  </Chip>
                ))}
              </div>
            </Field>

            <ColorPicker value={color} onChange={setColor} />

            <Input label="Место" icon="location" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Необязательно" />
            <Textarea
              label="Заметки"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Необязательно"
              rows={2}
              style={{ resize: 'vertical' }}
            />

            <Field label="Приватность">
              <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
                {EVENT_VISIBILITY_OPTIONS.map((v) => (
                  <Chip
                    key={v.value}
                    size="sm"
                    tone="accent"
                    selected={visibility === v.value}
                    onClick={() => setVisibility(v.value)}
                    title={v.hint}
                  >
                    {v.label}
                  </Chip>
                ))}
              </div>
            </Field>
          </div>
        ) : (
          /* Режим ответа/просмотра (не организатор) */
          <div className="ui-stack" style={{ gap: 'var(--spacing-3)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              {detail?.icon ? (
                <Glyph value={detail.icon} size={18} />
              ) : (
                <span aria-hidden style={{ width: 12, height: 12, borderRadius: '50%', background: detail?.color ?? DEFAULT_EVENT_COLOR }} />
              )}
              <span className="title-md">{detail?.title}</span>
            </div>
            <div className="body-md">{whenLabel(detail)}</div>

            {occ && occ.ownerName && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', flexWrap: 'wrap' }}>
                <span className="label-caps">Организатор</span>
                <PersonChip size="S" userId={occ.ownerId} firstName={occ.ownerName} />
              </div>
            )}
            {detail?.location && (
              <div className="body-sm" style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                <Icon name="location" size={15} style={{ color: 'var(--muted)' }} />
                {detail.location}
              </div>
            )}
            {occ?.resourceName && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', flexWrap: 'wrap' }}>
                <Chip size="sm" tone="neutral" icon="folder">{occ.resourceName}</Chip>
                {occ.resourceStatus && (
                  <Chip size="sm" tone={BOOKING_TONE[occ.resourceStatus]}>
                    {RESOURCE_BOOKING_STATUS_META[occ.resourceStatus].label}
                  </Chip>
                )}
              </div>
            )}
            {detail?.description && <p className="body-md" style={{ margin: 0 }}>{detail.description}</p>}

            <ParticipantBlocks participants={participants} pendingIds={[]} contacts={contacts} canManage={false} />

            {isParticipant && (
              <>
                <Field label="Ваш ответ">
                  <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap' }}>
                    {(['accepted', 'tentative', 'declined'] as RsvpStatus[]).map((s) => (
                      <Button
                        key={s}
                        variant={myRsvp === s ? 'primary' : 'matte'}
                        tone={RSVP_TONE[s]}
                        size="sm"
                        disabled={busyAction}
                        onClick={() => doRsvp(s)}
                      >
                        {RSVP_META[s].label}
                      </Button>
                    ))}
                  </div>
                </Field>

                <Field label="Мои напоминания">
                  <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
                    {CALENDAR_REMINDER_PRESETS.map((r) => (
                      <Chip
                        key={r.minutesBefore}
                        size="sm"
                        tone="accent"
                        selected={reminders.includes(r.minutesBefore)}
                        onClick={() => toggleReminder(r.minutesBefore)}
                      >
                        {r.label}
                      </Chip>
                    ))}
                  </div>
                </Field>
              </>
            )}
          </div>
        )}
      </Modal>

      {showForward && eventId && (
        <ShareCardModal
          refType="event"
          refId={eventId}
          title={detail?.title || title || occ?.title || 'Событие'}
          onClose={() => setShowForward(false)}
        />
      )}
    </>
  );
}

/** Цвет события — палитра из shared; свой примитив, потому что в ките нет выбора цвета. */
function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <Field label="Цвет">
      <div role="radiogroup" aria-label="Цвет события" style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        {CALENDAR_EVENT_COLORS.map((c) => {
          const active = value === c.value;
          return (
            <button
              key={c.value}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={c.name}
              title={c.name}
              onClick={() => onChange(c.value)}
              style={{
                width: 26, height: 26, borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                background: c.value, border: 'none',
                boxShadow: active ? `0 0 0 2px var(--block), 0 0 0 4px ${c.value}` : 'none',
              }}
            />
          );
        })}
      </div>
    </Field>
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
  if (all.length === 0) return <p className="label-sm" style={{ margin: 0 }}>Пока никого</p>;

  const groups: RsvpStatus[] = ['accepted', 'tentative', 'pending', 'declined'];
  return (
    <div className="ui-stack" style={{ gap: 'var(--spacing-2)' }}>
      {groups.map((g) => {
        const list = all.filter((p) => p.rsvp === g);
        if (!list.length) return null;
        return (
          <div key={g} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <Chip size="sm" tone={RSVP_TONE[g]}>{RSVP_META[g].group}</Chip>
            {list.map((p) => (
              <span key={p.userId} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.125rem' }}>
                <PersonChip size="S" userId={p.userId} firstName={p.firstName} lastName={p.lastName ?? null} />
                {canManage && onRemove && (
                  <IconButton icon="close" label={`Убрать ${p.firstName}`} size={22} iconSize={12} onClick={() => onRemove(p.userId)} />
                )}
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
  const [sel, setSel] = useState<Principal[]>([]);
  const options = [
    ...contacts.map((c) => ({ type: 'user', id: c.them.id, title: `${c.them.firstName} ${c.them.lastName ?? ''}`.trim(), firstName: c.them.firstName, lastName: c.them.lastName, role: c.myRole })),
    ...circles.map((g) => ({ type: 'circle', id: g.id, title: g.name, icon: g.icon, color: g.color, count: g.membersCount })),
  ];
  const add = () => {
    const userIds = sel.filter((p) => p.type === 'user').map((p) => p.id);
    const circleIds = sel.filter((p) => p.type === 'circle').map((p) => p.id);
    if (userIds.length) onPick(userIds, null);
    for (const cid of circleIds) onPick([], cid);
    setSel([]);
  };
  return (
    <Card small style={{ marginTop: 'var(--spacing-2)' }}>
      <EntitySelector types={['user', 'circle']} multi options={options} value={sel} onChange={setSel} placeholder="Люди или Группы из окружения…" />
      {sel.length > 0 && (
        <div style={{ marginTop: 'var(--spacing-3)' }}>
          <Button variant="primary" tone="success" size="sm" icon="userAdd" onClick={add}>
            Добавить ({sel.length})
          </Button>
        </div>
      )}
    </Card>
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
