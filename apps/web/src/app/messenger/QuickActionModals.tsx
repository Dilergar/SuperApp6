'use client';

import { CloseChip, Input, ModalShell, Select, Textarea } from '@/components/ui';
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import {
  SCHEDULED_MESSAGE_LIMITS,
  type Task,
  type CalendarEvent,
  type FinTransactionDto,
} from '@superapp/shared';
import { apiPost } from '@/lib/api';
import { shareRichCard, scheduleMessage } from '@/lib/messenger-api';
import { financeOverviewKey, fetchFinanceOverview } from '@/lib/queries';
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
function DialogFrame({
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
    <ModalShell onClose={onClose} zIndex={110}>
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
          <CloseChip onClick={onClose} />
        </div>
        {subtitle && (
          <p className="label-sm" style={{ opacity: 0.7, marginBottom: 'var(--spacing-4)' }}>
            {subtitle}
          </p>
        )}
        {children}
      </div>
    </ModalShell>
  );
}

/** Поле «дата и время» на ките: подпись связана с полем самим китом. */
function DateTimeField({
  label,
  value,
  onChange,
  min,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  min?: string;
}) {
  return (
    <Input
      label={label}
      type="datetime-local"
      value={value}
      min={min}
      onChange={(e) => onChange(e.target.value)}
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
  const t = useTranslations('messenger');
  const tc = useTranslations('common');
  const { contacts, loading, error } = useContacts();
  const [executorId, setExecutorId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const minDue = useMemo(() => toLocalInput(new Date()), []);

  const submit = async () => {
    if (!executorId || !title.trim()) {
      setErr(t('qa.task.pickExecutor'));
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
      const { id: taskId } = await apiPost<Task>('/tasks', payload);
      await shareRichCard(chatId, 'task', taskId);
      onPosted?.();
      onClose();
    } catch (e) {
      setErr(errMsg(e, t('qa.task.failed')));
      setBusy(false);
    }
  };

  return (
    <DialogFrame
      title={t('qa.task.title')}
      subtitle={t('qa.task.subtitle')}
      onClose={onClose}
    >
      {err && <p style={errStyle}>{err}</p>}

      <Input
        label={t('qa.task.label')}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={t('qa.task.placeholder')}
        autoFocus
        wrapClassName="mb-3"
        style={{ fontSize: '0.95rem', fontWeight: 600 }}
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
            {t('qa.task.descriptionFromMessage')}
          </div>
          <div style={{ fontSize: '0.85rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {prefillDescription.trim()}
          </div>
        </div>
      )}

      <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>
        {t('qa.task.executor')}
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
          {t('qa.task.executorPicked')}
        </p>
      )}

      <div style={{ marginBottom: 'var(--spacing-4)' }}>
        <DateTimeField label={t('qa.task.due')} value={due} onChange={setDue} min={minDue} />
      </div>

      <div style={{ display: 'flex', gap: 'var(--spacing-2)', justifyContent: 'flex-end' }}>
        <button onClick={onClose} className="btn-ghost-inline">
          {tc('actions.cancel')}
        </button>
        <button
          onClick={submit}
          disabled={busy || !executorId || !title.trim()}
          className="btn-success"
          style={{ fontSize: '0.85rem', opacity: busy || !executorId || !title.trim() ? 0.5 : 1 }}
        >
          {busy ? '…' : tc('actions.create')}
        </button>
      </div>
    </DialogFrame>
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
  const t = useTranslations('messenger');
  const tc = useTranslations('common');
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
      setErr(t('qa.event.fillTitleAndStart'));
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
      const { id: eventId } = await apiPost<CalendarEvent>('/calendar/events', payload);
      await shareRichCard(chatId, 'event', eventId);
      onPosted?.();
      onClose();
    } catch (e) {
      setErr(errMsg(e, t('qa.event.failed')));
      setBusy(false);
    }
  };

  return (
    <DialogFrame
      title={t('qa.event.title')}
      subtitle={t('qa.event.subtitle')}
      onClose={onClose}
    >
      {err && <p style={errStyle}>{err}</p>}

      <Input
        label={t('qa.event.label')}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={t('qa.event.placeholder')}
        autoFocus
        wrapClassName="mb-3"
        style={{ fontSize: '0.95rem', fontWeight: 600 }}
      />

      <div style={{ marginBottom: 'var(--spacing-4)' }}>
        <DateTimeField label={t('qa.event.start')} value={start} onChange={setStart} min={minStart} />
      </div>

      <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>
        {t('qa.event.participants')}
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
        <button onClick={onClose} className="btn-ghost-inline">
          {tc('actions.cancel')}
        </button>
        <button
          onClick={submit}
          disabled={busy || !title.trim() || !start}
          className="btn-success"
          style={{ fontSize: '0.85rem', opacity: busy || !title.trim() || !start ? 0.5 : 1 }}
        >
          {busy ? '…' : tc('actions.create')}
        </button>
      </div>
    </DialogFrame>
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
  const t = useTranslations('messenger');
  const tc = useTranslations('common');
  const [content, setContent] = useState(prefillContent ?? '');
  const [when, setWhen] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Picker floor: now + 1 minute (the server requires ≥ now + minLeadSeconds).
  const minWhen = useMemo(() => toLocalInput(new Date(Date.now() + 60_000)), []);

  const submit = async () => {
    const sendAt = localToIso(when);
    if (!content.trim() || !sendAt) {
      setErr(t('qa.schedule.fillTextAndTime'));
      return;
    }
    if (new Date(sendAt).getTime() < Date.now() + SCHEDULED_MESSAGE_LIMITS.minLeadSeconds * 1000) {
      setErr(t('qa.schedule.atLeastMinute'));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await scheduleMessage(chatId, { content: content.trim(), sendAt });
      onScheduled?.();
      onClose();
    } catch (e) {
      setErr(errMsg(e, t('qa.schedule.failed')));
      setBusy(false);
    }
  };

  return (
    <DialogFrame
      title={t('qa.schedule.title')}
      subtitle={t('qa.schedule.subtitle')}
      onClose={onClose}
    >
      {err && <p style={errStyle}>{err}</p>}

      <Textarea
        label={t('qa.schedule.label')}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder={t('qa.schedule.placeholder')}
        rows={3}
        autoFocus
        wrapClassName="mb-4"
        style={{ resize: 'vertical' }}
      />

      <div style={{ marginBottom: 'var(--spacing-4)' }}>
        <DateTimeField label={t('qa.schedule.when')} value={when} onChange={setWhen} min={minWhen} />
      </div>

      <div style={{ display: 'flex', gap: 'var(--spacing-2)', justifyContent: 'flex-end' }}>
        <button onClick={onClose} className="btn-ghost-inline">
          {tc('actions.cancel')}
        </button>
        <button
          onClick={submit}
          disabled={busy || !content.trim() || !when}
          className="btn-success"
          style={{ fontSize: '0.85rem', opacity: busy || !content.trim() || !when ? 0.5 : 1 }}
        >
          {busy ? '…' : t('qa.schedule.submit')}
        </button>
      </div>
    </DialogFrame>
  );
}

