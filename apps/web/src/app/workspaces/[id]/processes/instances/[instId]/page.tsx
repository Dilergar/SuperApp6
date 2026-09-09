'use client';

// Карточка запущенного процесса: живой канвас (статусы шагов на нодах),
// «секундомер» по шагам, анкета, отмена. Автообновление, пока процесс идёт.

import { useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { apiErrorMessage, apiGet, apiPost } from '@/lib/api';
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
import { useTranslations } from 'next-intl';
import {
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
import { useDurationUnits } from '../../use-duration-units';
import { useFormatters } from '@/lib/format';

export default function ProcessInstancePage() {
  const t = useTranslations('processes');
  const tc = useTranslations('common');
  const f = useFormatters();
  const units = useDurationUnits();
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
    queryFn: async () => await apiGet<WorkspaceMember[]>(`/workspaces/${wsId}/members`),
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
    mutationFn: async () => apiPost(`/workspaces/${wsId}/processes/instances/${instId}/cancel`),
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
      apiPost(`/workspaces/${wsId}/processes/instances/${instId}/steps/${v.stepId}/decide`, {
        decision: v.decision,
        ...(v.comment ? { comment: v.comment } : {}),
      }),
    onSuccess: () => { setRejectFor(null); setRejectWhy(''); refresh(); },
    onError: onMutError,
  });
  const claimMut = useMutation({
    mutationFn: async (stepId: string) =>
      await apiPost<{ taskId: string }>(`/workspaces/${wsId}/processes/instances/${instId}/steps/${stepId}/claim`),
    onSuccess: (data) => { refresh(); router.push(`/tasks/${data.taskId}`); },
    onError: onMutError,
  });
  const reassignMut = useMutation({
    mutationFn: async (v: { stepId: string; userId: string }) =>
      apiPost(`/workspaces/${wsId}/processes/instances/${instId}/steps/${v.stepId}/reassign`, { userId: v.userId }),
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
      const dur = s.status === 'done' && s.durationMs !== null ? ` · ${humanizeDuration(s.durationMs, units)}` : '';
      stepState.set(s.nodeId, {
        status: s.status,
        badge: `${t(`stepStatus.${s.status}`)}${n > 1 ? ` ×${n}` : ''}${dur}`,
      });
    }
    return docToFlow(inst.document, typeMap, stepState);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inst?.id, stepDigest, typeMap]);

  if (!isReady || detailQ.isLoading) return <LoadingBlock />;

  if (detailQ.isError || !inst) {
    return (
      <>
        <PageHeader breadcrumb={t('title')} title={t('instance.title')} />
        <BentoGrid>
          <Card span={12}>
            <EmptyState
              icon="warningCircle"
              title={t('instance.notFound')}
              description={t('instance.notFoundText')}
              action={<Button variant="matte" icon="arrowLeft" href={`/workspaces/${wsId}/processes`}>{t('instance.toProcesses')}</Button>}
            />
          </Card>
        </BentoGrid>
      </>
    );
  }

  return (
    <>
      <PageHeader
        breadcrumb={t('title')}
        title={
          <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: '0.5rem', flexWrap: 'wrap' }}>
            {inst.definitionName}
            <span className="label-sm">v{inst.version}</span>
          </span>
        }
        chip={
          <Chip tone={INSTANCE_STATUS_TONE[inst.status] ?? 'neutral'}>
            {t(`instanceStatus.${inst.status}`)}
          </Chip>
        }
        actions={
          <>
            {/* Контурная: шапка страницы лежит на фоне, а не на блоке */}
            <Button variant="outline" icon="arrowLeft" href={`/workspaces/${wsId}/processes`}>{t('title')}</Button>
            {inst.canCancel && (
              <Button variant="matte" tone="danger" icon="close" loading={cancelMut.isPending} onClick={() => setConfirmCancel(true)}>
                {tc('actions.cancel')}
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
              <span className="label-caps">{t('instance.startedBy')}</span>
              <PersonChip size="S" userId={inst.startedBy.id} firstName={inst.startedBy.firstName} lastName={inst.startedBy.lastName} />
            </span>
            <span className="body-sm">
              {f.dateTime(inst.startedAt, 'long')}
            </span>
            <span className="title-sm">
              {inst.finishedAt
                ? t('instance.lasted', { duration: humanizeDuration(inst.durationMs, units) })
                : t('instance.running', {
                    duration: humanizeDuration(Date.now() - new Date(inst.startedAt).getTime(), units),
                  })}
            </span>
          </div>
        </Card>

        {/* ---------- Канвас со статусами ---------- */}
        <Card span={12} style={{ padding: 0, overflow: 'hidden' }}>
          <ProcessCanvas nodes={nodes} edges={edges} editable={false} height="52vh" withMiniMap />
        </Card>

        {/* ---------- Шаги: «секундомер отделов» ---------- */}
        <Card span={8}>
          <CardHeader title={t('instance.steps')} subtitle={t('instance.stepsHint')} />
          <div className="density-compact ui-stack" style={{ gap: '0.375rem' }}>
            {inst.steps.map((s) => {
              const queued = s.status === 'active' && !!s.departmentId && !s.taskId;
              const decision =
              s.decision === 'approved'
                ? t('instance.decisionApproved')
                : s.decision === 'rejected'
                  ? t('instance.decisionRejected')
                  : null;
              return (
                <div
                  key={s.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', flexWrap: 'wrap',
                    padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-md)',
                    border: `1px solid ${s.overdue ? 'var(--danger-base)' : 'var(--divider)'}`,
                  }}
                >
                  <StatusDot tone={STEP_STATUS_TONE[s.status]} size={9} title={t(`stepStatus.${s.status}`)} />
                  <div style={{ flex: '1 1 10rem', minWidth: 0 }}>
                    <div className="title-sm">{s.label}</div>
                    <div className="label-sm">
                      <span style={{ fontWeight: 600 }}>
                        {queued ? t('instance.inDepartmentQueue') : t(`stepStatus.${s.status}`)}
                      </span>
                      {s.departmentName ? ` · ${s.departmentName}` : ''}
                      {decision ? ` · ${decision}` : ''}
                      {s.outcome && s.nodeType === 'condition'
                        ? ` · ${t('instance.branch', { branch: t(`output.${s.outcome}`) })}`
                        : ''}
                      {s.overdue
                        ? ` · ${t('instance.overdueStep')}`
                        : s.deadlineAt && s.status === 'active'
                          ? ` · ${t('instance.due', { at: f.dateTime(s.deadlineAt) })}`
                          : ''}
                      {s.error ? ` · ${s.error}` : ''}
                    </div>
                  </div>
                  {s.canDecide && (
                    <span style={{ display: 'flex', gap: '0.375rem', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      {rejectFor?.stepId === s.id && (
                        <Input
                          label={t('instance.reason')}
                          value={rejectWhy}
                          onChange={(e) => setRejectWhy(e.target.value)}
                          placeholder={t('instance.reasonPlaceholder')}
                          autoFocus
                          style={{ minWidth: 220 }}
                        />
                      )}
                      <Button variant="primary" tone="success" size="sm" icon="check" disabled={decideMut.isPending} onClick={() => decideMut.mutate({ stepId: s.id, decision: 'approved' })}>
                        {t('instance.approve')}
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
                        {t('instance.reject')}
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
                        {t('instance.return')}
                      </Button>
                    </span>
                  )}
                  {s.canClaim && (
                    <Button variant="primary" tone="success" size="sm" icon="download" disabled={claimMut.isPending} onClick={() => claimMut.mutate(s.id)}>
                      {t('inbox.take')}
                    </Button>
                  )}
                  {s.canReassign && (
                    <Button variant="ghost" size="sm" icon="refresh" onClick={() => setReassignFor(s.id)}>
                      {t('instance.reassignAction')}
                    </Button>
                  )}
                  {s.assignee && <PersonChip size="S" userId={s.assignee.id} firstName={s.assignee.firstName} lastName={s.assignee.lastName} />}
                  {s.taskId && (
                    <Button variant="ghost" size="sm" iconRight="caretRight" href={`/tasks/${s.taskId}`}>
                      {t('instance.taskWord')}
                    </Button>
                  )}
                  <div className="label-sm" style={{ textAlign: 'right' }}>
                    <div>
                      {f.time(s.startedAt)}
                      {s.completedAt ? ` → ${f.time(s.completedAt)}` : ''}
                    </div>
                    <div style={{ fontWeight: 700 }}>
                      {s.completedAt
                        ? humanizeDuration(s.durationMs, units)
                        : humanizeDuration(Date.now() - new Date(s.startedAt).getTime(), units)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        {/* ---------- Анкета ---------- */}
        <Card span={4}>
          <CardHeader title={t('instance.form')} subtitle={t('instance.formHint')} />
          {Object.keys(inst.variables).length === 0 ? (
            <EmptyState icon="empty" title={t('instance.formEmpty')} />
          ) : (
            <div className="ui-stack" style={{ gap: 'var(--spacing-3)' }}>
              {Object.entries(inst.variables).map(([k, v]) => (
                <div key={k}>
                  <div className="label-caps">{k}</div>
                  <div className="title-sm" style={{ wordBreak: 'break-word' }}>
                    {typeof v === 'boolean' ? tc(v ? 'actions.yes' : 'actions.no') : String(v)}
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
          title={t('instance.reassign')}
          subtitle={t('instance.reassignHint')}
          size="sm"
          footer={<Button variant="ghost" onClick={() => setReassignFor(null)}>{tc('actions.cancel')}</Button>}
        >
          <EntitySelector
            value={[]}
            onChange={(next: Principal[]) => { if (next[0]) reassignMut.mutate({ stepId: reassignFor, userId: next[0].id }); }}
            multi={false}
            options={memberOptions}
            placeholder={t('instance.reassignPlaceholder')}
          />
        </Modal>
      )}

      <ConfirmDialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        onConfirm={() => cancelMut.mutate()}
        title={t('instance.cancelTitle')}
        message={t('instance.cancelText')}
        confirmLabel={t('instance.cancelConfirm')}
        cancelLabel={t('instance.cancelDeny')}
        danger
        loading={cancelMut.isPending}
      />
    </>
  );
}
