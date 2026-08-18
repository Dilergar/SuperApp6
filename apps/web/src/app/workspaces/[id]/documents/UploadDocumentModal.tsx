'use client';

// ============================================================
// «Загрузить готовый файл» — третий путь создания документа: договор уже
// согласован в Word/PDF вне платформы, сюда он приходит на подпись и в реестр.
// PDF становится отпечатком сразу; DOCX оживляется в общем редакторе.
// ============================================================

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CounterpartyDto, FileDto } from '@superapp/shared';
import { apiErrorMessage } from '@/lib/api';
import { toastError } from '@/lib/toast';
import { counterpartiesKey, counterpartyKey, docTypesKey, orgDocumentsPrefix } from '@/lib/queries';
import { Alert, Button, Dropzone, Input, Modal, Select } from '@/components/ui';
import { UploadProgressList } from '@/components/files/UploadProgressList';
import { useFileUpload } from '@/lib/hooks/useFileUpload';
import { fetchCounterparties, fetchCounterparty } from '../counterparties/counterparties-api';
import { documentsApi, fetchDocTypes } from './documents-api';

const ACCEPT = '.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export function UploadDocumentModal({
  workspaceId,
  open,
  onClose,
  presetCounterpartyId,
}: {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
  /** Открыто из вкладки «С контрагентами» — контрагент уже выбран */
  presetCounterpartyId?: string | null;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const [docTypeId, setDocTypeId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [counterpartyId, setCounterpartyId] = useState<string | null>(presetCounterpartyId ?? null);
  const [contactId, setContactId] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<FileDto | null>(null);

  const upload = useFileUpload('document', {
    ownerWorkspaceId: workspaceId,
    onUploaded: (f) => setUploaded(f),
  });

  const typesQuery = useQuery({
    queryKey: docTypesKey(workspaceId),
    queryFn: () => fetchDocTypes(workspaceId),
    enabled: open,
  });
  const selectedType = (typesQuery.data ?? []).find((t) => t.id === docTypeId) ?? null;
  const isExternal = selectedType?.category === 'external';

  const cpsQuery = useQuery({
    queryKey: counterpartiesKey(workspaceId, { forPicker: 'upload' }),
    queryFn: () => fetchCounterparties(workspaceId, { limit: 200 }),
    enabled: open && isExternal,
  });
  const cpQuery = useQuery({
    queryKey: counterpartyKey(workspaceId, counterpartyId ?? ''),
    queryFn: () => fetchCounterparty(workspaceId, counterpartyId as string),
    enabled: open && isExternal && !!counterpartyId,
  });
  const contacts = (cpQuery.data as CounterpartyDto | undefined)?.contacts ?? [];

  const reset = () => {
    setDocTypeId(null);
    setTitle('');
    setCounterpartyId(presetCounterpartyId ?? null);
    setContactId(null);
    setUploaded(null);
    upload.clearFinished();
  };

  const create = useMutation({
    mutationFn: () =>
      documentsApi.createUploadedDocument(workspaceId, {
        docTypeId,
        fileId: uploaded?.id,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(isExternal && counterpartyId ? { counterpartyId } : {}),
        ...(isExternal && contactId ? { counterpartyContactId: contactId } : {}),
      }),
    onSuccess: (doc) => {
      qc.invalidateQueries({ queryKey: orgDocumentsPrefix(workspaceId) });
      reset();
      onClose();
      router.push(`/workspaces/${workspaceId}/documents/${doc.id}`);
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const badExt = useMemo(
    () => uploaded && !/\.(pdf|docx)$/i.test(uploaded.name),
    [uploaded],
  );

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Загрузить готовый файл"
      subtitle="PDF или Word (.docx): PDF идёт на подпись как есть, Word откроется в редакторе"
      size="md"
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Отмена
          </Button>
          <Button
            icon="check"
            loading={create.isPending}
            disabled={!docTypeId || !uploaded || upload.busy || !!badExt}
            onClick={() => create.mutate()}
          >
            Создать документ
          </Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
        <Select
          label="Вид документа"
          value={docTypeId}
          onChange={(v) => {
            setDocTypeId(v || null);
            setContactId(null);
          }}
          options={(typesQuery.data ?? []).map((t) => ({ value: t.id, label: t.name }))}
          placeholder="Выберите вид"
          hint="От вида зависят нумерация, видимость и уровень подписи"
        />
        {isExternal && (
          <>
            <Select
              label="Контрагент"
              value={counterpartyId}
              onChange={(v) => {
                setCounterpartyId(v || null);
                setContactId(null);
              }}
              options={(cpsQuery.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))}
              placeholder={(cpsQuery.data?.items ?? []).length === 0 ? 'Справочник пуст — заведите контрагента' : 'Выберите контрагента'}
            />
            {counterpartyId && (
              <Select
                label="Подписант (контактное лицо)"
                value={contactId}
                onChange={(v) => setContactId(v || null)}
                options={contacts.map((c) => ({ value: c.id, label: c.position ? `${c.name} · ${c.position}` : c.name }))}
                placeholder={contacts.length === 0 ? 'У контрагента нет контактов' : 'Можно выбрать при отправке'}
                hint="Кому уйдёт ссылка на подписание — можно указать и позже"
              />
            )}
          </>
        )}
        <Input
          label="Название документа"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Пусто — возьмём имя файла"
        />
        {!uploaded && (
          <Dropzone
            accept={ACCEPT}
            multiple={false}
            onFiles={(files) => upload.add(files)}
            title="Перетащите PDF или .docx сюда"
            note="ДОГОВОР, АВР ИЛИ ЛЮБОЙ ГОТОВЫЙ ДОКУМЕНТ"
          />
        )}
        <UploadProgressList items={upload.items} onCancel={upload.cancel} onRemove={upload.remove} />
        {badExt && <Alert tone="danger">Документом можно сделать только PDF или Word-файл (.docx)</Alert>}
      </div>
    </Modal>
  );
}
