'use client';

// «Процессы» организации: вкладка конструктора (определения) + «Журнал» (запущенные).
// Канвас рядовым не показывается — они живут в задачах/уведомлениях; сюда заходят
// менеджеры (строить) и участники (смотреть свои запуски в Журнале).

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { apiErrorMessage, apiGet, apiPost } from '@/lib/api';
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
import {
  Alert, BentoGrid, Button, Card, CardHeader, Chip, EmptyState, Icon, Input, LoadingBlock,
  Modal, PageHeader, StatTile, SegmentedControl, type TabItem,
} from '@/components/ui';
import { humanizeDuration, INSTANCE_STATUS_TONE } from './process-lib';

type Tab = 'defs' | 'inbox' | 'journal' | 'analytics';

export default function ProcessesPage() {
  const { isReady } = useRequireAuth();
  const { id: wsId } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('defs');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  const { data: ws } = useQuery({
    queryKey: workspaceKey(wsId),
    queryFn: async () => await apiGet<Workspace>(`/workspaces/${wsId}`),
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
    // Адаптивный поллинг (паттерн Виртуального офиса): часто — только пока есть
    // бегущий инстанс; тихий журнал не молотит сервер каждые 5 секунд.
    // На скрытой вкладке React Query сам ставит интервал на паузу.
    refetchInterval: (q) =>
      (q.state.data ?? []).some((i) => i.status === 'running') ? 7_000 : 30_000,
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
      await apiPost<{ id: string }>(`/workspaces/${wsId}/processes`, { name }),
    onSuccess: (def) => {
      void qc.invalidateQueries({ queryKey: processesKey(wsId) });
      router.push(`/workspaces/${wsId}/processes/${def.id}`);
    },
    onError: (e) => setCreateError(apiErrorMessage(e)),
  });

  const running = useMemo(() => (defs ?? []).reduce((acc, d) => acc + d.runningCount, 0), [defs]);

  if (!isReady) return <LoadingBlock />;

  const tabs: TabItem<Tab>[] = [
    { key: 'defs', label: 'Процессы', icon: 'processes', count: defs?.length ?? 0 },
    { key: 'inbox', label: 'Входящие', icon: 'empty', count: inbox?.length ?? 0 },
    { key: 'journal', label: 'Журнал', icon: 'journal', count: running },
    ...(canEdit ? [{ key: 'analytics' as Tab, label: 'Аналитика', icon: 'chart' as const }] : []),
  ];

  return (
    <>
      <PageHeader
        breadcrumb={ws?.name ?? 'Организация'}
        title="Процессы"
        description="Конструктор бизнес-процессов: задачи отделам, согласования, автоматизация"
        actions={
          canEdit && tab === 'defs' ? (
            <Button variant="primary" tone="success" icon="add" onClick={() => { setCreateError(null); setCreating(true); }}>
              Новый процесс
            </Button>
          ) : undefined
        }
      />

      <div style={{ marginBottom: 'var(--gap-grid)' }}>
        <SegmentedControl aria-label="Разделы Процессов" items={tabs} value={tab} onChange={setTab} />
      </div>

      {tab === 'defs' && (
        <BentoGrid>
          {isLoading ? (
            <Card span={12}><LoadingBlock /></Card>
          ) : (defs ?? []).length === 0 ? (
            <Card span={12}>
              <EmptyState
                icon="processes"
                title="Процессов пока нет"
                description={
                  canEdit
                    ? 'Создайте первый: нарисуйте цепочку задач и согласований на канвасе.'
                    : 'Когда менеджеры создадут процессы, они появятся здесь.'
                }
                action={
                  canEdit ? (
                    <Button variant="primary" tone="success" icon="add" onClick={() => setCreating(true)}>Новый процесс</Button>
                  ) : undefined
                }
              />
            </Card>
          ) : (
            (defs ?? []).map((d) => (
              <Card key={d.id} span={6} hoverable>
                {/* next/link: сырой <a> перезагружал всё приложение перед самым тяжёлым роутом */}
                <Link href={`/workspaces/${wsId}/processes/${d.id}`} style={{ color: 'inherit', display: 'block' }}>
                  <CardHeader
                    title={d.name}
                    subtitle={d.description || undefined}
                    actions={
                      <Chip size="sm" tone={d.hasPublished ? 'success' : 'neutral'}>
                        {d.hasPublished ? 'Опубликован' : PROCESS_VERSION_STATUS_LABELS[d.latestVersionStatus]}
                      </Chip>
                    }
                  />
                  <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap', alignItems: 'center' }}>
                    <Chip size="sm" tone="neutral">v{d.latestVersion}</Chip>
                    {d.runningCount > 0 && (
                      <Chip size="sm" tone="warning" icon="inProgress">идёт: {d.runningCount}</Chip>
                    )}
                    {d.visibility === 'admins' && (
                      <Chip size="sm" tone="neutral" icon="lock">только админы</Chip>
                    )}
                  </div>
                </Link>
              </Card>
            ))
          )}
        </BentoGrid>
      )}

      {tab === 'inbox' && <InboxList wsId={wsId} items={inbox ?? []} />}
      {tab === 'analytics' && <Analytics wsId={wsId} defs={defs ?? []} />}
      {tab === 'journal' && <JournalTable wsId={wsId} instances={instances ?? []} />}

      {creating && canEdit && (
        <Modal
          open
          onClose={() => setCreating(false)}
          title="Новый процесс"
          subtitle="Дальше откроется канвас: триггер → шаги → конец"
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setCreating(false)}>Отмена</Button>
              <Button
                variant="primary"
                tone="success"
                icon="add"
                disabled={!newName.trim()}
                loading={createMut.isPending}
                onClick={() => createMut.mutate(newName.trim())}
              >
                Создать
              </Button>
            </>
          }
        >
          <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
            {createError && <Alert tone="danger" onClose={() => setCreateError(null)}>{createError}</Alert>}
            <Input
              label="Название процесса"
              value={newName}
              autoFocus
              placeholder="Например: Замена техники"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && newName.trim() && !createMut.isPending) createMut.mutate(newName.trim()); }}
            />
          </div>
        </Modal>
      )}
    </>
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
  const onErr = (e: unknown) => setErr(apiErrorMessage(e));
  const claimMut = useMutation({
    mutationFn: async (it: ProcessInboxItem) =>
      await apiPost<{ taskId: string }>(`/workspaces/${wsId}/processes/instances/${it.instanceId}/steps/${it.stepId}/claim`),
    onSuccess: (d) => { refresh(); router.push(`/tasks/${d.taskId}`); },
    onError: onErr,
  });
  // Решения ушли отсюда в общую стопку «Ждут решения» (бейдж топбара и плитка
  // Главной): адресатом шага может быть должность или отдел, и «Входящие» Процессов
  // такого адресата не находили. Здесь остались только очереди задач отдела.

  return (
    <BentoGrid>
      {err && (
        <div style={{ gridColumn: 'span 12' }}>
          <Alert tone="danger" onClose={() => setErr(null)}>{err}</Alert>
        </div>
      )}

      <Card span={12}>
        <CardHeader title="Входящие" subtitle="Задачи вашего отдела в очереди и согласования на вас" />
        {items.length === 0 ? (
          <EmptyState icon="empty" title="Входящих нет" description="Здесь появятся задачи отдела, которые можно забрать, и согласования." />
        ) : (
          <div className="ui-stack" style={{ gap: '0.5rem' }}>
            {items.map((it) => (
              <div
                key={it.stepId}
                style={{
                  display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', flexWrap: 'wrap',
                  padding: '0.625rem 0.75rem', borderRadius: 'var(--radius-md)',
                  border: `1px solid ${it.overdue ? 'var(--danger-base)' : 'var(--divider)'}`,
                }}
              >
                <Chip size="sm" tone={it.kind === 'approve' ? 'success' : 'warning'}>
                  {it.kind === 'approve' ? 'Одобрение' : 'Задача отдела'}
                </Chip>
                <div style={{ flex: '1 1 14rem', minWidth: 0 }}>
                  <div className="title-sm">{it.title}</div>
                  <div className="label-sm">
                    «{it.processName}»{it.departmentName ? ` · ${it.departmentName}` : ''}
                  </div>
                  {it.detail && <div className="label-sm">{it.detail}</div>}
                </div>
                {it.overdue && <Chip size="sm" tone="danger" icon="overdue">просрочено</Chip>}
                <PersonChip size="S" userId={it.startedBy.id} firstName={it.startedBy.firstName} lastName={it.startedBy.lastName} />
                {/* Только «Забрать»: решения переехали в общую стопку «Ждут решения»,
                    и рисовать здесь вторые кнопки решения значило бы держать две
                    расходящиеся правды о том, кто вправе решать. */}
                {it.kind === 'claim' && (
                  <Button variant="primary" tone="success" size="sm" icon="download" loading={claimMut.isPending} onClick={() => claimMut.mutate(it)}>
                    Забрать
                  </Button>
                )}
                <Button variant="ghost" size="sm" iconRight="caretRight" href={`/workspaces/${wsId}/processes/instances/${it.instanceId}`}>
                  процесс
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </BentoGrid>
  );
}

function Analytics({ wsId, defs }: { wsId: string; defs: ProcessDefinitionDto[] }) {
  const [selected, setSelected] = useState<string | null>(defs[0]?.id ?? null);
  const { data: report, isLoading } = useQuery({
    queryKey: processReportKey(wsId, selected ?? ''),
    queryFn: () => fetchProcessReport(wsId, selected!),
    enabled: !!selected,
  });

  if (defs.length === 0) {
    return (
      <BentoGrid>
        <Card span={12}>
          <EmptyState icon="chart" title="Сначала создайте процесс" description="Аналитика появится после первых запусков." />
        </Card>
      </BentoGrid>
    );
  }

  return (
    <>
      <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap', marginBottom: 'var(--gap-grid)' }}>
        {defs.map((d) => (
          <Chip key={d.id} tone="accent" selected={selected === d.id} onClick={() => setSelected(d.id)}>
            {d.name}
          </Chip>
        ))}
      </div>

      {isLoading || !report ? (
        <LoadingBlock />
      ) : report.rows.length === 0 ? (
        <BentoGrid>
          <Card span={12}>
            <EmptyState icon="clock" title="Нет завершённых шагов" description="Запустите и пройдите процесс — «секундомер отделов» начнёт считать." />
          </Card>
        </BentoGrid>
      ) : (
        <BentoGrid>
          <StatTile span={6} label="Завершено процессов" value={report.finishedInstances} icon="checkCircle" tone="success" />
          <StatTile span={6} label="Среднее время процесса" value={humanizeDuration(report.avgCycleMs)} icon="clock" tone="accent" />

          <Card span={12}>
            <CardHeader title="Время по шагам" subtitle="Где процесс стоит дольше всего" />
            <div className="density-compact">
              <div
                className="label-caps"
                style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 0.6fr)', gap: '0.5rem', padding: '0 0.75rem 0.5rem' }}
              >
                <span>Шаг</span>
                <span style={{ textAlign: 'right' }}>Среднее</span>
                <span style={{ textAlign: 'right' }}>Максимум</span>
                <span style={{ textAlign: 'right' }}>Раз</span>
              </div>
              <div className="ui-stack" style={{ gap: '0.25rem' }}>
                {report.rows.map((r) => (
                  <div
                    key={r.nodeId}
                    style={{
                      display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 0.6fr)', gap: '0.5rem',
                      alignItems: 'center', padding: '0.5rem 0.75rem',
                      border: '1px solid var(--divider)', borderRadius: 'var(--radius-md)',
                    }}
                  >
                    <span className="title-sm" style={{ minWidth: 0 }}>
                      {r.label}
                      {r.departmentName && <span className="label-sm"> · {r.departmentName}</span>}
                    </span>
                    <span className="title-sm" style={{ textAlign: 'right' }}>{humanizeDuration(r.avgMs)}</span>
                    <span className="body-sm" style={{ textAlign: 'right' }}>{humanizeDuration(r.maxMs)}</span>
                    <span className="body-sm" style={{ textAlign: 'right' }}>{r.count}</span>
                  </div>
                ))}
              </div>
            </div>
          </Card>
        </BentoGrid>
      )}
    </>
  );
}

function JournalTable({ wsId, instances }: { wsId: string; instances: ProcessInstanceDto[] }) {
  return (
    <BentoGrid>
      <Card span={12}>
        <CardHeader title="Журнал запусков" subtitle="Кто запустил, где сейчас токен и сколько идёт" />
        {instances.length === 0 ? (
          <EmptyState icon="journal" title="Запущенных процессов пока нет" description="Запустите процесс — он появится здесь с таймингом по шагам." />
        ) : (
          <div className="density-compact ui-stack" style={{ gap: '0.375rem' }}>
            {instances.map((inst) => (
              <a
                key={inst.id}
                href={`/workspaces/${wsId}/processes/instances/${inst.id}`}
                style={{
                  display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', flexWrap: 'wrap',
                  padding: '0.625rem 0.75rem', border: '1px solid var(--divider)',
                  borderRadius: 'var(--radius-md)', color: 'var(--on-surface)',
                }}
              >
                <Chip size="sm" tone={INSTANCE_STATUS_TONE[inst.status] ?? 'neutral'} title={inst.error ?? undefined}>
                  {PROCESS_INSTANCE_STATUS_LABELS[inst.status]}
                </Chip>
                <div style={{ flex: '1 1 14rem', minWidth: 0 }}>
                  <div className="title-sm">
                    {inst.definitionName} <span className="label-sm">v{inst.version}</span>
                  </div>
                  {inst.currentSteps.length > 0 && (
                    <div className="label-sm">сейчас: {inst.currentSteps.join(', ')}</div>
                  )}
                  {inst.error && (
                    <div className="label-sm" style={{ color: 'var(--danger)' }}>{inst.error}</div>
                  )}
                </div>
                <PersonChip size="S" userId={inst.startedBy.id} firstName={inst.startedBy.firstName} lastName={inst.startedBy.lastName} />
                <div className="label-sm" style={{ textAlign: 'right' }}>
                  <div>{new Date(inst.startedAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                    <Icon name="clock" size={12} />
                    {inst.finishedAt ? humanizeDuration(inst.durationMs) : humanizeDuration(Date.now() - new Date(inst.startedAt).getTime())}
                  </div>
                </div>
              </a>
            ))}
          </div>
        )}
      </Card>
    </BentoGrid>
  );
}
