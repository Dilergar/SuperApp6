'use client';

// «Процессы» организации: вкладка конструктора (определения) + «Журнал» (запущенные).
// Канвас рядовым не показывается — они живут в задачах/уведомлениях; сюда заходят
// менеджеры (строить) и участники (смотреть свои запуски в Журнале).

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { api } from '@/lib/api';
import {
  fetchProcessInbox,
  fetchProcessInstances,
  fetchProcessReport,
  fetchProcesses,
  processesKey,
  processInboxKey,
  processInstancesKey,
  processReportKey,
  workspaceKey,
} from '@/lib/queries';
import {
  PROCESS_INSTANCE_STATUS_LABELS,
  PROCESS_VERSION_STATUS_LABELS,
  WORKSPACE_ROLE_RANK,
  type ProcessDefinitionDto,
  type ProcessInboxItem,
  type ProcessInstanceDto,
  type Workspace,
  type WorkspaceRole,
} from '@superapp/shared';
import { PersonChip } from '@/app/circles/PersonCard';
import { humanizeDuration, INSTANCE_STATUS_BADGE } from './process-lib';

export default function ProcessesPage() {
  const { isReady } = useRequireAuth();
  const { id: wsId } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'defs' | 'inbox' | 'journal' | 'analytics'>('defs');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  const { data: ws } = useQuery({
    queryKey: workspaceKey(wsId),
    queryFn: async () => (await api.get(`/workspaces/${wsId}`)).data.data as Workspace,
    enabled: isReady,
  });
  const myRank = WORKSPACE_ROLE_RANK[(ws?.myRole ?? 'trainee') as WorkspaceRole] ?? 0;
  const canEdit = myRank >= WORKSPACE_ROLE_RANK.manager;

  const { data: defs, isLoading } = useQuery({
    queryKey: processesKey(wsId),
    queryFn: () => fetchProcesses(wsId),
    enabled: isReady,
  });
  const { data: instances } = useQuery({
    queryKey: processInstancesKey(wsId),
    queryFn: () => fetchProcessInstances(wsId),
    enabled: isReady && tab === 'journal',
    refetchInterval: 5000,
  });
  const { data: inbox } = useQuery({
    queryKey: processInboxKey(wsId),
    queryFn: () => fetchProcessInbox(wsId),
    enabled: isReady,
    refetchInterval: tab === 'inbox' ? 8000 : false,
  });

  const [createError, setCreateError] = useState<string | null>(null);
  const createMut = useMutation({
    mutationFn: async (name: string) =>
      (await api.post(`/workspaces/${wsId}/processes`, { name })).data.data as { id: string },
    onSuccess: (def) => {
      void qc.invalidateQueries({ queryKey: processesKey(wsId) });
      router.push(`/workspaces/${wsId}/processes/${def.id}`);
    },
    onError: (e) => {
      const r = e as { response?: { data?: { message?: string } } };
      setCreateError(r.response?.data?.message ?? 'Не удалось создать процесс');
    },
  });

  const running = useMemo(() => (defs ?? []).reduce((acc, d) => acc + d.runningCount, 0), [defs]);

  if (!isReady) return <p className="label-md">Загрузка…</p>;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 'var(--spacing-4)', marginBottom: 'var(--spacing-8)' }}>
        <div>
          <h1 className="display-md" style={{ fontSize: '1.9rem' }}>Процессы</h1>
          <p className="label-md">Конструктор бизнес-процессов: задачи отделам, согласования, автоматизация</p>
        </div>
        {canEdit && tab === 'defs' && (
          <button className="btn-primary" style={{ padding: '0.55rem 1.3rem' }} onClick={() => setCreating(true)}>
            + Новый процесс
          </button>
        )}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-6)', flexWrap: 'wrap' }}>
        {([
          ['defs', 'Процессы'],
          ['inbox', `Входящие${inbox && inbox.length ? ` · ${inbox.length}` : ''}`],
          ['journal', `Журнал${running ? ` · ${running} идёт` : ''}`],
          ...(canEdit ? [['analytics', 'Аналитика'] as const] : []),
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className="title-md"
            style={{
              padding: '0.45rem 1.1rem',
              fontSize: '0.85rem',
              borderRadius: '0.8rem 0.5rem 0.9rem 0.6rem',
              background: tab === key ? 'var(--secondary-container)' : 'transparent',
              opacity: tab === key ? 1 : 0.6,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {creating && (
        <div className="card-elevated" style={{ marginBottom: 'var(--spacing-6)', display: 'flex', gap: 'var(--spacing-3)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 16rem' }}>
            <label className="label-md" style={{ display: 'block', marginBottom: '0.3rem' }}>Название процесса</label>
            <input
              className="input-sketch"
              style={{ width: '100%' }}
              value={newName}
              autoFocus
              placeholder="Например: Замена техники"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && newName.trim() && !createMut.isPending) createMut.mutate(newName.trim()); }}
            />
          </div>
          <button
            className="btn-primary"
            style={{ padding: '0.5rem 1.2rem' }}
            disabled={!newName.trim() || createMut.isPending}
            onClick={() => createMut.mutate(newName.trim())}
          >
            {createMut.isPending ? 'Создаю…' : 'Создать'}
          </button>
          <button className="btn-secondary" style={{ padding: '0.5rem 1rem' }} onClick={() => setCreating(false)}>
            Отмена
          </button>
          {createError && <p className="label-md" style={{ flexBasis: '100%', color: 'var(--primary)', fontSize: '0.78rem' }}>{createError}</p>}
        </div>
      )}

      {tab === 'defs' ? (
        isLoading ? (
          <p className="label-md">Загрузка…</p>
        ) : (defs ?? []).length === 0 ? (
          <div className="card" style={{ textAlign: 'center', padding: 'var(--spacing-12)' }}>
            <div style={{ fontSize: '2rem', marginBottom: 'var(--spacing-3)' }}>🧩</div>
            <p className="title-md" style={{ marginBottom: 'var(--spacing-2)' }}>Процессов пока нет</p>
            <p className="label-md">
              {canEdit ? 'Создайте первый: нарисуйте цепочку задач и согласований на канвасе.' : 'Когда менеджеры создадут процессы, они появятся здесь.'}
            </p>
          </div>
        ) : (
          <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-6)' }}>
            {(defs ?? []).map((d, i) => (
              <Link
                key={d.id}
                href={`/workspaces/${wsId}/processes/${d.id}`}
                className="card-elevated"
                style={{ display: 'block', transform: `rotate(${i % 2 === 0 ? '-0.4' : '0.35'}deg)` }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--spacing-3)', alignItems: 'flex-start' }}>
                  <div className="title-md">{d.name}</div>
                  <span
                    className="label-md"
                    style={{
                      fontSize: '0.68rem',
                      fontWeight: 700,
                      padding: '0.15rem 0.6rem',
                      borderRadius: '0.6rem 0.4rem 0.7rem 0.5rem',
                      background: d.hasPublished ? '#dff0e4' : 'var(--surface-container-high)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {d.hasPublished ? 'Опубликован' : PROCESS_VERSION_STATUS_LABELS[d.latestVersionStatus]}
                  </span>
                </div>
                {d.description && (
                  <p className="label-md" style={{ marginTop: 'var(--spacing-2)' }}>{d.description}</p>
                )}
                <div style={{ display: 'flex', gap: 'var(--spacing-4)', marginTop: 'var(--spacing-4)', flexWrap: 'wrap' }}>
                  <span className="label-md" style={{ fontSize: '0.75rem' }}>v{d.latestVersion}</span>
                  {d.runningCount > 0 && (
                    <span className="label-md" style={{ fontSize: '0.75rem', color: '#b07414', fontWeight: 700 }}>
                      ● идёт: {d.runningCount}
                    </span>
                  )}
                  {d.visibility === 'admins' && (
                    <span className="label-md" style={{ fontSize: '0.75rem' }}>🔒 только админы</span>
                  )}
                </div>
              </Link>
            ))}
          </div>
        )
      ) : tab === 'inbox' ? (
        <InboxList wsId={wsId} items={inbox ?? []} />
      ) : tab === 'analytics' ? (
        <Analytics wsId={wsId} defs={defs ?? []} />
      ) : (
        <JournalTable wsId={wsId} instances={instances ?? []} />
      )}
    </div>
  );
}

function InboxList({ wsId, items }: { wsId: string; items: ProcessInboxItem[] }) {
  const qc = useQueryClient();
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: processInboxKey(wsId) });
    void qc.invalidateQueries({ queryKey: processInstancesKey(wsId) });
  };
  const onErr = (e: unknown) => setErr((e as { response?: { data?: { message?: string } } }).response?.data?.message ?? 'Ошибка');
  const claimMut = useMutation({
    mutationFn: async (it: ProcessInboxItem) =>
      (await api.post(`/workspaces/${wsId}/processes/instances/${it.instanceId}/steps/${it.stepId}/claim`)).data.data as { taskId: string },
    onSuccess: (d) => { refresh(); router.push(`/tasks/${d.taskId}`); },
    onError: onErr,
  });
  const decideMut = useMutation({
    mutationFn: async (v: { it: ProcessInboxItem; decision: 'approved' | 'rejected' }) =>
      api.post(`/workspaces/${wsId}/processes/instances/${v.it.instanceId}/steps/${v.it.stepId}/decide`, { decision: v.decision }),
    onSuccess: refresh,
    onError: onErr,
  });
  if (items.length === 0) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: 'var(--spacing-12)' }}>
        <div style={{ fontSize: '2rem', marginBottom: 'var(--spacing-3)' }}>📥</div>
        <p className="label-md">Входящих задач и согласований нет</p>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
      {err && <p className="label-md" style={{ color: 'var(--primary)' }}>{err}</p>}
      {items.map((it) => (
        <div key={it.stepId} className="card" style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-4)', flexWrap: 'wrap', boxShadow: it.overdue ? '0 0 0 2px var(--primary)' : undefined }}>
          <span style={{ fontSize: '0.7rem', fontWeight: 700, padding: '0.2rem 0.65rem', borderRadius: '0.6rem 0.4rem 0.7rem 0.5rem', background: it.kind === 'approve' ? '#dff0e4' : '#f6e3bd', color: it.kind === 'approve' ? '#27563a' : '#7a4f10' }}>
            {it.kind === 'approve' ? 'Одобрение' : 'Задача отдела'}
          </span>
          <div style={{ flex: '1 1 14rem', minWidth: 0 }}>
            <div className="title-md" style={{ fontSize: '0.92rem' }}>{it.title}</div>
            <div className="label-md" style={{ fontSize: '0.76rem' }}>
              «{it.processName}»{it.departmentName ? ` · ${it.departmentName}` : ''}{it.overdue ? ' · ⏰ просрочено' : ''}
            </div>
            {it.detail && <div className="label-md" style={{ fontSize: '0.74rem', opacity: 0.8 }}>{it.detail}</div>}
          </div>
          <PersonChip size="S" userId={it.startedBy.id} firstName={it.startedBy.firstName} lastName={it.startedBy.lastName} />
          {it.kind === 'claim' ? (
            <button className="btn-primary" style={{ padding: '0.35rem 1rem', fontSize: '0.78rem' }} disabled={claimMut.isPending} onClick={() => claimMut.mutate(it)}>📥 Забрать</button>
          ) : (
            <div style={{ display: 'flex', gap: '0.4rem' }}>
              <button className="btn-primary" style={{ padding: '0.35rem 0.8rem', fontSize: '0.76rem' }} disabled={decideMut.isPending} onClick={() => decideMut.mutate({ it, decision: 'approved' })}>✓ Одобрить</button>
              <button className="btn-secondary" style={{ padding: '0.35rem 0.8rem', fontSize: '0.76rem' }} disabled={decideMut.isPending} onClick={() => decideMut.mutate({ it, decision: 'rejected' })}>✕ Отклонить</button>
            </div>
          )}
          <Link href={`/workspaces/${wsId}/processes/instances/${it.instanceId}`} className="label-md" style={{ fontSize: '0.74rem', fontWeight: 700, color: 'var(--secondary)' }}>процесс →</Link>
        </div>
      ))}
    </div>
  );
}

