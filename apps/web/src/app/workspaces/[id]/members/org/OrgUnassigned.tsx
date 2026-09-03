'use client';

// ============================================================
// Панель «Вне структуры»: люди без назначений (с формой «Назначить»), вакансии,
// несколько корней. Владелец, не держащий должность, — нейтральный чип: это
// законно (сервер разрешает руководителя фолбэком на владельца).
// ============================================================

import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { WORKSPACE_ROLES, type OrgChartDto, type WorkspaceRole } from '@superapp/shared';
import { Button, Chip, CloseChip, Divider, Icon, LoadingBlock, Select } from '@/components/ui';
import { EntitySelector } from '@/components/EntitySelector';
import type { Principal } from '@/lib/entities';
import { assignPositionTo, fetchOrgUnassigned } from '@/lib/org-api';
import { orgUnassignedKey } from '@/lib/queries';
import { PersonChip } from '@/app/circles/PersonCard';
import { showApiError, useOrgRefresh, type OrgSelection } from './org-lib';

export function OrgUnassignedPanel({
  workspaceId, chart, canEdit, onSelect, onClose,
}: {
  workspaceId: string; chart: OrgChartDto; canEdit: boolean;
  onSelect: (sel: OrgSelection | null) => void; onClose: () => void;
}) {
  const q = useQuery({ queryKey: orgUnassignedKey(workspaceId), queryFn: () => fetchOrgUnassigned(workspaceId) });
  const data = q.data;
  return (
    <div className="opanel" role="region" aria-label="Вне структуры">
      <div className="opanel-head">
        <Icon name="people" size={18} />
        <strong className="title-sm" style={{ flex: 1 }}>Вне структуры</strong>
        <CloseChip onClick={onClose} />
      </div>
      <div className="opanel-body">
        {q.isPending && <LoadingBlock />}
        {data && (
          <>
            <section className="opanel-section">
              <span className="label-caps">Люди без должности · {data.people.length}</span>
              {data.people.length === 0 && <p className="label-sm" style={{ margin: 0 }}>Все сотрудники держат должности.</p>}
              {data.people.map((m) => {
                const person = data.persons[m.userId];
                const isOwner = m.userId === chart.ownerUserId;
                return (
                  <div key={m.userId} className="opanel-section" style={{ gap: '0.375rem' }}>
                    <div className="opanel-row" style={{ flexWrap: 'wrap' }}>
                      <PersonChip size="S" userId={m.userId} firstName={person?.firstName ?? 'Без имени'} lastName={person?.lastName ?? null} avatar={person?.avatar ?? null} role={WORKSPACE_ROLES[m.role as WorkspaceRole]?.name ?? m.role} />
                      {isOwner && <Chip size="sm" tone="neutral">Владелец вне схемы — это нормально</Chip>}
                    </div>
                    {canEdit && <AssignRow workspaceId={workspaceId} chart={chart} userId={m.userId} />}
                  </div>
                );
              })}
            </section>
            <Divider />
            <section className="opanel-section">
              <span className="label-caps">Вакансии · {data.vacancies.length}</span>
              {data.vacancies.length === 0 && <p className="label-sm" style={{ margin: 0 }}>Все должности заняты.</p>}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem' }}>
                {data.vacancies.map((v) => (
                  <Chip key={v.positionId} tone="waiting" icon="position" onClick={() => onSelect({ type: 'position', id: v.positionId })}>{v.name}</Chip>
                ))}
              </div>
              {data.vacancies.length > 0 && (
                <div className="opanel-row">
                  <Button variant="matte" size="sm" icon="userAdd" href={`/workspaces/${workspaceId}/members/invitations`}>Нанять</Button>
                </div>
              )}
            </section>
            {/* Одна вершина — норма, а не находка: раздел показывается, только когда
                должностей без руководителя больше одной (тогда это и правда вопрос). */}
            {data.roots.length > 1 && (
              <>
                <Divider />
                <section className="opanel-section">
                  <span className="label-caps">Без руководителя · {data.roots.length}</span>
                  <p className="label-sm" style={{ margin: 0 }}>Несколько должностей ни к кому не подчиняются — свяжите их проводом или назначьте руководителя объекта.</p>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem' }}>
                    {data.roots.map((r) => (
                      <Chip key={r.positionId} tone="warning" icon="position" onClick={() => onSelect({ type: 'position', id: r.positionId })}>{r.name}</Chip>
                    ))}
                  </div>
                </section>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function AssignRow({ workspaceId, chart, userId }: { workspaceId: string; chart: OrgChartDto; userId: string }) {
  const refresh = useOrgRefresh(workspaceId);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Principal[]>([]);
  const defaultBranch = chart.branches.find((b) => b.isDefault)?.id ?? chart.branches[0]?.id ?? '';
  const [branchId, setBranchId] = useState(defaultBranch);
  const positionOptions = chart.positions.map((x) => ({ type: 'position', id: x.id, title: x.name, icon: x.glyph }));
  const assign = useMutation({
    mutationFn: () => assignPositionTo(workspaceId, userId, { positionId: pos[0].id, branchId: branchId || null }),
    onSuccess: () => { setOpen(false); setPos([]); refresh(); },
    onError: showApiError,
  });
  if (!open) {
    return (
      <div className="opanel-row">
        <Button variant="outline" size="sm" icon="position" onClick={() => setOpen(true)}>Назначить</Button>
      </div>
    );
  }
  return (
    <div className="opanel-note" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <EntitySelector value={pos} onChange={setPos} types={['position']} multi={false} options={positionOptions} placeholder="На какую должность…" context={{ workspaceId }} />
      <Select label="Объект" value={branchId} onChange={setBranchId} options={chart.branches.map((b) => ({ value: b.id, label: b.name, icon: 'branch' as const }))} />
      <div className="opanel-row">
        <Button variant="primary" tone="success" size="sm" icon="check" disabled={!pos.length || !branchId} loading={assign.isPending} onClick={() => assign.mutate()}>Назначить</Button>
        <Button variant="ghost" size="sm" onClick={() => { setOpen(false); setPos([]); }}>Отмена</Button>
      </div>
    </div>
  );
}
