'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { NOTE_ROLES, type NoteRole, type NoteShareDto, type NoteSpaceRef } from '@superapp/shared';
import { Button, Chip, EmptyState, IconButton, LoadingBlock, Modal, Select } from '@/components/ui';
import { EntitySelector } from '@/components/EntitySelector';
import type { Principal } from '@/lib/entities';
import { PersonChip } from '@/app/circles/PersonCard';
import { apiErrorMessage } from '@/lib/api';
import { fetchFolderShares, fetchNoteShares, shareFolder, shareNote, unshareFolder, unshareNote } from '@/lib/notes-api';
import { noteFolderSharesKey, noteSharesKey, notesRootKey } from '@/lib/queries';
import { toastError } from '@/lib/toast';

// ============================================================
// Доступ к заметке или папке: кому и с каким правом. Пикер не предлагает того, что
// сервер отвергнет: в личном пространстве — люди из окружения и мои Группы; в
// организации — сотрудники, отделы, должности, объекты и «вся организация».
// ============================================================

interface Props {
  open: boolean;
  onClose: () => void;
  scope: NoteSpaceRef;
  target: { kind: 'note' | 'folder'; id: string; title: string };
  /** Зритель управляет доступом (иначе — только просмотр списка) */
  canManage: boolean;
}

export function NoteShareModal({ open, onClose, scope, target, canManage }: Props) {
  const t = useTranslations('notes');
  // Реестр называет РОЛЬ, слово ей даёт каталог — иначе список прав говорил бы
  // по-русски у зрителя, выбравшего другой язык.
  const roleOptions = NOTE_ROLES.map((r) => ({ value: r, label: t(`role.${r}`) }));
  const qc = useQueryClient();
  const key = target.kind === 'note' ? noteSharesKey(target.id) : noteFolderSharesKey(target.id);
  const shares = useQuery({
    queryKey: key,
    queryFn: () => (target.kind === 'note' ? fetchNoteShares(target.id) : fetchFolderShares(target.id)),
    enabled: open,
  });
  const [principals, setPrincipals] = useState<Principal[]>([]);
  const [role, setRole] = useState<NoteRole>('viewer');
  const personal = !scope.workspaceId;
  const types = personal ? ['user', 'circle'] : ['user', 'department', 'position', 'branch'];

  const refresh = (data: NoteShareDto[]) => {
    qc.setQueryData(key, data);
    void qc.invalidateQueries({ queryKey: notesRootKey, refetchType: 'inactive' });
  };

  const add = useMutation({
    mutationFn: async (list: Principal[]) => {
      let last: NoteShareDto[] = [];
      for (const p of list) {
        const input = { principalType: p.type as NoteShareDto['principalType'], principalId: p.id, role };
        last = target.kind === 'note' ? await shareNote(target.id, input) : await shareFolder(target.id, input);
      }
      return last;
    },
    onSuccess: (data) => {
      refresh(data);
      setPrincipals([]);
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: (s: NoteShareDto) => (target.kind === 'note' ? unshareNote(target.id, s.principalType, s.principalId) : unshareFolder(target.id, s.principalType, s.principalId)),
    onSuccess: refresh,
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const shareToWorkspace = () => {
    if (!scope.workspaceId) return;
    add.mutate([{ type: 'workspace', id: scope.workspaceId }]);
  };

  return (
    <Modal open={open} onClose={onClose} title={t(target.kind === 'note' ? 'share.noteTitle' : 'share.folderTitle')} subtitle={target.title} size="md">
      {canManage && (
        <div style={{ display: 'grid', gap: 'var(--spacing-3)', marginBottom: 'var(--spacing-4)' }}>
          <EntitySelector value={principals} onChange={setPrincipals} types={types} context={scope.workspaceId ? { workspaceId: scope.workspaceId } : undefined} placeholder={t(personal ? 'share.pickPersonal' : 'share.pickOrg')} />
          <div style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <Select value={role} onChange={(v) => setRole(v as NoteRole)} options={roleOptions} label={t('share.roleLabel')} width={220} />
            <Button icon="share" onClick={() => add.mutate(principals)} disabled={!principals.length} loading={add.isPending}>
              {t('share.grant')}
            </Button>
            {!personal && (
              <Button variant="matte" icon="workspace" onClick={shareToWorkspace} loading={add.isPending}>
                {t('share.wholeOrg')}
              </Button>
            )}
          </div>
        </div>
      )}
      {shares.isPending ? (
        <LoadingBlock />
      ) : !shares.data?.length ? (
        <EmptyState icon="lock" title={t('share.emptyTitle')} description={t(target.kind === 'note' ? 'share.emptyNote' : 'share.emptyFolder')} />
      ) : (
        <div style={{ display: 'grid', gap: 'var(--spacing-2)' }}>
          {shares.data.map((s) => (
            <div key={`${s.refId}:${s.principalType}:${s.principalId}`} style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                {s.principalType === 'user' ? (
                  <PersonChip size="S" userId={s.principalId} firstName={s.principalName.split(' ')[0] || s.principalName} lastName={s.principalName.split(' ').slice(1).join(' ') || null} />
                ) : (
                  <Chip icon={s.principalType === 'workspace' ? 'workspace' : s.principalType === 'circle' ? 'circle' : s.principalType === 'department' ? 'department' : s.principalType === 'position' ? 'position' : 'branch'}>
                    {s.principalName}
                  </Chip>
                )}
              </div>
              <Chip size="sm" tone={s.role === 'manager' ? 'accent' : s.role === 'editor' ? 'success' : 'neutral'}>
                {t(`role.${s.role}`)}
              </Chip>
              {s.inherited ? (
                <Chip size="sm" icon="folder">{t('share.fromFolder', { name: s.refName })}</Chip>
              ) : (
                canManage && <IconButton icon="close" label={t('share.revoke')} size={28} iconSize={14} onClick={() => remove.mutate(s)} />
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
