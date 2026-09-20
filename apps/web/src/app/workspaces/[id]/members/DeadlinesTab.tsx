'use client';

// ============================================================
// Вкладка «Сроки» (КЭДО): сводный экран «что горит сегодня» — ЕСУТД ×3 срока
// + окно исправления 30 РД, вручения 3 РД, расчёты 3 РД, испытательные,
// окончания срочных, неознакомившиеся. Плюс массовые действия по аудитории.
// ============================================================

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import {
  DISMISSAL_GROUNDS,
  HR_ACTION_KINDS,
  HR_ACTION_ORDER_LIBRARY_KEY,
  HR_LIMITS,
  type CreateHrBatchInput,
  type DocTemplateDto,
  type EsutdSubmissionDto,
  type HrActionBatchDto,
  type HrActorLite,
  type HrDeadlineItemDto,
} from '@superapp/shared';
import { apiGet } from '@/lib/api';
import { dmy } from '@/lib/dates';
import { useFormatters } from '@/lib/format';
import {
  createHrBatch,
  fetchEsutd,
  fetchEsutdPayload,
  fetchHrBatch,
  fetchHrDeadlines,
  fetchHrRegistryZip,
  markEsutdNotRequired,
  markEsutdSubmitted,
  saveHrBlob,
} from '@/lib/hr-api';
import { hrDeadlinesKey, hrEsutdKey, hrRootKey } from '@/lib/queries';
import { toastApiError } from '@/lib/api-errors';
import { useIdempotencyKey } from '@/lib/useIdempotencyKey';
import { OutcomeUnknownAlert, SlowRequestNote, useOutcomeUnknown } from '@/components/idempotency/OutcomeUnknownAlert';
import { toast } from '@/lib/toast';
import {
  Alert,
  Button,
  Card,
  CardHeader,
  Chip,
  DatePicker,
  EmptyState,
  Input,
  LoadingBlock,
  Modal,
  Select,
  TickBar,
  Toggle,
  useConfirm,
} from '@/components/ui';
import { PersonChip } from '@/app/circles/PersonCard';
import { parseTengeToTiyn } from './[userId]/member-hr-ui';
import { EntitySelector } from '@/components/EntitySelector';
import type { Principal } from '@/lib/entities';

const isoToDate = (iso?: string): Date | null => (iso ? new Date(`${iso}T00:00:00`) : null);
const dateToIso = (d: Date | null): string | undefined =>
  d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : undefined;

/** Остаток срока словами каталога: «Просрочено» / «Сегодня» / «N раб. дн.» */
function useDaysLeftLabel(): (workDaysLeft: number) => string {
  const t = useTranslations('hr');
  return (workDaysLeft: number) =>
    workDaysLeft < 0
      ? t('daysLeft.overdue')
      : workDaysLeft === 0
        ? t('daysLeft.today')
        : t('daysLeft.workDays', { days: workDaysLeft });
}

function DaysLeftChip({ item }: { item: HrDeadlineItemDto }) {
  const t = useTranslations('hr');
  const label = useDaysLeftLabel();
  if (item.overdue) return <Chip tone="danger">{t('daysLeft.overdue')}</Chip>;
  if (item.workDaysLeft === null) {
    return item.dueAt ? <Chip tone="neutral">{t('daysLeft.until', { date: dmy(item.dueAt) })}</Chip> : null;
  }
  const tone = item.workDaysLeft <= 1 ? 'danger' : item.workDaysLeft <= 3 ? 'warning' : 'neutral';
  return <Chip tone={tone}>{label(item.workDaysLeft)}</Chip>;
}

