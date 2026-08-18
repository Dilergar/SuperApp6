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
import { isDocDateRangeValue, type AvailableTemplateDto, type DocFormFieldDto } from '@superapp/shared';
import { apiErrorMessage } from '@/lib/api';
import { toastError } from '@/lib/toast';
import { availableTemplatesKey, orgDocumentsKey } from '@/lib/queries';
import { Alert, Button, Card, DatePicker, EmptyState, Input, LoadingBlock, Modal, Select, Textarea, Toggle } from '@/components/ui';
import { documentsApi, fetchAvailableTemplates } from './documents-api';

/** Значения формы: строки у обычных полей, {from,to} у периода дат */
export type DocFormValues = Record<string, unknown>;

/** Заполнено ли обязательное поле — период проверяется целиком, не как строка */
export function formFieldFilled(f: DocFormFieldDto, value: unknown): boolean {
  if (f.kind === 'daterange') return isDocDateRangeValue(value);
  return typeof value === 'string' ? value.trim().length > 0 : value !== null && value !== undefined;
}

export function SubmitDocumentModal({
  workspaceId,
  open,
  onClose,
  subjectUserId,
  subjectName,
  category,
  onNoTemplates,
}: {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
  /** Документ НА сотрудника (из его карточки в ростере). Пусто — «от себя». */
  subjectUserId?: string;
  subjectName?: string;
  /** Сузить шаблоны до категории (вкладка «С контрагентами» = 'external') */
  category?: string;
  /** В категории нет шаблонов — предложить запасной путь (загрузку файла) */
  onNoTemplates?: () => void;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [values, setValues] = useState<DocFormValues>({});

  const templatesQuery = useQuery({
    queryKey: availableTemplatesKey(workspaceId),
    queryFn: () => fetchAvailableTemplates(workspaceId),
    enabled: open,
  });
  const available = useMemo(
    () => (templatesQuery.data ?? []).filter((t) => !category || t.category === category),
    [templatesQuery.data, category],
  );

  const template = useMemo(
    () => available.find((t) => t.id === templateId) ?? null,
    [available, templateId],
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
      return res.id;
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

  const missing = (template?.fields ?? []).filter((f) => f.required && !formFieldFilled(f, values[f.key]));

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
      ) : available.length === 0 ? (
        category === 'external' ? (
          <EmptyState
            icon="workspace"
            title="Шаблонов для контрагентов пока нет"
            description="Менеджер+ заводит вид категории «С контрагентами» и его шаблон. Готовый договор можно загрузить файлом прямо сейчас."
            action={
              onNoTemplates ? (
                <Button variant="matte" icon="upload" onClick={onNoTemplates}>
                  Загрузить готовый файл
                </Button>
              ) : undefined
            }
          />
        ) : (
          <EmptyState
            icon="file"
            title="Пока нечего подавать"
            description="Шаблоны заявлений настраивает управляющий: он же решает, кому какой доступен."
          />
        )
      ) : (
        <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
          {available.map((t) => (
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
  values: DocFormValues;
  onChange: (next: DocFormValues) => void;
  disabled?: boolean;
}) {
  if (!fields.length) {
    return (
      <p style={{ color: 'var(--text-muted)' }}>
        У этого шаблона нет полей — документ соберётся по данным организации и сотрудника.
      </p>
    );
  }
  const set = (key: string, value: unknown) => onChange({ ...values, [key]: value });
  const str = (v: unknown) => (typeof v === 'string' ? v : '');

  return (
    <div style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
      {fields.map((f) => {
        const label = f.label + (f.required ? ' *' : '');
        if (f.kind === 'select') {
          return (
            <Select
              key={f.key}
              label={label}
              value={str(values[f.key]) || null}
              onChange={(v) => set(f.key, v)}
              options={(f.options ?? []).map((o) => ({ value: o.value, label: o.label }))}
              placeholder={f.placeholder ?? 'Выберите'}
              disabled={disabled}
            />
          );
        }
        if (f.kind === 'textarea') {
          return (
            <Textarea
              key={f.key}
              label={label}
              value={str(values[f.key])}
              disabled={disabled}
              placeholder={f.placeholder}
              rows={4}
              onChange={(e) => set(f.key, e.target.value)}
            />
          );
        }
        if (f.kind === 'date') {
          return (
            <DatePicker
              key={f.key}
              label={label}
              value={isoToDate(str(values[f.key]))}
              onChange={(d) => set(f.key, d ? dateToIso(d) : '')}
              disabled={disabled}
            />
          );
        }
        if (f.kind === 'daterange') {
          return (
            <DateRangeField
              key={f.key}
              label={label}
              value={isDocDateRangeValue(values[f.key]) ? (values[f.key] as { from: string; to: string }) : null}
              onChange={(v) => set(f.key, v)}
              disabled={disabled}
            />
          );
        }
        return (
          <Input
            key={f.key}
            label={label}
            value={str(values[f.key])}
            disabled={disabled}
            placeholder={f.placeholder}
            type={f.kind === 'number' ? 'number' : 'text'}
            onChange={(e) => set(f.key, e.target.value)}
          />
        );
      })}
    </div>
  );
}

function isoToDate(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function dateToIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Период дат: два мини-календаря «С»/«По» + тумблер «Один день» (остаётся один
 * календарь, to = from). «По» не даёт выбрать дату раньше «С».
 */
function DateRangeField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: { from: string; to: string } | null;
  onChange: (v: { from: string; to: string } | null) => void;
  disabled?: boolean;
}) {
  const from = value ? isoToDate(value.from) : null;
  const to = value ? isoToDate(value.to) : null;
  const singleDay = !!value && value.from === value.to;
  const [single, setSingle] = useState(singleDay);

  const apply = (f: Date | null, t: Date | null, one: boolean) => {
    if (!f) {
      onChange(null);
      return;
    }
    const fromIso = dateToIso(f);
    const toIso = one || !t ? fromIso : dateToIso(t < f ? f : t);
    onChange({ from: fromIso, to: toIso });
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 'var(--spacing-3)', marginBottom: 'var(--spacing-2)' }}>
        <span className="label-sm" style={{ fontWeight: 600 }}>{label}</span>
        <Toggle
          label="Один день"
          checked={single}
          disabled={disabled}
          onChange={(v) => {
            setSingle(v);
            apply(from, to, v);
          }}
        />
      </div>
      <div style={{ display: 'flex', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
        <DatePicker
          label={single ? 'Дата' : 'С'}
          value={from}
          onChange={(d) => apply(d, to, single)}
          disabled={disabled}
          width={170}
        />
        {!single && (
          <DatePicker
            label="По"
            value={to}
            onChange={(d) => apply(from, d, false)}
            min={from ?? undefined}
            disabled={disabled || !from}
            width={170}
          />
        )}
      </div>
    </div>
  );
}
