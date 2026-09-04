'use client';

// ============================================================
// КЭДО, страница человека — блоки и модалки. Внутренности по образцу карточки
// контрагента: SegmentedControl + блоки-Card; ростер members/page.tsx не
// раздуваем (правило плана — новые файлы).
// ============================================================

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CONTRACT_MAX_SILENT_EXTENSIONS,
  CONTRACT_TYPES,
  DISMISSAL_GROUNDS,
  HR_ACTION_KIND_LABELS,
  HR_ACTION_ORDER_LIBRARY_KEY,
  HR_ACTION_STATUS_LABELS,
  ST54_BAN_EXCEPTIONS_NOTE,
  type CreateHrActionInput,
  type DocTemplateDto,
  type EmploymentDto,
  type HrActionDto,
  type HrActionKind,
  type HrMemberCardDto,
  type UpsertEmploymentInput,
} from '@superapp/shared';
import { apiErrorMessage, apiGet } from '@/lib/api';
import { dmyOrDash } from '@/lib/dates';
import { cancelHrAction, createHrAction, upsertEmployment } from '@/lib/hr-api';
import { hrMemberKey, hrRootKey } from '@/lib/queries';
import { toastError } from '@/lib/toast';
import {
  Alert,
  Button,
  Card,
  CardHeader,
  Checkbox,
  Chip,
  DatePicker,
  EmptyState,
  Input,
  Modal,
  SegmentedControl,
  Select,
  Toggle,
  useConfirm,
} from '@/components/ui';
import { EntitySelector } from '@/components/EntitySelector';
import type { Principal } from '@/lib/entities';

// ---------- Утилиты ----------

/** Формат один на весь веб — `lib/dates` (здесь только привычное для КЭДО имя) */
export const fmtDate = (iso: string | null | undefined): string => dmyOrDash(iso);

/** Тиыны (строка/число) → «250 000 ₸» */
export const fmtMoney = (tiyn: string | number | null | undefined): string => {
  if (tiyn === null || tiyn === undefined || tiyn === '') return '—';
  const tenge = Math.round(Number(tiyn) / 100);
  return `${tenge.toLocaleString('ru-RU')} ₸`;
};

/**
 * Ввод суммы → тиыны. `undefined` — «введено не число»: раньше строка «250 000,50»
 * или опечатка давали NaN, а `JSON.stringify(NaN)` — это `null`, и оклад молча
 * СТИРАЛСЯ (в действии — падал в 400 без внятной причины). Запятая-разделитель
 * принимается: так пишут в тенге по-русски.
 */
export const parseTengeToTiyn = (raw: string): number | undefined => {
  const norm = raw.replace(/\s| /g, '').replace(',', '.');
  if (!norm) return undefined;
  const n = Number(norm);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 100);
};

/** Ставка: «0,5» — то же число, что «0.5»; мусор → undefined (а не молчаливая 1) */
export const parseRate = (raw: string): number | undefined => {
  const n = Number(raw.replace(/\s| /g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

const isoToDate = (iso: string | null | undefined): Date | null => (iso ? new Date(`${iso}T00:00:00`) : null);
const dateToIso = (d: Date | null): string | undefined =>
  d
    ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    : undefined;

const contractTypeLabel = (v: string): string => CONTRACT_TYPES.find((t) => t.value === v)?.label ?? v;

// ---------- Трудовые данные ----------

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--spacing-3)', padding: '0.35rem 0' }}>
      <span className="label-md">{label}</span>
      <span style={{ textAlign: 'right', fontWeight: 600 }}>{value}</span>
    </div>
  );
}

