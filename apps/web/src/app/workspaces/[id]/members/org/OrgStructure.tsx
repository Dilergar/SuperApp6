'use client';

// ============================================================
// «Орг. структура» — витрина графа должностей и объектов (этап 5).
// Десктоп: шапка сервиса + полноэкранный холст (как у Процессов) с тулбаром —
// виды «Подчинение / Замещения / Всё», фильтр «Объект» (в адресе), «Моя ветка /
// Вся компания», поиск, «Вне структуры», мастер «Соберём структуру», «+ Отдел» /
// «+ Должность»; справа — панель выбранного. Ширина < 768 — дерево-список.
// Данные — ОДИН снимок GET /org/chart (люди батчем внутри); координат нет.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ORG_ERROR_CODES, pluralRu, type OrgChartDto, type Workspace } from '@superapp/shared';
import { apiErrorDetails, apiErrorMessage } from '@/lib/api';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { fetchOrgChart, movePositionToDepartment, setPositionReportsTo } from '@/lib/org-api';
import { orgChartKey } from '@/lib/queries';
import {
  Alert, Badge, Button, Chip, EmptyState, Icon, LoadingBlock, SearchField, SegmentedControl, Select,
} from '@/components/ui';
import { MembersHeader, membersSectionHref } from '../members-lib';
import { OrgCanvas } from './OrgCanvas';
import { OrgSidePanel } from './OrgSidePanel';
import { OrgUnassignedPanel } from './OrgUnassigned';
import { OrgWizard } from './OrgWizard';
import { CreateDepartmentModal, CreatePositionModal } from './OrgCreateModals';
import { OrgTree } from './OrgTree';
import { deptNodeId, type OrgFocusMode, type OrgViewMode } from './org-layout';
import { focusNodeId as resolveFocusNodeId, parseFocus, personName, showApiError, useOrgRefresh, type OrgSelection } from './org-lib';

const ALL_BRANCHES = '__all__';
/** Порог, после которого рамки отделов не рисуются (предупреждение + фильтр объекта) */
const FRAMES_MAX_POSITIONS = 300;
const FRAMES_MAX_DEPARTMENTS = 200;

interface SearchHit {
  nodeId: string;
  title: string;
  meta: string;
  icon: 'position' | 'department' | 'user';
}

