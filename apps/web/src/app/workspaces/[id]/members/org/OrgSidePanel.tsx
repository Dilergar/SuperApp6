'use client';

// ============================================================
// Панель справа при выборе на схеме: должность (название, значок, отдел,
// подчиняется, держатели, назначение, заместители, удаление), отдел (название,
// родитель, руководитель, удаление), объект (руководитель объекта).
// Все ошибки сервера (400/403/409) — всплывашкой с его текстом; после успеха —
// общий refresh (снимок схемы, ростер, справочники, кэш пикеров).
// ============================================================

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation } from '@tanstack/react-query';
import type { OrgChartDto, OrgChartPositionDto, OrgDeputyDto } from '@superapp/shared';
import {
  Button, Chip, CloseChip, DatePicker, Divider, EmptyState, GlyphField, Icon, IconButton, Input, Select,
  SegmentedControl, Textarea, useConfirm,
} from '@/components/ui';
import { EntitySelector } from '@/components/EntitySelector';
import type { Principal } from '@/lib/entities';
import {
  assignPositionTo, createOrgDeputy, deleteDepartment, deleteOrgDeputy, deletePosition, removeAssignment,
  setBranchHead, setDepartmentHead, updateDepartment, updatePosition,
} from '@/lib/org-api';
import { PersonChip } from '@/app/circles/PersonCard';
import { showApiError, useDeputyPeriodLabel, useOrgRefresh, usePersonName, type OrgSelection } from './org-lib';

const NO_DEPT = '__none__';
const ALL_BRANCHES = '__all__';

/** Дата → YYYY-MM-DD по ЛОКАЛЬНЫМ частям (не UTC: вечером в Алматы UTC уже «вчера») */
const isoDate = (d: Date | null): string | null =>
  d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : null;

export interface OrgSidePanelProps {
  workspaceId: string;
  chart: OrgChartDto;
  selection: OrgSelection;
  canEdit: boolean;
  onSelect: (sel: OrgSelection | null) => void;
  onClose: () => void;
}

export function OrgSidePanel({ workspaceId, chart, selection, canEdit, onSelect, onClose }: OrgSidePanelProps) {
  if (selection.type === 'position') {
    const p = chart.positions.find((x) => x.id === selection.id);
    if (!p) return null;
    return <PositionPanel key={p.id} workspaceId={workspaceId} chart={chart} position={p} canEdit={canEdit} onSelect={onSelect} onClose={onClose} />;
  }
  if (selection.type === 'department') {
    const d = chart.departments.find((x) => x.id === selection.id);
    if (!d) return null;
    return <DepartmentPanel key={d.id} workspaceId={workspaceId} chart={chart} departmentId={d.id} canEdit={canEdit} onSelect={onSelect} onClose={onClose} />;
  }
  if (selection.type === 'branch') {
    const b = chart.branches.find((x) => x.id === selection.id);
    if (!b) return null;
    return <BranchPanel key={b.id} workspaceId={workspaceId} chart={chart} branchId={b.id} canEdit={canEdit} onSelect={onSelect} onClose={onClose} />;
  }
  return null;
}

function PanelShell({ icon, title, onClose, children }: { icon: 'position' | 'department' | 'branch'; title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    // Escape закрывает панель и возвращает фокус на узел схемы (обработчик возврата —
    // в OrgStructure): без этого клавиатурный путь заканчивался внутри панели.
    <div
      className="opanel"
      role="region"
      aria-label={title}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="opanel-head">
        <Icon name={icon} size={18} />
        <strong className="title-sm" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</strong>
        <CloseChip onClick={onClose} />
      </div>
      <div className="opanel-body">{children}</div>
    </div>
  );
}

// ---------------- Должность ----------------

