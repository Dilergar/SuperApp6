'use client';

import { useMemo, useState } from 'react';
import { SCHEDULED_MESSAGE_LIMITS } from '@superapp/shared';
import { api } from '@/lib/api';
import { shareRichCard, scheduleMessage } from '@/lib/messenger-api';
import { ContactPicker, useContacts } from './ContactPicker';
import { errMsg } from './ShareCardModal';

// ============================================================
// Phase 7 — the three composer/message quick-action modals:
//  • CreateTaskModal     (key 'task.create')
//  • CreateEventModal    (key 'event.create')
//  • ScheduleMessageModal(key 'message.schedule')
//
// Each is reached either from the composer ＋-menu (blank) or from a
// message's corner menu (PREFILLED with that message's text). On a task /
// event creation we drop its live Rich Card into the open chat via the
// existing shareRichCard wrapper; the card then arrives over socket (or the
// onPosted fallback refetches messages).
//
// Styling mirrors AttachCardModal / ShareCardModal: warm paper overlay +
// backdrop blur, rotated card-elevated panel, NO white surfaces.
// ============================================================

/** Shared modal shell — warm paper, backdrop blur, slight rotation. */
function ModalShell({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(56,57,45,0.35)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 110,
        padding: '1rem',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card-elevated"
        style={{
          background: 'var(--surface-container-low)',
          padding: 'var(--spacing-6)',
          maxWidth: 460,
          width: '100%',
          maxHeight: '86vh',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 'var(--radius-md)',
          transform: 'rotate(-0.3deg)',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            marginBottom: subtitle ? 'var(--spacing-1)' : 'var(--spacing-4)',
          }}
        >
          <h3 className="title-md">{title}</h3>
          <button
            onClick={onClose}
            aria-label="Закрыть"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: '1.2rem',
              color: 'var(--on-surface-variant)',
              opacity: 0.5,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
        {subtitle && (
          <p className="label-sm" style={{ opacity: 0.7, marginBottom: 'var(--spacing-4)' }}>
            {subtitle}
          </p>
        )}
        {children}
      </div>
    </div>
  );
}

/** Sketchbook datetime-local input (no white surface, no 1px gray border). */
function DateTimeField({
  value,
  onChange,
  min,
}: {
  value: string;
  onChange: (v: string) => void;
  min?: string;
}) {
  return (
    <input
      type="datetime-local"
      value={value}
      min={min}
      onChange={(e) => onChange(e.target.value)}
      className="input-sketch"
      style={{ fontSize: '0.9rem', fontFamily: 'var(--font-body)' }}
    />
  );
}

const errStyle: React.CSSProperties = {
  color: 'var(--danger)',
  fontSize: '0.82rem',
  marginBottom: 'var(--spacing-3)',
};

/** datetime-local value (local wall clock, no seconds) for a Date. */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

