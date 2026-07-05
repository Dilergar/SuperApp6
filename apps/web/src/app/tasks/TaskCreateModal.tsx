'use client';

// ============================================================
// Модалка «+ Новая задача» — полная форма создания (Себе/Человеку/Группе,
// дедлайн, напоминание, повтор, приоритет, награда-эскроу).
// Форма перенесена из старого page.tsx; открывается из headerSlot сайдбара
// и из разделов. Оверлей — по образцу ShareCardModal.
// ============================================================

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { contactsKey, circlesKey, fetchAllContacts, fetchCircles } from '@/lib/queries';
import { EntitySelector } from '@/components/EntitySelector';
import { Chip } from './tasks-ui';
import { useFileUpload } from '@/lib/hooks/useFileUpload';
import { deleteFile } from '@/lib/files-api';
import { FileDropzone } from '@/components/files/FileDropzone';
import { UploadProgressList } from '@/components/files/UploadProgressList';
import { FileChip } from '@/components/files/FileChip';
import {
  TASK_PRIORITY_META,
  TASK_RECURRENCE_PRESETS,
  TASK_REMINDER_PRESETS,
  type Task,
  type Contact,
  type Circle,
  type FileDto,
} from '@superapp/shared';

export function TaskCreateModal({ onClose, onCreated }: { onClose: () => void; onCreated?: (task: Task) => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState('');

  const contactsQ = useQuery({ queryKey: contactsKey, queryFn: fetchAllContacts, staleTime: 60_000 });
  const circlesQ = useQuery({ queryKey: circlesKey, queryFn: fetchCircles, staleTime: 60_000 });

  const handleCreate = async (payload: Record<string, unknown>): Promise<boolean> => {
    setError('');
    try {
      const { data } = await api.post('/tasks', payload);
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      onCreated?.(data.data as Task);
      onClose();
      return true;
    } catch (err: unknown) {
      const a = err as { response?: { data?: { message?: string } } };
      setError(a.response?.data?.message || 'Ошибка создания задачи');
      return false;
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(56,57,45,0.35)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        zIndex: 100, padding: '1rem', overflowY: 'auto',
      }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 620, margin: '3vh 0' }}>
        {error && (
          <div className="wash-primary" style={{ padding: 'var(--spacing-3) var(--spacing-4)', marginBottom: 'var(--spacing-3)', color: 'var(--primary)', fontSize: '0.875rem' }}>
            {error}
          </div>
        )}
        <TaskCreateForm
          contacts={contactsQ.data ?? []}
          circles={circlesQ.data ?? []}
          onCreate={handleCreate}
          onCancel={onClose}
        />
      </div>
    </div>
  );
}

// ============================================================
// Форма (бывший TaskCreateForm из page.tsx)
// ============================================================

type AssignMode = 'self' | 'person' | 'group';