function PositionPanel({
  workspaceId, chart, position: p, canEdit, onSelect, onClose,
}: {
  workspaceId: string; chart: OrgChartDto; position: OrgChartPositionDto; canEdit: boolean;
  onSelect: (sel: OrgSelection | null) => void; onClose: () => void;
}) {
  const t = useTranslations('staff');
  const tc = useTranslations('common');
  const personName = usePersonName();
  const refresh = useOrgRefresh(workspaceId);
  const [confirm, confirmUI] = useConfirm();
  /** Правка — по требованию: панель открывается фактами (см. ниже) */
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.name);
  const [glyph, setGlyph] = useState<string | null>(p.glyph);
  const [deptId, setDeptId] = useState<string>(p.departmentId ?? NO_DEPT);
  const [reportsTo, setReportsTo] = useState<Principal[]>(p.reportsToPositionId ? [{ type: 'position', id: p.reportsToPositionId }] : []);

  const dirty =
    name.trim() !== p.name || (glyph ?? null) !== (p.glyph ?? null) || (deptId === NO_DEPT ? null : deptId) !== p.departmentId ||
    (reportsTo[0]?.id ?? null) !== p.reportsToPositionId;

  const save = useMutation({
    mutationFn: () => {
      const dto: Parameters<typeof updatePosition>[2] = {};
      if (name.trim() !== p.name) dto.name = name.trim();
      if ((glyph ?? null) !== (p.glyph ?? null)) dto.glyph = glyph;
      const nextDept = deptId === NO_DEPT ? null : deptId;
      if (nextDept !== p.departmentId) dto.departmentId = nextDept;
      const nextSup = reportsTo[0]?.id ?? null;
      if (nextSup !== p.reportsToPositionId) dto.reportsToPositionId = nextSup;
      return updatePosition(workspaceId, p.id, dto);
    },
    onSuccess: () => { setEditing(false); refresh(); },
    onError: showApiError,
  });
  const remove = useMutation({
    mutationFn: () => deletePosition(workspaceId, p.id),
    onSuccess: () => { refresh(); onClose(); },
    onError: showApiError,
  });
  const unassign = useMutation({
    mutationFn: (assignmentId: string) => removeAssignment(workspaceId, assignmentId),
    onSuccess: refresh,
    onError: showApiError,
  });

  const deputies = useMemo(() => chart.deputies.filter((d) => d.positionId === p.id), [chart.deputies, p.id]);
  // Заместителя ставит не только «правящий структуру»: сервер разрешает это самому
  // ДЕРЖАТЕЛЮ должности (он делегирует свою же ответственность) и его руководителю.
  // Пока форма висела на общем `canEdit`, задокументированная возможность была
  // недостижима из интерфейса — рядовой сотрудник кнопки просто не видел.
  const iAmHolder = chart.myPositionIds.includes(p.id);
  const canManageDeputies = canEdit || iAmHolder;
  // Правка САМОЙ должности — по области: у руководителя ветки чужая должность
  // вернула бы 403 (кнопку показывать незачем — правило «пикер не предлагает того,
  // что сервер отвергнет» действует и на кнопки).
  const canEditThis =
    canEdit && (chart.scope.kind === 'all' || (!!p.departmentId && chart.scope.departmentIds.includes(p.departmentId)));
  const superior = p.superiorPositionId ? chart.positions.find((x) => x.id === p.superiorPositionId) : null;
  const deptOptions = [{ value: NO_DEPT, label: t('org.noDepartment') }, ...chart.departments.map((d) => ({ value: d.id, label: d.name }))];
  // Пикер не предлагает того, что сервер отвергнет: саму должность — нельзя
  const positionOptions = useMemo(
    () => chart.positions.filter((x) => x.id !== p.id).map((x) => ({ type: 'position', id: x.id, title: x.name, icon: x.glyph })),
    [chart.positions, p.id],
  );

  return (
    <PanelShell icon="position" title={p.name} onClose={onClose}>
      {/* Чем руководит */}
      {(p.headsDepartmentIds.length > 0 || p.headsBranchIds.length > 0) && (
        <div className="opanel-row" style={{ flexWrap: 'wrap' }}>
          {p.headsDepartmentIds.map((id) => {
            const d = chart.departments.find((x) => x.id === id);
            return d ? <Chip key={id} tone="accent" icon="department" onClick={() => onSelect({ type: 'department', id })}>{t('org.leadsName', { name: d.name })}</Chip> : null;
          })}
          {p.headsBranchIds.map((id) => {
            const b = chart.branches.find((x) => x.id === id);
            return b ? <Chip key={id} tone="accent" icon="branch" onClick={() => onSelect({ type: 'branch', id })}>{t('org.panel.leadsBranch', { name: b.name })}</Chip> : null;
          })}
        </div>
      )}

      {/* ФАКТ идёт первым и всем: панель открывается на вопрос «кто здесь работает
          и кому подчиняется», а не формой. Правка — под «Изменить» (её открывают
          несравнимо реже, а она занимала весь первый экран и уводила держателей
          с заместителями под сгиб). */}
      <section className="opanel-section">
        <div className="opanel-row" style={{ flexWrap: 'wrap' }}>
          {p.departmentId && <Chip tone="neutral" icon="department">{chart.departments.find((d) => d.id === p.departmentId)?.name}</Chip>}
          {superior && (
            <Button variant="ghost" size="sm" icon="arrowUp" onClick={() => onSelect({ type: 'position', id: superior.id })}>
              {t('org.panel.reportsTo', { name: superior.name })}
            </Button>
          )}
          {!superior && <Chip tone="neutral" icon="crown">{t('org.panel.topOfStructure')}</Chip>}
          {p.vacant && <Chip tone="waiting">{t('org.vacancyChip')}</Chip>}
          {p.reportsToPositionId && <Chip size="sm" tone="neutral">{t('org.panel.directNotByStructure')}</Chip>}
        </div>
        {canEditThis && !editing && (
          <div className="opanel-row">
            <Button variant="outline" size="sm" icon="edit" onClick={() => setEditing(true)}>{t('org.panel.editPosition')}</Button>
          </div>
        )}
      </section>

      {canEditThis && editing && (
        <section className="opanel-section">
          <div className="opanel-row" style={{ alignItems: 'flex-end' }}>
            <GlyphField value={glyph} onChange={setGlyph} suggest={name} size={40} />
            <div className="grow">
              <Input label={tc('labels.name')} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />
            </div>
          </div>
          <Select label={t('term.department')} value={deptId} onChange={setDeptId} options={deptOptions} />
          <div>
            <div className="ui-field-label label-caps" style={{ marginBottom: '0.375rem' }}>{t('org.panel.reportsToDirect')}</div>
            <EntitySelector value={reportsTo} onChange={setReportsTo} types={['position']} multi={false} options={positionOptions} placeholder={t('org.reportsToPlaceholder')} context={{ workspaceId }} />
            <p className="label-sm" style={{ margin: '0.375rem 0 0' }}>
              {reportsTo.length
                ? t('org.panel.reportsToChosen')
                : superior
                  ? t('org.panel.reportsToEmptyWith', { name: superior.name })
                  : t('org.panel.reportsToEmptyNone')}
            </p>
          </div>
          <div className="opanel-row">
            <Button variant="primary" tone="success" size="sm" icon="save" disabled={!dirty || !name.trim()} loading={save.isPending} onClick={() => save.mutate()}>
              {tc('actions.save')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => { setEditing(false); setName(p.name); setGlyph(p.glyph); setDeptId(p.departmentId ?? NO_DEPT); setReportsTo(p.reportsToPositionId ? [{ type: 'position', id: p.reportsToPositionId }] : []); }}>
              {tc('actions.cancel')}
            </Button>
          </div>
        </section>
      )}

      <Divider />

      {/* Держатели */}
      <section className="opanel-section">
        <div className="opanel-section-title">
          <span className="label-caps">{t('org.panel.holders', { n: p.holders.length })}</span>
        </div>
        {p.holders.length === 0 ? (
          <p className="label-sm" style={{ margin: 0 }}>{t('org.panel.noHolders')}</p>
        ) : (
          p.holders.map((h) => {
            const person = chart.people[h.userId];
            const branch = chart.branches.find((b) => b.id === h.branchId);
            return (
              <div key={h.assignmentId} className="opanel-row">
                <div className="grow" style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', flexWrap: 'wrap' }}>
                  <PersonChip size="S" userId={h.userId} firstName={person?.firstName ?? t('noName')} lastName={person?.lastName ?? null} avatar={person?.avatar ?? null} />
                  {branch && <Chip size="sm" tone="neutral" icon="branch">{branch.name}</Chip>}
                  {h.status === 'training' && <Chip size="sm" tone="waiting">{t('assignmentStatus.training')}</Chip>}
                  {h.isPrimary && <Chip size="sm" tone="neutral">{t('member.primary')}</Chip>}
                </div>
                {/* Тот же значок, что у «снять назначение» в ростере: одно действие —
                    один знак (тонкий прочерк `remove` для деструктива не читался) */}
                {canEdit && (
                  <IconButton
                    icon="close"
                    label={t('org.panel.unassignAria', { name: personName(person) })}
                    variant="danger"
                    onClick={() => confirm(
                      {
                        title: t('org.panel.unassignTitle'),
                        message: t('org.panel.unassignMessage', {
                          name: personName(person),
                          position: p.name,
                          branchSuffix: branch ? t('org.panel.unassignBranchSuffix', { name: branch.name }) : '',
                        }),
                        confirmLabel: t('org.panel.unassignConfirm'),
                        danger: true,
                      },
                      () => unassign.mutateAsync(h.assignmentId),
                    )}
                  />
                )}
              </div>
            );
          })
        )}
        {canEdit && <AssignForm workspaceId={workspaceId} chart={chart} positionId={p.id} onDone={refresh} />}
      </section>

      <Divider />

      {/* Заместители */}
      <section className="opanel-section">
        <div className="opanel-section-title">
          <span className="label-caps">{t('org.panel.deputies', { n: deputies.length })}</span>
        </div>
        {deputies.length === 0 ? (
          <p className="label-sm" style={{ margin: 0 }}>{t('org.panel.noDeputies')}</p>
        ) : (
          deputies.map((d) => (
            <DeputyRow key={d.id} workspaceId={workspaceId} chart={chart} deputy={d} canEdit={canManageDeputies} onSelect={onSelect} confirm={confirm} />
          ))
        )}
        {canManageDeputies && <DeputyForm workspaceId={workspaceId} chart={chart} positionId={p.id} />}
        {!canEdit && iAmHolder && (
          <p className="label-sm" style={{ margin: 0 }}>{t('org.panel.yourPositionHint')}</p>
        )}
      </section>

      {/* Опасное — вместе с правкой, а не в читающем виде панели */}
      {canEditThis && editing && (
        <>
          <Divider />
          <div className="opanel-row">
            <Button
              variant="matte"
              tone="danger"
              size="sm"
              icon="delete"
              loading={remove.isPending}
              onClick={() => confirm(
                {
                  title: t('org.panel.deletePositionTitle'),
                  message: t('org.panel.deletePositionMessage', { name: p.name }),
                  confirmLabel: tc('actions.delete'),
                  danger: true,
                },
                () => remove.mutateAsync(),
              )}
            >
              {t('org.panel.deletePosition')}
            </Button>
          </div>
        </>
      )}
      {confirmUI}
    </PanelShell>
  );
}

