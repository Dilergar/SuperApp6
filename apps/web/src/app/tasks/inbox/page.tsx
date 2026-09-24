'use client';

// ============================================================
// «Входящие» — GTD-разборная папка (Todoist Inbox / Things 3 / Linear Triage).
// Каждая запись — НАСТОЯЩАЯ Task (само-задача с inbox=true), поэтому её видно
// в календарном слое/чате/rich-cards как любую задачу. Разбор (clarify):
//  • «Срок» → PATCH {dueDate} — флаг снимается сервером сам;
//  • «Поручить» → PATCH {executorId} — тоже авто-уточнение;
//  • «Разобрано» → PATCH {inbox:false} — остаётся бессрочной само-задачей;
//  • чекбокс — submit само-задачи → сразу «Готово».
// ============================================================

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { apiPatch, apiPost } from '@/lib/api';
import { contactsKey, fetchAllContacts } from '@/lib/queries';
import { EntitySelector } from '@/components/EntitySelector';
import { useTasksService } from '../tasks-shell';
import { QuickAdd, useDueFormat } from '../tasks-ui';
import { Alert, Button, Card, Icon, Input, PageHeader } from '@/components/ui';
import { TaskListSection } from '../TaskListSection';
import type { Contact, Task } from '@superapp/shared';
import { guardedDisplay } from '@superapp/shared';

export default function TasksInboxPage() {
  const t = useTranslations('tasks');
  const { invalidate } = useTasksService();
  const contactsQ = useQuery({ queryKey: contactsKey, queryFn: fetchAllContacts, staleTime: 60_000 });
  const contacts = contactsQ.data ?? [];

  return (
    <>
      <PageHeader
        breadcrumb={t('breadcrumb')}
        title={t('sections.inbox.title')}
        description={t('sections.inbox.description')}
      />

      <Card small style={{ marginBottom: 'var(--gap-grid)' }}>
        <QuickAdd autoFocus />
      </Card>

      <TaskListSection
        filter={{ smartList: 'inbox' }}
        emptyText={t('sections.inbox.empty')}
        emptyHint={t('sections.inbox.emptyHint')}
        renderRow={(t) => <InboxRow task={t} contacts={contacts} onChanged={invalidate} />}
      />
    </>
  );
}

// ------------------------------------------------------------
// Строка Входящих: чекбокс «выполнить» + название + действия разбора
// ------------------------------------------------------------

function InboxRow({ task, contacts, onChanged }: { task: Task; contacts: Contact[]; onChanged: () => void }) {
  const t = useTranslations('tasks');
  const tc = useTranslations('common');
  const formatDue = useDueFormat();
  const [panel, setPanel] = useState<null | 'date' | 'assign'>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const [withTime, setWithTime] = useState(false);
  const [due, setDue] = useState('');
  const [executorId, setExecutorId] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await fn();
      onChanged();
    } catch (err: unknown) {
      const a = err as { response?: { data?: { message?: string } } };
      setError(a.response?.data?.message || t('inbox.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  const complete = () => run(() => apiPost(`/tasks/${task.id}/submit`));
  const markSorted = () => run(() => apiPatch(`/tasks/${task.id}`, { inbox: false }));
  const saveDue = () => {
    if (!due) return;
    const d = withTime ? new Date(due) : new Date(`${due}T00:00:00`);
    if (Number.isNaN(d.getTime())) return;
    return run(() => apiPatch(`/tasks/${task.id}`, { dueDate: d.toISOString(), allDay: !withTime }));
  };
  const saveExecutor = () => {
    if (!executorId) return;
    return run(() => apiPatch(`/tasks/${task.id}`, { executorId }));
  };

  const actionStyle: React.CSSProperties = {
    background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600,
    fontSize: '0.78rem', color: 'var(--secondary)', padding: '0.2rem 0.35rem', whiteSpace: 'nowrap',
  };

  return (
    <div className="card" style={{ padding: 'var(--spacing-3) var(--spacing-4)', opacity: busy ? 0.6 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)' }}>
        <button
          onClick={complete}
          disabled={busy}
          aria-label={t('inbox.complete')}
          title={t('inbox.complete')}
          style={{
            width: 24, height: 24, minWidth: 24, borderRadius: '50%', cursor: 'pointer',
            border: '1px solid var(--outline)', background: 'transparent', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            color: 'transparent', fontSize: '0.8rem', lineHeight: 1,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--success-base)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'transparent'; }}
        >
          <Icon name="check" size={13} />
        </button>

        <div style={{ flex: 1, minWidth: 0 }}>
          <Link href={`/tasks/${task.id}`} style={{ textDecoration: 'none', color: 'inherit', fontWeight: 600, fontSize: '0.95rem' }}>
            {task.title}
          </Link>
          <div className="label-sm" style={{ marginTop: 2, opacity: 0.75 }}>
            {t('inbox.added', { date: formatDue(task.createdAt, false) })}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-1)', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <Button size="sm" variant="ghost" icon="calendar" onClick={() => setPanel(panel === 'date' ? null : 'date')}>{t('inbox.due')}</Button>
          <Button size="sm" variant="ghost" icon="userAdd" onClick={() => setPanel(panel === 'assign' ? null : 'assign')}>{t('inbox.assign')}</Button>
          <Button size="sm" variant="ghost" icon="check" onClick={markSorted} title={t('inbox.sortedHint')}>{t('inbox.sorted')}</Button>
        </div>
      </div>

      {panel === 'date' && (
        <div style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'center', marginTop: 'var(--spacing-3)', flexWrap: 'wrap' }}>
          <Input
            type={withTime ? 'datetime-local' : 'date'}
            value={due}
            onChange={(e) => setDue(e.target.value)}
            wrapClassName="inbox-due-field"
          />
          <Button size="sm" variant="ghost" icon={withTime ? 'calendar' : 'clock'} onClick={() => { setWithTime(!withTime); setDue(''); }}>
            {withTime ? t('create.allDay') : t('create.withTime')}
          </Button>
          <Button size="sm" variant="primary" tone="success" icon="check" disabled={!due} loading={busy} onClick={saveDue}>{tc('actions.save')}</Button>
        </div>
      )}

      {panel === 'assign' && (
        <div style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'center', marginTop: 'var(--spacing-3)', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <EntitySelector
              types={['user']}
              multi={false}
              options={contacts.map((c) => ({ type: 'user', id: c.them.id, title: `${c.them.firstName} ${guardedDisplay(c.them.lastName) ?? ''}`.trim(), firstName: c.them.firstName, lastName: guardedDisplay(c.them.lastName), role: c.myRole }))}
              value={executorId ? [{ type: 'user', id: executorId }] : []}
              onChange={(p) => setExecutorId(p[0]?.id ?? null)}
              placeholder={t('inbox.assignPlaceholder')}
            />
          </div>
          <Button size="sm" variant="primary" tone="success" icon="userAdd" disabled={!executorId} loading={busy} onClick={saveExecutor}>{t('inbox.assign')}</Button>
        </div>
      )}

      {error && <div style={{ marginTop: 'var(--spacing-2)' }}><Alert tone="danger">{error}</Alert></div>}
    </div>
  );
}
