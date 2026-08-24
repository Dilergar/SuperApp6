'use client';

// ============================================================
// Шаблоны документов (Менеджер+): бланк + форма подачи + кому доступен.
//
// Список нарочно скупой: шаблон настраивается в СВОЁМ конструкторе (там бланк
// в редакторе рядом с панелью полей), а здесь видно только то, по чему шаблон
// выбирают глазами — вид, состояние, есть ли маршрут.
// ============================================================

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DocTemplateDto } from '@superapp/shared';
import { apiErrorMessage } from '@/lib/api';
import { toastError } from '@/lib/toast';
import { uploadFile } from '@/lib/files-api';
import { docTemplatesKey, docTypesKey } from '@/lib/queries';
import {
  BentoGrid,
  Button,
  Card,
  CardHeader,
  Chip,
  EmptyState,
  Input,
  LoadingBlock,
  Modal,
  Select,
} from '@/components/ui';
import { documentsApi, fetchDocTemplates, fetchDocTypes } from './documents-api';
import { HrLibraryBlock } from './HrLibraryBlock';

export function TemplatesTab({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);

  const templatesQuery = useQuery({
    queryKey: docTemplatesKey(workspaceId),
    queryFn: () => fetchDocTemplates(workspaceId),
  });

  const publish = useMutation({
    mutationFn: (tplId: string) => documentsApi.publishTemplate(workspaceId, tplId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'documents'] }),
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', margin: 'var(--gap-grid) 0' }}>
        <Button variant="matte" icon="add" onClick={() => setCreating(true)}>
          Новый шаблон
        </Button>
      </div>

      <BentoGrid>
        {/* КЭДО: платформенная библиотека кадровых бланков — установка мастером */}
        <HrLibraryBlock workspaceId={workspaceId} />
        {templatesQuery.isPending ? (
          <Card span={12}>
            <LoadingBlock />
          </Card>
        ) : templatesQuery.isError ? (
          <Card span={12}>
            <EmptyState
              icon="warningCircle"
              title="Не удалось загрузить шаблоны"
              action={
                <Button variant="matte" icon="refresh" onClick={() => templatesQuery.refetch()}>
                  Повторить
                </Button>
              }
            />
          </Card>
        ) : (templatesQuery.data ?? []).length === 0 ? (
          <Card span={12}>
            <EmptyState
              icon="filePlus"
              title="Шаблонов пока нет"
              description="Шаблон — это бланк с тегами вида {Организация.БИН} плюс форма, которую заполняет сотрудник."
              action={
                <Button variant="matte" icon="add" onClick={() => setCreating(true)}>
                  Создать шаблон
                </Button>
              }
            />
          </Card>
        ) : (
          (templatesQuery.data ?? []).map((tpl) => (
            <Card key={tpl.id} span={6}>
              <CardHeader
                title={tpl.name}
                actions={
                  <div style={{ display: 'flex', gap: 'var(--spacing-2)' }}>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="edit"
                      onClick={() => router.push(`/workspaces/${workspaceId}/documents/templates/${tpl.id}`)}
                    >
                      Настроить
                    </Button>
                    {tpl.status !== 'published' && (
                      <Button
                        variant="matte"
                        size="sm"
                        icon="check"
                        loading={publish.isPending}
                        onClick={() => publish.mutate(tpl.id)}
                      >
                        Опубликовать
                      </Button>
                    )}
                  </div>
                }
              />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-2)' }}>
                <Chip size="sm">{tpl.docTypeName}</Chip>
                <Chip size="sm" tone={tpl.status === 'published' ? 'success' : 'neutral'}>
                  {tpl.status === 'published' ? 'Опубликован' : 'Черновик'}
                </Chip>
                {tpl.selfService && (
                  <Chip size="sm" tone="accent" icon="staff">
                    Сотрудник подаёт сам
                  </Chip>
                )}
                {tpl.hasRoute ? (
                  <Chip size="sm" icon="processes">
                    Маршрут настроен
                  </Chip>
                ) : (
                  <Chip size="sm" icon="warningCircle">
                    Без маршрута
                  </Chip>
                )}
              </div>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: 'var(--spacing-3)' }}>
                {tpl.description || `Полей формы: ${tpl.fields.length}`}
              </p>
            </Card>
          ))
        )}
      </BentoGrid>

      <CreateTemplateModal workspaceId={workspaceId} open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function CreateTemplateModal({
  workspaceId,
  open,
  onClose,
}: {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const router = useRouter();
  const [name, setName] = useState('');
  const [docTypeId, setDocTypeId] = useState<string | null>(null);
  const [kind, setKind] = useState<'builder' | 'docx'>('builder');
  const [file, setFile] = useState<File | null>(null);

  const typesQuery = useQuery({
    queryKey: docTypesKey(workspaceId),
    queryFn: () => fetchDocTypes(workspaceId),
    enabled: open,
  });

  const create = useMutation({
    mutationFn: async () => {
      // Бланк грузим обычным путём движка файлов, а Документам отдаём уже готовый
      // fileId — сервис не принимает байты вовсе (правило движка файлов).
      let fileId: string | undefined;
      if (kind === 'docx' && file) {
        const uploaded = await uploadFile(file, 'document', { ownerWorkspaceId: workspaceId });
        fileId = uploaded.id;
      }
      const res = await documentsApi.createTemplate(workspaceId, {
        docTypeId,
        name: name.trim(),
        kind,
        ...(fileId ? { fileId } : {}),
      });
      return res;
    },
    onSuccess: (tpl) => {
      qc.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'documents'] });
      setName('');
      setFile(null);
      setDocTypeId(null);
      onClose();
      router.push(`/workspaces/${workspaceId}/documents/templates/${tpl.id}`);
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Новый шаблон"
      subtitle="Бланк собирается в конструкторе или загружается готовым Word-файлом"
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            icon="check"
            loading={create.isPending}
            disabled={!name.trim() || !docTypeId}
            onClick={() => create.mutate()}
          >
            Создать
          </Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
        <Input
          label="Название для сотрудника"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Отпуск"
          hint="Так шаблон будет называться в окне «Подать заявление»"
        />
        <Select
          label="Вид документа"
          value={docTypeId}
          onChange={(v) => setDocTypeId(v || null)}
          options={(typesQuery.data ?? []).map((t) => ({ value: t.id, label: t.name }))}
          placeholder="Выберите вид"
          hint="От вида зависят нумерация, видимость и правила проверки маршрута"
        />

        <div role="radiogroup" aria-label="Как сделать бланк" style={{ display: 'grid', gap: 'var(--spacing-2)' }}>
          <KindOption
            checked={kind === 'builder'}
            title="Собрать в конструкторе"
            hint="С нуля прямо здесь: блоки, данные чипами, на выходе PDF. Word не нужен."
            onPick={() => setKind('builder')}
          />
          <KindOption
            checked={kind === 'docx'}
            title="Загрузить Word-бланк"
            hint="Готовый .docx с тегами вида {Организация.БИН} — правится в редакторе документов."
            onPick={() => setKind('docx')}
          />
        </div>

        {kind === 'docx' && (
          <Input
            label="Бланк .docx"
            type="file"
            accept=".docx"
            onChange={(e) => setFile((e.target as HTMLInputElement).files?.[0] ?? null)}
            hint="Обычный документ Word с тегами вида {Организация.БИН} — их подскажет конструктор"
          />
        )}
      </div>
    </Modal>
  );
}

/** Крупная радио-карточка выбора вида бланка */
function KindOption({
  checked,
  title,
  hint,
  onPick,
}: {
  checked: boolean;
  title: string;
  hint: string;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onPick}
      style={{
        textAlign: 'left',
        font: 'inherit',
        cursor: 'pointer',
        borderRadius: 14,
        padding: 'var(--spacing-3) var(--spacing-4)',
        border: checked ? '1px solid rgba(88,140,211,0.55)' : '1px solid var(--line)',
        background: checked ? 'rgba(88,140,211,0.10)' : 'transparent',
        color: 'var(--text)',
      }}
    >
      <div style={{ fontWeight: 600 }}>{title}</div>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 2 }}>{hint}</div>
    </button>
  );
}