export function EmploymentCard({
  workspaceId,
  userId,
  card,
}: {
  workspaceId: string;
  userId: string;
  card: HrMemberCardDto;
}) {
  const [editing, setEditing] = useState(false);
  // Совместительство: у человека может быть карточка в каждом юрлице организации.
  // Переключатель появляется, только когда их правда больше одной.
  const employments = card.employments?.length ? card.employments : card.employment ? [card.employment] : [];
  const [activeId, setActiveId] = useState<string | null>(null);
  const e = employments.find((x) => x.id === activeId) ?? employments[0] ?? null;

  if (!card.canSeeEmployment) {
    return (
      <Card>
        <EmptyState icon="lock" title="Трудовая карточка закрыта" description="Её видят управляющие и сам сотрудник." />
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Трудовая карточка"
        subtitle="Юридический план: как договорились"
        actions={
          card.canManage ? (
            <Button variant="matte" size="sm" icon="edit" onClick={() => setEditing(true)}>
              {e ? 'Править' : 'Завести'}
            </Button>
          ) : undefined
        }
      />
      {employments.length > 1 && (
        <div style={{ marginBottom: 'var(--spacing-4)' }}>
          <SegmentedControl
            value={e?.id ?? employments[0].id}
            onChange={setActiveId}
            items={employments.map((x) => ({ key: x.id, label: x.legalEntityName ?? 'Юрлицо' }))}
          />
        </div>
      )}
      {!e ? (
        <EmptyState
          icon="file"
          title="Трудовой карточки нет"
          description="Оформите приём кадровым действием — или заведите карточку вручную, если человек уже работает."
        />
      ) : (
        <div>
          <Row label="Работодатель" value={e.legalEntityName ?? '—'} />
          <Row
            label="Статус"
            value={
              <Chip tone={e.status === 'active' ? 'success' : e.status === 'terminated' ? 'danger' : 'warning'}>
                {e.status === 'active' ? 'Работает' : e.status === 'terminated' ? 'Уволен' : 'Оформляется'}
              </Chip>
            }
          />
          <Row label="Дата приёма" value={fmtDate(e.hiredAt)} />
          {e.firedAt && <Row label="Дата увольнения" value={fmtDate(e.firedAt)} />}
          {e.dismissalGround && (
            <Row
              label="Основание прекращения"
              value={DISMISSAL_GROUNDS.find((g) => g.value === e.dismissalGround)?.label ?? e.dismissalGround}
            />
          )}
          <Row label="Договор" value={`${e.contractNumber ? `№ ${e.contractNumber} · ` : ''}${contractTypeLabel(e.contractType)}`} />
          {e.contractDate && <Row label="Дата договора" value={fmtDate(e.contractDate)} />}
          {e.contractEndAt && (
            <Row
              label="Окончание договора"
              value={
                <>
                  {fmtDate(e.contractEndAt)}
                  {e.contractExtensionsCount >= CONTRACT_MAX_SILENT_EXTENSIONS && (
                    <Chip tone="warning" style={{ marginLeft: 8 }}>
                      продлевался молчанием ×{e.contractExtensionsCount} — считается бессрочным (ст. 30 ТК РК)
                    </Chip>
                  )}
                </>
              }
            />
          )}
          {e.probationUntil && <Row label="Испытательный срок до" value={fmtDate(e.probationUntil)} />}
          <Row label="Должность по договору" value={e.legalPositionName ?? '—'} />
          <Row label="Филиал по договору" value={e.legalBranchName ?? '—'} />
          <Row label="Оклад" value={fmtMoney(e.salaryAmount)} />
          <Row label="Ставка" value={e.workRate ?? 1} />
          <Row label="График" value={e.workSchedule ?? '—'} />
          <Row label="Табельный номер" value={e.personnelNumber ?? '—'} />
          <Row
            label="Документооборот"
            value={
              e.paperMode ? <Chip tone="warning">гибрид: без ЭЦП, с бумажным дублем</Chip> : <Chip tone="success">электронный</Chip>
            }
          />
        </div>
      )}
      {editing && (
        <EmploymentEditModal
          workspaceId={workspaceId}
          userId={userId}
          employment={e}
          onClose={() => setEditing(false)}
        />
      )}
    </Card>
  );
}

function EmploymentEditModal({
  workspaceId,
  userId,
  employment,
  onClose,
}: {
  workspaceId: string;
  userId: string;
  employment: EmploymentDto | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const e = employment;
  const [hiredAt, setHiredAt] = useState<string | undefined>(e?.hiredAt ?? undefined);
  const [contractNumber, setContractNumber] = useState(e?.contractNumber ?? '');
  const [contractDate, setContractDate] = useState<string | undefined>(e?.contractDate ?? undefined);
  const [contractType, setContractType] = useState(e?.contractType ?? 'indefinite');
  const [contractEndAt, setContractEndAt] = useState<string | undefined>(e?.contractEndAt ?? undefined);
  const [probationUntil, setProbationUntil] = useState<string | undefined>(e?.probationUntil ?? undefined);
  const [position, setPosition] = useState<Principal[]>(
    e?.legalPositionId ? [{ type: 'position', id: e.legalPositionId }] : [],
  );
  const [branch, setBranch] = useState<Principal[]>(e?.legalBranchId ? [{ type: 'branch', id: e.legalBranchId }] : []);
  const [salary, setSalary] = useState(e?.salaryAmount ? String(Math.round(Number(e.salaryAmount) / 100)) : '');
  const [workRate, setWorkRate] = useState(String(e?.workRate ?? 1));
  const [workSchedule, setWorkSchedule] = useState(e?.workSchedule ?? '');
  const [paperMode, setPaperMode] = useState(e?.paperMode ?? false);
  const [personnelNumber, setPersonnelNumber] = useState(e?.personnelNumber ?? '');

  const save = useMutation({
    mutationFn: () => {
      // Числа проверяем ДО отправки: молчаливое «оклад стёрся» и «ставка стала 1»
      // человек замечает через месяц, в расчётном листке.
      const salaryTiyn = salary.trim() ? parseTengeToTiyn(salary) : null;
      if (salaryTiyn === undefined) throw new Error('Оклад — это число, например 250 000');
      const rate = workRate.trim() ? parseRate(workRate) : 1;
      if (rate === undefined) throw new Error('Ставка — это число, например 1 или 0,5');
      const dto: UpsertEmploymentInput = {
        // Правим КОНКРЕТНУЮ карточку: у совместителя их несколько (по юрлицам)
        ...(e ? { employmentId: e.id } : {}),
        hiredAt: hiredAt ?? null,
        contractNumber: contractNumber.trim() || null,
        contractDate: contractDate ?? null,
        contractType: contractType as UpsertEmploymentInput['contractType'],
        contractEndAt: contractEndAt ?? null,
        probationUntil: probationUntil ?? null,
        legalPositionId: position[0]?.id ?? null,
        legalBranchId: branch[0]?.id ?? null,
        salaryAmount: salaryTiyn,
        workRate: rate,
        workSchedule: workSchedule.trim() || null,
        paperMode,
        personnelNumber: personnelNumber.trim() || null,
      };
      return upsertEmployment(workspaceId, userId, dto);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: hrMemberKey(workspaceId, userId) });
      void qc.invalidateQueries({ queryKey: hrRootKey(workspaceId) });
      onClose();
    },
    onError: (err) => toastError(apiErrorMessage(err)),
  });

  return (
    <Modal open onClose={onClose} title={e ? 'Трудовая карточка' : 'Завести трудовую карточку'} size="md">
      <div style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--spacing-3)' }}>
          <DatePicker label="Дата приёма" value={isoToDate(hiredAt)} onChange={(d) => setHiredAt(dateToIso(d))} />
          <Input label="Номер договора" value={contractNumber} onChange={(ev) => setContractNumber(ev.target.value)} placeholder="ТД-2026-014" />
          <DatePicker label="Дата договора" value={isoToDate(contractDate)} onChange={(d) => setContractDate(dateToIso(d))} />
          <Select
            label="Вид договора"
            value={contractType}
            onChange={(v) => setContractType(v)}
            options={CONTRACT_TYPES.map((t) => ({ value: t.value, label: t.label }))}
          />
          {contractType !== 'indefinite' && (
            <DatePicker label="Окончание договора" value={isoToDate(contractEndAt)} onChange={(d) => setContractEndAt(dateToIso(d))} />
          )}
          <DatePicker label="Испытательный срок до" value={isoToDate(probationUntil)} onChange={(d) => setProbationUntil(dateToIso(d))} />
          <Input label="Оклад, ₸ в месяц" value={salary} onChange={(ev) => setSalary(ev.target.value)} placeholder="250000" inputMode="numeric" />
          <Input label="Ставка" value={workRate} onChange={(ev) => setWorkRate(ev.target.value)} placeholder="1 / 0.5" inputMode="decimal" />
          <Input label="График" value={workSchedule} onChange={(ev) => setWorkSchedule(ev.target.value)} placeholder="5/2, 09:00–18:00" />
          <Input label="Табельный номер" value={personnelNumber} onChange={(ev) => setPersonnelNumber(ev.target.value)} placeholder="0042" />
        </div>
        <div>
          <div className="label-md" style={{ marginBottom: 6 }}>Должность по договору</div>
          <EntitySelector types={['position']} multi={false} value={position} onChange={setPosition} context={{ workspaceId }} placeholder="Выберите должность" />
        </div>
        <div>
          <div className="label-md" style={{ marginBottom: 6 }}>Филиал по договору</div>
          <EntitySelector types={['branch']} multi={false} value={branch} onChange={setBranch} context={{ workspaceId }} placeholder="Без филиала" />
        </div>
        <Toggle
          checked={paperMode}
          onChange={setPaperMode}
          label="Гибридный режим (без ЭЦП)"
          description="У работника нет ЭЦП — подписи работника заменяет печать комплекта и фиксация вручения. Обязать работника получить ЭЦП нельзя."
        />
        <div style={{ display: 'flex', gap: 'var(--spacing-2)', justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose}>Отмена</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Сохранить</Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------- Кадровые действия ----------

const STATUS_TONE: Record<string, 'accent' | 'success' | 'danger' | 'warning' | 'neutral'> = {
  draft: 'neutral',
  in_progress: 'accent',
  scheduled: 'warning',
  applied: 'success',
  cancelled: 'neutral',
  failed: 'danger',
};

export function ActionsCard({
  workspaceId,
  card,
  meId,
}: {
  workspaceId: string;
  card: HrMemberCardDto;
  meId?: string;
}) {
  const qc = useQueryClient();
  const [confirm, confirmUI] = useConfirm();
  const cancel = useMutation({
    mutationFn: (actionId: string) => cancelHrAction(workspaceId, actionId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: hrMemberKey(workspaceId, card.user.id) });
      void qc.invalidateQueries({ queryKey: hrRootKey(workspaceId) });
    },
    onError: (err) => toastError(apiErrorMessage(err)),
  });

  if (!card.canSeeEmployment) return null;
  return (
    <Card>
      <CardHeader title="Кадровые действия" subtitle="Действие первично — документ производен" />
      {card.actions.length === 0 ? (
        <EmptyState icon="list" title="Действий пока не было" description="Приём, перевод, отпуск и увольнение появятся здесь." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
          {card.actions.map((a) => {
            // Ст. 56 п. 4 — отзыв СВОЕГО заявления (увольнение по собственному
            // желанию). Приказ работодателя (сокращение, ст. 52) работник не
            // отменяет: сервер это отвергает, и кнопки быть не должно тоже.
            const isOwnApplication =
              a.kind === 'dismissal' &&
              a.userId === meId &&
              (a.source === 'employee' || (a.params as { ground?: string } | undefined)?.ground === 'st56');
            return (
            <ActionRow
              key={a.id}
              workspaceId={workspaceId}
              action={a}
              canCancel={
                ['draft', 'in_progress', 'scheduled'].includes(a.status) && (card.canManage || isOwnApplication)
              }
              cancelLabel={isOwnApplication && !card.canManage ? 'Отозвать заявление' : 'Отменить'}
              onCancel={() =>
                confirm(
                  {
                    title: 'Отменить действие?',
                    message: isOwnApplication
                      ? 'Отзыв заявления безусловен весь срок уведомления (ст. 56 п. 4 ТК РК). Неизданный приказ отменится; об изданном кадровик получит задачу издать приказ об отмене.'
                      : 'Неприменённое действие и его неизданные документы будут отменены.',
                    confirmLabel: 'Отменить действие',
                    danger: true,
                  },
                  async () => {
                    await cancel.mutateAsync(a.id);
                  },
                )
              }
            />
            );
          })}
        </div>
      )}
      {confirmUI}
    </Card>
  );
}