/** Назначить человека на должность: человек (ростер организации) + объект */
function AssignForm({ workspaceId, chart, positionId, onDone }: { workspaceId: string; chart: OrgChartDto; positionId: string; onDone: () => void }) {
  const t = useTranslations('staff');
  const tc = useTranslations('common');
  const [open, setOpen] = useState(false);
  const [who, setWho] = useState<Principal[]>([]);
  const defaultBranch = chart.branches.find((b) => b.isDefault)?.id ?? chart.branches[0]?.id ?? '';
  const [branchId, setBranchId] = useState<string>(chart.branchId ?? defaultBranch);
  const assign = useMutation({
    mutationFn: () => assignPositionTo(workspaceId, who[0].id, { positionId, branchId: branchId || null }),
    onSuccess: () => { setWho([]); setOpen(false); onDone(); },
    onError: showApiError,
  });
  if (!open) {
    return (
      <div className="opanel-row">
        <Button variant="outline" size="sm" icon="userAdd" onClick={() => setOpen(true)}>{t('org.panel.assignPerson')}</Button>
      </div>
    );
  }
  return (
    <div className="opanel-note" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <EntitySelector value={who} onChange={setWho} types={['user']} multi={false} placeholder={t('org.panel.whoToAssign')} context={{ workspaceId }} />
      <Select label={t('term.branch')} value={branchId} onChange={setBranchId} options={chart.branches.map((b) => ({ value: b.id, label: b.name, icon: 'branch' as const }))} />
      <div className="opanel-row">
        <Button variant="primary" tone="success" size="sm" icon="check" disabled={!who.length || !branchId} loading={assign.isPending} onClick={() => assign.mutate()}>{t('member.assign')}</Button>
        <Button variant="ghost" size="sm" onClick={() => { setOpen(false); setWho([]); }}>{tc('actions.cancel')}</Button>
      </div>
    </div>
  );
}

