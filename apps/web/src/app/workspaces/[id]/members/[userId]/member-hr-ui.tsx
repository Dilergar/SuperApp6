'use client';

// ============================================================
// КЭДО, страница человека — блоки и модалки. Внутренности по образцу карточки
// контрагента: SegmentedControl + блоки-Card; ростер members/page.tsx не
// раздуваем (правило плана — новые файлы).
// ============================================================

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import {
  CONTRACT_MAX_SILENT_EXTENSIONS,
  CONTRACT_TYPES,
  DISMISSAL_GROUNDS,
  HR_ACTION_ORDER_LIBRARY_KEY,
  SOURCE_LOCALE,
  type CreateHrActionInput,
  type DocTemplateDto,
  type EmploymentDto,
  type HrActionDto,
  type HrActionKind,
  type HrMemberCardDto,
  type UpsertEmploymentInput,
} from '@superapp/shared';
import { formatMoney } from '@superapp/i18n/format';
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

/**
 * Тиыны (строка/число) → «250 000 ₸». Разделители и знак валюты — ПРАВИЛА
 * РЕГИОНА, а не языка: в Казахстане деньги пишутся одинаково и для того, кто
 * выбрал English. Поэтому функция остаётся чистой (тот же приём, что у
 * `formatWalletAmount`), а прочерк передаёт вызывающий — слово у него есть.
 */