function ActionRow({
  workspaceId,
  action,
  canCancel,
  cancelLabel,
  onCancel,
}: {
  workspaceId: string;
  action: HrActionDto;
  canCancel: boolean;
  cancelLabel: string;
  onCancel: () => void;
}) {
  const a = action;
  return (
    <div
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
          {HR_ACTION_KIND_LABELS[a.kind]} · с {fmtDate(a.effectiveAt)}
          {a.effectiveTo ? ` по ${fmtDate(a.effectiveTo)}` : ''}
        </div>
        <div className="meta" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
          <Chip tone={STATUS_TONE[a.status] ?? 'neutral'}>{HR_ACTION_STATUS_LABELS[a.status]}</Chip>
          {a.documents.length > 1 && (
            // Прогресс пакета (онбординг «подписано N из M») — по статусам документов
            <Chip tone="neutral">
              Подписано {a.documents.filter((d) => ['signed', 'registered', 'active', 'archived'].includes(d.status)).length}{' '}
              из {a.documents.length}
            </Chip>
          )}
          {a.failReason && <span style={{ color: 'var(--danger-text)' }}>{a.failReason}</span>}
        </div>
        {a.documents.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            {a.documents.map((d) => (
              <Button
                key={d.id}
                variant="ghost"
                size="sm"
                icon="file"
                href={`/workspaces/${workspaceId}/documents/${d.id}`}
              >
                {d.number ? `${d.title} № ${d.number}` : d.title}
              </Button>
            ))}
          </div>
        )}
      </div>
      {canCancel && (
        <Button variant="matte" tone="danger" size="sm" onClick={onCancel}>
          {cancelLabel}
        </Button>
      )}
    </div>
  );
}