function TaskCreateForm({
  contacts, circles, onCreate, onCancel,
}: {
  contacts: Contact[];
  circles: Circle[];
  onCreate: (payload: Record<string, unknown>) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Task['priority']>('medium');
  const [dueDate, setDueDate] = useState('');
  const [allDay, setAllDay] = useState(false);
  const [reminderMin, setReminderMin] = useState<number | null>(null);
  const [recurrence, setRecurrence] = useState<string | null>(null);
  const [coinReward, setCoinReward] = useState(0);

  const [mode, setMode] = useState<AssignMode>('self');
  const [executorId, setExecutorId] = useState<string | null>(null);
  const [coExecutorIds, setCoExecutorIds] = useState<string[]>([]);
  const [observerIds, setObserverIds] = useState<string[]>([]);
  const [circleId, setCircleId] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);

  // Вложения «с порога»: файлы грузятся в движок ДО создания задачи; их id уходят
  // в attachmentFileIds. Если модалку закрыть без создания — незакреплённые файлы
  // удаляются (не мусорим квоту).
  const [attachments, setAttachments] = useState<FileDto[]>([]);
  const committedRef = useRef(false);
  const attachmentsRef = useRef<FileDto[]>([]);
  attachmentsRef.current = attachments;
  const attachUploader = useFileUpload('chat_attachment', {
    onUploaded: (f) => setAttachments((prev) => [...prev, f]),
  });
  useEffect(() => {
    return () => {
      if (!committedRef.current) {
        for (const f of attachmentsRef.current) deleteFile(f.id).catch(() => undefined);
      }
    };
  }, []);

  const selectedCircle = circles.find((c) => c.id === circleId);

  const toIso = (local: string, allDayFlag: boolean): string | undefined => {
    if (!local) return undefined;
    const d = allDayFlag ? new Date(`${local}T00:00:00`) : new Date(local);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setSubmitting(true);

    const dueIso = toIso(dueDate, allDay);
    const payload: Record<string, unknown> = {
      title: title.trim(),
      priority,
      allDay,
    };
    if (description.trim()) payload.description = description.trim();
    if (dueIso) payload.dueDate = dueIso;
    if (recurrence) payload.recurrenceRule = recurrence;
    if (coinReward > 0) payload.coinReward = coinReward;
    if (dueIso && reminderMin != null) {
      payload.reminderAt = new Date(new Date(dueIso).getTime() - reminderMin * 60_000).toISOString();
    }

    if (mode === 'person' && executorId) {
      payload.executorId = executorId;
      if (coExecutorIds.length) payload.coExecutorIds = coExecutorIds;
    } else if (mode === 'group' && circleId) {
      payload.assignedCircleId = circleId;
    }
    if (observerIds.length) payload.observerIds = observerIds;
    if (attachments.length) payload.attachmentFileIds = attachments.map((f) => f.id);

    // committedRef ставим ТОЛЬКО при успехе: если создание упало (напр. не хватило
    // коинов на награду), файлы должны прибраться при закрытии, а не утечь в квоту.
    const ok = await onCreate(payload);
    if (ok) committedRef.current = true;
    setSubmitting(false);
  };

  const canSubmit =
    title.trim().length > 0 &&
    !submitting &&
    (mode === 'self' || (mode === 'person' && !!executorId) || (mode === 'group' && !!circleId));

  return (
    <form onSubmit={submit} className="card-elevated" style={{ padding: 'var(--spacing-6)', background: 'var(--surface-container-low)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-4)' }}>
        <h3 className="title-md">Новая задача</h3>
        <button type="button" onClick={onCancel} aria-label="Закрыть" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.2rem', color: 'var(--on-surface-variant)' }}>×</button>
      </div>

      <input
        type="text" value={title} onChange={(e) => setTitle(e.target.value)}
        placeholder="Что нужно сделать?" className="input-sketch" autoFocus
        style={{ marginBottom: 'var(--spacing-3)', fontSize: '1rem', fontWeight: 600 }}
      />
      <textarea
        value={description} onChange={(e) => setDescription(e.target.value)}
        placeholder="Описание (необязательно)" className="input-sketch" rows={2}
        style={{ marginBottom: 'var(--spacing-4)', resize: 'vertical' }}
      />

      {/* Assignment mode */}
      <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>Кому</label>
      <div style={{ display: 'flex', gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-3)', flexWrap: 'wrap' }}>
        {([['self', 'Себе'], ['person', 'Человеку'], ['group', 'Группе']] as [AssignMode, string][]).map(([m, lbl]) => (
          <Chip key={m} active={mode === m} onClick={() => setMode(m)}>{lbl}</Chip>
        ))}
      </div>

      {mode === 'person' && (
        <div style={{ marginBottom: 'var(--spacing-4)' }}>
          <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>Исполнитель (1 ответственный)</label>
          <EntitySelector
            types={['user']}
            multi={false}
            options={contacts.map((c) => ({ type: 'user', id: c.them.id, title: `${c.them.firstName} ${c.them.lastName ?? ''}`.trim(), firstName: c.them.firstName, lastName: c.them.lastName, role: c.myRole }))}
            value={executorId ? [{ type: 'user', id: executorId }] : []}
            onChange={(p) => setExecutorId(p[0]?.id ?? null)}
            placeholder="Выберите исполнителя…"
          />
          <div style={{ marginTop: 'var(--spacing-3)' }}>
            <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>Соисполнители (помогают)</label>
            <EntitySelector
              types={['user']}
              multi
              options={contacts.filter((c) => c.them.id !== executorId).map((c) => ({ type: 'user', id: c.them.id, title: `${c.them.firstName} ${c.them.lastName ?? ''}`.trim(), firstName: c.them.firstName, lastName: c.them.lastName, role: c.myRole }))}
              value={coExecutorIds.map((id) => ({ type: 'user', id }))}
              onChange={(p) => setCoExecutorIds(p.map((x) => x.id))}
              placeholder="Добавьте соисполнителей…"
            />
          </div>
        </div>
      )}

      {mode === 'group' && (
        <div style={{ marginBottom: 'var(--spacing-4)' }}>
          <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>Группа из окружения</label>
          {circles.length === 0 ? (
            <p className="label-sm">Сначала создайте группу на странице «Моё окружение»</p>
          ) : (
            <EntitySelector
              types={['circle']}
              multi={false}
              value={circleId ? [{ type: 'circle', id: circleId }] : []}
              onChange={(p) => setCircleId(p[0]?.id ?? null)}
              placeholder="Выберите Группу…"
            />
          )}
          {selectedCircle && (
            <p className="label-sm" style={{ marginTop: 'var(--spacing-2)', color: 'var(--secondary)' }}>
              Все из «{selectedCircle.name}» станут Соисполнителями, у каждого свой статус и приёмка.
            </p>
          )}
        </div>
      )}

      {mode !== 'self' && (
        <div style={{ marginBottom: 'var(--spacing-4)' }}>
          <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>Наблюдатели (видят прогресс и чат)</label>
          <EntitySelector
            types={['user']}
            multi
            options={contacts.filter((c) => c.them.id !== executorId && !coExecutorIds.includes(c.them.id)).map((c) => ({ type: 'user', id: c.them.id, title: `${c.them.firstName} ${c.them.lastName ?? ''}`.trim(), firstName: c.them.firstName, lastName: c.them.lastName, role: c.myRole }))}
            value={observerIds.map((id) => ({ type: 'user', id }))}
            onChange={(p) => setObserverIds(p.map((x) => x.id))}
            placeholder="Добавьте наблюдателей…"
          />
        </div>
      )}

      {/* Deadline + reminder + recurrence */}
      <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-4)', marginBottom: 'var(--spacing-4)' }}>
        <div>
          <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>
            Дедлайн
            <button type="button" onClick={() => { setAllDay(!allDay); setDueDate(''); }} style={{ marginLeft: '0.5rem', background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.75rem', color: 'var(--secondary)', fontWeight: 600 }}>
              {allDay ? '🕒 со временем' : '📅 весь день'}
            </button>
          </label>
          <input
            type={allDay ? 'date' : 'datetime-local'}
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="input-sketch"
          />
        </div>
        <div>
          <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>Приоритет</label>
          <div style={{ display: 'flex', gap: 'var(--spacing-1)', flexWrap: 'wrap' }}>
            {(Object.keys(TASK_PRIORITY_META) as Task['priority'][]).map((p) => (
              <Chip key={p} active={priority === p} color={TASK_PRIORITY_META[p].color} onClick={() => setPriority(p)}>
                {TASK_PRIORITY_META[p].label}
              </Chip>
            ))}
          </div>
        </div>
      </div>

      <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-4)', marginBottom: 'var(--spacing-4)' }}>
        <div>
          <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>Напоминание</label>
          <select className="input-sketch" value={reminderMin ?? ''} onChange={(e) => setReminderMin(e.target.value === '' ? null : Number(e.target.value))} disabled={!dueDate}>
            {TASK_REMINDER_PRESETS.map((r) => (
              <option key={r.label} value={r.minutesBefore ?? ''}>{r.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>Повтор</label>
          <select className="input-sketch" value={recurrence ?? ''} onChange={(e) => setRecurrence(e.target.value === '' ? null : e.target.value)}>
            {TASK_RECURRENCE_PRESETS.map((r) => (
              <option key={r.label} value={r.rule ?? ''}>{r.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Reward */}
      <div style={{ marginBottom: 'var(--spacing-5)' }}>
        <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>
          Награда коинами {mode === 'group' && selectedCircle ? '(каждому)' : ''}
        </label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)' }}>
          <input
            type="number" min={0} value={coinReward}
            onChange={(e) => setCoinReward(Math.max(0, Number(e.target.value) || 0))}
            className="input-sketch" style={{ maxWidth: '140px' }}
          />
          {mode === 'group' && selectedCircle && coinReward > 0 && (
            <span className="label-sm" style={{ color: 'var(--tertiary)' }}>
              Каждому по {coinReward} 🪙 · итого {coinReward * selectedCircle.membersCount}
            </span>
          )}
        </div>
        <p className="label-sm" style={{ marginTop: 'var(--spacing-1)', opacity: 0.7 }}>
          Коины замораживаются из вашего кошелька при создании и выплачиваются при приёмке работы.
        </p>
      </div>

      {/* Вложения (движок файлов) */}
      <div style={{ marginBottom: 'var(--spacing-5)' }}>
        <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>Вложения</label>
        {attachments.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-2)' }}>
            {attachments.map((f) => (
              <FileChip key={f.id} file={f} onRemove={() => { deleteFile(f.id).catch(() => undefined); setAttachments((prev) => prev.filter((x) => x.id !== f.id)); }} />
            ))}
          </div>
        )}
        <FileDropzone onFiles={(fs) => attachUploader.add(fs)} paste multiple compact label="Прикрепить файл" />
        <UploadProgressList items={attachUploader.items.filter((i) => i.status !== 'done')} onCancel={attachUploader.cancel} onRemove={attachUploader.remove} />
      </div>

      <div style={{ display: 'flex', gap: 'var(--spacing-3)' }}>
        <button type="submit" disabled={!canSubmit} className="btn-primary" style={{ fontSize: '0.9rem', opacity: canSubmit ? 1 : 0.6 }}>
          {submitting ? 'Создание...' : 'Создать задачу'}
        </button>
        <button type="button" onClick={onCancel} className="btn-secondary" style={{ fontSize: '0.9rem' }}>
          Отмена
        </button>
      </div>
    </form>
  );
}
