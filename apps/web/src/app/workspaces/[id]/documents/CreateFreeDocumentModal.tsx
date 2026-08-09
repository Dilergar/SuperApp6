'use client';

// ============================================================
// «Создать документ» — свободный документ с нуля (служебка, письмо):
// вид + название + сторона → черновик → сразу в блочный конструктор.
// ============================================================

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiErrorMessage } from '@/lib/api';
import { toastError } from '@/lib/toast';
import { docTypesKey } from '@/lib/queries';
import { Button, Input, Modal, Select } from '@/components/ui';
import { EntitySelector } from '@/components/EntitySelector';
import { documentsApi, fetchDocTypes } from './documents-api';

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
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const noTypes = !typesQuery.isPending && (typesQuery.data ?? []).length === 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Создать документ"
      subtitle="Документ собирается с нуля в конструкторе — Word не нужен, на выходе PDF"
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            icon="edit"
            loading={create.isPending}
            disabled={!title.trim() || !docTypeId}
            onClick={() => create.mutate()}
          >
            Открыть конструктор
          </Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
        <Input
          label="Название документа"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Служебная записка о закупке"
        />
        <Select
          label="Вид документа"
          value={docTypeId}
          onChange={(v) => setDocTypeId(v || null)}
          options={(typesQuery.data ?? []).map((t) => ({ value: t.id, label: t.name }))}
          placeholder={noTypes ? 'Видов пока нет — их заводит Менеджер+' : 'Выберите вид'}
          hint="От вида зависят нумерация, видимость и подшивка в дело"
        />
        {isManager && (
          <EntitySelector
            types={['user']}
            value={subject}
            onChange={(v) => setSubject(v.slice(-1))}
            context={{ workspaceId }}
            placeholder="Сторона документа (пусто — вы сами)"
          />
        )}
      </div>
    </Modal>
  );
}