function DeputyRow({
  workspaceId, chart, deputy: d, canEdit, onSelect, confirm,
}: {
  workspaceId: string; chart: OrgChartDto; deputy: OrgDeputyDto; canEdit: boolean;
  onSelect: (sel: OrgSelection | null) => void;
  confirm: ReturnType<typeof useConfirm>[0];
}) {
  const t = useTranslations('staff');
  const personName = usePersonName();
  const deputyPeriodLabel = useDeputyPeriodLabel();
  const refresh = useOrgRefresh(workspaceId);
  const remove = useMutation({ mutationFn: () => deleteOrgDeputy(workspaceId, d.id), onSuccess: refresh, onError: showApiError });
  const person = d.deputyUserId ? chart.people[d.deputyUserId] : undefined;
  return (
    <div className="opanel-row" style={{ alignItems: 'flex-start' }}>
      <div className="grow" style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', flexWrap: 'wrap' }}>
          {d.deputyUserId ? (
            <PersonChip size="S" userId={d.deputyUserId} firstName={person?.firstName ?? t('noName')} lastName={person?.lastName ?? null} avatar={person?.avatar ?? null} />
          ) : d.deputyPositionId ? (
            <Chip tone="neutral" icon="position" onClick={() => onSelect({ type: 'position', id: d.deputyPositionId! })}>{d.deputyPositionName}</Chip>
          ) : null}
          <Chip size="sm" tone={d.kind === 'temporary' ? 'warning' : 'neutral'}>
            {d.kind === 'temporary' ? deputyPeriodLabel(d.startsOn, d.endsOn) : t('deputyKind.standing')}
          </Chip>
          {d.kind === 'temporary' && d.activeToday && <Chip size="sm" tone="success">{t('org.panel.todayChip')}</Chip>}
          <Chip size="sm" tone="neutral" icon="branch">{d.branchName ?? t('org.panel.allBranches')}</Chip>
        </div>
        {d.note && <p className="label-sm" style={{ margin: 0 }}>{d.note}</p>}
      </div>
      {canEdit && (
        <IconButton
          icon="remove"
          label={t('org.panel.removeDeputy')}
          variant="danger"
          onClick={() => confirm(
            {
              title: t('org.panel.removeDeputyTitle'),
              message: t('org.panel.removeDeputyMessage'),
              confirmLabel: t('org.panel.removeConfirm'),
              danger: true,
            },
            () => remove.mutateAsync(),
          )}
        />
      )}
    </div>
  );
}