export function OrgStructure({ workspaceId, ws }: { workspaceId: string; ws: Workspace }) {
  const { user } = useRequireAuth();
  const meId = user?.id ?? null;
  const router = useRouter();
  const searchParams = useSearchParams();
  const branchId = searchParams.get('branchId');
  const focusTarget = useMemo(() => parseFocus(searchParams.get('focus')), [searchParams]);
  const refresh = useOrgRefresh(workspaceId);

  // Мобильный фолбэк: только после монтирования (matchMedia нет на сервере)
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  const chartQ = useQuery({
    queryKey: orgChartKey(workspaceId, branchId),
    queryFn: () => fetchOrgChart(workspaceId, branchId),
  });
  const chart = chartQ.data;
  const canEdit = !!chart && chart.scope.kind !== 'none';

  // ---- Состояние витрины ----
  const [view, setView] = useState<OrgViewMode>('reports');
  const [focusMode, setFocusMode] = useState<OrgFocusMode | null>(null);
  const [selection, setSelection] = useState<OrgSelection | null>(null);
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [focusNode, setFocusNode] = useState<string | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const [resetTick, setResetTick] = useState(0);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState<'department' | 'position' | null>(null);

  // По умолчанию: управляющим — вся компания, рядовым — моя ветка; цель фокуса вне ветки → вся
  const effectiveFocusMode: OrgFocusMode = focusMode ?? (chart?.scope.kind === 'all' || focusTarget ? 'all' : 'mine');

  // Фокус из адреса — один раз на цель
  const appliedFocus = useRef<string | null>(null);
  useEffect(() => {
    if (!chart || !focusTarget) return;
    const key = `${focusTarget.type}:${focusTarget.id}`;
    if (appliedFocus.current === key) return;
    appliedFocus.current = key;
    const id = resolveFocusNodeId(chart, focusTarget);
    setFocusNode(id);
    setFocusTick((t) => t + 1);
    if (id && !id.startsWith('dept:')) setSelection({ type: 'position', id });
    else if (focusTarget.type === 'department') setSelection({ type: 'department', id: focusTarget.id });
  }, [chart, focusTarget]);

  // Мастер — сразу на несобранной схеме (один раз за визит)
  const wizardShown = useRef(false);
  useEffect(() => {
    if (!chart || wizardShown.current) return;
    if (!chart.assembled && chart.scope.kind === 'all' && !isMobile) {
      wizardShown.current = true;
      setWizardOpen(true);
    }
  }, [chart, isMobile]);

  // ---- Поиск по должностям и людям ----
  const hitsList = useMemo<SearchHit[]>(() => {
    if (!chart) return [];
    const q = search.trim().toLowerCase();
    if (!q) return [];
    const out: SearchHit[] = [];
    for (const p of chart.positions) {
      if (p.name.toLowerCase().includes(q)) {
        out.push({ nodeId: p.id, title: p.name, meta: p.holders.length ? `${p.holders.length} чел.` : 'вакансия', icon: 'position' });
        continue;
      }
      const holder = p.holders.find((h) => personName(chart.people[h.userId]).toLowerCase().includes(q));
      if (holder) out.push({ nodeId: p.id, title: personName(chart.people[holder.userId]), meta: p.name, icon: 'user' });
    }
    for (const d of chart.departments) {
      if (d.name.toLowerCase().includes(q)) out.push({ nodeId: deptNodeId(d.id), title: d.name, meta: 'отдел', icon: 'department' });
    }
    return out.slice(0, 12);
  }, [chart, search]);
  const hits = useMemo(() => (search.trim() ? new Set(hitsList.map((h) => h.nodeId)) : null), [hitsList, search]);

  /** Закрыть панель и вернуть фокус на узел, с которого её открыли (клавиатурный путь) */
  const closePanel = useCallback(() => {
    const nodeId =
      selection?.type === 'position' ? selection.id : selection?.type === 'department' ? deptNodeId(selection.id) : null;
    setSelection(null);
    if (!nodeId) return;
    requestAnimationFrame(() => {
      const el = document.querySelector(`.react-flow__node[data-id="${CSS.escape(nodeId)}"]`);
      if (el instanceof HTMLElement) el.focus();
    });
  }, [selection]);

  const goTo = useCallback((nodeId: string) => {
    setFocusNode(nodeId);
    setFocusTick((t) => t + 1);
    setSelection(nodeId.startsWith('dept:') ? { type: 'department', id: nodeId.slice(5) } : { type: 'position', id: nodeId });
    setSearchOpen(false);
    // Цель поиска может лежать вне «моей ветки»
    setFocusMode('all');
  }, []);

  // ---- Жесты схемы → мутации (серверный 400/403 → всплывашка + возврат раскладки) ----
  const move = useMutation({
    mutationFn: ({ positionId, departmentId }: { positionId: string; departmentId: string }) => movePositionToDepartment(workspaceId, positionId, departmentId),
    onSuccess: refresh,
    onError: showApiError,
    onSettled: () => setResetTick((t) => t + 1),
  });
  const reports = useMutation({
    mutationFn: ({ positionId, superiorId }: { positionId: string; superiorId: string }) => setPositionReportsTo(workspaceId, positionId, superiorId),
    onSuccess: refresh,
    onError: showApiError,
    onSettled: () => setResetTick((t) => t + 1),
  });
  const onMoveToDepartment = useCallback((positionId: string, departmentId: string) => move.mutate({ positionId, departmentId }), [move]);
  const onReportsTo = useCallback((positionId: string, superiorId: string) => reports.mutate({ positionId, superiorId }), [reports]);

  const setBranch = useCallback(
    (id: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (id === ALL_BRANCHES) params.delete('branchId');
      else params.set('branchId', id);
      params.delete('focus');
      const qs = params.toString();
      router.replace(`${membersSectionHref(workspaceId, 'org')}${qs ? `?${qs}` : ''}`);
      setSelection(null);
    },
    [router, searchParams, workspaceId],
  );

  const hireHref = `/workspaces/${workspaceId}/members/invitations`;
  const tooBigForFrames = !!chart && (chart.counts.positions > FRAMES_MAX_POSITIONS || chart.counts.departments > FRAMES_MAX_DEPARTMENTS);

  // ---- Ошибки снимка ----
  if (chartQ.isError) {
    const code = apiErrorDetails(chartQ.error)?.code;
    return (
      <MembersHeader ws={ws} title="Орг. структура" description="Кто кому руководитель — на графе должностей и объектов">
        {code === ORG_ERROR_CODES.chartTooBig ? (
          <EmptyState
            icon="department"
            title="Схема больше потолка"
            description={apiErrorMessage(chartQ.error)}
            action={<Button variant="matte" icon="branch" href={`/workspaces/${workspaceId}/members/branches`}>Открыть по объектам</Button>}
          />
        ) : (
          <Alert tone="danger">{apiErrorMessage(chartQ.error)}</Alert>
        )}
      </MembersHeader>
    );
  }
  if (!chart) return <LoadingBlock />;

  // ---- Мобильный фолбэк ----
  if (isMobile) {
    return (
      <MembersHeader ws={ws} title="Орг. структура" description="Дерево отделов и должностей">
        {chart.branches.length > 1 && (
          <div style={{ marginBottom: 'var(--gap-grid)' }}>
            <BranchSelect chart={chart} value={branchId} onChange={setBranch} />
          </div>
        )}
        <OrgTree workspaceId={workspaceId} chart={chart} meId={meId} />
      </MembersHeader>
    );
  }

  return (
    <div className="canvas-layer">
      <div className="org-toolbar">
        <div className="org-toolbar-head">
          <MembersHeader
            ws={ws}
            title="Орг. структура"
            actions={
              <>
                <Button variant="ghost" size="sm" icon="arrowLeft" href={membersSectionHref(workspaceId, 'people')}>Люди</Button>
                <Button
                  variant={selection?.type === 'unassigned' ? 'matte' : 'outline'}
                  size="sm"
                  icon="people"
                  onClick={() => setSelection(selection?.type === 'unassigned' ? null : { type: 'unassigned' })}
                >
                  Вне структуры
                  {/* Бейдж считает ЛЮДЕЙ вне структуры: раньше сюда подмешивались
                      вакансии, и «Вне структуры · 2» горело при нуле таких людей
                      (вакансии видно отдельным чипом в ряду ниже). */}
                  {chart.counts.unassigned > 0 && <Badge tone="neutral">{chart.counts.unassigned}</Badge>}
                </Button>
                {chart.scope.kind === 'all' && (
                  <Button variant={chart.assembled ? 'outline' : 'primary'} size="sm" icon="spark" onClick={() => setWizardOpen(true)}>Собрать структуру</Button>
                )}
                {canEdit && (
                  <>
                    <Button variant="matte" size="sm" icon="add" onClick={() => setCreateOpen('department')}>Отдел</Button>
                    <Button variant="matte" size="sm" icon="add" onClick={() => setCreateOpen('position')}>Должность</Button>
                  </>
                )}
              </>
            }
          />
        </div>
        <div className="org-toolbar-row">
          <SegmentedControl<OrgViewMode>
            aria-label="Вид схемы"
            value={view}
            onChange={setView}
            items={[
              { key: 'reports', label: 'Подчинение', icon: 'processes' },
              { key: 'deputies', label: 'Замещения', icon: 'loop', count: chart.deputies.length },
              { key: 'both', label: 'Всё' },
            ]}
          />
          <BranchSelect chart={chart} value={branchId} onChange={setBranch} />
          {branchId && (
            <Button variant="ghost" size="sm" icon="crown" onClick={() => setSelection({ type: 'branch', id: branchId })}>Руководитель объекта</Button>
          )}
          <SegmentedControl<OrgFocusMode>
            aria-label="Охват"
            value={effectiveFocusMode}
            onChange={setFocusMode}
            items={[
              { key: 'mine', label: 'Моя ветка', icon: 'user', disabled: chart.myPositionIds.length === 0 },
              { key: 'all', label: 'Вся компания', icon: 'workspace' },
            ]}
          />
          <div className="org-search">
            <SearchField
              value={search}
              onChange={(e) => { setSearch(e.target.value); setSearchOpen(true); }}
              onFocus={() => setSearchOpen(true)}
              onBlur={() => window.setTimeout(() => setSearchOpen(false), 150)}
              onKeyDown={(e) => { if (e.key === 'Enter' && hitsList[0]) goTo(hitsList[0].nodeId); if (e.key === 'Escape') { setSearch(''); setSearchOpen(false); } }}
              onClear={() => setSearch('')}
              placeholder="Должность или человек…"
              width={220}
              aria-label="Поиск по схеме"
            />
            {searchOpen && search.trim() && (
              <div className="org-search-list" role="listbox" aria-label="Совпадения">
                {hitsList.length === 0 ? (
                  <p className="label-sm" style={{ margin: '0.25rem 0.5rem' }}>Ничего не найдено</p>
                ) : (
                  hitsList.map((h) => (
                    <button key={`${h.icon}:${h.nodeId}:${h.title}`} type="button" className="org-search-item" role="option" aria-selected={false} onMouseDown={(e) => e.preventDefault()} onClick={() => goTo(h.nodeId)}>
                      <Icon name={h.icon} size={15} />
                      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.title}</span>
                      <span className="meta">{h.meta}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
          <span className="org-toolbar-spacer" />
          {/* Одна подписанная строка вместо четырёх голых чисел с иконками: «5 · 3 · 2»
              не читалось без наведения и переносилось во второй ряд, дёргая тулбар. */}
          <span className="meta">
            {chart.counts.positions} {pluralRu(chart.counts.positions, ['должность', 'должности', 'должностей'])}
            {' · '}
            {chart.counts.departments} {pluralRu(chart.counts.departments, ['отдел', 'отдела', 'отделов'])}
            {' · '}
            {chart.counts.branches} {pluralRu(chart.counts.branches, ['объект', 'объекта', 'объектов'])}
          </span>
          {chart.counts.vacancies > 0 && (
            <Chip size="sm" tone="waiting">
              {chart.counts.vacancies} {pluralRu(chart.counts.vacancies, ['вакансия', 'вакансии', 'вакансий'])}
            </Chip>
          )}
          {effectiveFocusMode === 'mine' && chart.myPositionIds.length > 0 && (
            <Chip size="sm" tone="neutral" icon="user" title="Мои должности, руководители выше и команда ниже">показана моя ветка</Chip>
          )}
          {!canEdit && <Chip size="sm" tone="neutral" icon="eye">только просмотр</Chip>}
          {chart.scope.kind === 'scoped' && <Chip size="sm" tone="accent" icon="edit">правка своих веток</Chip>}
        </div>
      </div>

      <div className="org-stage">
        {chart.positions.length === 0 ? (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <EmptyState
              icon="position"
              title="Должностей пока нет"
              description="Добавьте первую должность — от неё и пойдёт схема."
              action={canEdit ? <Button variant="primary" tone="success" icon="add" onClick={() => setCreateOpen('position')}>Должность</Button> : undefined}
            />
          </div>
        ) : (
          <OrgCanvas
            chart={chart}
            view={view}
            focusMode={effectiveFocusMode}
            frames={!tooBigForFrames}
            hits={hits}
            focusNodeId={focusNode}
            focusTick={focusTick}
            resetTick={resetTick}
            selection={selection}
            onSelect={setSelection}
            canEdit={canEdit}
            hireHref={hireHref}
            onMoveToDepartment={onMoveToDepartment}
            onReportsTo={onReportsTo}
          />
        )}

        {tooBigForFrames && (
          <div className="org-banner">
            <Alert
              tone="warning"
              action={<BranchSelect chart={chart} value={branchId} onChange={setBranch} />}
            >
              Схема большая ({chart.counts.positions} должностей, {chart.counts.departments} отделов) — рамки отделов не рисуются. Откройте её по объекту.
            </Alert>
          </div>
        )}
        {!chart.ownerInChart && selection?.type !== 'unassigned' && chart.positions.length > 0 && chart.roots.length > 1 && (
          <div className="org-banner" style={{ top: 'auto', bottom: 'var(--spacing-4)' }}>
            <Alert tone="neutral" icon="info">Несколько корней: должности без руководителя подчиняются владельцу организации напрямую.</Alert>
          </div>
        )}

        {selection?.type === 'unassigned' ? (
          <OrgUnassignedPanel workspaceId={workspaceId} chart={chart} canEdit={canEdit} onSelect={setSelection} onClose={() => setSelection(null)} />
        ) : selection ? (
          <OrgSidePanel workspaceId={workspaceId} chart={chart} selection={selection} canEdit={canEdit} onSelect={setSelection} onClose={closePanel} />
        ) : null}
      </div>

      {wizardOpen && <OrgWizard workspaceId={workspaceId} chart={chart} open onClose={() => setWizardOpen(false)} />}
      <CreateDepartmentModal workspaceId={workspaceId} chart={chart} open={createOpen === 'department'} onClose={() => setCreateOpen(null)} onCreated={setSelection} />
      <CreatePositionModal
        workspaceId={workspaceId}
        chart={chart}
        open={createOpen === 'position'}
        onClose={() => setCreateOpen(null)}
        onCreated={setSelection}
        defaultDepartmentId={selection?.type === 'department' ? selection.id : null}
      />
    </div>
  );
}

function BranchSelect({ chart, value, onChange }: { chart: OrgChartDto; value: string | null; onChange: (id: string) => void }) {
  return (
    <Select
      aria-label="Объект"
      value={value ?? ALL_BRANCHES}
      onChange={onChange}
      width={200}
      options={[
        { value: ALL_BRANCHES, label: 'Все объекты', icon: 'branch' },
        ...chart.branches.map((b) => ({ value: b.id, label: b.name, hint: b.isDefault ? 'основной' : undefined })),
      ]}
    />
  );
}
