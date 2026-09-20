'use client';

// ============================================================
// Справочник моделей оборудования — ОРГАНИЗАЦИЯ, а не объект.
//
// «Кофемашина Jura X8» заводится на лету из формы оборудования одним именем, и
// без этого экрана дальше с ней ничего сделать было нельзя: производителя,
// категорию и значок задать нечем, опечатку в названии не исправить, лишнюю
// строку не убрать. Поэтому маршрут — СОСЕДНИЙ списку объектов
// (`objects/models`, статический сегмент выигрывает у `objects/[objectId]`), а не
// вкладка внутри одного объекта: модель общая для всей сети.
//
// Права: справочник ведёт тот, кто управляет ХОТЯ БЫ ОДНИМ объектом (так же
// считает сервер) — владелец/админ или управляющий своей ветки.
// ============================================================

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ASSET_KINDS, type AssetKind, type AssetModelDto } from '@superapp/shared';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import {
  Button,
  Card,
  Chip,
  EmptyState,
  GlyphField,
  Glyph,
  Icon,
  Input,
  LoadingBlock,
  Modal,
  PageHeader,
  SearchField,
  Select,
  TableCell,
  Table,
  TableHeader,
  TableRow,
  useConfirm,
  type IconName,
  type TableColumn,
} from '@/components/ui';
import { apiErrorDetails, apiErrorMessage } from '@/lib/api';
import { toastApiError } from '@/lib/api-errors';
import { toastError } from '@/lib/toast';
import { assetModelFilesKey, assetModelsKey, objectsTreeKey } from '@/lib/queries';
import { AttachmentsSection } from '@/components/files/AttachmentsSection';
import { assetModelsApi, assetsApi, fetchAssetModels, fetchObjectTree } from '../objects-api';

const KIND_META = new Map(ASSET_KINDS.map((k) => [k.value, k]));

interface Draft {
  id: string | null;
  kind: AssetKind;
  name: string;
  manufacturer: string;
  category: string;
  glyph: string | null;
}

const EMPTY_DRAFT: Draft = { id: null, kind: 'equipment', name: '', manufacturer: '', category: '', glyph: null };