function Analytics({ wsId, defs }: { wsId: string; defs: ProcessDefinitionDto[] }) {
  const [selected, setSelected] = useState<string | null>(defs[0]?.id ?? null);
  const { data: report, isLoading } = useQuery({
    queryKey: processReportKey(wsId, selected ?? ''),
    queryFn: () => fetchProcessReport(wsId, selected!),
    enabled: !!selected,
  });
  if (defs.length === 0) return <div className="card" style={{ textAlign: 'center', padding: 'var(--spacing-12)' }}><p className="label-md">Сначала создайте процесс</p></div>;
  return (
    <div>
      <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap', marginBottom: 'var(--spacing-5)' }}>
        {defs.map((d) => (
          <button key={d.id} onClick={() => setSelected(d.id)} className="label-md" style={{ padding: '0.35rem 0.9rem', fontSize: '0.78rem', fontWeight: 700, borderRadius: '0.7rem 0.5rem 0.8rem 0.55rem', background: selected === d.id ? 'var(--secondary-container)' : 'var(--surface-container)', opacity: selected === d.id ? 1 : 0.7 }}>{d.name}</button>
        ))}
      </div>
      {isLoading || !report ? (
        <p className="label-md">Загрузка…</p>
      ) : report.rows.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 'var(--spacing-10)' }}><p className="label-md">Нет завершённых шагов для статистики. Запустите и пройдите процесс.</p></div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 'var(--spacing-6)', flexWrap: 'wrap', marginBottom: 'var(--spacing-5)' }}>
            <StatTile label="Завершено процессов" value={report.finishedInstances} />
            <StatTile label="Среднее время процесса" value={humanizeDuration(report.avgCycleMs)} />
          </div>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: 0, padding: '0.6rem 1rem', background: 'var(--surface-container-high)', fontSize: '0.72rem', fontWeight: 700 }}>
              <span>Шаг</span><span style={{ textAlign: 'right' }}>Среднее</span><span style={{ textAlign: 'right' }}>Максимум</span><span style={{ textAlign: 'right' }}>Раз</span>
            </div>
            {report.rows.map((r) => (
              <div key={r.nodeId} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: 0, padding: '0.6rem 1rem', borderTop: '1px solid var(--surface-container-high)' }}>
                <span className="label-md" style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--on-surface)' }}>
                  {r.label}{r.departmentName ? <span style={{ opacity: 0.7 }}> · {r.departmentName}</span> : ''}
                </span>
                <span className="label-md" style={{ fontSize: '0.8rem', textAlign: 'right', fontWeight: 700 }}>{humanizeDuration(r.avgMs)}</span>
                <span className="label-md" style={{ fontSize: '0.8rem', textAlign: 'right' }}>{humanizeDuration(r.maxMs)}</span>
                <span className="label-md" style={{ fontSize: '0.8rem', textAlign: 'right' }}>{r.count}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="card" style={{ textAlign: 'center', minWidth: '10rem' }}>
      <div className="display-md" style={{ color: 'var(--primary)', fontSize: '1.7rem' }}>{value}</div>
      <div className="label-md" style={{ marginTop: 'var(--spacing-1)', fontSize: '0.74rem' }}>{label}</div>
    </div>
  );
}

