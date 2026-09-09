'use client';

// ============================================================
// Виды документов — справочник ОРГАНИЗАЦИИ (Менеджер+).
//
// Вид отвечает на четыре вопроса сразу: как нумеровать, кто видит, по каким
// правилам проверять маршрут (кадры/общие) и подшивать ли в личное дело.
// Поэтому редактируется он карточкой целиком, а не полем «переименовать».
// ============================================================

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_DOC_NUMBER_FORMAT,
  DOC_CATEGORIES,
  DOC_NUMBER_TOKENS,
  DOC_SIGNATURE_LEVELS,
  DOC_VISIBILITIES,
  formatDocNumber,
  type DocTypeDto,
} from '@superapp/shared';
import { apiErrorMessage } from '@/lib/api';
import { toastError } from '@/lib/toast';
import { docTypesKey } from '@/lib/queries';
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
  Toggle,
  useConfirm,
} from '@/components/ui';
import { documentsApi, fetchDocTypes } from './documents-api';

interface Draft {
  name: string;
  category: string;
  numberFormat: string;
  visibility: string;
  signatureLevel: string;
  toPersonalFile: boolean;
}

const EMPTY: Draft = {
  name: '',
  category: 'hr',
  numberFormat: DEFAULT_DOC_NUMBER_FORMAT,
  visibility: 'managers',
  // Кадровый вид по умолчанию требует ЭЦП: ст. 33 ТК РК не оставляет выбора,
  // а «по умолчанию без подписи» означало бы, что забыть можно молча.
  signatureLevel: 'ecp',
  toPersonalFile: false,
};

export function DocTypesTab({ workspaceId }: { workspaceId: string }) {
  const tr = useTranslations('documents');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [confirm, confirmUI] = useConfirm();
  const [editing, setEditing] = useState<DocTypeDto | null>(null);
  const [creating, setCreating] = useState(false);

  const typesQuery = useQuery({
    queryKey: docTypesKey(workspaceId),
    queryFn: () => fetchDocTypes(workspaceId),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'documents'] });

  const archive = useMutation({
    mutationFn: (typeId: string) => documentsApi.archiveType(workspaceId, typeId),
    onSuccess: refresh,
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', margin: 'var(--gap-grid) 0' }}>
        <Button variant="matte" icon="add" onClick={() => setCreating(true)}>
          {tr('types.new')}
        </Button>
      </div>

      <BentoGrid>
        {typesQuery.isPending ? (
          <Card span={12}>
            <LoadingBlock />
          </Card>
        ) : typesQuery.isError ? (
          // Сбой ≠ «пусто»: утверждение о состоянии данных, которого сервер не
          // подтверждал, читается как факт и уводит человека не туда.
          <Card span={12}>
            <EmptyState
              icon="warningCircle"
              title={tr('types.loadFailed')}
              action={
                <Button variant="matte" icon="refresh" onClick={() => typesQuery.refetch()}>
                  {tc('actions.retry')}
                </Button>
              }
            />
          </Card>
        ) : (typesQuery.data ?? []).length === 0 ? (
          <Card span={12}>
            <EmptyState
              icon="folder"
              title={tr('types.emptyTitle')}
              description={tr('types.emptyText')}
              action={
                <Button variant="matte" icon="add" onClick={() => setCreating(true)}>
                  {tr('types.createFirst')}
                </Button>
              }
            />
          </Card>
        ) : (
          (typesQuery.data ?? []).map((type) => (
            <Card key={type.id} span={6}>
              <CardHeader
                title={type.name}
                actions={
                  <div style={{ display: 'flex', gap: 'var(--spacing-2)' }}>
                    <Button variant="ghost" size="sm" icon="edit" onClick={() => setEditing(type)}>
                      {tc('actions.edit')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="archive"
                      onClick={() =>
                        confirm(
                          {
                            title: tr('types.archiveTitle', { name: type.name }),
                            message: tr('types.archiveText'),
                            confirmLabel: tr('types.archive'),
                          },
                          async () => { await archive.mutateAsync(type.id); },
                        )
                      }
                    >
                      {tr('types.archive')}
                    </Button>
                  </div>
                }
              />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-2)' }}>
                <Chip size="sm" tone="accent">
                  {tr(`category.${type.category}`)}
                </Chip>
                <Chip size="sm">{tr(`visibility.${type.visibility}`)}</Chip>
                {type.signatureLevel !== 'none' && (
                  <Chip size="sm" tone="accent" icon="signature">
                    {tr(type.signatureLevel === 'ecp' ? 'types.signEcp' : 'types.signPep')}
                  </Chip>
                )}
                {type.toPersonalFile && (
                  <Chip size="sm" icon="folder">
                    {tr('types.toPersonalFile')}
                  </Chip>
                )}
                <Chip size="sm" icon="list">
                  {tr('types.numberSample', { sample: formatDocNumber(type.numberFormat, 7, new Date()) })}
                </Chip>
              </div>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: 'var(--spacing-3)' }}>
                {tr('types.templatesCount', { count: type.templatesCount ?? 0 })}
              </p>
            </Card>
          ))
        )}
      </BentoGrid>

      <TypeModal
        workspaceId={workspaceId}
        open={creating || !!editing}
        type={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />
      {confirmUI}
    </>
  );
}

