'use client';

// ============================================================
// Конструктор шаблона (Менеджер+): бланк, поля формы, доступность, публикация.
//
// Панель «Что подставить» — главная идея страницы: кадровик не должен помнить
// синтаксис и точные имена полей. Он видит группы реестра (Организация,
// Сотрудник, Документ), кликает по нужному — и тег уходит в буфер, откуда
// вставляется в бланк одним Ctrl+V.
//
// Почему не «вставить прямо в документ по клику»: правку бланка ведёт внешний
// редактор в своём фрейме, и его протокол вставки — деталь конкретной сборки.
// Буфер работает при любой, и человек сам видит, куда встал курсор.
// ============================================================

import { useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DOC_FIELD_KINDS,
  TEMPLATE_FORMATTERS,
  emptyBuilderDoc,
  type BuilderDoc,
  type DocFormFieldDto,
  type DocTemplateDto,
  type ProcessDefinitionDto,
} from '@superapp/shared';
import { apiErrorMessage, apiPost } from '@/lib/api';
import { toast, toastError } from '@/lib/toast';
import { documentHref } from '@/lib/docs-api';
import { uploadFile } from '@/lib/files-api';
import { docTemplateGrantsKey, docTemplatesKey, templateFieldGroupsKey } from '@/lib/queries';
import {
  Alert,
  BentoGrid,
  Button,
  Card,
  CardHeader,
  Chip,
  Divider,
  EmptyState,
  Input,
  LoadingBlock,
  PageHeader,
  Select,
  Toggle,
  useConfirm,
} from '@/components/ui';
import { EntitySelector } from '@/components/EntitySelector';
import { BuilderEditorLazy } from '@/components/doc-builder/BuilderEditorLazy';
import {
  documentsApi,
  fetchDocTemplates,
  fetchTemplateFieldGroups,
  fetchTemplateGrants,
  findRouteDefinitionId,
} from '../../documents-api';
import { buildRouteBlueprint, surfaceOfCategory } from '../../route-blueprint';

/** Вид получателя доступа — человеку понятным словом */
const PRINCIPAL_KIND: Record<string, string> = {
  user: 'Сотрудник',
  department: 'Отдел',
  position: 'Должность',
  branch: 'Филиал',
};