/** ISO string from a datetime-local value, or undefined if blank/invalid. */
function localToIso(local: string): string | undefined {
  if (!local) return undefined;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

// ============================================================
// CreateTaskModal — pick one executor from Окружение + title + optional due.
// ============================================================

export function CreateTaskModal({
  chatId,
  prefillDescription,
  onClose,
  onPosted,
}: {
  chatId: string;
  /** When opened from a message: seeds the task description with its text. */
  prefillDescription?: string;
  onClose: () => void;
  /** Called after the rich card is posted (invalidate messages as a fallback). */
  onPosted?: () => void;
}) {
  const { contacts, loading, error } = useContacts();
  const [executorId, setExecutorId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const minDue = useMemo(() => toLocalInput(new Date()), []);

  const submit = async () => {
    if (!executorId || !title.trim()) {
      setErr('Выберите исполнителя и введите название.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const payload: Record<string, unknown> = {
        executorId,
        title: title.trim(),
        dueDate: localToIso(due),
        allDay: false,
      };
      if (prefillDescription?.trim()) payload.description = prefillDescription.trim();
      const res = await api.post('/tasks', payload);
      const taskId: string = res.data.data.id;
      await shareRichCard(chatId, 'task', taskId);
      onPosted?.();
      onClose();
    } catch (e) {
      setErr(errMsg(e, 'Не удалось создать задачу'));
      setBusy(false);
    }
  };

  return (
    <ModalShell
      title="Создать задачу"
      subtitle="Поставьте задачу человеку из окружения — её карточка появится в этом чате."
      onClose={onClose}
    >
      {err && <p style={errStyle}>{err}</p>}

      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Что нужно сделать?"
        className="input-sketch"
        autoFocus
        style={{ marginBottom: 'var(--spacing-3)', fontSize: '0.95rem', fontWeight: 600 }}
      />

      {prefillDescription?.trim() && (
        <div
          style={{
            marginBottom: 'var(--spacing-3)',
            padding: 'var(--spacing-2) var(--spacing-3)',
            background: 'var(--surface-container)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          <div className="label-sm" style={{ fontSize: '0.68rem', opacity: 0.6, marginBottom: '0.15rem' }}>
            Описание (из сообщения)
          </div>
          <div style={{ fontSize: '0.85rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {prefillDescription.trim()}
          </div>
        </div>
      )}

      <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>
        Исполнитель
      </label>
      <div
        style={{
          maxHeight: '14rem',
          display: 'flex',
          flexDirection: 'column',
          marginBottom: 'var(--spacing-3)',
          minHeight: 0,
        }}
      >
        <ContactPicker
          contacts={contacts}
          loading={loading}
          error={error}
          mode="single"
          selected={executorId ? [executorId] : []}
          onPick={(id) => setExecutorId((cur) => (cur === id ? null : id))}
        />
      </div>
      {executorId && (
        <p className="label-sm" style={{ fontSize: '0.74rem', color: 'var(--secondary)', marginBottom: 'var(--spacing-3)' }}>
          Исполнитель выбран ✓
        </p>
      )}

      <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>
        Срок (необязательно)
      </label>
      <div style={{ marginBottom: 'var(--spacing-4)' }}>
        <DateTimeField value={due} onChange={setDue} min={minDue} />
      </div>

      <div style={{ display: 'flex', gap: 'var(--spacing-2)', justifyContent: 'flex-end' }}>
        <button onClick={onClose} className="btn-secondary" style={{ fontSize: '0.85rem' }}>
          Отмена
        </button>
        <button
          onClick={submit}
          disabled={busy || !executorId || !title.trim()}
          className="btn-primary"
          style={{ fontSize: '0.85rem', opacity: busy || !executorId || !title.trim() ? 0.5 : 1 }}
        >
          {busy ? '…' : 'Создать'}
        </button>
      </div>
    </ModalShell>
  );
}

// ============================================================
// CreateEventModal — title + start datetime + multi participants.
// ============================================================

export function CreateEventModal({
  chatId,
  prefillTitle,
  onClose,
  onPosted,
}: {
  chatId: string;
  /** When opened from a message: seeds the event title with its text. */
  prefillTitle?: string;
  onClose: () => void;
  onPosted?: () => void;
}) {
  const { contacts, loading, error } = useContacts();
  const [title, setTitle] = useState(prefillTitle?.trim().slice(0, 120) ?? '');
  const [start, setStart] = useState('');
  const [participantIds, setParticipantIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const minStart = useMemo(() => toLocalInput(new Date()), []);

  const toggleParticipant = (id: string) =>
    setParticipantIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const submit = async () => {
    const startIso = localToIso(start);
    if (!title.trim() || !startIso) {
      setErr('Введите название и время начала.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const startDate = new Date(startIso);
      const endIso = new Date(+startDate + 3_600_000).toISOString(); // +1h, mirrors EventModal
      const payload: Record<string, unknown> = {
        title: title.trim(),
        startTime: startIso,
        endTime: endIso,
        allDay: false,
      };
      if (participantIds.length) payload.participantUserIds = participantIds;
      const res = await api.post('/calendar/events', payload);
      const eventId: string = res.data.data.id;
      await shareRichCard(chatId, 'event', eventId);
      onPosted?.();
      onClose();
    } catch (e) {
      setErr(errMsg(e, 'Не удалось создать событие'));
      setBusy(false);
    }
  };

  return (
    <ModalShell
      title="Создать событие"
      subtitle="Запланируйте событие и пригласите людей — карточка появится в этом чате."
      onClose={onClose}
    >
      {err && <p style={errStyle}>{err}</p>}

      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Название события"
        className="input-sketch"
        autoFocus
        style={{ marginBottom: 'var(--spacing-3)', fontSize: '0.95rem', fontWeight: 600 }}
      />

      <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>
        Начало
      </label>
      <div style={{ marginBottom: 'var(--spacing-4)' }}>
        <DateTimeField value={start} onChange={setStart} min={minStart} />
      </div>

      <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>
        Участники (необязательно)
      </label>
      <div
        style={{
          maxHeight: '14rem',
          display: 'flex',
          flexDirection: 'column',
          marginBottom: 'var(--spacing-4)',
          minHeight: 0,
        }}
      >
        <ContactPicker
          contacts={contacts}
          loading={loading}
          error={error}
          mode="multi"
          selected={participantIds}
          onToggle={toggleParticipant}
        />
      </div>

      <div style={{ display: 'flex', gap: 'var(--spacing-2)', justifyContent: 'flex-end' }}>
        <button onClick={onClose} className="btn-secondary" style={{ fontSize: '0.85rem' }}>
          Отмена
        </button>
        <button
          onClick={submit}
          disabled={busy || !title.trim() || !start}
          className="btn-primary"
          style={{ fontSize: '0.85rem', opacity: busy || !title.trim() || !start ? 0.5 : 1 }}
        >
          {busy ? '…' : 'Создать'}
        </button>
      </div>
    </ModalShell>
  );
}

// ============================================================
// ScheduleMessageModal — textarea + datetime (min now+1min). Reused by both
// the composer ＋-menu (blank) and a message's corner menu (prefilled text).
// ============================================================

export function ScheduleMessageModal({
  chatId,
  prefillContent,
  onClose,
  onScheduled,
}: {
  chatId: string;
  /** When opened from a message: seeds the textarea with its text. */
  prefillContent?: string;
  onClose: () => void;
  /** Called after a message is scheduled — refetch the scheduled list. */
  onScheduled?: () => void;
}) {
  const [content, setContent] = useState(prefillContent ?? '');
  const [when, setWhen] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Picker floor: now + 1 minute (the server requires ≥ now + minLeadSeconds).
  const minWhen = useMemo(() => toLocalInput(new Date(Date.now() + 60_000)), []);

  const submit = async () => {
    const sendAt = localToIso(when);
    if (!content.trim() || !sendAt) {
      setErr('Введите текст и время отправки.');
      return;
    }
    if (new Date(sendAt).getTime() < Date.now() + SCHEDULED_MESSAGE_LIMITS.minLeadSeconds * 1000) {
      setErr('Выберите время хотя бы на минуту вперёд.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await scheduleMessage(chatId, { content: content.trim(), sendAt });
      onScheduled?.();
      onClose();
    } catch (e) {
      setErr(errMsg(e, 'Не удалось запланировать'));
      setBusy(false);
    }
  };

  return (
    <ModalShell
      title="Запланировать сообщение"
      subtitle="Сообщение отправится автоматически в выбранное время."
      onClose={onClose}
    >
      {err && <p style={errStyle}>{err}</p>}

      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Текст сообщения…"
        className="input-sketch"
        rows={3}
        autoFocus
        style={{ marginBottom: 'var(--spacing-4)', resize: 'vertical' }}
      />

      <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>
        Когда отправить
      </label>
      <div style={{ marginBottom: 'var(--spacing-4)' }}>
        <DateTimeField value={when} onChange={setWhen} min={minWhen} />
      </div>

      <div style={{ display: 'flex', gap: 'var(--spacing-2)', justifyContent: 'flex-end' }}>
        <button onClick={onClose} className="btn-secondary" style={{ fontSize: '0.85rem' }}>
          Отмена
        </button>
        <button
          onClick={submit}
          disabled={busy || !content.trim() || !when}
          className="btn-primary"
          style={{ fontSize: '0.85rem', opacity: busy || !content.trim() || !when ? 0.5 : 1 }}
        >
          {busy ? '…' : 'Запланировать'}
        </button>
      </div>
    </ModalShell>
  );
}

export { toLocalInput, localToIso };
