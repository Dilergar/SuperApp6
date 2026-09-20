'use client';

// ============================================================
// «Создать документ» — свободный документ с нуля (служебка, письмо):
// вид + название + сторона → черновик → сразу в блочный конструктор.
// ============================================================

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { docTypesKey } from '@/lib/queries';
import { Button, Input, Modal, Select } from '@/components/ui';
import { EntitySelector } from '@/components/EntitySelector';
import { documentsApi, fetchDocTypes } from './documents-api';

import { toastApiError } from '@/lib/api-errors';
export function CreateFreeDocumentModal({
  workspaceId,
  open,
  isManager,
  onClose,
}: {
  workspaceId: string;
  open: boolean;
  /** Менеджер может завести документ НА сотрудника; рядовой — только от себя */
  isManager: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [docTypeId, setDocTypeId] = useState<string | null>(null);
  const [subject, setSubject] = useState<{ type: string; id: string }[]>([]);

  const typesQuery = useQuery({
    queryKey: docTypesKey(workspaceId),
    queryFn: () => fetchDocTypes(workspaceId),
    enabled: open,
  });

  const create = useMutation({
    mutationFn: () =>
      documentsApi.createFreeDocument(workspaceId, {
        docTypeId,
        title: title.trim(),
        ...(subject[0] ? { subjectUserId: subject[0].id } : {}),
      }),
    onSuccess: (doc) => {
      qc.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'documents'] });
      setTitle('');
      setDocTypeId(null);
      setSubject([]);
      onClose();
      router.push(`/workspaces/${workspaceId}/documents/${doc.id}/edit`);
    },
    onError: (e) => toastApiError(e),
  });

  const noTypes = !typesQuery.isPending && (typesQuery.data ?? []).length === 0;
  const tr = useTranslations('documents');
  const tc = useTranslations('common');

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={tr('free.title')}
      subtitle={tr('free.subtitle')}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tc('actions.cancel')}
          </Button>
          <Button
            icon="edit"
            loading={create.isPending}
            disabled={!title.trim() || !docTypeId}
            onClick={() => create.mutate()}
          >
            {tr('free.openBuilder')}
          </Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
        <Input
          label={tr('free.titleLabel')}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={tr('free.titlePlaceholder')}
        />
        <Select
          label={tr('templates.docType')}
          value={docTypeId}
          onChange={(v) => setDocTypeId(v || null)}
          options={(typesQuery.data ?? []).map((t) => ({ value: t.id, label: t.name }))}
          placeholder={tr(noTypes ? 'free.noTypes' : 'templates.docTypePlaceholder')}
          hint={tr('free.docTypeHint')}
        />
        {isManager && (
          <EntitySelector
            types={['user']}
            value={subject}
            onChange={(v) => setSubject(v.slice(-1))}
            context={{ workspaceId }}
            placeholder={tr('free.subjectPlaceholder')}
          />
        )}
      </div>
    </Modal>
  );
}
