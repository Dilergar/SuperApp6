'use client';

// Карточка запущенного процесса: живой канвас (статусы шагов на нодах),
// «секундомер» по шагам, анкета, отмена. Автообновление, пока процесс идёт.

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { api } from '@/lib/api';
import {
  fetchProcessInstance,
  fetchProcessNodeTypes,
  processInstanceKey,
  processInstancesKey,
  processNodeTypesKey,
  workspaceMembersKey,
} from '@/lib/queries';
import {
  PROCESS_INSTANCE_STATUS_LABELS,
  PROCESS_STEP_STATUS_LABELS,
  type ProcessStepStatus,
  type WorkspaceMember,
} from '@superapp/shared';
import { EntitySelector } from '@/components/EntitySelector';
import type { EntityOption, Principal } from '@/lib/entities';
import { PersonChip } from '@/app/circles/PersonCard';
import { ProcessCanvas } from '../../ProcessCanvas';
import {
  docToFlow,
  humanizeDuration,
  INSTANCE_STATUS_BADGE,
  STEP_STATUS_BADGE,
  STEP_STATUS_COLORS,
} from '../../process-lib';

export default function ProcessInstancePage() {
  const { isReady } = useRequireAuth();
  const { id: wsId, instId } = useParams<{ id: string; instId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const [cancelError, setCancelError] = useState<string | null>(null);

  const instQ = useQuery({
    queryKey: processInstanceKey(wsId, instId),
    queryFn: () => fetchProcessInstance(wsId, instId),
    enabled: isReady,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 4000 : false),
  });
  const typesQ = useQuery({
    queryKey: processNodeTypesKey(wsId),
    queryFn: () => fetchProcessNodeTypes(wsId),
    enabled: isReady,
    staleTime: 5 * 60_000,
  });

  const inst = instQ.data;
  const typeMap = useMemo(() => new Map((typesQ.data ?? []).map((t) => [t.type, t])), [typesQ.data]);
  const [reassignFor, setReassignFor] = useState<string | null>(null);
  const membersQ = useQuery({
    queryKey: workspaceMembersKey(wsId),
    queryFn: async () => (await api.get(`/workspaces/${wsId}/members`)).data.data as WorkspaceMember[],
    enabled: isReady && !!reassignFor,
    staleTime: 60_000,
  });
  const memberOptions: EntityOption[] = useMemo(
    () => (membersQ.data ?? []).map((m) => {
      const [fn, ...rest] = (m.userName || '?').split(' ');
      return { type: 'user', id: m.userId, title: m.userName, firstName: m.card?.firstName ?? fn, lastName: m.card?.lastName ?? (rest.join(' ') || null) } as EntityOption;
    }),
    [membersQ.data],
  );

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: processInstanceKey(wsId, instId) });
    void qc.invalidateQueries({ queryKey: processInstancesKey(wsId) });
    void qc.invalidateQueries({ queryKey: ['workspaces', wsId, 'processes', 'inbox'] });
  };
  const onMutError = (e: unknown) => {
    const r = e as { response?: { data?: { message?: string } } };
    setCancelError(r.response?.data?.message ?? 'Не удалось выполнить действие');
  };

  const cancelMut = useMutation({
    mutationFn: async () => api.post(`/workspaces/${wsId}/processes/instances/${instId}/cancel`),
    onSuccess: refresh,
    onError: onMutError,
  });
  const decideMut = useMutation({
    mutationFn: async (v: { stepId: string; decision: 'approved' | 'rejected' }) =>
      api.post(`/workspaces/${wsId}/processes/instances/${instId}/steps/${v.stepId}/decide`, { decision: v.decision }),
    onSuccess: refresh,
    onError: onMutError,
  });
  const claimMut = useMutation({
    mutationFn: async (stepId: string) =>
      (await api.post(`/workspaces/${wsId}/processes/instances/${instId}/steps/${stepId}/claim`)).data.data as { taskId: string },
    onSuccess: (data) => { refresh(); router.push(`/tasks/${data.taskId}`); },
    onError: onMutError,
  });
  const reassignMut = useMutation({
    mutationFn: async (v: { stepId: string; userId: string }) =>
      api.post(`/workspaces/${wsId}/processes/instances/${instId}/steps/${v.stepId}/reassign`, { userId: v.userId }),
    onSuccess: () => { setReassignFor(null); refresh(); },
    onError: onMutError,
  });

  // Счётчик попыток на ноду (циклы): сколько раз шаг этой ноды запускался.
  const attempts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of inst?.steps ?? []) m.set(s.nodeId, (m.get(s.nodeId) ?? 0) + 1);
    return m;
  }, [inst?.steps]);

  // Дайджест статусов — чтобы канвас НЕ пересобирался каждый поллинг (только при смене статусов).
  const stepDigest = useMemo(
    () => (inst?.steps ?? []).map((s) => `${s.nodeId}:${s.status}:${s.durationMs ?? ''}`).join('|'),
    [inst?.steps],
  );
  const { nodes, edges } = useMemo(() => {
    if (!inst) return { nodes: [], edges: [] };
    const stepState = new Map<string, { status: ProcessStepStatus; badge?: string }>();
    for (const s of inst.steps) {
      const n = attempts.get(s.nodeId) ?? 1;
      const dur = s.status === 'done' && s.durationMs !== null ? ` · ${humanizeDuration(s.durationMs)}` : '';
      stepState.set(s.nodeId, {
        status: s.status,
        badge: `${PROCESS_STEP_STATUS_LABELS[s.status]}${n > 1 ? ` ×${n}` : ''}${dur}`,
      });
    }
    return docToFlow(inst.document, typeMap, stepState);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inst?.id, stepDigest, typeMap]);

  if (!isReady || instQ.isLoading) return <p className="label-md">Загрузка…</p>;
  if (instQ.isError || !inst) return <p className="label-md">Процесс не найден</p>;

  const statusBadge = INSTANCE_STATUS_BADGE[inst.status] ?? { bg: 'var(--surface-container-high)', fg: 'var(--on-surface)' };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-4)', flexWrap: 'wrap', marginBottom: 'var(--spacing-6)' }}>
        <button className="label-md" style={{ opacity: 0.7 }} onClick={() => router.push(`/workspaces/${wsId}/processes`)}>
          ← Процессы
        </button>
        <h1 className="display-md" style={{ fontSize: '1.5rem', flex: '1 1 auto' }}>
          {inst.definitionName} <span className="label-md" style={{ fontSize: '0.8rem' }}>v{inst.version}</span>
        </h1>
        <span style={{ fontSize: '0.75rem', fontWeight: 700, color: statusBadge.fg, padding: '0.25rem 0.8rem', borderRadius: '0.7rem 0.5rem 0.8rem 0.55rem', background: statusBadge.bg }}>
          {PROCESS_INSTANCE_STATUS_LABELS[inst.status]}
        </span>
        {inst.canCancel && (
          <button
            className="btn-secondary"
            style={{ padding: '0.4rem 1rem', fontSize: '0.78rem' }}
            disabled={cancelMut.isPending}
            onClick={() => confirm('Отменить процесс? Открытые задачи будут отменены.') && cancelMut.mutate()}
          >
            ✕ Отменить
          </button>
        )}
      </div>

      {(inst.error || cancelError) && (
        <div className="card" style={{ marginBottom: 'var(--spacing-5)', background: 'var(--primary-container)' }}>
          <span className="label-md" style={{ fontWeight: 700 }}>⚠ {cancelError ?? inst.error}</span>
        </div>
      )}

      {/* Шапка-факты */}
      <div style={{ display: 'flex', gap: 'var(--spacing-6)', flexWrap: 'wrap', alignItems: 'center', marginBottom: 'var(--spacing-6)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span className="label-md" style={{ fontSize: '0.75rem' }}>Запустил:</span>
          <PersonChip size="S" userId={inst.startedBy.id} firstName={inst.startedBy.firstName} lastName={inst.startedBy.lastName} />
        </div>
        <span className="label-md" style={{ fontSize: '0.78rem' }}>
          {new Date(inst.startedAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}
        </span>
        <span className="label-md" style={{ fontSize: '0.78rem', fontWeight: 700 }}>
          {inst.finishedAt
            ? `Длился ${humanizeDuration(inst.durationMs)}`
            : `Идёт ${humanizeDuration(Date.now() - new Date(inst.startedAt).getTime())}`}
        </span>
      </div>

      <ProcessCanvas nodes={nodes} edges={edges} editable={false} height="52vh" withMiniMap />

      <div className="grid md:grid-cols-3" style={{ gap: 'var(--spacing-6)', marginTop: 'var(--spacing-8)', alignItems: 'start' }}>
        {/* Шаги — «секундомер отделов» */}
        <div className="md:col-span-2" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)' }}>
          <h2 className="title-lg" style={{ fontSize: '1rem' }}>Шаги</h2>
          {inst.steps.map((s) => {
            const badge = STEP_STATUS_BADGE[s.status];
            const queued = s.status === 'active' && !!s.departmentId && !s.taskId;
            const decision = s.decision === 'approved' ? 'одобрено' : s.decision === 'rejected' ? 'отклонено' : null;
            return (
              <div key={s.id} className="card" style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-4)', flexWrap: 'wrap', padding: '0.7rem 1rem', boxShadow: s.overdue ? '0 0 0 2px var(--primary)' : undefined }}>
                <span style={{ width: '0.7rem', height: '0.7rem', flexShrink: 0, borderRadius: '45% 55% 50% 60%', background: STEP_STATUS_COLORS[s.status] }} />
                <div style={{ flex: '1 1 10rem', minWidth: 0 }}>
                  <div className="title-md" style={{ fontSize: '0.86rem' }}>{s.label}</div>
                  <div className="label-md" style={{ fontSize: '0.7rem' }}>
                    <span style={{ color: badge.fg, fontWeight: 600 }}>{queued ? 'В очереди отдела' : PROCESS_STEP_STATUS_LABELS[s.status]}</span>
                    {s.departmentName ? ` · ${s.departmentName}` : ''}
                    {decision ? ` · ${decision}` : ''}
                    {s.outcome && s.nodeType === 'condition' ? ` · ветка «${s.outcome === 'true' ? 'Да' : 'Нет'}»` : ''}
                    {s.overdue ? ' · ⏰ просрочен' : s.deadlineAt && s.status === 'active' ? ` · срок ${new Date(s.deadlineAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}
                    {s.error ? ` · ${s.error}` : ''}
                  </div>
                </div>
                {s.canDecide && (
                  <div style={{ display: 'flex', gap: '0.4rem' }}>
                    <button className="btn-primary" style={{ padding: '0.3rem 0.8rem', fontSize: '0.74rem' }} disabled={decideMut.isPending} onClick={() => decideMut.mutate({ stepId: s.id, decision: 'approved' })}>✓ Одобрить</button>
                    <button className="btn-secondary" style={{ padding: '0.3rem 0.8rem', fontSize: '0.74rem' }} disabled={decideMut.isPending} onClick={() => decideMut.mutate({ stepId: s.id, decision: 'rejected' })}>✕ Отклонить</button>
                  </div>
                )}
                {s.canClaim && (
                  <button className="btn-primary" style={{ padding: '0.3rem 0.9rem', fontSize: '0.74rem' }} disabled={claimMut.isPending} onClick={() => claimMut.mutate(s.id)}>📥 Забрать</button>
                )}
                {s.canReassign && (
                  <button className="label-md" style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--secondary)' }} onClick={() => setReassignFor(s.id)}>↪ Переназначить</button>
                )}
                {s.assignee && <PersonChip size="S" userId={s.assignee.id} firstName={s.assignee.firstName} lastName={s.assignee.lastName} />}
                {s.taskId && (
                  <Link href={`/tasks/${s.taskId}`} className="label-md" style={{ fontSize: '0.74rem', fontWeight: 700, color: 'var(--secondary)' }}>→ задача</Link>
                )}
                <div className="label-md" style={{ fontSize: '0.72rem', textAlign: 'right' }}>
                  <div>{new Date(s.startedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}{s.completedAt ? ` → ${new Date(s.completedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` : ''}</div>
                  <div style={{ fontWeight: 700 }}>{s.completedAt ? humanizeDuration(s.durationMs) : humanizeDuration(Date.now() - new Date(s.startedAt).getTime())}</div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Анкета */}
        <div className="card" style={{ background: 'var(--surface-container)' }}>
          <h2 className="title-md" style={{ fontSize: '0.9rem', marginBottom: 'var(--spacing-3)' }}>Анкета процесса</h2>
          {Object.keys(inst.variables).length === 0 ? (
            <p className="label-md" style={{ fontSize: '0.76rem' }}>Пусто</p>
          ) : (
            Object.entries(inst.variables).map(([k, v]) => (
              <div key={k} style={{ marginBottom: 'var(--spacing-2)' }}>
                <div className="label-md" style={{ fontSize: '0.66rem', opacity: 0.7 }}>{k}</div>
                <div className="label-md" style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--on-surface)' }}>
                  {typeof v === 'boolean' ? (v ? 'да' : 'нет') : String(v)}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {reassignFor && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(56,57,45,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }} onClick={() => setReassignFor(null)}>
          <div className="card-elevated" style={{ width: '24rem', maxWidth: '100%', background: 'var(--surface)' }} onClick={(e) => e.stopPropagation()}>
            <div className="title-lg" style={{ fontSize: '1.05rem', marginBottom: 'var(--spacing-4)' }}>↪ Переназначить исполнителя</div>
            <EntitySelector
              value={[]}
              onChange={(next: Principal[]) => { if (next[0]) reassignMut.mutate({ stepId: reassignFor, userId: next[0].id }); }}
              multi={false}
              options={memberOptions}
              placeholder="Выберите нового исполнителя…"
            />
            <div style={{ marginTop: 'var(--spacing-5)' }}>
              <button className="btn-secondary" style={{ padding: '0.45rem 1.1rem' }} onClick={() => setReassignFor(null)}>Отмена</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