export const fmtMoney = (tiyn: string | number | null | undefined, dash = '—'): string => {
  if (tiyn === null || tiyn === undefined || tiyn === '') return dash;
  return formatMoney(Math.round(Number(tiyn) / 100), { locale: SOURCE_LOCALE }, { scale: 0 });
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
  const t = useTranslations('hr');
  const tc = useTranslations('common');
  const [editing, setEditing] = useState(false);
  // Совместительство: у человека может быть карточка в каждом юрлице организации.
  // Переключатель появляется, только когда их правда больше одной.
  const employments = card.employments?.length ? card.employments : card.employment ? [card.employment] : [];
  const [activeId, setActiveId] = useState<string | null>(null);
  const e = employments.find((x) => x.id === activeId) ?? employments[0] ?? null;

  if (!card.canSeeEmployment) {
    return (
      <Card>
        <EmptyState icon="lock" title={t('employment.lockedTitle')} description={t('employment.lockedDescription')} />
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title={t('employment.title')}
        subtitle={t('employment.subtitle')}
        actions={
          card.canManage ? (
            <Button variant="matte" size="sm" icon="edit" onClick={() => setEditing(true)}>
              {e ? tc('actions.edit') : t('employment.create')}
            </Button>
          ) : undefined
        }
      />
      {employments.length > 1 && (
        <div style={{ marginBottom: 'var(--spacing-4)' }}>
          <SegmentedControl
            value={e?.id ?? employments[0].id}
            onChange={setActiveId}
            items={employments.map((x) => ({ key: x.id, label: x.legalEntityName ?? t('employment.legalEntity') }))}
          />
        </div>
      )}
      {!e ? (
        <EmptyState
          icon="file"
          title={t('employment.emptyTitle')}
          description={t('employment.emptyDescription')}
        />
      ) : (
        <div>
          <Row label={t('esutd.field.employer')} value={e.legalEntityName ?? tc('labels.dash')} />
          <Row
            label={tc('labels.status')}
            value={
              <Chip tone={e.status === 'active' ? 'success' : e.status === 'terminated' ? 'danger' : 'warning'}>
                {t(`employmentStatus.${e.status}`)}
              </Chip>
            }
          />
          <Row label={t('esutd.field.hiredAt')} value={fmtDate(e.hiredAt)} />
          {e.firedAt && <Row label={t('esutd.field.firedAt')} value={fmtDate(e.firedAt)} />}
          {e.dismissalGround && (
            <Row label={t('esutd.field.dismissalGround')} value={t(`ground.${e.dismissalGround}`)} />
          )}
          <Row
            label={t('employment.contract')}
            value={t('employment.contractValue', {
              numberPrefix: e.contractNumber ? t('employment.contractNumberPrefix', { number: e.contractNumber }) : '',
              type: t(`contractType.${e.contractType}`),
            })}
          />
          {e.contractDate && <Row label={t('esutd.field.contractDate')} value={fmtDate(e.contractDate)} />}
          {e.contractEndAt && (
            <Row
              label={t('employment.contractEnd')}
              value={
                <>
                  {fmtDate(e.contractEndAt)}
                  {e.contractExtensionsCount >= CONTRACT_MAX_SILENT_EXTENSIONS && (
                    <Chip tone="warning" style={{ marginLeft: 8 }}>
                      {t('employment.silentExtensions', { count: e.contractExtensionsCount })}
                    </Chip>
                  )}
                </>
              }
            />
          )}
          {e.probationUntil && <Row label={t('employment.probationUntil')} value={fmtDate(e.probationUntil)} />}
          <Row label={t('employment.legalPosition')} value={e.legalPositionName ?? tc('labels.dash')} />
          <Row label={t('employment.legalBranch')} value={e.legalBranchName ?? tc('labels.dash')} />
          <Row label={t('employment.salary')} value={fmtMoney(e.salaryAmount, tc('labels.dash'))} />
          <Row label={t('employment.workRate')} value={e.workRate ?? 1} />
          <Row label={t('employment.workSchedule')} value={e.workSchedule ?? tc('labels.dash')} />
          <Row label={t('employment.personnelNumber')} value={e.personnelNumber ?? tc('labels.dash')} />
          <Row
            label={t('employment.docFlow')}
            value={
              e.paperMode ? (
                <Chip tone="warning">{t('deliveryMode.hybrid')}</Chip>
              ) : (
                <Chip tone="success">{t('deliveryMode.electronic')}</Chip>
              )
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
  const t = useTranslations('hr');
  const tc = useTranslations('common');
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
      if (salaryTiyn === undefined) throw new Error(t('form.salaryNumber'));
      const rate = workRate.trim() ? parseRate(workRate) : 1;
      if (rate === undefined) throw new Error(t('form.rateNumber'));
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
    <Modal open onClose={onClose} title={t(e ? 'employment.title' : 'employment.createTitle')} size="md">
      <div style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--spacing-3)' }}>
          <DatePicker label={t('esutd.field.hiredAt')} value={isoToDate(hiredAt)} onChange={(d) => setHiredAt(dateToIso(d))} />
          <Input label={t('esutd.field.contractNumber')} value={contractNumber} onChange={(ev) => setContractNumber(ev.target.value)} placeholder="2026-014" />
          <DatePicker label={t('esutd.field.contractDate')} value={isoToDate(contractDate)} onChange={(d) => setContractDate(dateToIso(d))} />
          <Select
            label={t('esutd.field.contractType')}
            value={contractType}
            onChange={(v) => setContractType(v)}
            options={CONTRACT_TYPES.map((ct) => ({ value: ct, label: t(`contractType.${ct}`) }))}
          />
          {contractType !== 'indefinite' && (
            <DatePicker label={t('employment.contractEnd')} value={isoToDate(contractEndAt)} onChange={(d) => setContractEndAt(dateToIso(d))} />
          )}
          <DatePicker label={t('employment.probationUntil')} value={isoToDate(probationUntil)} onChange={(d) => setProbationUntil(dateToIso(d))} />
          <Input label={t('form.salaryMonthly')} value={salary} onChange={(ev) => setSalary(ev.target.value)} placeholder="250000" inputMode="numeric" />
          <Input label={t('employment.workRate')} value={workRate} onChange={(ev) => setWorkRate(ev.target.value)} placeholder="1 / 0.5" inputMode="decimal" />
          <Input label={t('employment.workSchedule')} value={workSchedule} onChange={(ev) => setWorkSchedule(ev.target.value)} placeholder="5/2, 09:00–18:00" />
          <Input label={t('employment.personnelNumber')} value={personnelNumber} onChange={(ev) => setPersonnelNumber(ev.target.value)} placeholder="0042" />
        </div>
        <div>
          <div className="label-md" style={{ marginBottom: 6 }}>{t('employment.legalPosition')}</div>
          <EntitySelector types={['position']} multi={false} value={position} onChange={setPosition} context={{ workspaceId }} placeholder={t('form.pickPosition')} />
        </div>
        <div>
          <div className="label-md" style={{ marginBottom: 6 }}>{t('employment.legalBranch')}</div>
          <EntitySelector types={['branch']} multi={false} value={branch} onChange={setBranch} context={{ workspaceId }} placeholder={t('form.noBranch')} />
        </div>
        <Toggle
          checked={paperMode}
          onChange={setPaperMode}
          label={t('form.paperMode')}
          description={t('form.paperModeHint')}
        />
        <div style={{ display: 'flex', gap: 'var(--spacing-2)', justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose}>{tc('actions.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>{tc('actions.save')}</Button>
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
  const t = useTranslations('hr');
  const tc = useTranslations('common');
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
      <CardHeader title={t('actions.title')} subtitle={t('actions.subtitle')} />
      {card.actions.length === 0 ? (
        <EmptyState icon="list" title={t('actions.emptyTitle')} description={t('actions.emptyDescription')} />
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
              cancelLabel={isOwnApplication && !card.canManage ? t('actions.withdraw') : tc('actions.cancel')}
              onCancel={() =>
                confirm(
                  {
                    title: t('actions.cancelConfirmTitle'),
                    message: t(isOwnApplication ? 'actions.cancelConfirmOwn' : 'actions.cancelConfirmManager'),
                    confirmLabel: t('actions.cancelConfirmLabel'),
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
  const t = useTranslations('hr');
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
          {t('actions.rowTitle', {
            kind: t(`actionKind.${a.kind}`),
            from: fmtDate(a.effectiveAt),
            toSuffix: a.effectiveTo ? t('actions.rowUntil', { to: fmtDate(a.effectiveTo) }) : '',
          })}
        </div>
        <div className="meta" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
          <Chip tone={STATUS_TONE[a.status] ?? 'neutral'}>{t(`actionStatus.${a.status}`)}</Chip>
          {a.documents.length > 1 && (
            // Прогресс пакета (онбординг «подписано N из M») — по статусам документов
            <Chip tone="neutral">
              {t('actions.signedOf', {
                signed: a.documents.filter((d) => ['signed', 'registered', 'active', 'archived'].includes(d.status)).length,
                total: a.documents.length,
              })}
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
  const t = useTranslations('hr');
  const tc = useTranslations('common');
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
      if (!effectiveAt) throw new Error(t('form.effectiveAtRequired'));
      if (kind === 'leave' && !effectiveTo) throw new Error(t('form.leaveEndRequired'));
      if (kind === 'leave' && effectiveTo && effectiveTo < effectiveAt) {
        throw new Error(t('form.periodEnd'));
      }
      if (kind === 'dismissal' && !ground) throw new Error(t('form.groundRequired'));
      if (kind === 'transfer' && !position[0]) throw new Error(t('form.positionRequired'));
      if (!chosenTemplateId) throw new Error(t('form.templateRequired'));
      const salaryTiyn = salary.trim() ? parseTengeToTiyn(salary) : undefined;
      if (salary.trim() && salaryTiyn === undefined) throw new Error(t('form.salaryNumber'));
      if (kind === 'salary_change' && salaryTiyn === undefined) throw new Error(t('form.salaryRequired'));
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

  return (
    <Modal open onClose={onClose} title={t(`actionKind.${kind}`)} size="md">
      <div style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
        {kind === 'dismissal' && (
          <Alert tone="warning">
            {t('form.st54Warning')} {t('st54ExceptionsNote')}
          </Alert>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--spacing-3)' }}>
          <DatePicker
            label={t(
              kind === 'leave' ? 'form.leaveFrom' : kind === 'dismissal' ? 'esutd.field.firedAt' : 'form.effectiveAt',
            )}
            value={isoToDate(effectiveAt)}
            onChange={(d) => setEffectiveAt(dateToIso(d))}
          />
          {kind === 'leave' && (
            <DatePicker label={t('form.leaveTo')} value={isoToDate(effectiveTo)} onChange={(d) => setEffectiveTo(dateToIso(d))} />
          )}
        </div>

        {(kind === 'transfer' || kind === 'hire') && (
          <>
            <div>
              <div className="label-md" style={{ marginBottom: 6 }}>
                {t(kind === 'transfer' ? 'form.newPosition' : 'employment.legalPosition')}
              </div>
              <EntitySelector types={['position']} multi={false} value={position} onChange={setPosition} context={{ workspaceId }} placeholder={t('form.pickPosition')} />
            </div>
            <div>
              <div className="label-md" style={{ marginBottom: 6 }}>{t('form.branch')}</div>
              <EntitySelector types={['branch']} multi={false} value={branch} onChange={setBranch} context={{ workspaceId }} placeholder={t('form.noBranch')} />
            </div>
          </>
        )}

        {(kind === 'salary_change' || kind === 'transfer' || kind === 'hire') && (
          <Input
            label={t(kind === 'salary_change' ? 'form.newSalaryMonthly' : 'form.salaryMonthly')}
            value={salary}
            onChange={(ev) => setSalary(ev.target.value)}
            placeholder="250000"
            inputMode="numeric"
            hint={
              employment?.salaryAmount
                ? t('form.salaryNow', { amount: fmtMoney(employment.salaryAmount, tc('labels.dash')) })
                : undefined
            }
          />
        )}

        {kind === 'hire' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--spacing-3)' }}>
            <Select
              label={t('esutd.field.contractType')}
              value={contractType}
              onChange={setContractType}
              options={CONTRACT_TYPES.map((ct) => ({ value: ct, label: t(`contractType.${ct}`) }))}
            />
            <DatePicker label={t('employment.probationUntil')} value={isoToDate(probationUntil)} onChange={(d) => setProbationUntil(dateToIso(d))} />
          </div>
        )}

        {kind === 'hire' && packageCandidates.length > 0 && (
          <div>
            {/* Онбординг-пакет: один объект с одним прогрессом «подписано N из M».
                По умолчанию отмечены трудовой договор и согласие на ПД (библиотека). */}
            <div className="label-md" style={{ marginBottom: 6 }}>{t('form.hirePackage')}</div>
            <div style={{ display: 'grid', gap: 6 }}>
              {packageCandidates.map((tpl) => (
                <Checkbox
                  key={tpl.id}
                  checked={effectivePackage.includes(tpl.id)}
                  onChange={() => togglePackage(tpl.id)}
                  label={tpl.name}
                />
              ))}
            </div>
          </div>
        )}

        {kind === 'transfer' && (
          <Toggle
            checked={syncFact}
            onChange={setSyncFact}
            label={t('form.syncFact')}
            description={t('form.syncFactHint')}
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
              hint={t('form.groundHint')}
            />
            {employerInitiative && (
              <Toggle
                checked={banConfirmed}
                onChange={setBanConfirmed}
                label={t('form.banException')}
                description={t('form.banExceptionHintSingle')}
              />
            )}
            <Toggle
              checked={alsoRemove}
              onChange={setAlsoRemove}
              label={t('form.alsoRemove')}
              description={t('form.alsoRemoveHint')}
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
          hint={t('form.templateHint')}
        />

        <div style={{ display: 'flex', gap: 'var(--spacing-2)', justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose}>{tc('actions.cancel')}</Button>
          <Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>
            {t('form.createOrder')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