function TypeModal({
  workspaceId,
  open,
  type,
  onClose,
}: {
  workspaceId: string;
  open: boolean;
  type: DocTypeDto | null;
  onClose: () => void;
}) {
  const tr = useTranslations('documents');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  // Синхронизация формы с открытой карточкой без useEffect: рендер сам замечает,
  // что открыли другой вид (тот же приём, что у формы правки в «Сотрудниках»).
  const key = type?.id ?? 'new';
  if (open && loadedFor !== key) {
    setLoadedFor(key);
    setDraft(
      type
        ? {
            name: type.name,
            category: type.category,
            numberFormat: type.numberFormat ?? DEFAULT_DOC_NUMBER_FORMAT,
            visibility: type.visibility,
            signatureLevel: type.signatureLevel,
            toPersonalFile: type.toPersonalFile,
          }
        : EMPTY,
    );
  }
  if (!open && loadedFor !== null) setLoadedFor(null);

  const save = useMutation({
    mutationFn: () =>
      type
        ? documentsApi.updateType(workspaceId, type.id, { ...draft })
        : documentsApi.createType(workspaceId, { ...draft }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'documents'] });
      onClose();
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={tr(type ? 'types.editTitle' : 'types.newTitle')}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tc('actions.cancel')}
          </Button>
          <Button icon="check" loading={save.isPending} disabled={!draft.name.trim()} onClick={() => save.mutate()}>
            {tc('actions.save')}
          </Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
        <Input
          label={tc('labels.name')}
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder={tr('types.namePlaceholder')}
        />
        <Select
          label={tr('types.category')}
          value={draft.category}
          onChange={(v) => setDraft({ ...draft, category: v })}
          options={DOC_CATEGORIES.map((c) => ({ value: c, label: tr(`category.${c}`) }))}
          hint={tr('types.categoryHint')}
        />
        <Input
          label={tr('types.numberFormat')}
          value={draft.numberFormat}
          onChange={(e) => setDraft({ ...draft, numberFormat: e.target.value })}
          // Сами плейсхолдеры — DSL бланка и пишутся как есть; объяснение к ним — каталог
          hint={tr('types.numberFormatHint', {
            tokens: DOC_NUMBER_TOKENS.map((t) => `${t.token} — ${tr(`numberToken.${t.descKey}`)}`).join(', '),
            sample: formatDocNumber(draft.numberFormat, 7, new Date()),
          })}
        />
        <Select
          label={tr('types.visibility')}
          value={draft.visibility}
          onChange={(v) => setDraft({ ...draft, visibility: v })}
          options={DOC_VISIBILITIES.map((v) => ({ value: v, label: tr(`visibility.${v}`) }))}
          hint={tr('types.visibilityHint')}
        />
        {/* Уровень подписи задаёт ВИД, а не каждый маршрут по отдельности:
            кадровые документы по ст. 33 ТК РК требуют именно ЭЦП, и выбирать
            это руками на каждом маршруте — способ однажды забыть. Отсюда
            значение подставляется в шаг «Подписать» заготовки маршрута. */}
        <Select
          label={tr('types.signatureLevel')}
          value={draft.signatureLevel}
          onChange={(v) => setDraft({ ...draft, signatureLevel: v })}
          options={DOC_SIGNATURE_LEVELS.map((s) => ({ value: s, label: tr(`signatureLevel.${s}`) }))}
          hint={tr(`types.signatureHint.${draft.signatureLevel}`)}
        />
        <div>
          <Toggle
            label={tr('types.personalFileToggle')}
            checked={draft.toPersonalFile}
            onChange={(v) => setDraft({ ...draft, toPersonalFile: v })}
          />
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: 'var(--spacing-2)' }}>
            {tr('types.personalFileHint')}
          </p>
        </div>
      </div>
    </Modal>
  );
}