function Section({
  title,
  items,
  actors,
  tc,
}: {
  title: string;
  items: HrDeadlineItemDto[];
  actors: Record<string, HrActorLite>;
  tc: (key: string) => string;
}) {
  const t = useTranslations('hr');
  if (!items.length) return null;
  return (
    <Card>
      <CardHeader title={title} subtitle={t('section.count', { count: items.length })} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
        {items.map((item) => {
          const actor = item.userId ? actors[item.userId] : null;
          return (
            <div
              key={item.key}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--spacing-3)',
                padding: 'var(--spacing-3)',
                border: '1px solid var(--card-border)',
                borderRadius: 14,
                flexWrap: 'wrap',
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 700 }}>{item.title}</div>
                <div className="meta">{item.subtitle}</div>
                {actor && (
                  <div style={{ marginTop: 6 }}>
                    <PersonChip
                      size="S"
                      userId={actor.id}
                      firstName={actor.firstName}
                      lastName={actor.lastName}
                      avatar={actor.avatar}
                    />
                  </div>
                )}
              </div>
              <DaysLeftChip item={item} />
              {item.href && (
                <Button variant="ghost" size="sm" href={item.href} icon="arrowRight">
                  {tc('actions.open')}
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export function DeadlinesTab({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('hr');
  const tc = useTranslations('common');
  const f = useFormatters();
  const daysLeft = useDaysLeftLabel();
  const qc = useQueryClient();
  const [payloadFor, setPayloadFor] = useState<EsutdSubmissionDto | null>(null);
  const [submitFor, setSubmitFor] = useState<EsutdSubmissionDto | null>(null);
  const [confirm, confirmUI] = useConfirm();
  const [massOpen, setMassOpen] = useState(false);
  const [zipBusy, setZipBusy] = useState(false);
  const [batchId, setBatchId] = useState<string | null>(null);

  const deadlinesQ = useQuery({
    queryKey: hrDeadlinesKey(workspaceId),
    queryFn: () => fetchHrDeadlines(workspaceId),
  });
  const esutdQ = useQuery({
    queryKey: hrEsutdKey(workspaceId),
    queryFn: () => fetchEsutd(workspaceId),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: hrRootKey(workspaceId) });
  };

  const markSubmitted = useMutation({
    mutationFn: ({ id, num }: { id: string; num?: string }) => markEsutdSubmitted(workspaceId, id, num),
    onSuccess: refresh,
    onError: (e) => toastApiError(e),
  });
  const markNotRequired = useMutation({
    mutationFn: (id: string) => markEsutdNotRequired(workspaceId, id),
    onSuccess: refresh,
    onError: (e) => toastApiError(e),
  });

  if (deadlinesQ.isPending) return <LoadingBlock />;
  if (deadlinesQ.isError || !deadlinesQ.data) {
    return (
      <EmptyState
        icon="warningCircle"
        title={t('deadlines.loadFailed')}
        description={t('deadlines.lockedDescription')}
        action={
          <Button variant="matte" icon="refresh" onClick={() => deadlinesQ.refetch()}>
            {tc('actions.retry')}
          </Button>
        }
      />
    );
  }
  const d = deadlinesQ.data;
  const esutdPending = (esutdQ.data?.items ?? []).filter((s) => s.status === 'pending');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gap-grid)' }}>
      <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap', alignItems: 'center' }}>
        <Chip tone={d.total > 0 ? 'warning' : 'success'} icon="clock">
          {t('deadlines.burning', { count: d.total })}
        </Chip>
        <span style={{ flex: 1 }} />
        <Button
          variant="matte"
          icon="download"
          disabled={zipBusy}
          onClick={async () => {
            // Байтами с токеном: простая ссылка на JWT-ручку отвечает 401
            setZipBusy(true);
            try {
              const blob = await fetchHrRegistryZip(workspaceId);
              saveHrBlob(blob, `${t('deadlines.registryFile')}.zip`);
            } catch (e) {
              toastApiError(e);
            } finally {
              setZipBusy(false);
            }
          }}
        >
          {zipBusy ? t('deadlines.zipBusy') : t('deadlines.registryZip')}
        </Button>
        <Button variant="primary" icon="people" onClick={() => setMassOpen(true)}>
          {t('batch.open')}
        </Button>
      </div>

      {d.total === 0 && (
        <EmptyState icon="checkCircle" title={t('deadlines.emptyTitle')} description={t('deadlines.emptyDescription')} />
      )}

      {esutdQ.isError && (
        <Alert
          tone="warning"
          action={
            <Button variant="matte" size="sm" icon="refresh" onClick={() => void esutdQ.refetch()}>
              {tc('actions.retry')}
            </Button>
          }
        >
          {t('esutd.queueFailed')}
        </Alert>
      )}

      {/* ЕСУТД — с кнопками ручного пути */}
      {esutdPending.length > 0 && (
        <Card>
          <CardHeader title={t('esutd.pendingTitle')} subtitle={t('esutdFinesNote')} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
            {esutdPending.map((s) => {
              const actor = esutdQ.data?.actors[s.userId];
              return (
                <div
                  key={s.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--spacing-3)',
                    padding: 'var(--spacing-3)',
                    border: '1px solid var(--card-border)',
                    borderRadius: 14,
                    flexWrap: 'wrap',
                  }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 700 }}>
                      {t(`esutdKind.${s.kind}`)}
                    </div>
                    <div className="meta">{t('esutd.dueBy', { date: dmy(s.dueAt) })}</div>
                    {actor && (
                      <div style={{ marginTop: 6 }}>
                        <PersonChip size="S" userId={actor.id} firstName={actor.firstName} lastName={actor.lastName} avatar={actor.avatar} />
                      </div>
                    )}
                  </div>
                  {s.workDaysLeft !== null && (
                    <Chip tone={s.workDaysLeft < 0 ? 'danger' : s.workDaysLeft <= 1 ? 'danger' : s.workDaysLeft <= 3 ? 'warning' : 'neutral'}>
                      {daysLeft(s.workDaysLeft)}
                    </Chip>
                  )}
                  <Button variant="matte" size="sm" icon="copy" onClick={() => setPayloadFor(s)}>
                    {t('esutd.copyData')}
                  </Button>
                  {/* Отметка о сдаче НЕОБРАТИМА для прекращения (п. 13 Правил
                      № 353: правка только через госорган) — спрашиваем номер
                      регистрации и подтверждение, а не закрываем одним кликом. */}
                  <Button variant="primary" size="sm" onClick={() => setSubmitFor(s)}>
                    {t('esutd.markSubmitted')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      confirm(
                        {
                          title: t('esutd.notRequiredConfirmTitle'),
                          message: t('esutd.notRequiredConfirmMessage'),
                          confirmLabel: t('esutd.notRequired'),
                          danger: true,
                        },
                        async () => {
                          await markNotRequired.mutateAsync(s.id);
                        },
                      )
                    }
                  >
                    {t('esutd.notRequired')}
                  </Button>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Окна исправления после сдачи */}
      {(esutdQ.data?.items ?? []).some((s) => s.status === 'submitted' && s.correctionUntil) && (
        <Card>
          <CardHeader title={t('esutd.correctionTitle')} subtitle={t('esutd.correctionSubtitle')} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {(esutdQ.data?.items ?? [])
              .filter((s) => s.status === 'submitted' && s.correctionUntil)
              .map((s) => (
                <div key={s.id} className="meta">
                  {t('esutd.correctionRow', {
                    kind: t(`esutdKind.${s.kind}`),
                    submittedAt: s.submittedAt ? f.date(s.submittedAt) : tc('labels.dash'),
                    numberSuffix: s.externalNumber ? t('esutd.numberSuffix', { number: s.externalNumber }) : '',
                    until: dmy(s.correctionUntil),
                  })}
                </div>
              ))}
          </div>
        </Card>
      )}

      <Section title={t('section.deliveries')} items={d.deliveries} actors={d.actors} tc={tc} />
      <Section title={t('section.settlements')} items={d.settlements} actors={d.actors} tc={tc} />
      <Section title={t('section.probations')} items={d.probations} actors={d.actors} tc={tc} />
      <Section title={t('section.contractEnds')} items={d.contractEnds} actors={d.actors} tc={tc} />
      <Section title={t('section.campaigns')} items={d.campaigns} actors={d.actors} tc={tc} />

      {payloadFor && (
        <EsutdPayloadModal workspaceId={workspaceId} submission={payloadFor} onClose={() => setPayloadFor(null)} />
      )}
      {submitFor && (
        <EsutdSubmitModal
          submission={submitFor}
          pending={markSubmitted.isPending}
          onClose={() => setSubmitFor(null)}
          onSubmit={async (num) => {
            await markSubmitted.mutateAsync({ id: submitFor.id, num });
            setSubmitFor(null);
          }}
        />
      )}
      {confirmUI}
      {massOpen && (
        <MassActionModal
          workspaceId={workspaceId}
          onClose={() => setMassOpen(false)}
          onStarted={(id) => {
            setMassOpen(false);
            setBatchId(id);
          }}
        />
      )}
      {batchId && <BatchProgressModal workspaceId={workspaceId} batchId={batchId} onClose={() => { setBatchId(null); refresh(); }} />}
    </div>
  );
}

// ---------- «Скопировать сведения» ----------

function EsutdPayloadModal({
  workspaceId,
  submission,
  onClose,
}: {
  workspaceId: string;
  submission: EsutdSubmissionDto;
  onClose: () => void;
}) {
  const t = useTranslations('hr');
  const tc = useTranslations('common');
  const payloadQ = useQuery({
    queryKey: [...hrEsutdKey(workspaceId), submission.id, 'payload'],
    queryFn: () => fetchEsutdPayload(workspaceId, submission.id),
  });
  const text = useMemo(() => {
    const p = payloadQ.data ?? {};
    return Object.entries(p)
      .map(([k, v]) => `${k}: ${v ?? '—'}`)
      .join('\n');
  }, [payloadQ.data]);
  return (
    <Modal open onClose={onClose} title={t('esutd.payloadTitle')} subtitle={t('esutd.payloadSubtitle')} size="md">
      {payloadQ.isPending ? (
        <LoadingBlock />
      ) : (
        <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              background: 'var(--page)',
              border: '1px solid var(--card-border)',
              borderRadius: 12,
              padding: 'var(--spacing-3)',
              fontSize: '0.9rem',
            }}
          >
            {text}
          </pre>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--spacing-2)' }}>
            <Button
              variant="primary"
              icon="copy"
              onClick={() => {
                void navigator.clipboard.writeText(text);
                toast(t('esutd.copied'), 'success');
              }}
            >
              {tc('actions.copy')}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/**
 * «Отметить сданным»: номер регистрации ЕСУТД — доказательство сдачи, а для
 * ПРЕКРАЩЕНИЯ отметка ещё и необратима (п. 13 Правил № 353 — дальше только через
 * госорган по обращению). Поэтому не кнопка в один клик, а шаг с предупреждением.
 */
function EsutdSubmitModal({
  submission,
  pending,
  onClose,
  onSubmit,
}: {
  submission: EsutdSubmissionDto;
  pending: boolean;
  onClose: () => void;
  onSubmit: (externalNumber?: string) => Promise<void>;
}) {
  const t = useTranslations('hr');
  const tc = useTranslations('common');
  const [num, setNum] = useState('');
  const isTermination = submission.kind === 'termination';
  return (
    <Modal open onClose={onClose} title={t('esutd.submitTitle')} size="sm">
      <div style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
        <Alert tone={isTermination ? 'warning' : 'accent'}>
          {t(isTermination ? 'esutd.submitWarnTermination' : 'esutd.submitHint')}
        </Alert>
        <Input
          label={t('esutd.externalNumber')}
          value={num}
          onChange={(e) => setNum(e.target.value)}
          placeholder="2026-000123"
          hint={t('esutd.externalNumberHint')}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--spacing-2)' }}>
          <Button variant="ghost" onClick={onClose}>{tc('actions.cancel')}</Button>
          <Button
            variant="primary"
            loading={pending}
            onClick={() => void onSubmit(num.trim() || undefined)}
          >
            {t(isTermination ? 'esutd.submitConfirm' : 'esutd.markSubmitted')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------- Массовое действие ----------

function MassActionModal({
  workspaceId,
  onClose,
  onStarted,
}: {
  workspaceId: string;
  onClose: () => void;
  onStarted: (batchId: string) => void;
}) {
  const t = useTranslations('hr');
  const tc = useTranslations('common');
  const [kind, setKind] = useState('leave');
  const [audience, setAudience] = useState<Principal[]>([]);
  const [effectiveAt, setEffectiveAt] = useState<string | undefined>(undefined);
  const [effectiveTo, setEffectiveTo] = useState<string | undefined>(undefined);
  const [templateId, setTemplateId] = useState('');
  // Параметры вида: без них сервер честно отвергает КАЖДОЕ действие пачки, и
  // массовая операция целиком уходила в «Не удалось» с причиной внутри каждой
  // строки. Спрашиваем ровно то, что требует вид (правило: интерфейс не даёт
  // запустить заведомо неисполнимое).
  const [ground, setGround] = useState('');
  const [banConfirmed, setBanConfirmed] = useState(false);
  const [alsoRemove, setAlsoRemove] = useState(false);
  const [position, setPosition] = useState<Principal[]>([]);
  const [branch, setBranch] = useState<Principal[]>([]);
  const [syncFact, setSyncFact] = useState(true);
  const [salary, setSalary] = useState('');

  const templatesQ = useQuery({
    queryKey: [...hrRootKey(workspaceId), 'templates-for-actions'],
    queryFn: () => apiGet<DocTemplateDto[]>(`/workspaces/${workspaceId}/documents/templates`),
  });
  const templates = (templatesQ.data ?? []).filter((t) => t.status === 'published' && t.category === 'hr');
  // Библиотечный приказ этого вида подставляем сам — как в модалке одного действия
  const defaultTemplateId =
    templates.find((t) => t.libraryKey === HR_ACTION_ORDER_LIBRARY_KEY[kind])?.id ?? '';
  const chosenTemplateId = templateId || defaultTemplateId;

  const groundMeta = DISMISSAL_GROUNDS.find((g) => g.value === ground);
  const employerInitiative = !!groundMeta?.employerInitiative;

  // Пакет = приказы СРАЗУ НА ВСЮ АУДИТОРИЮ: повтор дал бы второй такой же пакет,
  // и отменять его пришлось бы по одному человеку. Ключ намерения — на форму.
  const startKey = useIdempotencyKey([kind, effectiveAt, effectiveTo, ground, salary, chosenTemplateId, audience.map((p) => `${p.type}:${p.id}`).join(',')]);
  const outcome = useOutcomeUnknown();

  const start = useMutation({
    mutationFn: () => {
      if (!effectiveAt) throw new Error(t('form.dateRequired'));
      if (!chosenTemplateId) throw new Error(t('form.templateRequired'));
      if (!audience.length) throw new Error(t('form.audienceRequired'));
      if (kind === 'leave' && !effectiveTo) throw new Error(t('form.leaveEndRequired'));
      if (kind === 'leave' && effectiveTo && effectiveTo < effectiveAt) {
        throw new Error(t('form.periodEnd'));
      }
      if (kind === 'dismissal' && !ground) throw new Error(t('form.groundRequired'));
      if (kind === 'transfer' && !position[0]) throw new Error(t('form.positionRequired'));
      const salaryTiyn = salary.trim() ? parseTengeToTiyn(salary) : undefined;
      if (salary.trim() && salaryTiyn === undefined) throw new Error(t('form.salaryNumber'));
      if (kind === 'salary_change' && salaryTiyn === undefined) throw new Error(t('form.salaryRequired'));
      const dto: CreateHrBatchInput = {
        kind,
        audience: audience.map((p) => ({ type: p.type as CreateHrBatchInput['audience'][number]['type'], id: p.id })),
        effectiveAt,
        ...(effectiveTo ? { effectiveTo } : {}),
        templateId: chosenTemplateId,
        params: {
          ...(kind === 'dismissal'
            ? {
                ground: ground as never,
                alsoRemoveMembership: alsoRemove,
                banExceptionConfirmed: banConfirmed || undefined,
              }
            : {}),
          ...(kind === 'transfer'
            ? { legalPositionId: position[0]?.id, legalBranchId: branch[0]?.id ?? null, syncFact }
            : {}),
          ...(salaryTiyn !== undefined ? { salaryAmount: salaryTiyn } : {}),
        },
      };
      return createHrBatch(workspaceId, dto, startKey.key);
    },
    onSuccess: (batch) => {
      startKey.reset();
      onStarted(batch.id);
    },
    onError: (e) => {
      if (!outcome.capture(e)) toastApiError(e);
    },
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={t('batch.title')}
      subtitle={t('batch.cap', { max: HR_LIMITS.batchMax })}
      size="md"
    >
      <div style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
        <Select
          label={t('batch.action')}
          value={kind}
          onChange={(v) => {
            setKind(v);
            setTemplateId('');
          }}
          options={HR_ACTION_KINDS.filter((k) => k !== 'hire').map((k) => ({ value: k, label: t(`actionKind.${k}`) }))}
        />
        <div>
          <div className="label-md" style={{ marginBottom: 6 }}>{t('batch.audience')}</div>
          <EntitySelector
            types={['user', 'position', 'department', 'branch', 'workspace']}
            value={audience}
            onChange={setAudience}
            context={{ workspaceId }}
            placeholder={t('batch.audiencePlaceholder')}
          />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'var(--spacing-3)' }}>
          <DatePicker label={t('form.effectiveAt')} value={isoToDate(effectiveAt)} onChange={(dd) => setEffectiveAt(dateToIso(dd))} />
          {kind === 'leave' && (
            <DatePicker label={t('form.effectiveTo')} value={isoToDate(effectiveTo)} onChange={(dd) => setEffectiveTo(dateToIso(dd))} />
          )}
        </div>

        {kind === 'transfer' && (
          <>
            <div>
              <div className="label-md" style={{ marginBottom: 6 }}>{t('batch.newPosition')}</div>
              <EntitySelector types={['position']} multi={false} value={position} onChange={setPosition} context={{ workspaceId }} placeholder={t('form.pickPosition')} />
            </div>
            <div>
              <div className="label-md" style={{ marginBottom: 6 }}>{t('form.newBranch')}</div>
              <EntitySelector types={['branch']} multi={false} value={branch} onChange={setBranch} context={{ workspaceId }} placeholder={t('form.noBranch')} />
            </div>
            <Toggle
              checked={syncFact}
              onChange={setSyncFact}
              label={t('form.syncFact')}
              description={t('batch.syncFactHint')}
            />
          </>
        )}

        {(kind === 'salary_change' || kind === 'transfer') && (
          <Input
            label={t(kind === 'salary_change' ? 'batch.salaryRequired' : 'batch.salaryOptional')}
            value={salary}
            onChange={(ev) => setSalary(ev.target.value)}
            placeholder="250000"
            inputMode="numeric"
          />
        )}

        {kind === 'dismissal' && (
          <>
            <Select
              label={t('form.ground')}
              value={ground}
              onChange={setGround}
              options={DISMISSAL_GROUNDS.map((g) => ({ value: g.value, label: t(`ground.${g.value}`) }))}
              placeholder={t('form.pickGround')}
              hint={t('batch.groundHint')}
            />
            {employerInitiative && (
              <>
                <Alert tone="warning">
                  {t('batch.st54Warning')}
                </Alert>
                <Toggle
                  checked={banConfirmed}
                  onChange={setBanConfirmed}
                  label={t('form.banException')}
                  description={t('form.banExceptionHint')}
                />
              </>
            )}
            <Toggle
              checked={alsoRemove}
              onChange={setAlsoRemove}
              label={t('form.alsoRemove')}
              description={t('batch.alsoRemoveHint')}
            />
          </>
        )}

        <Select
          label={t('form.template')}
          value={chosenTemplateId}
          onChange={setTemplateId}
          options={templates.map((tpl) => ({
            value: tpl.id,
            label: `${tpl.name}${tpl.hasRoute ? '' : t('form.templateNoRouteSuffix')}`,
          }))}
          placeholder={templatesQ.isPending ? t('form.loading') : t('form.pickTemplate')}
        />
        <Alert tone="accent">{t('batch.perPersonHint')}</Alert>
        {/* Пакет МОГ запуститься: плашка ведёт в список пакетов, а не подталкивает
            нажать «Запустить» второй раз. */}
        <OutcomeUnknownAlert error={outcome.error} onDismiss={outcome.clear} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--spacing-2)', alignItems: 'center' }}>
          <SlowRequestNote pending={start.isPending} />
          <Button variant="ghost" onClick={onClose}>{tc('actions.cancel')}</Button>
          <Button variant="primary" loading={start.isPending} onClick={() => start.mutate()}>{t('batch.start')}</Button>
        </div>
      </div>
    </Modal>
  );
}
/** Экран прогресса: поллинг + TickBar (готового экрана прогресса в системе нет — новый паттерн) */
function BatchProgressModal({
  workspaceId,
  batchId,
  onClose,
}: {
  workspaceId: string;
  batchId: string;
  onClose: () => void;
}) {
  const t = useTranslations('hr');
  const tc = useTranslations('common');
  const batchQ = useQuery({
    queryKey: [...hrRootKey(workspaceId), 'batch', batchId],
    queryFn: () => fetchHrBatch(workspaceId, batchId),
    refetchInterval: (q) => {
      const b = q.state.data as HrActionBatchDto | undefined;
      return b && b.status !== 'running' ? false : HR_LIMITS.batchPollMs;
    },
  });
  const b = batchQ.data;
  const created = b ? Object.values(b.progress).reduce((s, n) => s + n, 0) : 0;
  return (
    <Modal
      open
      onClose={onClose}
      title={t('batch.progressTitle')}
      subtitle={b ? t('batch.progressOf', { created, total: b.total }) : undefined}
      size="sm"
    >
      {!b ? (
        <LoadingBlock />
      ) : (
        <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
          <TickBar value={b.total ? Math.round((created / b.total) * 100) : 0} />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {b.progress.in_progress > 0 && (
              <Chip tone="accent">{t('batch.stat', { status: t('actionStatus.in_progress'), n: b.progress.in_progress })}</Chip>
            )}
            {b.progress.draft > 0 && (
              <Chip tone="neutral">{t('batch.stat', { status: t('actionStatus.draft'), n: b.progress.draft })}</Chip>
            )}
            {b.progress.scheduled > 0 && (
              <Chip tone="warning">{t('batch.stat', { status: t('actionStatus.scheduled'), n: b.progress.scheduled })}</Chip>
            )}
            {b.progress.applied > 0 && (
              <Chip tone="success">{t('batch.stat', { status: t('actionStatus.applied'), n: b.progress.applied })}</Chip>
            )}
            {b.progress.failed > 0 && (
              <Chip tone="danger">{t('batch.stat', { status: t('actionStatus.failed'), n: b.progress.failed })}</Chip>
            )}
          </div>
          <div className="meta">
            {t(b.status === 'running' ? 'batch.running' : 'batch.done')}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button variant="matte" onClick={onClose}>{tc('actions.close')}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