// ============================================================
// AddExpenseModal (key 'finance.add-expense') — трата из чата в СВОЮ
// книгу Финансов; в чат уходит карточка-снимок операции.
// ============================================================

export function AddExpenseModal({
  chatId,
  onClose,
  onPosted,
}: {
  chatId: string;
  onClose: () => void;
  onPosted?: () => void;
}) {
  const t = useTranslations('messenger');
  const tc = useTranslations('common');
  const { data: overview } = useQuery({
    queryKey: financeOverviewKey(),
    queryFn: () => fetchFinanceOverview(),
  });
  const accounts = useMemo(
    () => (overview?.accounts ?? []).filter((a) => !a.archived),
    [overview],
  );
  const cats = useMemo(
    () => (overview?.categories ?? []).filter((c) => c.kind === 'expense' && !c.archived),
    [overview],
  );

  const [amount, setAmount] = useState('');
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!fromId && accounts[0]) setFromId(accounts[0].id);
    if (!toId && cats[0]) setToId(cats[0].id);
  }, [accounts, cats, fromId, toId]);

  const parseAmount = (raw: string): number | null => {
    const v = Number(raw.replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(v) && v > 0 ? Math.round(v * 100) : null;
  };

  const submit = async () => {
    const minor = parseAmount(amount);
    if (!minor || !fromId || !toId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const tx = await apiPost<FinTransactionDto>('/finance/transactions', {
        fromAccountId: fromId,
        toAccountId: toId,
        amount: minor,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      await shareRichCard(chatId, 'fin_transaction', tx.id);
      onPosted?.();
      onClose();
    } catch (e) {
      setError(errMsg(e, t('card.actionFailed')));
    } finally {
      setBusy(false);
    }
  };

  // Дерево категорий (2 уровня) плющится в плоский список кита: вложенность
  // показывает отступ в подписи, иконка живёт отдельным полем emoji.
  const catOptions = useMemo(() => {
    const roots = cats.filter((c) => !c.parentId);
    return roots.flatMap((root) => [
      { value: root.id, label: root.name, emoji: root.icon },
      ...cats
        .filter((c) => c.parentId === root.id)
        .map((c) => ({ value: c.id, label: `— ${c.name}`, emoji: c.icon })),
    ]);
  }, [cats]);

  return (
    <DialogFrame title={t('qa.expense.title')} subtitle={t('qa.expense.subtitle')} onClose={onClose}>
      <Input
        label={t('qa.expense.amount')}
        inputMode="decimal"
        placeholder="2 500"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        autoFocus
        wrapClassName="mb-4"
        style={{ fontSize: '1.3rem', fontFamily: 'var(--font-display)', fontWeight: 700 }}
      />
      <Select
        label={t('qa.expense.account')}
        value={fromId}
        onChange={setFromId}
        className="mb-4"
        options={accounts.map((a) => ({ value: a.id, label: a.name, emoji: a.icon }))}
      />
      <Select
        label={t('qa.expense.category')}
        value={toId}
        onChange={setToId}
        className="mb-4"
        options={catOptions}
      />
      <Input
        label={t('qa.expense.note')}
        placeholder="Magnum…"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        wrapClassName="mb-4"
      />

      {error && <p className="label-sm" style={{ color: 'var(--danger)', marginBottom: 'var(--spacing-3)' }}>{error}</p>}

      <div style={{ display: 'flex', gap: 'var(--spacing-2)', justifyContent: 'flex-end' }}>
        <button onClick={onClose} className="btn-ghost-inline">{tc('actions.cancel')}</button>
        <button
          onClick={submit}
          disabled={busy || !parseAmount(amount)}
          className="btn-success"
          style={{ fontSize: '0.85rem', opacity: busy || !parseAmount(amount) ? 0.5 : 1 }}
        >
          {busy ? '…' : t('qa.expense.submit')}
        </button>
      </div>
    </DialogFrame>
  );
}

export { toLocalInput, localToIso };