/** Форма заместителя: человек ИЛИ должность · объект · без дат или период · комментарий */
function DeputyForm({ workspaceId, chart, positionId }: { workspaceId: string; chart: OrgChartDto; positionId: string }) {
  const t = useTranslations('staff');
  const tc = useTranslations('common');
  const refresh = useOrgRefresh(workspaceId);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'user' | 'position'>('user');
  const [target, setTarget] = useState<Principal[]>([]);
  const [branchId, setBranchId] = useState<string>(chart.branchId ?? ALL_BRANCHES);
  const [kind, setKind] = useState<'standing' | 'temporary'>('standing');
  const [startsOn, setStartsOn] = useState<Date | null>(null);
  const [endsOn, setEndsOn] = useState<Date | null>(null);
  const [note, setNote] = useState('');
  const positionOptions = useMemo(
    () => chart.positions.filter((x) => x.id !== positionId).map((x) => ({ type: 'position', id: x.id, title: x.name, icon: x.glyph })),
    [chart.positions, positionId],
  );
  const reset = () => { setTarget([]); setKind('standing'); setStartsOn(null); setEndsOn(null); setNote(''); setOpen(false); };
  const create = useMutation({
    mutationFn: () =>
      createOrgDeputy(workspaceId, {
        positionId,
        branchId: branchId === ALL_BRANCHES ? null : branchId,
        deputyUserId: mode === 'user' ? target[0].id : null,
        deputyPositionId: mode === 'position' ? target[0].id : null,
        startsOn: kind === 'temporary' ? isoDate(startsOn) : null,
        endsOn: kind === 'temporary' ? isoDate(endsOn) : null,
        note: note.trim() || null,
      }),
    onSuccess: () => { reset(); refresh(); },
    onError: showApiError,
  });
  const periodBad = kind === 'temporary' && !!startsOn && !!endsOn && endsOn < startsOn;
  if (!open) {
    return (
      <div className="opanel-row">
        <Button variant="outline" size="sm" icon="add" onClick={() => setOpen(true)}>{t('org.panel.addDeputy')}</Button>
      </div>
    );
  }
  return (
    <div className="opanel-note" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <SegmentedControl
        aria-label={t('org.panel.whoDeputisesAria')}
        value={mode}
        onChange={(m) => { setMode(m); setTarget([]); }}
        items={[{ key: 'user', label: t('org.panel.modePerson'), icon: 'user' }, { key: 'position', label: t('term.position'), icon: 'position' }]}
      />
      {mode === 'user' ? (
        <EntitySelector value={target} onChange={setTarget} types={['user']} multi={false} placeholder={t('org.panel.whoDeputises')} context={{ workspaceId }} />
      ) : (
        <EntitySelector value={target} onChange={setTarget} types={['position']} multi={false} options={positionOptions} placeholder={t('org.panel.whichPositionDeputises')} context={{ workspaceId }} />
      )}
      <Select
        label={t('term.branch')}
        value={branchId}
        onChange={setBranchId}
        options={[{ value: ALL_BRANCHES, label: t('org.panel.inAllBranches') }, ...chart.branches.map((b) => ({ value: b.id, label: b.name, icon: 'branch' as const }))]}
      />
      <SegmentedControl
        aria-label={t('org.panel.deputyKindAria')}
        value={kind}
        onChange={setKind}
        items={[{ key: 'standing', label: t('org.panel.kindStanding') }, { key: 'temporary', label: t('org.panel.kindTemporary') }]}
      />
      <p className="label-sm" style={{ margin: 0 }}>{t(`deputyKind.${kind}`)}</p>
      {kind === 'temporary' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '0.5rem' }}>
          <DatePicker label={t('org.panel.from')} value={startsOn} onChange={setStartsOn} clearable />
          <DatePicker label={t('org.panel.to')} value={endsOn} onChange={setEndsOn} clearable error={periodBad ? t('org.panel.endBeforeStart') : null} />
        </div>
      )}
      <Textarea label={t('org.panel.note')} value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={300} />
      <div className="opanel-row">
        <Button variant="primary" tone="success" size="sm" icon="check" disabled={!target.length || periodBad} loading={create.isPending} onClick={() => create.mutate()}>{tc('actions.add')}</Button>
        <Button variant="ghost" size="sm" onClick={reset}>{tc('actions.cancel')}</Button>
      </div>
    </div>
  );
}