// ---------- Модалка кадрового действия ----------

export function HrActionModal({
  workspaceId,
  userId,
  kind,
  employment,
  onClose,
}: {
  workspaceId: string;
  userId: string;
  kind: HrActionKind;
  employment: EmploymentDto | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [effectiveAt, setEffectiveAt] = useState<string | undefined>(undefined);
  const [effectiveTo, setEffectiveTo] = useState<string | undefined>(undefined);
  const [templateId, setTemplateId] = useState('');
  const [position, setPosition] = useState<Principal[]>([]);
  const [branch, setBranch] = useState<Principal[]>([]);
  const [salary, setSalary] = useState('');
  // Основание НЕ предзаполняем: дефолт «по собственному желанию» в модалке,
  // которую открывает кадровик, — это приказ с чужой формулировкой у того,
  // кто забыл поменять список.
  const [ground, setGround] = useState('');
  const [syncFact, setSyncFact] = useState(true);
  const [alsoRemove, setAlsoRemove] = useState(false);
  const [banConfirmed, setBanConfirmed] = useState(false);
  const [contractType, setContractType] = useState('indefinite');
  const [probationUntil, setProbationUntil] = useState<string | undefined>(undefined);
  // Онбординг-пакет приёма: null = дефолт (договор + согласие на ПД из библиотеки)
  const [packageIds, setPackageIds] = useState<string[] | null>(null);

  // Шаблоны приказов (Менеджер+): подставляем библиотечный по виду действия
  const templatesQ = useQuery({
    queryKey: [...hrRootKey(workspaceId), 'templates-for-actions'],
    queryFn: () => apiGet<DocTemplateDto[]>(`/workspaces/${workspaceId}/documents/templates`),
  });
  const templates = useMemo(
    () => (templatesQ.data ?? []).filter((t) => t.status === 'published' && t.category === 'hr'),
    [templatesQ.data],
  );
  const defaultTemplate = useMemo(
    () => templates.find((t) => t.libraryKey === HR_ACTION_ORDER_LIBRARY_KEY[kind]) ?? null,
    [templates, kind],
  );
  const chosenTemplateId = templateId || defaultTemplate?.id || '';

  // Пакет приёма (Этап 4: «один объект с одним прогрессом»): кандидаты — прочие
  // published hr-шаблоны; по умолчанию отмечены договор и согласие на ПД.
  const orderKeys = useMemo(() => new Set(Object.values(HR_ACTION_ORDER_LIBRARY_KEY)), []);
  const packageCandidates = useMemo(
    // Пакет приёма — это ДОГОВОР и согласия, а не приказы: предложить в нём
    // «Приказ об увольнении» значит дать оформить его одним кликом при приёме.
    () => templates.filter((t) => t.id !== chosenTemplateId && !(t.libraryKey && orderKeys.has(t.libraryKey))),
    [templates, chosenTemplateId, orderKeys],
  );
  const defaultPackageIds = useMemo(
    () =>
      packageCandidates
        .filter((t) => t.libraryKey === 'employment_contract' || t.libraryKey === 'pd_consent')
        .map((t) => t.id),
    [packageCandidates],
  );
  const effectivePackage = packageIds ?? defaultPackageIds;
  const togglePackage = (id: string) =>
    setPackageIds(effectivePackage.includes(id) ? effectivePackage.filter((x) => x !== id) : [...effectivePackage, id]);

  const groundMeta = DISMISSAL_GROUNDS.find((g) => g.value === ground);
  const employerInitiative = !!groundMeta?.employerInitiative;

  const create = useMutation({
    mutationFn: () => {
      if (!effectiveAt) throw new Error('Укажите дату вступления в силу');
      if (kind === 'leave' && !effectiveTo) throw new Error('Укажите дату окончания отпуска');
      if (kind === 'leave' && effectiveTo && effectiveTo < effectiveAt) {
        throw new Error('Отпуск не может кончаться раньше, чем начался');
      }
      if (kind === 'dismissal' && !ground) throw new Error('Выберите основание прекращения (статья ТК РК)');
      if (kind === 'transfer' && !position[0]) throw new Error('Выберите новую должность');
      if (!chosenTemplateId) throw new Error('Выберите шаблон приказа');
      const salaryTiyn = salary.trim() ? parseTengeToTiyn(salary) : undefined;
      if (salary.trim() && salaryTiyn === undefined) throw new Error('Оклад — это число, например 250 000');
      if (kind === 'salary_change' && salaryTiyn === undefined) throw new Error('Укажите новый оклад');
      const dto: CreateHrActionInput = {
        kind,
        userId,
        effectiveAt,
        ...(kind === 'leave' ? { effectiveTo } : {}),
        templateId: chosenTemplateId,
        ...(kind === 'hire' && effectivePackage.length ? { packageTemplateIds: effectivePackage } : {}),
        params: {
          ...(kind === 'dismissal'
            ? { ground: ground as never, alsoRemoveMembership: alsoRemove, banExceptionConfirmed: banConfirmed || undefined }
            : {}),
          ...(kind === 'transfer'
            ? { legalPositionId: position[0]?.id, legalBranchId: branch[0]?.id ?? null, syncFact }
            : {}),
          ...((kind === 'salary_change' || kind === 'transfer' || kind === 'hire') && salaryTiyn !== undefined
            ? { salaryAmount: salaryTiyn }
            : {}),
          ...(kind === 'hire'
            ? {
                contractType: contractType as never,
                probationUntil,
                legalPositionId: position[0]?.id,
                legalBranchId: branch[0]?.id ?? null,
              }
            : {}),
        },
      };
      return createHrAction(workspaceId, dto);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: hrMemberKey(workspaceId, userId) });
      void qc.invalidateQueries({ queryKey: hrRootKey(workspaceId) });
      onClose();
    },
    onError: (err) => toastError(apiErrorMessage(err)),
  });

  const title = HR_ACTION_KIND_LABELS[kind];

  return (
    <Modal open onClose={onClose} title={title} size="md">
      <div style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
        {kind === 'dismissal' && (
          <Alert tone="warning">
            Проверка ст. 54 ТК РК повторится в момент применения: отпуска — по данным системы, <b>больничные системе
            неизвестны — проверьте вручную</b>. {ST54_BAN_EXCEPTIONS_NOTE}
          </Alert>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--spacing-3)' }}>
          <DatePicker
            label={kind === 'leave' ? 'Отпуск с' : kind === 'dismissal' ? 'Дата увольнения' : 'Вступает в силу'}
            value={isoToDate(effectiveAt)}
            onChange={(d) => setEffectiveAt(dateToIso(d))}
          />
          {kind === 'leave' && (
            <DatePicker label="Отпуск по" value={isoToDate(effectiveTo)} onChange={(d) => setEffectiveTo(dateToIso(d))} />
          )}
        </div>

        {(kind === 'transfer' || kind === 'hire') && (
          <>
            <div>
              <div className="label-md" style={{ marginBottom: 6 }}>{kind === 'transfer' ? 'Новая должность' : 'Должность по договору'}</div>
              <EntitySelector types={['position']} multi={false} value={position} onChange={setPosition} context={{ workspaceId }} placeholder="Выберите должность" />
            </div>
            <div>
              <div className="label-md" style={{ marginBottom: 6 }}>Филиал</div>
              <EntitySelector types={['branch']} multi={false} value={branch} onChange={setBranch} context={{ workspaceId }} placeholder="Без филиала" />
            </div>
          </>
        )}

        {(kind === 'salary_change' || kind === 'transfer' || kind === 'hire') && (
          <Input
            label={kind === 'salary_change' ? 'Новый оклад, ₸ в месяц' : 'Оклад, ₸ в месяц'}
            value={salary}
            onChange={(ev) => setSalary(ev.target.value)}
            placeholder="250000"
            inputMode="numeric"
            hint={employment?.salaryAmount ? `Сейчас: ${fmtMoney(employment.salaryAmount)}` : undefined}
          />
        )}

        {kind === 'hire' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--spacing-3)' }}>
            <Select
              label="Вид договора"
              value={contractType}
              onChange={setContractType}
              options={CONTRACT_TYPES.map((t) => ({ value: t.value, label: t.label }))}
            />
            <DatePicker label="Испытательный срок до" value={isoToDate(probationUntil)} onChange={(d) => setProbationUntil(dateToIso(d))} />
          </div>
        )}

        {kind === 'hire' && packageCandidates.length > 0 && (
          <div>
            {/* Онбординг-пакет: один объект с одним прогрессом «подписано N из M».
                По умолчанию отмечены трудовой договор и согласие на ПД (библиотека). */}
            <div className="label-md" style={{ marginBottom: 6 }}>
              Пакет приёма (вместе с приказом)
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              {packageCandidates.map((t) => (
                <Checkbox
                  key={t.id}
                  checked={effectivePackage.includes(t.id)}
                  onChange={() => togglePackage(t.id)}
                  label={t.name}
                />
              ))}
            </div>
          </div>
        )}

        {kind === 'transfer' && (
          <Toggle
            checked={syncFact}
            onChange={setSyncFact}
            label="Обновить фактическое назначение"
            description="Иначе юридический перевод сам родит расхождение «факт ≠ договор»."
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
              hint="Основание печатается в приказе и уходит в ЕСУТД — предзаполнения нет намеренно."
            />
            {employerInitiative && (
              <Toggle
                checked={banConfirmed}
                onChange={setBanConfirmed}
                label="Основание — исключение ст. 54"
                description="Подтверждаю: основание входит в исключения (пп. 1), 18), 20), 23) п. 1 ст. 52 или п. 1-1) — применение в период отпуска не блокировать."
              />
            )}
            <Toggle
              checked={alsoRemove}
              onChange={setAlsoRemove}
              label="И убрать из организации в SuperApp6"
              description="При применении приказа членство в организации тоже снимется («и то и другое»). Выключено — только юридическое увольнение."
            />
          </>
        )}

        <Select
          label="Шаблон приказа"
          value={chosenTemplateId}
          onChange={setTemplateId}
          options={templates.map((t) => ({ value: t.id, label: `${t.name}${t.hasRoute ? '' : ' — без маршрута!'}` }))}
          placeholder={templatesQ.isPending ? 'Загружаем…' : 'Выберите шаблон'}
          hint="У шаблона должен быть опубликованный маршрут с нодой «Применить кадровое действие» — иначе старт честно откажет. Готовые бланки — в библиотеке (Документооборот → Шаблоны)."
        />

        <div style={{ display: 'flex', gap: 'var(--spacing-2)', justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose}>Отмена</Button>
          <Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>
            Создать приказ
          </Button>
        </div>
      </div>
    </Modal>
  );
}