export default function TemplateConstructorPage() {
  const { id, templateId } = useParams<{ id: string; templateId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const [confirm, confirmUI] = useConfirm();

  const templatesQuery = useQuery({
    queryKey: docTemplatesKey(id),
    queryFn: () => fetchDocTemplates(id),
  });
  const template = useMemo(
    () => (templatesQuery.data ?? []).find((t) => t.id === templateId) ?? null,
    [templatesQuery.data, templateId],
  );

  const groupsQuery = useQuery({
    queryKey: templateFieldGroupsKey,
    queryFn: fetchTemplateFieldGroups,
    staleTime: 30 * 60 * 1000, // реестр статичен на процесс API
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ['workspaces', id, 'documents'] });

  const publish = useMutation({
    mutationFn: () => documentsApi.publishTemplate(id, templateId),
    onSuccess: () => {
      refresh();
      toast('Шаблон опубликован — по нему можно подавать', 'success');
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  /**
   * «Маршрут» — связка с Процессами. Не «перейди в Процессы и разберись»: заводим
   * процесс кадрового профиля с уже собранной схемой, где ЭТОТ шаблон проставлен в
   * триггере. Маршрут уже есть — открываем его, а не плодим второй (публикация всё
   * равно не пропустит два живых маршрута на один шаблон).
   */
  const openRoute = useMutation({
    mutationFn: async () => {
      if (!template) throw new Error('Шаблон не загружен');
      const existing = await findRouteDefinitionId(id, template.id);
      if (existing) return existing;
      const res = await apiPost<ProcessDefinitionDto>(`/workspaces/${id}/processes`, {
        name: `Маршрут: ${template.name}`,
        description: `Запускается отправкой документа по шаблону «${template.name}»`,
        surface: surfaceOfCategory(template.category),
        // Уровень подписи берём из ВИДА документа: кадровый маршрут обязан
        // требовать ЭЦП (ст. 33 ТК РК), и выбирать это руками — способ забыть.
        document: buildRouteBlueprint(template.id, template.name, template.signatureLevel),
      });
      return res.id;
    },
    onSuccess: (defId) => {
      qc.invalidateQueries({ queryKey: ['workspaces', id, 'documents'] });
      router.push(`/workspaces/${id}/processes/${defId}`);
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const uploadBlank = useMutation({
    mutationFn: async (file: File) => {
      const uploaded = await uploadFile(file, 'document', { ownerWorkspaceId: id });
      // Бланк живёт как обычный документ core/docs — заменить его целиком нельзя,
      // поэтому новый бланк = новый шаблон. Здесь только ПЕРВАЯ загрузка.
      return documentsApi.updateTemplate(id, templateId, { fileId: uploaded.id });
    },
    onSuccess: refresh,
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  if (templatesQuery.isPending) return <LoadingBlock />;

  if (templatesQuery.isError || !template) {
    return (
      <>
        <PageHeader breadcrumb="Документооборот" title="Шаблон не открылся" />
        <BentoGrid>
          <Card span={12}>
            <EmptyState
              icon="blocked"
              title="Нет доступа к шаблону"
              description="Настройка шаблонов доступна с роли Менеджер."
              action={
                <Button variant="matte" icon="arrowLeft" href={`/workspaces/${id}/documents`}>
                  К документам
                </Button>
              }
            />
          </Card>
        </BentoGrid>
      </>
    );
  }

  return (
    <>
      <PageHeader
        breadcrumb={`Документооборот · ${template.docTypeName}`}
        title={template.name}
        chip={
          <Chip size="sm" tone={template.status === 'published' ? 'success' : 'neutral'}>
            {template.status === 'published' ? 'Опубликован' : 'Черновик'}
          </Chip>
        }
        actions={
          <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
            <Button variant="ghost" icon="arrowLeft" href={`/workspaces/${id}/documents`}>
              К документам
            </Button>
            {template.documentId && (
              <Button
                variant="matte"
                icon="edit"
                href={documentHref(template.documentId, { refType: 'document', refId: template.documentId })}
              >
                Открыть бланк
              </Button>
            )}
            {/* У видов «С контрагентами» маршрутов НЕТ (v1): их путь — «Отправить
                контрагенту» с карточки, и кнопка обещала бы то, что публикация
                процесса всё равно отвергнет. */}
            {template.category !== 'external' && (
              <Button
                icon="processes"
                variant="matte"
                loading={openRoute.isPending}
                onClick={() => openRoute.mutate()}
              >
                {template.hasRoute ? 'Открыть маршрут' : 'Создать маршрут'}
              </Button>
            )}
            {template.status !== 'published' && (
              <Button icon="check" loading={publish.isPending} onClick={() => publish.mutate()}>
                Опубликовать
              </Button>
            )}
          </div>
        }
      />

      {template.kind === 'builder' ? (
        <BentoGrid>
          {/* Блочный конструктор: лист + панель данных (панель «Что подставить» встроена) */}
          <Card span={12}>
            <BuilderEditorLazy
              key={template.id}
              initial={(template.builderDoc ?? emptyBuilderDoc()) as BuilderDoc}
              fieldGroups={groupsQuery.data ?? []}
              formFields={template.fields}
              onSave={async (doc) => {
                // Тихий автосейв: кэш списка не трогаем — редактор и есть источник
                // правды на этой странице, а рефетч на каждый ввод дёргал бы лист
                await documentsApi.updateTemplate(id, templateId, { builderDoc: doc });
              }}
              onPreview={(doc) => documentsApi.previewTemplatePdf(id, templateId, doc)}
              formHint="Это заполнит сотрудник при подаче — и значение встанет в документ."
              onAddFormField={async (f) => {
                await documentsApi.updateTemplate(id, templateId, { fields: [...template.fields, f] });
                refresh();
              }}
            />
          </Card>

          <Card span={12}>
            <FormFieldsEditor workspaceId={id} template={template} onSaved={refresh} />
          </Card>

          <Card span={12}>
            <TemplateGrants workspaceId={id} template={template} confirm={confirm} />
          </Card>
        </BentoGrid>
      ) : (
      <BentoGrid>
        {/* Бланк */}
        <Card span={7}>
          <CardHeader title="Бланк документа" />
          {template.fileId ? (
            <>
              <p style={{ color: 'var(--text-muted)' }}>
                Бланк загружен. Откройте его в редакторе и расставьте теги — панель справа подскажет, какие
                бывают.
              </p>
              {!template.hasRoute && (
                <p style={{ color: 'var(--text-muted)', marginTop: 'var(--spacing-3)' }}>
                  Маршрута у шаблона пока нет: документ будет уходить «на маршрут» и ждать решения
                  управляющего. Нарисовать маршрут можно в «Процессах» — нодой «Документ отправлен».
                </p>
              )}
            </>
          ) : (
            <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
              <p style={{ color: 'var(--text-muted)' }}>
                Загрузите бланк .docx — обычный документ Word с тегами вида {'{Организация.БИН}'}.
              </p>
              <Input
                label="Файл бланка"
                type="file"
                accept=".docx"
                disabled={uploadBlank.isPending}
                onChange={(e) => {
                  const f = (e.target as HTMLInputElement).files?.[0];
                  if (f) uploadBlank.mutate(f);
                }}
              />
            </div>
          )}

          <Divider />
          <FormFieldsEditor workspaceId={id} template={template} onSaved={refresh} />
        </Card>

        {/* Что подставить */}
        <Card span={5}>
          <CardHeader title="Что подставить" />
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            Клик по полю копирует тег — вставьте его в бланк (Ctrl+V). Данные подставятся при подаче.
          </p>
          {groupsQuery.isPending ? (
            <LoadingBlock />
          ) : (
            <div style={{ display: 'grid', gap: 'var(--spacing-4)', marginTop: 'var(--spacing-3)' }}>
              {(groupsQuery.data ?? []).map((group) => (
                <div key={group.key}>
                  <div style={{ fontWeight: 600, marginBottom: 'var(--spacing-2)' }}>{group.label}</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-2)' }}>
                    {group.fields.map((f) => (
                      <Chip
                        key={f.key}
                        size="sm"
                        onClick={() => copyTag(`{${group.tagPrefix}.${f.key}}`)}
                        // Подпись идёт ПЕРВОЙ: у чипа-кнопки title становится доступным
                        // именем, и «Пример: Ахметов Аскар» вместо «Фамилия и имя»
                        // читается вслух вместо названия поля.
                        title={f.example ? `${f.label} — пример: ${f.example}` : f.label}
                      >
                        {f.label}
                      </Chip>
                    ))}
                  </div>
                </div>
              ))}

              {/* Поля формы самого шаблона — их сотрудник заполняет при подаче */}
              {template.fields.length > 0 && (
                <div>
                  <div style={{ fontWeight: 600, marginBottom: 'var(--spacing-2)' }}>Поля этого шаблона</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-2)' }}>
                    {template.fields.map((f) => (
                      <Chip key={f.key} size="sm" tone="accent" onClick={() => copyTag(`{${f.key}}`)}>
                        {f.label}
                      </Chip>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <div style={{ fontWeight: 600, marginBottom: 'var(--spacing-2)' }}>Форматы</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
                  {TEMPLATE_FORMATTERS.map((f) => (
                    <div key={f.key} style={{ fontSize: '0.85rem' }}>
                      <code>{`{Поле|${f.key}}`}</code>{' '}
                      <span style={{ color: 'var(--text-muted)' }}>— {f.hint}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </Card>

        {/* Кому доступен */}
        <Card span={12}>
          <TemplateGrants workspaceId={id} template={template} confirm={confirm} />
        </Card>
      </BentoGrid>
      )}

      {confirmUI}
    </>
  );
}

/** Копирование тега — с честным отказом, если буфер закрыт политикой браузера */
async function copyTag(tag: string) {
  try {
    await navigator.clipboard.writeText(tag);
    toast(`Скопировано: ${tag} — вставьте в бланк`, 'success');
  } catch {
    toastError(`Не удалось скопировать. Наберите тег вручную: ${tag}`);
  }
}

function FormFieldsEditor({
  workspaceId,
  template,
  onSaved,
}: {
  workspaceId: string;
  template: DocTemplateDto;
  onSaved: () => void;
}) {
  const [fields, setFields] = useState<DocFormFieldDto[] | null>(null);
  const list = fields ?? template.fields;
  const [selfService, setSelfService] = useState<boolean | null>(null);
  const selfServiceValue = selfService ?? template.selfService;

  const save = useMutation({
    mutationFn: () =>
      documentsApi.updateTemplate(workspaceId, template.id, {
        fields: list,
        selfService: selfServiceValue,
      }),
    onSuccess: () => {
      setFields(null);
      setSelfService(null);
      onSaved();
      toast('Форма сохранена', 'success');
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const update = (i: number, patch: Partial<DocFormFieldDto>) =>
    setFields(list.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));

  return (
    <div>
      <CardHeader title="Поля формы подачи" />
      <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
        Это то, что сотрудник заполняет в окне «Подать заявление». Ключ поля — имя тега в бланке.
      </p>

      <div style={{ display: 'grid', gap: 'var(--spacing-3)', marginTop: 'var(--spacing-3)' }}>
        {list.map((f, i) => (
          <div
            key={i}
            style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'flex-end', flexWrap: 'wrap' }}
          >
            <Input
              label="Ключ (тег)"
              value={f.key}
              onChange={(e) => update(i, { key: e.target.value })}
              wrapClassName="ui-grow"
            />
            <Input label="Подпись" value={f.label} onChange={(e) => update(i, { label: e.target.value })} />
            <Select
              label="Тип"
              value={f.kind}
              onChange={(v) => update(i, { kind: v as DocFormFieldDto['kind'] })}
              options={DOC_FIELD_KINDS.map((k) => ({ value: k.value, label: k.label }))}
              width={160}
            />
            <Button
              variant="ghost"
              size="sm"
              icon="delete"
              onClick={() => setFields(list.filter((_, idx) => idx !== i))}
            >
              Убрать
            </Button>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 'var(--spacing-3)', marginTop: 'var(--spacing-4)', flexWrap: 'wrap' }}>
        <Button
          variant="ghost"
          icon="add"
          onClick={() => setFields([...list, { key: '', label: '', kind: 'text' }])}
        >
          Добавить поле
        </Button>
        <Toggle
          label="Сотрудник подаёт сам"
          checked={selfServiceValue}
          onChange={(v) => setSelfService(v)}
        />
        <Button
          variant="matte"
          icon="check"
          loading={save.isPending}
          disabled={fields === null && selfService === null}
          onClick={() => save.mutate()}
        >
          Сохранить форму
        </Button>
      </div>
    </div>
  );
}

function TemplateGrants({
  workspaceId,
  template,
  confirm,
}: {
  workspaceId: string;
  template: DocTemplateDto;
  confirm: (options: { title: string; message?: string; danger?: boolean }, onConfirm: () => void | Promise<void>) => void;
}) {
  const qc = useQueryClient();
  const [picked, setPicked] = useState<{ type: string; id: string }[]>([]);

  const grantsQuery = useQuery({
    queryKey: docTemplateGrantsKey(workspaceId, template.id),
    queryFn: () => fetchTemplateGrants(workspaceId, template.id),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: docTemplateGrantsKey(workspaceId, template.id) });

  const add = useMutation({
    mutationFn: async () => {
      for (const p of picked) {
        await documentsApi.addGrant(workspaceId, template.id, {
          principalType: p.type === 'user' ? 'user' : p.type,
          principalId: p.id,
        });
      }
    },
    onSuccess: () => {
      setPicked([]);
      refresh();
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: (g: { principalType: string; principalId: string }) =>
      documentsApi.removeGrant(workspaceId, template.id, g.principalType, g.principalId),
    onSuccess: refresh,
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  return (
    <>
      <CardHeader title="Кому доступен шаблон" />
      <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
        Сотрудник увидит шаблон в «Подать заявление», только если он выдан ему лично, его отделу,
        должности или филиалу.
      </p>

      <div style={{ display: 'flex', gap: 'var(--spacing-3)', alignItems: 'flex-end', marginTop: 'var(--spacing-3)' }}>
        <EntitySelector
          types={['user', 'department', 'position', 'branch']}
          value={picked}
          onChange={setPicked}
          context={{ workspaceId }}
          placeholder="Кому выдать: сотрудник, отдел, должность или филиал"
          multi
        />
        <Button
          variant="matte"
          icon="add"
          disabled={picked.length === 0}
          loading={add.isPending}
          onClick={() => add.mutate()}
        >
          Выдать
        </Button>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-2)', marginTop: 'var(--spacing-4)' }}>
        {grantsQuery.isPending ? (
          <LoadingBlock />
        ) : grantsQuery.isError ? (
          // Сбой запроса — это НЕ «никому не выдано»: утверждать о состоянии данных,
          // которого сервер не подтверждал, значит превращать неудачу в успех.
          <Alert
            tone="danger"
            action={
              <Button variant="ghost" size="sm" icon="refresh" onClick={() => grantsQuery.refetch()}>
                Повторить
              </Button>
            }
          >
            Не удалось загрузить список доступа
          </Alert>
        ) : (grantsQuery.data ?? []).length === 0 ? (
          <span style={{ color: 'var(--text-muted)' }}>Пока никому — шаблон не появится ни у кого в списке.</span>
        ) : (
          (grantsQuery.data ?? []).map((g) => (
            <Chip
              key={`${g.principalType}:${g.principalId}`}
              size="sm"
              onRemove={() =>
                confirm({ title: 'Убрать доступ к шаблону?' }, async () => { await remove.mutateAsync(g); })
              }
              removeLabel="Убрать доступ"
            >
              {/* Подпись — ИМЯ получателя: пять одинаковых чипов «Сотрудник» не дают
                  снять доступ у нужного, и крестик жмут наугад. */}
              {PRINCIPAL_KIND[g.principalType] ?? 'Получатель'}: {g.label ?? '—'}
            </Chip>
          ))
        )}
      </div>
    </>
  );
}
