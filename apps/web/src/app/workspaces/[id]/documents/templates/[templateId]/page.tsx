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
import { useTranslations } from 'next-intl';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DOC_FIELD_KINDS,
  LOCALE_DISPLAY_ORDER,
  LOCALE_NAMES,
  TEMPLATE_FORMATTERS,
  type Locale,
  emptyBuilderDoc,
  type BuilderDoc,
  type DocFormFieldDto,
  type DocTemplateDto,
  type ProcessDefinitionDto,
} from '@superapp/shared';
import { apiPost } from '@/lib/api';
import { toastApiError } from '@/lib/api-errors';
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

/** Вид получателя доступа — слово даёт общий словарь адресатов */
const PRINCIPAL_KIND: Record<string, string> = {
  user: 'audience.kind.user',
  department: 'audience.kind.department',
  position: 'audience.kind.position',
  branch: 'audience.kind.branch',
};

export default function TemplateConstructorPage() {
  const tr = useTranslations('documents');
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
      toast(tr('template.published'), 'success');
    },
    onError: (e) => toastApiError(e),
  });

  /**
   * «Маршрут» — связка с Процессами. Не «перейди в Процессы и разберись»: заводим
   * процесс кадрового профиля с уже собранной схемой, где ЭТОТ шаблон проставлен в
   * триггере. Маршрут уже есть — открываем его, а не плодим второй (публикация всё
   * равно не пропустит два живых маршрута на один шаблон).
   */
  const openRoute = useMutation({
    mutationFn: async () => {
      if (!template) throw new Error(tr('template.notLoaded'));
      const existing = await findRouteDefinitionId(id, template.id);
      if (existing) return existing;
      const res = await apiPost<ProcessDefinitionDto>(`/workspaces/${id}/processes`, {
        name: tr('template.routeName', { name: template.name }),
        description: tr('template.routeDescription', { name: template.name }),
        surface: surfaceOfCategory(template.category),
        // Уровень подписи берём из ВИДА документа: кадровый маршрут обязан
        // требовать ЭЦП (ст. 33 ТК РК), и выбирать это руками — способ забыть.
        document: buildRouteBlueprint(
          template.id,
          {
            trigger: tr('routeBlueprint.trigger'),
            sign: tr('routeBlueprint.sign'),
            signTitle: tr('routeBlueprint.signTitle', { name: template.name }),
            ack: tr('routeBlueprint.ack'),
            ackTitle: tr('routeBlueprint.ackTitle', { name: template.name }),
            register: tr('routeBlueprint.register'),
            file: tr('routeBlueprint.file'),
            done: tr('routeBlueprint.done'),
            refused: tr('routeBlueprint.refused'),
          },
          template.signatureLevel,
        ),
      });
      return res.id;
    },
    onSuccess: (defId) => {
      qc.invalidateQueries({ queryKey: ['workspaces', id, 'documents'] });
      router.push(`/workspaces/${id}/processes/${defId}`);
    },
    onError: (e) => toastApiError(e),
  });

  const uploadBlank = useMutation({
    mutationFn: async (file: File) => {
      const uploaded = await uploadFile(file, 'document', { ownerWorkspaceId: id });
      // Бланк живёт как обычный документ core/docs — заменить его целиком нельзя,
      // поэтому новый бланк = новый шаблон. Здесь только ПЕРВАЯ загрузка.
      return documentsApi.updateTemplate(id, templateId, { fileId: uploaded.id });
    },
    onSuccess: refresh,
    onError: (e) => toastApiError(e),
  });

  if (templatesQuery.isPending) return <LoadingBlock />;

  if (templatesQuery.isError || !template) {
    return (
      <>
        <PageHeader breadcrumb={tr('page.title')} title={tr('template.failedTitle')} />
        <BentoGrid>
          <Card span={12}>
            <EmptyState
              icon="blocked"
              title={tr('template.noAccessTitle')}
              description={tr('template.noAccessText')}
              action={
                <Button variant="matte" icon="arrowLeft" href={`/workspaces/${id}/documents`}>
                  {tr('template.toDocuments')}
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
        breadcrumb={`${tr('page.title')} · ${template.docTypeName}`}
        title={template.name}
        chip={
          <Chip size="sm" tone={template.status === 'published' ? 'success' : 'neutral'}>
            {tr(template.status === 'published' ? 'templates.published' : 'templates.draft')}
          </Chip>
        }
        actions={
          <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
            <Button variant="ghost" icon="arrowLeft" href={`/workspaces/${id}/documents`}>
              {tr('template.toDocuments')}
            </Button>
            {template.documentId && (
              <Button
                variant="matte"
                icon="edit"
                href={documentHref(template.documentId, { refType: 'document', refId: template.documentId })}
              >
                {tr('template.openForm')}
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
                {tr(template.hasRoute ? 'template.openRoute' : 'template.createRoute')}
              </Button>
            )}
            {template.status !== 'published' && (
              <Button icon="check" loading={publish.isPending} onClick={() => publish.mutate()}>
                {tr('templates.publish')}
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
              formHint={tr('template.formHint')}
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
          <CardHeader title={tr('template.formCard')} />
          {template.fileId ? (
            <>
              <p style={{ color: 'var(--text-muted)' }}>{tr('template.formUploaded')}</p>
              {!template.hasRoute && (
                <p style={{ color: 'var(--text-muted)', marginTop: 'var(--spacing-3)' }}>
                  {tr('template.noRouteHint')}
                </p>
              )}
            </>
          ) : (
            <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
              <p style={{ color: 'var(--text-muted)' }}>{tr('template.uploadHint')}</p>
              <Input
                label={tr('template.fileLabel')}
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
          <CardHeader title={tr('template.whatToInsert')} />
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{tr('template.whatToInsertHint')}</p>
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
                        onClick={() => copyTag(`{${group.tagPrefix}.${f.key}}`, tr)}
                        // Подпись идёт ПЕРВОЙ: у чипа-кнопки title становится доступным
                        // именем, и «Пример: Ахметов Аскар» вместо «Фамилия и имя»
                        // читается вслух вместо названия поля.
                        title={f.example ? tr('builder.fieldExample', { label: f.label, example: f.example }) : f.label}
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
                  <div style={{ fontWeight: 600, marginBottom: 'var(--spacing-2)' }}>{tr('template.ownFields')}</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-2)' }}>
                    {template.fields.map((f) => (
                      <Chip key={f.key} size="sm" tone="accent" onClick={() => copyTag(`{${f.key}}`, tr)}>
                        {f.label}
                      </Chip>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <div style={{ fontWeight: 600, marginBottom: 'var(--spacing-2)' }}>{tr('template.formats')}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
                  {TEMPLATE_FORMATTERS.map((f) => (
                    <div key={f} style={{ fontSize: '0.85rem' }}>
                      <code>{`{${tr('template.fieldWord')}|${f}}`}</code>{' '}
                      <span style={{ color: 'var(--text-muted)' }}>— {tr(`formatter.${f}.hint`)}</span>
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

/**
 * Копирование тега — с честным отказом, если буфер закрыт политикой браузера.
 * Слова приходят параметром: функция не React-компонент, каталога у неё нет.
 */
async function copyTag(tag: string, tr: (key: string, values?: Record<string, string>) => string) {
  try {
    await navigator.clipboard.writeText(tag);
    toast(tr('template.copied', { tag }), 'success');
  } catch {
    toastError(tr('template.copyFailed', { tag }));
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
  const tr = useTranslations('documents');
  const tc = useTranslations('common');
  const [fields, setFields] = useState<DocFormFieldDto[] | null>(null);
  const list = fields ?? template.fields;
  const [selfService, setSelfService] = useState<boolean | null>(null);
  const selfServiceValue = selfService ?? template.selfService;
  // ЯЗЫК БЛАНКА — язык самой бумаги. Сменить его можно всегда: у уже поданных
  // документов свой снимок языка, и они не перерисовываются задним числом.
  const [language, setLanguage] = useState<Locale | null>(null);
  const languageValue = language ?? template.language;

  const save = useMutation({
    mutationFn: () =>
      documentsApi.updateTemplate(workspaceId, template.id, {
        fields: list,
        selfService: selfServiceValue,
        language: languageValue,
      }),
    onSuccess: () => {
      setFields(null);
      setSelfService(null);
      setLanguage(null);
      onSaved();
      toast(tr('template.formSaved'), 'success');
    },
    onError: (e) => toastApiError(e),
  });

  const update = (i: number, patch: Partial<DocFormFieldDto>) =>
    setFields(list.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));

  return (
    <div>
      <CardHeader title={tr('template.fieldsCard')} />
      <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{tr('template.fieldsHint')}</p>

      <div style={{ display: 'grid', gap: 'var(--spacing-3)', marginTop: 'var(--spacing-3)' }}>
        {list.map((f, i) => (
          <div
            key={i}
            style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'flex-end', flexWrap: 'wrap' }}
          >
            <Input
              label={tr('template.fieldKey')}
              value={f.key}
              onChange={(e) => update(i, { key: e.target.value })}
              wrapClassName="ui-grow"
            />
            <Input label={tr('template.fieldLabel')} value={f.label} onChange={(e) => update(i, { label: e.target.value })} />
            <Select
              label={tc('labels.type')}
              value={f.kind}
              onChange={(v) => update(i, { kind: v as DocFormFieldDto['kind'] })}
              options={DOC_FIELD_KINDS.map((k) => ({ value: k, label: tr(`fieldKind.${k}`) }))}
              width={160}
            />
            <Button
              variant="ghost"
              size="sm"
              icon="delete"
              onClick={() => setFields(list.filter((_, idx) => idx !== i))}
            >
              {tc('actions.remove')}
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
          {tr('template.addField')}
        </Button>
        <Toggle
          label={tr('template.selfService')}
          checked={selfServiceValue}
          onChange={(v) => setSelfService(v)}
        />
        <Select
          label={tr('template.language')}
          value={languageValue}
          onChange={(v) => setLanguage(v as Locale)}
          options={LOCALE_DISPLAY_ORDER.map((l) => ({ value: l, label: LOCALE_NAMES[l] }))}
          width={200}
          hint={tr('template.languageHint')}
        />
        <Button
          variant="matte"
          icon="check"
          loading={save.isPending}
          disabled={fields === null && selfService === null && language === null}
          onClick={() => save.mutate()}
        >
          {tr('template.saveForm')}
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
  const tr = useTranslations('documents');
  const tc = useTranslations('common');
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
    onError: (e) => toastApiError(e),
  });

  const remove = useMutation({
    mutationFn: (g: { principalType: string; principalId: string }) =>
      documentsApi.removeGrant(workspaceId, template.id, g.principalType, g.principalId),
    onSuccess: refresh,
    onError: (e) => toastApiError(e),
  });

  return (
    <>
      <CardHeader title={tr('template.grantsCard')} />
      <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{tr('template.grantsHint')}</p>

      <div style={{ display: 'flex', gap: 'var(--spacing-3)', alignItems: 'flex-end', marginTop: 'var(--spacing-3)' }}>
        <EntitySelector
          types={['user', 'department', 'position', 'branch']}
          value={picked}
          onChange={setPicked}
          context={{ workspaceId }}
          placeholder={tr('template.grantsPlaceholder')}
          multi
        />
        <Button
          variant="matte"
          icon="add"
          disabled={picked.length === 0}
          loading={add.isPending}
          onClick={() => add.mutate()}
        >
          {tr('template.grant')}
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
                {tc('actions.retry')}
              </Button>
            }
          >
            {tr('template.grantsFailed')}
          </Alert>
        ) : (grantsQuery.data ?? []).length === 0 ? (
          <span style={{ color: 'var(--text-muted)' }}>{tr('template.grantsEmpty')}</span>
        ) : (
          (grantsQuery.data ?? []).map((g) => (
            <Chip
              key={`${g.principalType}:${g.principalId}`}
              size="sm"
              onRemove={() =>
                confirm({ title: tr('template.grantRemoveConfirm') }, async () => { await remove.mutateAsync(g); })
              }
              removeLabel={tr('template.grantRemove')}
            >
              {/* Подпись — ИМЯ получателя: пять одинаковых чипов «Сотрудник» не дают
                  снять доступ у нужного, и крестик жмут наугад. */}
              {tc(PRINCIPAL_KIND[g.principalType] ?? 'labels.item')}: {g.label ?? tc('labels.dash')}
            </Chip>
          ))
        )}
      </div>
    </>
  );
}