// ---------------- Отдел ----------------

function DepartmentPanel({
  workspaceId, chart, departmentId, canEdit, onSelect, onClose,
}: {
  workspaceId: string; chart: OrgChartDto; departmentId: string; canEdit: boolean;
  onSelect: (sel: OrgSelection | null) => void; onClose: () => void;
}) {
  const t = useTranslations('staff');
  const tc = useTranslations('common');
  const d = chart.departments.find((x) => x.id === departmentId)!;
  const refresh = useOrgRefresh(workspaceId);
  const [confirm, confirmUI] = useConfirm();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(d.name);
  const [parentId, setParentId] = useState<string>(d.parentId ?? NO_DEPT);
  const [head, setHead] = useState<Principal[]>(d.headPositionId ? [{ type: 'position', id: d.headPositionId }] : []);

  // Родителем не может быть сам отдел и его потомки — пикер такого не предлагает
  const descendants = useMemo(() => {
    const out = new Set<string>([d.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const x of chart.departments) if (x.parentId && out.has(x.parentId) && !out.has(x.id)) { out.add(x.id); grew = true; }
    }
    return out;
  }, [chart.departments, d.id]);
  const parentOptions = [{ value: NO_DEPT, label: t('org.noParent') }, ...chart.departments.filter((x) => !descendants.has(x.id)).map((x) => ({ value: x.id, label: x.name }))];
  const positionOptions = useMemo(() => chart.positions.map((x) => ({ type: 'position', id: x.id, title: x.name, icon: x.glyph })), [chart.positions]);
  const members = chart.positions.filter((p) => p.departmentId === d.id);
  const headPos = d.headPositionId ? chart.positions.find((p) => p.id === d.headPositionId) : null;

  const dirty = name.trim() !== d.name || (parentId === NO_DEPT ? null : parentId) !== d.parentId || (head[0]?.id ?? null) !== d.headPositionId;
  const save = useMutation({
    mutationFn: () => {
      const dto: Parameters<typeof updateDepartment>[2] = {};
      if (name.trim() !== d.name) dto.name = name.trim();
      const nextParent = parentId === NO_DEPT ? null : parentId;
      if (nextParent !== d.parentId) dto.parentId = nextParent;
      const nextHead = head[0]?.id ?? null;
      if (nextHead !== d.headPositionId) dto.headPositionId = nextHead;
      return updateDepartment(workspaceId, d.id, dto);
    },
    onSuccess: () => { setEditing(false); refresh(); },
    onError: showApiError,
  });
  const unsetHead = useMutation({ mutationFn: () => setDepartmentHead(workspaceId, d.id, null), onSuccess: () => { setHead([]); refresh(); }, onError: showApiError });
  const remove = useMutation({ mutationFn: () => deleteDepartment(workspaceId, d.id), onSuccess: () => { refresh(); onClose(); }, onError: showApiError });

  return (
    <PanelShell icon="department" title={d.name} onClose={onClose}>
      {/* Факт первым (см. панель должности): кто руководит и где отдел стоит */}
      <section className="opanel-section">
        <div className="opanel-row" style={{ flexWrap: 'wrap' }}>
          {headPos ? (
            <Button variant="ghost" size="sm" icon="crown" onClick={() => onSelect({ type: 'position', id: headPos.id })}>{t('org.leadsName', { name: headPos.name })}</Button>
          ) : (
            <Chip tone="neutral">{t('org.panel.headNotSet')}</Chip>
          )}
          {d.parentId && (
            <Chip tone="neutral" icon="department">
              {t('org.panel.insideDepartment', { name: chart.departments.find((x) => x.id === d.parentId)?.name ?? '' })}
            </Chip>
          )}
        </div>
        {canEdit && !editing && (
          <div className="opanel-row">
            <Button variant="outline" size="sm" icon="edit" onClick={() => setEditing(true)}>{t('org.panel.editDepartment')}</Button>
          </div>
        )}
      </section>

      {canEdit && editing ? (
        <section className="opanel-section">
          <Input label={tc('labels.name')} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />
          <Select label={t('org.parentDepartment')} value={parentId} onChange={setParentId} options={parentOptions} />
          <div>
            <div className="ui-field-label label-caps" style={{ marginBottom: '0.375rem' }}>{t('org.panel.headPosition')}</div>
            <EntitySelector value={head} onChange={setHead} types={['position']} multi={false} options={positionOptions} placeholder={t('org.panel.pickPosition')} context={{ workspaceId }} />
          </div>
          <div className="opanel-row" style={{ flexWrap: 'wrap' }}>
            <Button variant="primary" tone="success" size="sm" icon="save" disabled={!dirty || !name.trim()} loading={save.isPending} onClick={() => save.mutate()}>{tc('actions.save')}</Button>
            <Button variant="ghost" size="sm" onClick={() => { setEditing(false); setName(d.name); setParentId(d.parentId ?? NO_DEPT); setHead(d.headPositionId ? [{ type: 'position', id: d.headPositionId }] : []); }}>{tc('actions.cancel')}</Button>
            {d.headPositionId && (
              <Button
                variant="outline"
                size="sm"
                icon="remove"
                loading={unsetHead.isPending}
                onClick={() => confirm(
                  {
                    title: t('org.panel.unsetHeadTitle'),
                    message: t('org.panel.unsetHeadMessage', { position: headPos?.name ?? '', department: d.name }),
                    confirmLabel: t('org.panel.unassignConfirm'),
                    danger: true,
                  },
                  () => unsetHead.mutateAsync(),
                )}
              >
                {t('org.panel.unsetHead')}
              </Button>
            )}
          </div>
        </section>
      ) : null}

      <Divider />
      <section className="opanel-section">
        <span className="label-caps">{t('org.panel.positionsCount', { n: members.length })}</span>
        {members.length === 0 ? (
          <p className="label-sm" style={{ margin: 0 }}>{t('org.panel.departmentEmpty')}</p>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem' }}>
            {members.map((p) => (
              <Chip key={p.id} tone={p.vacant ? 'waiting' : 'neutral'} emoji={p.glyph} icon={p.glyph ? undefined : 'position'} onClick={() => onSelect({ type: 'position', id: p.id })}>{p.name}</Chip>
            ))}
          </div>
        )}
      </section>

      {canEdit && editing && (
        <>
          <Divider />
          <div className="opanel-row">
            <Button
              variant="matte"
              tone="danger"
              size="sm"
              icon="delete"
              loading={remove.isPending}
              onClick={() => confirm(
                {
                  title: t('org.panel.deleteDepartmentTitle'),
                  message: t('org.panel.deleteDepartmentMessage', {
                    name: d.name,
                    childrenSuffix: chart.departments.some((x) => x.parentId === d.id) ? t('org.panel.deleteDepartmentChildren') : '',
                  }),
                  confirmLabel: tc('actions.delete'),
                  danger: true,
                },
                () => remove.mutateAsync(),
              )}
            >
              {t('org.panel.deleteDepartment')}
            </Button>
          </div>
        </>
      )}
      {confirmUI}
    </PanelShell>
  );
}