export default function AssetModelsPage() {
  const t = useTranslations('objects');
  const tc = useTranslations('common');
  const kindOptions = ASSET_KINDS.map((k) => ({ value: k.value, label: t(`assetKind.${k.value}`) }));
  const columns: TableColumn[] = [
    { key: 'name', label: t('models.one') },
    { key: 'manufacturer', label: t('models.manufacturer'), hideOnMobile: true, width: 'auto' },
    { key: 'category', label: t('models.category'), hideOnMobile: true, width: 'auto' },
    { key: 'count', label: t('models.unitsCol'), width: '90px', align: 'end' },
    { key: 'actions', label: '', width: '160px', align: 'end' },
  ];
  const { isReady } = useRequireAuth();
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const [confirm, confirmUI] = useConfirm();

  const [search, setSearch] = useState('');
  // Поиск идёт прямо в ключ запроса — без задержки каждая буква = запрос.
  const [query, setQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [filesFor, setFilesFor] = useState<AssetModelDto | null>(null);

  const { data: models, isPending } = useQuery({
    queryKey: assetModelsKey(id, query),
    queryFn: () => fetchAssetModels(id, query || undefined),
    enabled: isReady && !!id,
  });

  // Право на справочник = управление хотя бы одним объектом (контракт сервера
  // `assertAnyManage`). Владелец/админ проходит по `canCreate`.
  const { data: tree } = useQuery({
    queryKey: objectsTreeKey(id, false),
    queryFn: () => fetchObjectTree(id, false),
    enabled: isReady && !!id,
  });
  const canManage = !!tree && (tree.canCreate || tree.nodes.some((n) => n.caps.manage));

  const list = useMemo(() => (models as AssetModelDto[] | undefined) ?? [], [models]);

  // Инвалидируем ВСЕ строки поиска: правка имени меняет любую выборку.
  const invalidate = () => void qc.invalidateQueries({ queryKey: assetModelsKey(id, '').slice(0, -1) });

  const save = useMutation({
    mutationFn: async (d: Draft) => {
      const body = {
        name: d.name.trim(),
        manufacturer: d.manufacturer.trim() || null,
        category: d.category.trim() || null,
        glyph: d.glyph,
      };
      // Вид модели сервер меняет ТОЛЬКО при создании — на правке его не показываем,
      // чтобы интерфейс не обещал того, чего не произойдёт.
      return d.id
        ? assetModelsApi.update(id, d.id, body)
        : assetsApi.createModel(id, { ...body, kind: d.kind });
    },
    onSuccess: () => {
      setDraft(null);
      invalidate();
    },
    onError: (e) => toastApiError(e),
  });

  const remove = useMutation({
    mutationFn: (modelId: string) => assetsApi.removeModel(id, modelId),
    onSuccess: invalidate,
    onError: (e) =>
      toastError(apiErrorDetails(e)?.code === 'asset_model_in_use' ? t('models.inUseHint') : apiErrorMessage(e)),
  });

  if (!isReady) return null;

  return (
    <>
      <PageHeader
        breadcrumb={t('breadcrumb')}
        title={t('models.breadcrumb')}
        description={t('models.description')}
        actions={
          canManage ? (
            <Button variant="primary" icon="add" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
              {t('models.one')}
            </Button>
          ) : undefined
        }
      />

      <Card>
        <div style={{ marginBottom: 'var(--spacing-4)' }}>
          <SearchField
            placeholder={t('models.searchByName')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {isPending ? (
          <LoadingBlock />
        ) : list.length === 0 ? (
          <EmptyState
            icon="toolbox"
            title={query ? t('tree.nothingFound') : t('models.empty')}
            description={query ? t('models.nothingFoundHint') : t('models.emptyHint')}
            action={
              canManage && !query ? (
                <Button variant="primary" icon="add" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
                  {t('models.add')}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <Table columns={columns} aria-label={t('models.breadcrumb')}>
            <TableHeader columns={columns} />
            {list.map((m, i) => {
              const kind = KIND_META.get(m.kind);
              return (
                <TableRow key={m.id} columns={columns} rowIndex={i + 1}>
                  <TableCell>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 }}>
                      <span style={{ flex: 'none', color: 'var(--on-surface-variant)', display: 'inline-flex' }}>
                        {m.glyph ? (
                          <Glyph value={m.glyph} size={16} />
                        ) : (
                          <Icon name={(kind?.icon ?? 'toolbox') as IconName} size={16} />
                        )}
                      </span>
                      <span style={{ fontWeight: 600, minWidth: 0 }}>{m.name}</span>
                      {m.kind !== 'equipment' && <Chip tone="neutral">{kind ? t(`assetKind.${m.kind}`) : m.kind}</Chip>}
                    </span>
                  </TableCell>
                  <TableCell hideOnMobile>{m.manufacturer ?? '—'}</TableCell>
                  <TableCell hideOnMobile>{m.category ?? '—'}</TableCell>
                  <TableCell align="end">{m.assetsCount}</TableCell>
                  <TableCell align="end">
                    <span style={{ display: 'inline-flex', gap: '0.25rem' }}>
                      {/* Инструкция и паспорт крепятся к МОДЕЛИ один раз — на весь
                          парк одинаковых машин; читает их вся команда. */}
                      <Button
                        size="sm"
                        variant="ghost"
                        icon="docs"
                        aria-label={t('models.filesAria', { name: m.name })}
                        onClick={() => setFilesFor(m)}
                      >
                        {t('models.files')}
                      </Button>
                    {canManage && (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon="edit"
                          aria-label={t('models.editAria', { name: m.name })}
                          onClick={() =>
                            setDraft({
                              id: m.id,
                              kind: m.kind,
                              name: m.name,
                              manufacturer: m.manufacturer ?? '',
                              category: m.category ?? '',
                              glyph: m.glyph,
                            })
                          }
                        >
                          {tc('actions.edit')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          tone="danger"
                          icon="delete"
                          aria-label={t('models.deleteAria', { name: m.name })}
                          // Модель с экземплярами сервер не удалит (409): кнопку
                          // не прячем, но и не даём нажать — иначе непонятно, куда
                          // она делась у «занятых» строк.
                          disabled={m.assetsCount > 0}
                          onClick={() =>
                            confirm(
                              {
                                title: t('models.deleteTitle'),
                                message: t('models.deleteMessage', { name: m.name }),
                                confirmLabel: tc('actions.delete'),
                                danger: true,
                              },
                              () => remove.mutateAsync(m.id).then(() => undefined),
                            )
                          }
                        >
                          {tc('actions.delete')}
                        </Button>
                      </>
                    )}
                    </span>
                  </TableCell>
                </TableRow>
              );
            })}
          </Table>
        )}
      </Card>

      <Modal
        open={!!draft}
        onClose={() => setDraft(null)}
        title={draft?.id ? t('models.one') : t('models.newTitle')}
        size="md"
      >
        {draft && (
          <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
            <Input
              label={tc('labels.name')}
              placeholder="Jura X8"
              maxLength={120}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              autoFocus
            />
            <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-4)' }}>
              <Input
                label={t('models.manufacturer')}
                placeholder="Jura"
                maxLength={120}
                value={draft.manufacturer}
                onChange={(e) => setDraft({ ...draft, manufacturer: e.target.value })}
              />
              <Input
                label={t('models.category')}
                placeholder={t('models.categoryPlaceholder')}
                maxLength={80}
                value={draft.category}
                onChange={(e) => setDraft({ ...draft, category: e.target.value })}
              />
            </div>
            <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-4)' }}>
              {draft.id ? (
                <div>
                  <span className="label-sm" style={{ display: 'block', marginBottom: 'var(--spacing-2)', fontWeight: 600 }}>
                    {tc('labels.type')}
                  </span>
                  <Chip tone="neutral">{KIND_META.has(draft.kind) ? t(`assetKind.${draft.kind}`) : draft.kind}</Chip>
                </div>
              ) : (
                <Select
                  label={tc('labels.type')}
                  value={draft.kind}
                  onChange={(v) => setDraft({ ...draft, kind: v })}
                  options={kindOptions}
                />
              )}
              <GlyphField
                label={tc('glyph.field')}
                value={draft.glyph}
                onChange={(v) => setDraft({ ...draft, glyph: v })}
              />
            </div>

            <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end' }}>
              <Button variant="ghost" onClick={() => setDraft(null)}>
                {tc('actions.cancel')}
              </Button>
              <Button
                variant="primary"
                icon="save"
                loading={save.isPending}
                disabled={draft.name.trim().length === 0}
                onClick={() => save.mutate(draft)}
              >
                {tc('actions.save')}
              </Button>
            </div>
          </div>
        )}
      </Modal>
      {filesFor && (
        <ModelFilesModal
          workspaceId={id}
          model={filesFor}
          canEdit={canManage}
          onClose={() => setFilesFor(null)}
        />
      )}
      {confirmUI}
    </>
  );
}

/**
 * Документы МОДЕЛИ: инструкция, паспорт, гарантийный талон. Крепятся один раз —
 * и видны на всех экземплярах этой модели во всех объектах сети.
 */
function ModelFilesModal({
  workspaceId,
  model,
  canEdit,
  onClose,
}: {
  workspaceId: string;
  model: AssetModelDto;
  canEdit: boolean;
  onClose: () => void;
}) {
  const t = useTranslations('objects');
  const qc = useQueryClient();
  const { data: files } = useQuery({
    queryKey: assetModelFilesKey(workspaceId, model.id),
    queryFn: () => assetModelsApi.files(workspaceId, model.id),
  });
  const invalidate = () =>
    void qc.invalidateQueries({ queryKey: assetModelFilesKey(workspaceId, model.id) });
  const attach = useMutation({
    mutationFn: (fileId: string) => assetModelsApi.attachFile(workspaceId, model.id, fileId),
    onSuccess: invalidate,
    onError: (e) => toastApiError(e),
  });
  const detach = useMutation({
    mutationFn: (fileId: string) => assetModelsApi.detachFile(workspaceId, model.id, fileId),
    onSuccess: invalidate,
    onError: (e) => toastApiError(e),
  });

  return (
    <Modal open onClose={onClose} title={`${t('models.files')} — ${model.name}`} size="lg">
      <AttachmentsSection
        files={files ?? []}
        canEdit={canEdit}
        profile="document"
        imageProfile="asset_photo"
        onAttach={(f) => attach.mutate(f.id)}
        onRemove={(fileId) => detach.mutate(fileId)}
      />
    </Modal>
  );
}
