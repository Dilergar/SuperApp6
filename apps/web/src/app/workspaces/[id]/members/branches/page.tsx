'use client';

// ============================================================
// «Объекты» (StaffBranch; в UI пока «Филиалы» → «Объекты»): список с основным
// объектом, руководителем объекта и адресом. У организации всегда ≥1 объект;
// основной удалить нельзя — перенос флага явным действием. Справочник остаётся
// списком: сеть точек на канвасе — типовая схема + фильтр «Объект».
// ============================================================

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { apiDelete, apiErrorMessage, apiPatch, apiPost } from '@/lib/api';
import {
  BentoGrid, Button, Card, CardHeader, Chip, ConfirmDialog, EmptyState, Field, Input, LoadingBlock, Modal,
} from '@/components/ui';
import { EntitySelector } from '@/components/EntitySelector';
import type { Principal } from '@/lib/entities';
import type { StaffBranch, StaffDirectory } from '@superapp/shared';
import { DirectoryRow, MembersHeader, membersSectionHref, useLegacyMembersTabRedirect, useMembersBase } from '../members-lib';

export default function MembersBranchesPage() {
  const { id: workspaceId } = useParams<{ id: string }>();
  useLegacyMembersTabRedirect(workspaceId);
  const { isReady, ws, wsQ, canStaff, dir, refreshStaff } = useMembersBase(workspaceId);
  const [error, setError] = useState('');

  if (!isReady || wsQ.isLoading || !ws) return <LoadingBlock />;

  return (
    <MembersHeader
      ws={ws}
      title="Объекты"
      description="Точки, филиалы, площадки: назначение сотрудника всегда в объекте"
      error={error}
      onCloseError={() => setError('')}
      actions={
        <Button variant="matte" icon="department" href={membersSectionHref(workspaceId, 'org')}>
          Орг. структура
        </Button>
      }
    >
      <BranchesSection workspaceId={workspaceId} dir={dir} canStaff={canStaff} onError={setError} refresh={refreshStaff} />
    </MembersHeader>
  );
}

function BranchesSection({
  workspaceId, dir, canStaff, onError, refresh,
}: {
  workspaceId: string; dir: StaffDirectory; canStaff: boolean;
  onError: (m: string) => void; refresh: () => void;
}) {
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
  const [editing, setEditing] = useState<StaffBranch | null>(null);

  const create = useMutation({
    mutationFn: async () =>
      apiPost(`/workspaces/${workspaceId}/staff/branches`, {
        name: name.trim(),
        address: address.trim() || null,
      }),
    onSuccess: () => { setName(''); setAddress(''); onError(''); refresh(); },
    onError: (e) => onError(apiErrorMessage(e)),
  });
  const del = useMutation({
    mutationFn: async (id: string) => apiDelete(`/workspaces/${workspaceId}/staff/branches/${id}`),
    onSuccess: () => { setRemoving(null); onError(''); refresh(); },
    onError: (e) => { setRemoving(null); onError(apiErrorMessage(e)); },
  });

  return (
    <>
      <BentoGrid>
        {canStaff && (
          <Card span={12} small>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div style={{ width: 260 }}>
                <Input label="Название" value={name} onChange={(e) => setName(e.target.value)} placeholder="Алматы-1, Офис, Склад…" maxLength={100} />
              </div>
              <div style={{ flex: 1, minWidth: 220 }}>
                <Input label="Адрес" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Необязательно" maxLength={300} />
              </div>
              <Button variant="primary" tone="success" icon="add" disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>
                Создать
              </Button>
            </div>
          </Card>
        )}

        <Card span={12}>
          <CardHeader
            title="Объекты"
            subtitle="Основной объект — место назначений «без объекта»; руководитель объекта — вертикаль для должностей без отдела"
          />
          {dir.branches.length === 0 ? (
            <EmptyState icon="branch" title="Объектов пока нет" description={canStaff ? 'Например «Алматы-1» или «Офис».' : 'Справочник заполняют управляющие.'} />
          ) : (
            <div className="ui-stack" style={{ gap: '0.375rem' }}>
              {dir.branches.map((b) => (
                <DirectoryRow
                  key={b.id}
                  icon="branch"
                  title={b.name}
                  subtitle={`${b.membersCount ?? 0} чел.${b.address ? ` · ${b.address}` : ''}`}
                  chips={
                    <>
                      {b.isDefault && <Chip size="sm" tone="accent" icon="home">Основной</Chip>}
                      {b.headPositionName ? (
                        <Chip size="sm" tone="neutral" icon="position">Руководит: {b.headPositionName}</Chip>
                      ) : (
                        <Chip size="sm" tone="warning" icon="pending">Без руководителя</Chip>
                      )}
                    </>
                  }
                  onClick={canStaff ? () => setEditing(b) : undefined}
                  onRemove={canStaff && !b.isDefault ? () => setRemoving({ id: b.id, name: b.name }) : undefined}
                />
              ))}
            </div>
          )}
        </Card>
      </BentoGrid>

      {editing && (
        <BranchModal
          workspaceId={workspaceId}
          branch={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); onError(''); refresh(); }}
          onError={onError}
        />
      )}

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={() => { if (removing) del.mutate(removing.id); }}
        title={removing ? `Удалить объект «${removing.name}»?` : 'Удалить объект?'}
        message="Если к объекту привязаны люди — удалить не получится, сначала переведите их."
        confirmLabel="Удалить"
        danger
        loading={del.isPending}
      />
    </>
  );
}

/** Карточка объекта: название, адрес, руководитель объекта, «сделать основным». */
function BranchModal({
  workspaceId, branch, onClose, onSaved, onError,
}: {
  workspaceId: string;
  branch: StaffBranch;
  onClose: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [name, setName] = useState(branch.name);
  const [address, setAddress] = useState(branch.address ?? '');
  const [head, setHead] = useState<Principal[]>(branch.headPositionId ? [{ type: 'position', id: branch.headPositionId }] : []);
  const [makeDefault, setMakeDefault] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const headPositionId = head[0]?.id ?? null;
      await apiPatch(`/workspaces/${workspaceId}/staff/branches/${branch.id}`, {
        ...(name.trim() !== branch.name ? { name: name.trim() } : {}),
        ...(address.trim() !== (branch.address ?? '') ? { address: address.trim() || null } : {}),
        ...(headPositionId !== branch.headPositionId ? { headPositionId } : {}),
        ...(makeDefault && !branch.isDefault ? { isDefault: true } : {}),
      });
      onSaved();
    } catch (e) {
      onError(apiErrorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Объект «${branch.name}»`}
      size="md"
      footer={
        <Button variant="primary" tone="success" icon="save" loading={busy} disabled={!name.trim()} onClick={() => void save()}>
          Сохранить
        </Button>
      }
    >
      <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        <Input label="Название" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
        <Input label="Адрес" value={address} onChange={(e) => setAddress(e.target.value)} maxLength={300} placeholder="Необязательно" />
        <Field label="Руководитель объекта (должность)" hint="Должности без отдела в этом объекте подчиняются ей; руководитель считается по держателям В ЭТОМ объекте">
          <EntitySelector
            value={head}
            onChange={setHead}
            types={['position']}
            multi={false}
            placeholder="Должность из справочника…"
            context={{ workspaceId }}
          />
        </Field>
        {branch.isDefault ? (
          <Chip tone="accent" icon="home">Основной объект организации</Chip>
        ) : (
          <Chip tone="accent" icon="home" selected={makeDefault} onClick={() => setMakeDefault((v) => !v)}>
            Сделать основным объектом
          </Chip>
        )}
      </div>
    </Modal>
  );
}
