'use client';

// ============================================================
// «Подать заявление» — единственная точка входа сотрудника в документооборот.
//
// Два шага в одном окне: выбрать шаблон человеческим названием («Отпуск»,
// а не «Заявление о предоставлении…») → заполнить его форму. Списка «видов
// документов» здесь нет намеренно: это внутренняя настройка кадровика, а
// сотруднику важно только «что я могу подать».
// ============================================================

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AvailableTemplateDto, DocFormFieldDto } from '@superapp/shared';
import { apiErrorMessage } from '@/lib/api';
import { toastError } from '@/lib/toast';
import { availableTemplatesKey, orgDocumentsKey } from '@/lib/queries';
import { Alert, Button, Card, EmptyState, Input, LoadingBlock, Modal, Select, Textarea } from '@/components/ui';
import { documentsApi, fetchAvailableTemplates } from './documents-api';

export function SubmitDocumentModal({
  workspaceId,
  open,
  onClose,
  subjectUserId,
  subjectName,
}: {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
  /** Документ НА сотрудника (из его карточки в ростере). Пусто — «от себя». */
  subjectUserId?: string;
  subjectName?: string;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});

  const templatesQuery = useQuery({
    queryKey: availableTemplatesKey(workspaceId),
    queryFn: () => fetchAvailableTemplates(workspaceId),
    enabled: open,
  });

  const template = useMemo(
    () => (templatesQuery.data ?? []).find((t) => t.id === templateId) ?? null,
    [templatesQuery.data, templateId],
  );

  const reset = () => {
    setTemplateId(null);
    setValues({});
  };

  const create = useMutation({
    mutationFn: async () => {
      const res = await documentsApi.createDocument(workspaceId, {
        templateId,
        fields: values,
        ...(subjectUserId ? { subjectUserId } : {}),
      });
      return res.data.data.id as string;
    },
    onSuccess: (id) => {
      qc.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'documents'] });
      qc.invalidateQueries({ queryKey: orgDocumentsKey(workspaceId) });
      reset();
      onClose();
      router.push(`/workspaces/${workspaceId}/documents/${id}`);
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const missing = (template?.fields ?? []).filter((f) => f.required && !values[f.key]?.trim());

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title={subjectName ? `Документ: ${subjectName}` : 'Подать заявление'}
      subtitle={template ? template.name : subjectName ? 'Выберите, что оформить' : 'Выберите, что подать'}
      size="md"
      footer={
        template ? (
          <>
            <Button variant="ghost" onClick={() => setTemplateId(null)}>
              Назад
            </Button>
            <Button
              icon="check"
              loading={create.isPending}
              disabled={missing.length > 0}
              onClick={() => create.mutate()}
            >
              Создать документ
            </Button>
          </>
        ) : null
      }
    >
      {templatesQuery.isPending ? (
        <LoadingBlock />
      ) : template ? (
        <FormFields fields={template.fields} values={values} onChange={setValues} />
      ) : templatesQuery.isError ? (
        // Сбой запроса — НЕ «вам ничего не выдали»: человек с этим сообщением идёт к
        // кадровику жаловаться на доступ, которого его никто не лишал.
        <Alert
          tone="danger"
          action={
            <Button variant="ghost" size="sm" icon="refresh" onClick={() => templatesQuery.refetch()}>
              Повторить
            </Button>
          }
        >
          Не удалось загрузить список — проверьте связь и попробуйте снова
        </Alert>
      ) : (templatesQuery.data ?? []).length === 0 ? (
        <EmptyState
          icon="file"
          title="Пока нечего подавать"
          description="Шаблоны заявлений настраивает управляющий: он же решает, кому какой доступен."
        />
      ) : (
        <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
          {(templatesQuery.data ?? []).map((t) => (
            <TemplateOption key={t.id} template={t} onPick={() => setTemplateId(t.id)} />
          ))}
        </div>
      )}
    </Modal>
  );
}

function TemplateOption({
  template,
  onPick,
}: {
  template: AvailableTemplateDto;
  onPick: () => void;
}) {
  return (
    <Card hoverable onClick={onPick} small>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>{template.name}</div>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            {template.description || template.docTypeName}
          </div>
        </div>
        <Button variant="matte" size="sm" icon="arrowRight" onClick={onPick}>
          Заполнить
        </Button>
      </div>
    </Card>
  );
}

/** Поля формы подачи — только из кита: подпись связана с полем самим китом */
export function FormFields({
  fields,
  values,
  onChange,
  disabled,
}: {
  fields: DocFormFieldDto[];
  values: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  disabled?: boolean;
}) {
  if (!fields.length) {
    return (
      <p style={{ color: 'var(--text-muted)' }}>
        У этого шаблона нет полей — документ соберётся по данным организации и сотрудника.
      </p>
    );
  }
  const set = (key: string, value: string) => onChange({ ...values, [key]: value });

  return (
    <div style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
      {fields.map((f) => {
        const common = {
          label: f.label + (f.required ? ' *' : ''),
          value: values[f.key] ?? '',
          disabled,
          placeholder: f.placeholder,
        };
        if (f.kind === 'select') {
          return (
            <Select
              key={f.key}
              label={common.label}
              value={values[f.key] ?? null}
              onChange={(v) => set(f.key, v)}
              options={(f.options ?? []).map((o) => ({ value: o.value, label: o.label }))}
              placeholder={f.placeholder ?? 'Выберите'}
              disabled={disabled}
            />
          );
        }
        if (f.kind === 'textarea') {
          return (
            <Textarea key={f.key} {...common} rows={4} onChange={(e) => set(f.key, e.target.value)} />
          );
        }
        return (
          <Input
            key={f.key}
            {...common}
            type={f.kind === 'number' ? 'number' : f.kind === 'date' ? 'date' : 'text'}
            onChange={(e) => set(f.key, e.target.value)}
          />
        );
      })}
    </div>
  );
}