// ---------------- Объект ----------------

function BranchPanel({
  workspaceId, chart, branchId, canEdit, onSelect, onClose,
}: {
  workspaceId: string; chart: OrgChartDto; branchId: string; canEdit: boolean;
  onSelect: (sel: OrgSelection | null) => void; onClose: () => void;
}) {
  const t = useTranslations('staff');
  const tc = useTranslations('common');
  const b = chart.branches.find((x) => x.id === branchId)!;
  const refresh = useOrgRefresh(workspaceId);
  const [confirm, confirmUI] = useConfirm();
  const [editing, setEditing] = useState(false);
  // Объекты правят только полновластные роли (сервер: `requireAll`) — область
  // приезжает в снимке схемы, второй раз её считать не нужно.
  const canEditBranch = canEdit && chart.scope.kind === 'all';
  const [head, setHead] = useState<Principal[]>(b.headPositionId ? [{ type: 'position', id: b.headPositionId }] : []);
  const positionOptions = useMemo(() => chart.positions.map((x) => ({ type: 'position', id: x.id, title: x.name, icon: x.glyph })), [chart.positions]);
  const headPos = b.headPositionId ? chart.positions.find((p) => p.id === b.headPositionId) : null;
  const dirty = (head[0]?.id ?? null) !== b.headPositionId;
  const save = useMutation({ mutationFn: () => setBranchHead(workspaceId, b.id, head[0]?.id ?? null), onSuccess: () => { setEditing(false); refresh(); }, onError: showApiError });
  const unsetHead = useMutation({ mutationFn: () => setBranchHead(workspaceId, b.id, null), onSuccess: () => { setHead([]); refresh(); }, onError: showApiError });
  const inBranch = chart.positions.filter((p) => p.holders.some((h) => h.branchId === b.id));

  return (
    <PanelShell icon="branch" title={b.name} onClose={onClose}>
      <div className="opanel-row" style={{ flexWrap: 'wrap' }}>
        {b.isDefault && <Chip tone="accent">{t('org.panel.mainBranch')}</Chip>}
        <Chip tone="neutral" icon="people">
          {t('peopleCount', { n: inBranch.reduce((n, p) => n + p.holders.filter((h) => h.branchId === b.id).length, 0) })}
        </Chip>
      </div>
      {/* Факт первым; правку объекта сервер отдаёт только полновластным ролям
          (`requireAll`), поэтому кнопка стоит по области, а не по «есть ли вообще
          право что-то править»: раньше голова отдела открывала форму и получала 403. */}
      <section className="opanel-section">
        <div className="opanel-row" style={{ flexWrap: 'wrap' }}>
          {headPos ? (
            <Button variant="ghost" size="sm" icon="crown" onClick={() => onSelect({ type: 'position', id: headPos.id })}>{t('org.leadsName', { name: headPos.name })}</Button>
          ) : (
            <Chip tone="neutral">{t('org.panel.headNotSet')}</Chip>
          )}
        </div>
        {canEditBranch && !editing && (
          <div className="opanel-row">
            <Button variant="outline" size="sm" icon="edit" onClick={() => setEditing(true)}>{t('org.panel.editBranchHead')}</Button>
          </div>
        )}
      </section>

      {canEditBranch && editing ? (
        <section className="opanel-section">
          <div>
            <div className="ui-field-label label-caps" style={{ marginBottom: '0.375rem' }}>{t('org.panel.branchHeadPosition')}</div>
            <EntitySelector value={head} onChange={setHead} types={['position']} multi={false} options={positionOptions} placeholder={t('org.panel.pickPosition')} context={{ workspaceId }} />
            <p className="label-sm" style={{ margin: '0.375rem 0 0' }}>{t('org.panel.branchHeadHint')}</p>
          </div>
          <div className="opanel-row" style={{ flexWrap: 'wrap' }}>
            <Button variant="primary" tone="success" size="sm" icon="save" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>{tc('actions.save')}</Button>
            {b.headPositionId && (
              <Button
                variant="outline"
                size="sm"
                icon="remove"
                loading={unsetHead.isPending}
                onClick={() => confirm(
                  {
                    title: t('org.panel.unsetBranchHeadTitle'),
                    message: t('org.panel.unsetBranchHeadMessage', { position: headPos?.name ?? '', branch: b.name }),
                    confirmLabel: t('org.panel.unassignConfirm'),
                    danger: true,
                  },
                  () => unsetHead.mutateAsync(),
                )}
              >
                {t('org.panel.unsetHead')}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => { setEditing(false); setHead(b.headPositionId ? [{ type: 'position', id: b.headPositionId }] : []); }}>{tc('actions.cancel')}</Button>
          </div>
        </section>
      ) : null}
      <Divider />
      <section className="opanel-section">
        <span className="label-caps">{t('org.panel.branchMetaTitle')}</span>
        <div className="opanel-row">
          <Button variant="outline" size="sm" icon="branch" href={`/workspaces/${workspaceId}/members/branches`}>{t('org.panel.branchSection')}</Button>
        </div>
      </section>
      {inBranch.length === 0 && <EmptyState icon="branch" title={t('org.panel.branchEmpty')} />}
      {confirmUI}
    </PanelShell>
  );
}
