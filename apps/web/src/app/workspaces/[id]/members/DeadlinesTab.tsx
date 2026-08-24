'use client';

// ============================================================
// Вкладка «Сроки» (КЭДО): сводный экран «что горит сегодня» — ЕСУТД ×3 срока
// + окно исправления 30 РД, вручения 3 РД, расчёты 3 РД, испытательные,
// окончания срочных, неознакомившиеся. Плюс массовые действия по аудитории.
// ============================================================

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DISMISSAL_GROUNDS,
  ESUTD_FINES_NOTE,
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
import { apiErrorMessage, apiGet } from '@/lib/api';
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
import { toast, toastError } from '@/lib/toast';
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

function DaysLeftChip({ item }: { item: HrDeadlineItemDto }) {
  if (item.overdue) return <Chip tone="danger">Просрочено</Chip>;
  if (item.workDaysLeft === null) {
    return item.dueAt ? <Chip tone="neutral">до {item.dueAt.split('-').reverse().join('.')}</Chip> : null;
  }
  const tone = item.workDaysLeft <= 1 ? 'danger' : item.workDaysLeft <= 3 ? 'warning' : 'neutral';
  return (
    <Chip tone={tone}>
      {item.workDaysLeft === 0 ? 'Сегодня' : `${item.workDaysLeft} раб. дн.`}
    </Chip>
  );
}

