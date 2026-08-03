'use client';

// Карточка запущенного процесса: живой канвас (статусы шагов на нодах),
// «секундомер» по шагам, анкета, отмена. Автообновление, пока процесс идёт.

import { useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { api, apiErrorMessage } from '@/lib/api';
import {
  fetchProcessInstance,
  fetchProcessInstanceStatus,
  fetchProcessNodeTypes,
  processInstanceKey,
  processInstanceStatusKey,
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
import {
  Alert, BentoGrid, Button, Card, CardHeader, Chip, ConfirmDialog, EmptyState, Input, LoadingBlock,
  Modal, PageHeader, StatusDot,
} from '@/components/ui';
import { ProcessCanvas } from '../../ProcessCanvas';
import {
  docToFlow,
  humanizeDuration,
  INSTANCE_STATUS_TONE,
  STEP_STATUS_TONE,
} from '../../process-lib';

export default function ProcessInstancePage() {
  const { isReady } = useRequireAuth();
  const { id: wsId, instId } = useParams<{ id: string; instId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  // Деталь (документ/анкета/канвас) — тянем ОДИН раз; статусы шагов — тонким эндпоинтом
  // на 4с-поллинге (P7): не перекачиваем документ и output-блобы каждые 4 секунды.
  const detailQ = useQuery({
    queryKey: processInstanceKey(wsId, instId),
    queryFn: () => fetchProcessInstance(wsId, instId),
    enabled: isReady,
  });
  const statusQ = useQuery({
    queryKey: processInstanceStatusKey(wsId, instId),
    queryFn: () => fetchProcessInstanceStatus(wsId, instId),
    enabled: isReady,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 4000 : false),
  });
  const typesQ = useQuery({
    // Карточке запуска нужны ПОДПИСИ и иконки нод, а не палитра для рисования:
    // профиль здесь не режем, иначе нода чужой области осталась бы без имени.
    queryKey: processNodeTypesKey(wsId),
    queryFn: () => fetchProcessNodeTypes(wsId),
    enabled: isReady,
    staleTime: 5 * 60_000,
  });

  // Волатильные поля (статус/шаги/canCancel) из тонкого статуса накладываем на деталь.
  const inst = useMemo(
    () => (detailQ.data ? { ...detailQ.data, ...(statusQ.data ?? {}) } : undefined),
    [detailQ.data, statusQ.data],
  );
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
    void qc.invalidateQueries({ queryKey: processInstanceStatusKey(wsId, instId) });
    void qc.invalidateQueries({ queryKey: processInstancesKey(wsId) });
    void qc.invalidateQueries({ queryKey: ['workspaces', wsId, 'processes', 'inbox'] });
  };
  const onMutError = (e: unknown) => setCancelError(apiErrorMessage(e));

  const cancelMut = useMutation({
    mutationFn: async () => api.post(`/workspaces/${wsId}/processes/instances/${instId}/cancel`),
    onSuccess: () => { setConfirmCancel(false); refresh(); },
    onError: (e) => { setConfirmCancel(false); onMutError(e); },
  });
  // Отказ и возврат требуют причины (правило движка согласований — одно на все
  // поверхности). Первый клик раскрывает поле, второй отправляет: иначе кнопка
  // молча упиралась бы в отказ сервера.
  const [rejectFor, setRejectFor] = useState<{ stepId: string; decision: 'rejected' | 'returned' } | null>(null);
  const [rejectWhy, setRejectWhy] = useState('');
  const decideMut = useMutation({
    mutationFn: async (v: { stepId: string; decision: 'approved' | 'rejected' | 'returned'; comment?: string }) =>
      api.post(`/workspaces/${wsId}/processes/instances/${instId}/steps/${v.stepId}/decide`, {
        decision: v.decision,
        ...(v.comment ? { comment: v.comment } : {}),
      }),
    onSuccess: () => { setRejectFor(null); setRejectWhy(''); refresh(); },
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

  if (!isReady || detailQ.isLoading) return <LoadingBlock />;

  if (detailQ.isError || !inst) {
    return (
      <>
        <PageHeader breadcrumb="Процессы" title="Запуск процесса" />
        <BentoGrid>
          <Card span={12}>
            <EmptyState
              icon="warningCircle"
              title="Процесс не найден"
              description="Возможно, он удалён или у вас нет доступа."
              action={<Button variant="matte" icon="arrowLeft" href={`/workspaces/${wsId}/processes`}>К процессам</Button>}
            />
          </Card>
        </BentoGrid>
      </>
    );
  }

  return (
    <>
      <PageHeader
        breadcrumb="Процессы"
        title={
          <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: '0.5rem', flexWrap: 'wrap' }}>
            {inst.definitionName}
            <span className="label-sm">v{inst.version}</span>
          </span>
        }
        chip={
          <Chip tone={INSTANCE_STATUS_TONE[inst.status] ?? 'neutral'}>
            {PROCESS_INSTANCE_STATUS_LABELS[inst.status]}
          </Chip>
        }
        actions={
          <>
            {/* Контурная: шапка страницы лежит на фоне, а не на блоке */}
            <Button variant="outline" icon="arrowLeft" href={`/workspaces/${wsId}/processes`}>Процессы</Button>
            {inst.canCancel && (
              <Button variant="matte" tone="danger" icon="close" loading={cancelMut.isPending} onClick={() => setConfirmCancel(true)}>
                Отменить
              </Button>
            )}
          </>
        }
      />

      {(inst.error || cancelError) && (
        <div style={{ marginBottom: 'var(--gap-grid)' }}>
          <Alert tone="danger" onClose={cancelError ? () => setCancelError(null) : undefined}>
            {cancelError ?? inst.error}
          </Alert>
        </div>
      )}

      <BentoGrid>
        {/* ---------- Факты запуска ---------- */}
        <Card span={12} small>
          <div style={{ display: 'flex', gap: 'var(--spacing-6)', flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
              <span className="label-caps">Запустил</span>
              <PersonChip size="S" userId={inst.startedBy.id} firstName={inst.startedBy.firstName} lastName={inst.startedBy.lastName} />
            </span>
            <span className="body-sm">
              {new Date(inst.startedAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}
            </span>
            <span className="title-sm">
              {inst.finishedAt
                ? `Длился ${humanizeDuration(inst.durationMs)}`
                : `Идёт ${humanizeDuration(Date.now() - new Date(inst.startedAt).getTime())}`}
            </span>
          </div>
        </Card>

        {/* ---------- Канвас со статусами ---------- */}
        <Card span={12} style={{ padding: 0, overflow: 'hidden' }}>
          <ProcessCanvas nodes={nodes} edges={edges} editable={false} height="52vh" withMiniMap />
        </Card>

        {/* ---------- Шаги: «секундомер отделов» ---------- */}
        <Card span={8}>
          <CardHeader title="Шаги" subtitle="Сколько каждый шаг занял и кто его вёл" />
          <div className="density-compact ui-stack" style={{ gap: '0.375rem' }}>
            {inst.steps.map((s) => {
              const queued = s.status === 'active' && !!s.departmentId && !s.taskId;
              const decision = s.decision === 'approved' ? 'одобрено' : s.decision === 'rejected' ? 'отклонено' : null;
              return (
                <div
                  key={s.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', flexWrap: 'wrap',
                    padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-md)',
                    border: `1px solid ${s.overdue ? 'var(--danger-base)' : 'var(--divider)'}`,
                  }}
                >
                  <StatusDot tone={STEP_STATUS_TONE[s.status]} size={9} title={PROCESS_STEP_STATUS_LABELS[s.status]} />
                  <div style={{ flex: '1 1 10rem', minWidth: 0 }}>
                    <div className="title-sm">{s.label}</div>
                    <div className="label-sm">
                      <span style={{ fontWeight: 600 }}>{queued ? 'В очереди отдела' : PROCESS_STEP_STATUS_LABELS[s.status]}</span>
                      {s.departmentName ? ` · ${s.departmentName}` : ''}
                      {decision ? ` · ${decision}` : ''}
                      {s.outcome && s.nodeType === 'condition' ? ` · ветка «${s.outcome === 'true' ? 'Да' : 'Нет'}»` : ''}
                      {s.overdue
                        ? ' · просрочен'
                        : s.deadlineAt && s.status === 'active'
                          ? ` · срок ${new Date(s.deadlineAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
                          : ''}
                      {s.error ? ` · ${s.error}` : ''}
                    </div>
                  </div>
                  {s.canDecide && (
                    <span style={{ display: 'flex', gap: '0.375rem', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      {rejectFor?.stepId === s.id && (
                        <Input
                          label="Причина"
                          value={rejectWhy}
                          onChange={(e) => setRejectWhy(e.target.value)}
                          placeholder="Что именно поправить"
                          autoFocus
                          style={{ minWidth: 220 }}
                        />
                      )}
                      <Button variant="primary" tone="success" size="sm" icon="check" disabled={decideMut.isPending} onClick={() => decideMut.mutate({ stepId: s.id, decision: 'approved' })}>
                        Согласовать
                      </Button>
                      <Button
                        variant="matte"
                        tone="danger"
                        size="sm"
                        icon="close"
                        disabled={decideMut.isPending || (rejectFor?.stepId === s.id && rejectFor.decision === 'rejected' && !rejectWhy.trim())}
                        onClick={() => {
                          if (rejectFor?.stepId === s.id && rejectFor.decision === 'rejected') {
                            decideMut.mutate({ stepId: s.id, decision: 'rejected', comment: rejectWhy.trim() });
                          } else {
                            setRejectFor({ stepId: s.id, decision: 'rejected' });
                            setRejectWhy('');
                          }
                        }}
                      >
                        Отклонить
                      </Button>
                      <Button
                        variant="matte"
                        size="sm"
                        icon="arrowLeft"
                        disabled={decideMut.isPending || (rejectFor?.stepId === s.id && rejectFor.decision === 'returned' && !rejectWhy.trim())}
                        onClick={() => {
                          if (rejectFor?.stepId === s.id && rejectFor.decision === 'returned') {
                            decideMut.mutate({ stepId: s.id, decision: 'returned', comment: rejectWhy.trim() });
                          } else {
                            setRejectFor({ stepId: s.id, decision: 'returned' });
                            setRejectWhy('');
                          }
                        }}
                      >
                        На доработку
                      </Button>
                    </span>
                  )}
                  {s.canClaim && (
                    <Button variant="primary" tone="success" size="sm" icon="download" disabled={claimMut.isPending} onClick={() => claimMut.mutate(s.id)}>
                      Забрать
                    </Button>
                  )}
                  {s.canReassign && (
                    <Button variant="ghost" size="sm" icon="refresh" onClick={() => setReassignFor(s.id)}>Переназначить</Button>
                  )}
                  {s.assignee && <PersonChip size="S" userId={s.assignee.id} firstName={s.assignee.firstName} lastName={s.assignee.lastName} />}
                  {s.taskId && (
                    <Button variant="ghost" size="sm" iconRight="caretRight" href={`/tasks/${s.taskId}`}>задача</Button>
                  )}
                  <div className="label-sm" style={{ textAlign: 'right' }}>
                    <div>
                      {new Date(s.startedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                      {s.completedAt ? ` → ${new Date(s.completedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` : ''}
                    </div>
                    <div style={{ fontWeight: 700 }}>
                      {s.completedAt ? humanizeDuration(s.durationMs) : humanizeDuration(Date.now() - new Date(s.startedAt).getTime())}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        {/* ---------- Анкета ---------- */}
        <Card span={4}>
          <CardHeader title="Анкета процесса" subtitle="Значения, с которыми процесс запустили" />
          {Object.keys(inst.variables).length === 0 ? (
            <EmptyState icon="empty" title="Анкета пуста" />
          ) : (
            <div className="ui-stack" style={{ gap: 'var(--spacing-3)' }}>
              {Object.entries(inst.variables).map(([k, v]) => (
                <div key={k}>
                  <div className="label-caps">{k}</div>
                  <div className="title-sm" style={{ wordBreak: 'break-word' }}>
                    {typeof v === 'boolean' ? (v ? 'да' : 'нет') : String(v)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </BentoGrid>

      {reassignFor && (
        <Modal
          open
          onClose={() => setReassignFor(null)}
          title="Переназначить исполнителя"
          subtitle="Награда за задачу перемораживается на нового исполнителя"
          size="sm"
          footer={<Button variant="ghost" onClick={() => setReassignFor(null)}>Отмена</Button>}
        >
          <EntitySelector
            value={[]}
            onChange={(next: Principal[]) => { if (next[0]) reassignMut.mutate({ stepId: reassignFor, userId: next[0].id }); }}
            multi={false}
            options={memberOptions}
            placeholder="Выберите нового исполнителя…"
          />
        </Modal>
      )}

      <ConfirmDialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        onConfirm={() => cancelMut.mutate()}
        title="Отменить процесс?"
        message="Открытые задачи-шаги будут отменены, процесс закроется как отменённый."
        confirmLabel="Отменить процесс"
        cancelLabel="Пусть идёт"
        danger
        loading={cancelMut.isPending}
      />
    </>
  );
}