function JournalTable({ wsId, instances }: { wsId: string; instances: ProcessInstanceDto[] }) {
  if (instances.length === 0) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: 'var(--spacing-12)' }}>
        <p className="label-md">Запущенных процессов пока нет</p>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
      {instances.map((inst) => (
        <Link
          key={inst.id}
          href={`/workspaces/${wsId}/processes/instances/${inst.id}`}
          className="card"
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-5)', flexWrap: 'wrap' }}
        >
          <span
            title={inst.error ?? undefined}
            style={{
              fontSize: '0.7rem',
              fontWeight: 700,
              color: (INSTANCE_STATUS_BADGE[inst.status] ?? { fg: 'var(--on-surface)' }).fg,
              padding: '0.2rem 0.65rem',
              borderRadius: '0.6rem 0.4rem 0.7rem 0.5rem',
              background: (INSTANCE_STATUS_BADGE[inst.status] ?? { bg: 'var(--surface-container-high)' }).bg,
              whiteSpace: 'nowrap',
            }}
          >
            {PROCESS_INSTANCE_STATUS_LABELS[inst.status]}
          </span>
          <div style={{ flex: '1 1 14rem', minWidth: 0 }}>
            <div className="title-md" style={{ fontSize: '0.95rem' }}>{inst.definitionName} <span className="label-md" style={{ fontSize: '0.72rem' }}>v{inst.version}</span></div>
            {inst.currentSteps.length > 0 && (
              <div className="label-md" style={{ fontSize: '0.78rem' }}>сейчас: {inst.currentSteps.join(', ')}</div>
            )}
            {inst.error && <div className="label-md" style={{ fontSize: '0.78rem', color: 'var(--primary)' }}>{inst.error}</div>}
          </div>
          <PersonChip size="S" userId={inst.startedBy.id} firstName={inst.startedBy.firstName} lastName={inst.startedBy.lastName} />
          <div className="label-md" style={{ fontSize: '0.78rem', textAlign: 'right' }}>
            <div>{new Date(inst.startedAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
            <div>{inst.finishedAt ? `длился ${humanizeDuration(inst.durationMs)}` : `идёт ${humanizeDuration(Date.now() - new Date(inst.startedAt).getTime())}`}</div>
          </div>
        </Link>
      ))}
    </div>
  );
}