function Section({
  title,
  items,
  actors,
}: {
  title: string;
  items: HrDeadlineItemDto[];
  actors: Record<string, HrActorLite>;
}) {
  if (!items.length) return null;
  return (
    <Card>
      <CardHeader title={title} subtitle={`${items.length} шт.`} />
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
                  Открыть
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
    onError: (e) => toastError(apiErrorMessage(e)),
  });
  const markNotRequired = useMutation({
    mutationFn: (id: string) => markEsutdNotRequired(workspaceId, id),
    onSuccess: refresh,
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  if (deadlinesQ.isPending) return <LoadingBlock />;
  if (deadlinesQ.isError || !deadlinesQ.data) {
    return (
      <EmptyState
        icon="warningCircle"
        title="Сроки не загрузились"
        description="Экран доступен Менеджеру и выше."
        action={<Button variant="matte" icon="refresh" onClick={() => deadlinesQ.refetch()}>Повторить</Button>}
      />
    );
  }
  const d = deadlinesQ.data;
  const esutdPending = (esutdQ.data?.items ?? []).filter((s) => s.status === 'pending');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gap-grid)' }}>
      <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap', alignItems: 'center' }}>
        <Chip tone={d.total > 0 ? 'warning' : 'success'} icon="clock">
          Горит: {d.total}
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
              saveHrBlob(blob, 'Кадровый реестр.zip');
            } catch (e) {
              toastError(apiErrorMessage(e));
            } finally {
              setZipBusy(false);
            }
          }}
        >
          {zipBusy ? 'Собираем…' : 'Реестр (ZIP)'}
        </Button>
        <Button variant="primary" icon="people" onClick={() => setMassOpen(true)}>
          Массовое действие
        </Button>
      </div>

      {d.total === 0 && (
        <EmptyState icon="checkCircle" title="Ничего не горит" description="Сроки ЕСУТД, вручения и расчёты под контролем." />
      )}

      {esutdQ.isError && (
        <Alert
          tone="warning"
          action={
            <Button variant="matte" size="sm" icon="refresh" onClick={() => void esutdQ.refetch()}>
              Повторить
            </Button>
          }
        >
          Очередь ЕСУТД не загрузилась — сроки сдачи сведений на этом экране сейчас не видны.
        </Alert>
      )}

      {/* ЕСУТД — с кнопками ручного пути */}
      {esutdPending.length > 0 && (
        <Card>
          <CardHeader title="ЕСУТД: не сдано" subtitle={ESUTD_FINES_NOTE} />
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
                      {s.kind === 'contract' ? 'Заключение договора' : s.kind === 'amendment' ? 'Изменение договора' : 'Прекращение договора'}
                    </div>
                    <div className="meta">Срок: до {s.dueAt.split('-').reverse().join('.')}</div>
                    {actor && (
                      <div style={{ marginTop: 6 }}>
                        <PersonChip size="S" userId={actor.id} firstName={actor.firstName} lastName={actor.lastName} avatar={actor.avatar} />
                      </div>
                    )}
                  </div>
                  {s.workDaysLeft !== null && (
                    <Chip tone={s.workDaysLeft < 0 ? 'danger' : s.workDaysLeft <= 1 ? 'danger' : s.workDaysLeft <= 3 ? 'warning' : 'neutral'}>
                      {s.workDaysLeft < 0 ? 'Просрочено' : s.workDaysLeft === 0 ? 'Сегодня' : `${s.workDaysLeft} раб. дн.`}
                    </Chip>
                  )}
                  <Button variant="matte" size="sm" icon="copy" onClick={() => setPayloadFor(s)}>
                    Скопировать сведения
                  </Button>
                  {/* Отметка о сдаче НЕОБРАТИМА для прекращения (п. 13 Правил
                      № 353: правка только через госорган) — спрашиваем номер
                      регистрации и подтверждение, а не закрываем одним кликом. */}
                  <Button variant="primary" size="sm" onClick={() => setSubmitFor(s)}>
                    Отметить сданным
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      confirm(
                        {
                          title: 'Сдача не требуется?',
                          message:
                            'Строка закроется без сдачи сведений в ЕСУТД. Если сведения всё же подлежали сдаче, это нарушение ст. 98 п. 1-1 КоАП РК.',
                          confirmLabel: 'Не требуется',
                          danger: true,
                        },
                        async () => {
                          await markNotRequired.mutateAsync(s.id);
                        },
                      )
                    }
                  >
                    Не требуется
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
          <CardHeader title="ЕСУТД: окно исправления" subtitle="30 рабочих дней на исправление ошибочно внесённых сведений без штрафа" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {(esutdQ.data?.items ?? [])
              .filter((s) => s.status === 'submitted' && s.correctionUntil)
              .map((s) => (
                <div key={s.id} className="meta">
                  {s.kind === 'contract' ? 'Заключение' : s.kind === 'amendment' ? 'Изменение' : 'Прекращение'} · сдано{' '}
                  {s.submittedAt ? new Date(s.submittedAt).toLocaleDateString('ru-RU') : '—'}
                  {s.externalNumber ? ` (№ ${s.externalNumber})` : ''} · исправление без штрафа до{' '}
                  {s.correctionUntil!.split('-').reverse().join('.')}
                </div>
              ))}
          </div>
        </Card>
      )}

      <Section title="Вручения (3 рабочих дня, ст. 61 п. 3)" items={d.deliveries} actors={d.actors} />
      <Section title="Расчёты и документы при увольнении" items={d.settlements} actors={d.actors} />
      <Section title="Испытательные сроки" items={d.probations} actors={d.actors} />
      <Section title="Срочные договоры" items={d.contractEnds} actors={d.actors} />
      <Section title="Ознакомления" items={d.campaigns} actors={d.actors} />

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
    <Modal open onClose={onClose} title="Сведения для ЕСУТД" subtitle="По перечню Правил № 353 — вставьте в форму enbek.kz" size="md">
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
                toast('Скопировано', 'success');
              }}
            >
              Скопировать
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
  const [num, setNum] = useState('');
  const isTermination = submission.kind === 'termination';
  return (
    <Modal open onClose={onClose} title="Отметить сданным в ЕСУТД" size="sm">
      <div style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
        <Alert tone={isTermination ? 'warning' : 'accent'}>
          {isTermination
            ? 'Прекращение договора: после отправки исправить сведения самостоятельно НЕЛЬЗЯ — только через госорган по труду по обращению (п. 13 Правил № 353). Проверьте сведения кнопкой «Скопировать сведения» до отметки.'
            : 'Отметка фиксирует, что сведения поданы через кабинет enbek.kz. Окно исправления без штрафа — 30 рабочих дней.'}
        </Alert>
        <Input
          label="Номер регистрации в ЕСУТД (если есть)"
          value={num}
          onChange={(e) => setNum(e.target.value)}
          placeholder="например, 2026-000123"
          hint="Номер из кабинета enbek.kz — доказательство сдачи; можно оставить пустым."
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--spacing-2)' }}>
          <Button variant="ghost" onClick={onClose}>Отмена</Button>
          <Button
            variant="primary"
            loading={pending}
            onClick={() => void onSubmit(num.trim() || undefined)}
          >
            {isTermination ? 'Подтверждаю: сдано' : 'Отметить сданным'}
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

  const start = useMutation({
    mutationFn: () => {
      if (!effectiveAt) throw new Error('Укажите дату');
      if (!chosenTemplateId) throw new Error('Выберите шаблон приказа');
      if (!audience.length) throw new Error('Выберите аудиторию');
      if (kind === 'leave' && !effectiveTo) throw new Error('Укажите дату окончания отпуска');
      if (kind === 'leave' && effectiveTo && effectiveTo < effectiveAt) {
        throw new Error('Отпуск не может кончаться раньше, чем начался');
      }
      if (kind === 'dismissal' && !ground) throw new Error('Выберите основание прекращения (статья ТК РК)');
      if (kind === 'transfer' && !position[0]) throw new Error('Выберите новую должность');
      const salaryTiyn = salary.trim() ? parseTengeToTiyn(salary) : undefined;
      if (salary.trim() && salaryTiyn === undefined) throw new Error('Оклад — это число, например 250 000');
      if (kind === 'salary_change' && salaryTiyn === undefined) throw new Error('Укажите новый оклад');
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
      return createHrBatch(workspaceId, dto);
    },
    onSuccess: (batch) => onStarted(batch.id),
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  return (
    <Modal open onClose={onClose} title="Массовое кадровое действие" subtitle={`Потолок — ${HR_LIMITS.batchMax} человек за прогон`} size="md">
      <div style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
        <Select
          label="Действие"
          value={kind}
          onChange={(v) => {
            setKind(v);
            setTemplateId('');
          }}
          options={HR_ACTION_KINDS.filter((k) => k.value !== 'hire').map((k) => ({ value: k.value, label: k.label }))}
        />
        <div>
          <div className="label-md" style={{ marginBottom: 6 }}>Аудитория</div>
          <EntitySelector
            types={['user', 'position', 'department', 'branch', 'workspace']}
            value={audience}
            onChange={setAudience}
            context={{ workspaceId }}
            placeholder="Люди, должности, отделы, филиалы или вся организация"
          />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'var(--spacing-3)' }}>
          <DatePicker label="Вступает в силу" value={isoToDate(effectiveAt)} onChange={(dd) => setEffectiveAt(dateToIso(dd))} />
          {kind === 'leave' && (
            <DatePicker label="По" value={isoToDate(effectiveTo)} onChange={(dd) => setEffectiveTo(dateToIso(dd))} />
          )}
        </div>

        {kind === 'transfer' && (
          <>
            <div>
              <div className="label-md" style={{ marginBottom: 6 }}>Новая должность (одна на всю пачку)</div>
              <EntitySelector types={['position']} multi={false} value={position} onChange={setPosition} context={{ workspaceId }} placeholder="Выберите должность" />
            </div>
            <div>
              <div className="label-md" style={{ marginBottom: 6 }}>Новый филиал</div>
              <EntitySelector types={['branch']} multi={false} value={branch} onChange={setBranch} context={{ workspaceId }} placeholder="Без филиала" />
            </div>
            <Toggle
              checked={syncFact}
              onChange={setSyncFact}
              label="Обновить фактические назначения"
              description="Иначе юридический перевод сам родит расхождение «факт ≠ договор» у каждого."
            />
          </>
        )}

        {(kind === 'salary_change' || kind === 'transfer') && (
          <Input
            label={kind === 'salary_change' ? 'Новый оклад, ₸ в месяц (всем в пачке)' : 'Оклад, ₸ в месяц (необязательно)'}
            value={salary}
            onChange={(ev) => setSalary(ev.target.value)}
            placeholder="250000"
            inputMode="numeric"
          />
        )}

        {kind === 'dismissal' && (
          <>
            <Select
              label="Основание (статья ТК РК)"
              value={ground}
              onChange={setGround}
              options={DISMISSAL_GROUNDS.map((g) => ({ value: g.value, label: g.label }))}
              placeholder="Выберите основание"
              hint="Одно основание на всю пачку — оно печатается в каждом приказе и уходит в ЕСУТД."
            />
            {employerInitiative && (
              <>
                <Alert tone="warning">
                  Увольнение по инициативе работодателя: ст. 54 ТК РК проверяется в момент применения по КАЖДОМУ
                  человеку — кто в отпуске, тот получит «Не применено» с причиной. Больничные системе неизвестны.
                </Alert>
                <Toggle
                  checked={banConfirmed}
                  onChange={setBanConfirmed}
                  label="Основание — исключение ст. 54"
                  description="Подтверждаю: основание входит в исключения (пп. 1), 18), 20), 23) п. 1 ст. 52 или п. 1-1)."
                />
              </>
            )}
            <Toggle
              checked={alsoRemove}
              onChange={setAlsoRemove}
              label="И убрать из организации в SuperApp6"
              description="При применении приказа членство тоже снимется — у каждого в пачке."
            />
          </>
        )}

        <Select
          label="Шаблон приказа"
          value={chosenTemplateId}
          onChange={setTemplateId}
          options={templates.map((t) => ({ value: t.id, label: `${t.name}${t.hasRoute ? '' : ' — без маршрута!'}` }))}
          placeholder={templatesQ.isPending ? 'Загружаем…' : 'Выберите шаблон'}
        />
        <Alert tone="accent">
          На каждого человека будет создан СВОЙ приказ и запущен маршрут («приказ пер-человек юридически верен»). Один
          неподходящий человек не валит пачку — он останется на экране прогресса с причиной.
        </Alert>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--spacing-2)' }}>
          <Button variant="ghost" onClick={onClose}>Отмена</Button>
          <Button variant="primary" loading={start.isPending} onClick={() => start.mutate()}>Запустить</Button>
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
    <Modal open onClose={onClose} title="Массовая операция" subtitle={b ? `${created} из ${b.total}` : undefined} size="sm">
      {!b ? (
        <LoadingBlock />
      ) : (
        <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
          <TickBar value={b.total ? Math.round((created / b.total) * 100) : 0} />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {b.progress.in_progress > 0 && <Chip tone="accent">На оформлении: {b.progress.in_progress}</Chip>}
            {b.progress.draft > 0 && <Chip tone="neutral">Черновики: {b.progress.draft}</Chip>}
            {b.progress.scheduled > 0 && <Chip tone="warning">Вступают в силу: {b.progress.scheduled}</Chip>}
            {b.progress.applied > 0 && <Chip tone="success">Применено: {b.progress.applied}</Chip>}
            {b.progress.failed > 0 && <Chip tone="danger">Не удалось: {b.progress.failed}</Chip>}
          </div>
          <div className="meta">
            {b.status === 'running'
              ? 'Приказы создаются и уходят на маршруты…'
              : 'Пачка создана. Приказы идут по маршрутам — прогресс виден в действиях людей.'}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button variant="matte" onClick={onClose}>Закрыть</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
