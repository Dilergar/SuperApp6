'use client';

// ============================================================
// «+ Отдел» / «+ Должность» — модалки кита из тулбара схемы. После создания —
// общий refresh и выбор новой сущности на схеме.
// ============================================================

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation } from '@tanstack/react-query';
import type { OrgChartDto } from '@superapp/shared';
import { Button, GlyphField, Input, Modal, Select } from '@/components/ui';
import { EntitySelector } from '@/components/EntitySelector';
import type { Principal } from '@/lib/entities';
import { createDepartment, createPosition } from '@/lib/org-api';
import { showApiError, useOrgRefresh, type OrgSelection } from './org-lib';

const NONE = '__none__';

/**
 * Что человеку РАЗРЕШЕНО выбрать родителем/отделом. Область считает сервер и кладёт
 * в снимок схемы: полновластным — всё (включая корень), руководителю ветки — только
 * его отделы. Пикер не предлагает того, что сервер отвергнет: раньше обе модалки по
 * умолчанию целились в корень, и голова отдела гарантированно получала 403.
 */
function useDeptChoices(chart: OrgChartDto): { options: Array<{ value: string; label: string }>; canRoot: boolean; fallback: string } {
  return useMemo(() => {
    const canRoot = chart.scope.kind === 'all';
    const allowed = canRoot ? chart.departments : chart.departments.filter((d) => chart.scope.departmentIds.includes(d.id));
    const options = allowed.map((d) => ({ value: d.id, label: d.name }));
    return { options, canRoot, fallback: canRoot ? NONE : (options[0]?.value ?? NONE) };
  }, [chart.departments, chart.scope]);
}

export function CreateDepartmentModal({
  workspaceId, chart, open, onClose, onCreated,
}: {
  workspaceId: string; chart: OrgChartDto; open: boolean; onClose: () => void; onCreated: (sel: OrgSelection) => void;
}) {
  const t = useTranslations('staff');
  const tc = useTranslations('common');
  const refresh = useOrgRefresh(workspaceId);
  const { options: deptChoices, canRoot, fallback } = useDeptChoices(chart);
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState(fallback);
  const [head, setHead] = useState<Principal[]>([]);
  const positionOptions = useMemo(() => chart.positions.map((x) => ({ type: 'position', id: x.id, title: x.name, icon: x.glyph })), [chart.positions]);
  const create = useMutation({
    mutationFn: () => createDepartment(workspaceId, { name: name.trim(), parentId: parentId === NONE ? null : parentId, headPositionId: head[0]?.id ?? null }),
    onSuccess: (d) => { refresh(); setName(''); setParentId(fallback); setHead([]); onCreated({ type: 'department', id: d.id }); onClose(); },
    onError: showApiError,
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('org.newDepartment')}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{tc('actions.cancel')}</Button>
          <Button variant="primary" tone="success" icon="add" disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>{tc('actions.create')}</Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
        <Input label={tc('labels.name')} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('org.departmentPlaceholder')} maxLength={100} required autoFocus />
        <Select
          label={t('org.parentDepartment')}
          value={parentId}
          onChange={setParentId}
          options={canRoot ? [{ value: NONE, label: t('org.noParent') }, ...deptChoices] : deptChoices}
        />
        {!canRoot && (
          <p className="label-sm" style={{ margin: '-0.5rem 0 0' }}>{t('org.topLevelHint')}</p>
        )}
        <div>
          <div className="ui-field-label label-caps" style={{ marginBottom: '0.375rem' }}>{t('org.headOptional')}</div>
          <EntitySelector value={head} onChange={setHead} types={['position']} multi={false} options={positionOptions} placeholder={t('org.whoLeadsDepartment')} context={{ workspaceId }} />
        </div>
      </div>
    </Modal>
  );
}

export function CreatePositionModal({
  workspaceId, chart, open, onClose, onCreated, defaultDepartmentId,
}: {
  workspaceId: string; chart: OrgChartDto; open: boolean; onClose: () => void; onCreated: (sel: OrgSelection) => void;
  defaultDepartmentId?: string | null;
}) {
  const t = useTranslations('staff');
  const tc = useTranslations('common');
  const refresh = useOrgRefresh(workspaceId);
  const { options: deptChoices, canRoot, fallback } = useDeptChoices(chart);
  const [name, setName] = useState('');
  const [glyph, setGlyph] = useState<string | null>(null);
  const [deptId, setDeptId] = useState(defaultDepartmentId ?? fallback);
  const [reportsTo, setReportsTo] = useState<Principal[]>([]);
  const positionOptions = useMemo(() => chart.positions.map((x) => ({ type: 'position', id: x.id, title: x.name, icon: x.glyph })), [chart.positions]);
  const create = useMutation({
    mutationFn: () =>
      createPosition(workspaceId, { name: name.trim(), glyph, departmentId: deptId === NONE ? null : deptId, reportsToPositionId: reportsTo[0]?.id ?? null }),
    onSuccess: (p) => { refresh(); setName(''); setGlyph(null); setReportsTo([]); onCreated({ type: 'position', id: p.id }); onClose(); },
    onError: showApiError,
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('org.newPosition')}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{tc('actions.cancel')}</Button>
          <Button variant="primary" tone="success" icon="add" disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>{tc('actions.create')}</Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
          <GlyphField value={glyph} onChange={setGlyph} suggest={name} size={40} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <Input label={tc('labels.name')} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('org.positionPlaceholder')} maxLength={100} required autoFocus />
          </div>
        </div>
        <Select
          label={t('term.department')}
          value={deptId}
          onChange={setDeptId}
          options={canRoot ? [{ value: NONE, label: t('org.noDepartment') }, ...deptChoices] : deptChoices}
        />
        {!canRoot && (
          <p className="label-sm" style={{ margin: '-0.5rem 0 0' }}>{t('org.positionTopLevelHint')}</p>
        )}
        <div>
          <div className="ui-field-label label-caps" style={{ marginBottom: '0.375rem' }}>{t('org.reportsToOptional')}</div>
          <EntitySelector value={reportsTo} onChange={setReportsTo} types={['position']} multi={false} options={positionOptions} placeholder={t('org.reportsToPlaceholder')} context={{ workspaceId }} />
        </div>
      </div>
    </Modal>
  );
}
