'use client';

// ============================================================
// «+ Отдел» / «+ Должность» — модалки кита из тулбара схемы. После создания —
// общий refresh и выбор новой сущности на схеме.
// ============================================================

import { useMemo, useState } from 'react';
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
      title="Новый отдел"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Отмена</Button>
          <Button variant="primary" tone="success" icon="add" disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>Создать</Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
        <Input label="Название" value={name} onChange={(e) => setName(e.target.value)} placeholder="Финансовый отдел" maxLength={100} required autoFocus />
        <Select
          label="Родительский отдел"
          value={parentId}
          onChange={setParentId}
          options={canRoot ? [{ value: NONE, label: 'Без родителя (верхний уровень)' }, ...deptChoices] : deptChoices}
        />
        {!canRoot && (
          <p className="label-sm" style={{ margin: '-0.5rem 0 0' }}>Отдел верхнего уровня заводит Менеджер и выше — вам доступны подотделы своей ветки.</p>
        )}
        <div>
          <div className="ui-field-label label-caps" style={{ marginBottom: '0.375rem' }}>Руководитель (должность, необязательно)</div>
          <EntitySelector value={head} onChange={setHead} types={['position']} multi={false} options={positionOptions} placeholder="Кто руководит отделом…" context={{ workspaceId }} />
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
      title="Новая должность"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Отмена</Button>
          <Button variant="primary" tone="success" icon="add" disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>Создать</Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
          <GlyphField value={glyph} onChange={setGlyph} suggest={name} size={40} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <Input label="Название" value={name} onChange={(e) => setName(e.target.value)} placeholder="Менеджер по продажам" maxLength={100} required autoFocus />
          </div>
        </div>
        <Select
          label="Отдел"
          value={deptId}
          onChange={setDeptId}
          options={canRoot ? [{ value: NONE, label: 'Без отдела' }, ...deptChoices] : deptChoices}
        />
        {!canRoot && (
          <p className="label-sm" style={{ margin: '-0.5rem 0 0' }}>Должность вне отделов заводит Менеджер и выше — выберите отдел своей ветки.</p>
        )}
        <div>
          <div className="ui-field-label label-caps" style={{ marginBottom: '0.375rem' }}>Подчиняется (необязательно)</div>
          <EntitySelector value={reportsTo} onChange={setReportsTo} types={['position']} multi={false} options={positionOptions} placeholder="По структуре — руководитель отдела или объекта" context={{ workspaceId }} />
        </div>
      </div>
    </Modal>
  );
}
