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
  TableHeader,
  TableRow,
  useConfirm,
  type IconName,
  type TableColumn,
} from '@/components/ui';
import { apiErrorDetails, apiErrorMessage } from '@/lib/api';
import { toastError } from '@/lib/toast';
import { assetModelFilesKey, assetModelsKey, objectsTreeKey } from '@/lib/queries';
import { AttachmentsSection } from '@/components/files/AttachmentsSection';
import { assetModelsApi, assetsApi, fetchAssetModels, fetchObjectTree } from '../objects-api';

const KIND_META = new Map(ASSET_KINDS.map((k) => [k.value, k]));
const KIND_OPTIONS = ASSET_KINDS.map((k) => ({ value: k.value, label: k.label }));

const COLUMNS: TableColumn[] = [
  { key: 'name', label: 'Модель' },
  { key: 'manufacturer', label: 'Производитель', hideOnMobile: true, width: 'auto' },
  { key: 'category', label: 'Категория', hideOnMobile: true, width: 'auto' },
  { key: 'count', label: 'Единиц', width: '90px', align: 'end' },
  { key: 'actions', label: '', width: '160px', align: 'end' },
];

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
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: (modelId: string) => assetsApi.removeModel(id, modelId),
    onSuccess: invalidate,
    onError: (e) =>
      toastError(
        apiErrorDetails(e)?.code === 'asset_model_in_use'
          ? 'Модель используется: по ней заведено оборудование. Спишите или перенесите единицы, потом удаляйте модель.'
          : apiErrorMessage(e),
      ),
  });

  if (!isReady) return null;

  return (
    <>
      <PageHeader
        breadcrumb="Объекты"
        title="Модели оборудования"
        description="Общий справочник сети: производитель, категория и значок задаются один раз — все экземпляры показывают их сами."
        actions={
          canManage ? (
            <Button variant="primary" icon="add" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
              Модель
            </Button>
          ) : undefined
        }
      />

      <Card>
        <div style={{ marginBottom: 'var(--spacing-4)' }}>
          <SearchField
            placeholder="Название модели…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {isPending ? (
          <LoadingBlock />
        ) : list.length === 0 ? (
          <EmptyState
            icon="toolbox"
            title={query ? 'Ничего не нашлось' : 'Моделей пока нет'}
            description={
              query
                ? 'Попробуйте другое слово — поиск идёт по названию модели.'
                : 'Модель появляется сама, когда её впервые указывают в карточке оборудования. Здесь её можно дополнить и переименовать.'
            }
            action={
              canManage && !query ? (
                <Button variant="primary" icon="add" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
                  Добавить модель
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div role="table" aria-label="Модели оборудования">
            <TableHeader columns={COLUMNS} />
            {list.map((m, i) => {
              const kind = KIND_META.get(m.kind);
              return (
                <TableRow key={m.id} columns={COLUMNS} rowIndex={i + 1}>
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
                      {m.kind !== 'equipment' && <Chip tone="neutral">{kind?.label ?? m.kind}</Chip>}
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
                        aria-label={`Документы модели «${m.name}»`}
                        onClick={() => setFilesFor(m)}
                      >
                        Документы
                      </Button>
                    {canManage && (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon="edit"
                          aria-label={`Изменить модель «${m.name}»`}
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
                          Править
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          tone="danger"
                          icon="delete"
                          aria-label={`Удалить модель «${m.name}»`}
                          // Модель с экземплярами сервер не удалит (409): кнопку
                          // не прячем, но и не даём нажать — иначе непонятно, куда
                          // она делась у «занятых» строк.
                          disabled={m.assetsCount > 0}
                          onClick={() =>
                            confirm(
                              {
                                title: 'Удалить модель?',
                                message: `«${m.name}» исчезнет из справочника. Экземпляров по ней нет, поэтому история не пострадает.`,
                                confirmLabel: 'Удалить',
                                danger: true,
                              },
                              () => remove.mutateAsync(m.id).then(() => undefined),
                            )
                          }
                        >
                          Удалить
                        </Button>
                      </>
                    )}
                    </span>
                  </TableCell>
                </TableRow>
              );
            })}
          </div>
        )}
      </Card>

      <Modal
        open={!!draft}
        onClose={() => setDraft(null)}
        title={draft?.id ? 'Модель' : 'Новая модель'}
        size="md"
      >
        {draft && (
          <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
            <Input
              label="Название"
              placeholder="Jura X8"
              maxLength={120}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              autoFocus
            />
            <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-4)' }}>
              <Input
                label="Производитель"
                placeholder="Jura"
                maxLength={120}
                value={draft.manufacturer}
                onChange={(e) => setDraft({ ...draft, manufacturer: e.target.value })}
              />
              <Input
                label="Категория"
                placeholder="Кофейное оборудование"
                maxLength={80}
                value={draft.category}
                onChange={(e) => setDraft({ ...draft, category: e.target.value })}
              />
            </div>
            <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-4)' }}>
              {draft.id ? (
                <div>
                  <span className="label-sm" style={{ display: 'block', marginBottom: 'var(--spacing-2)', fontWeight: 600 }}>
                    Вид
                  </span>
                  <Chip tone="neutral">{KIND_META.get(draft.kind)?.label ?? draft.kind}</Chip>
                </div>
              ) : (
                <Select
                  label="Вид"
                  value={draft.kind}
                  onChange={(v) => setDraft({ ...draft, kind: v })}
                  options={KIND_OPTIONS}
                />
              )}
              <GlyphField
                label="Значок"
                value={draft.glyph}
                onChange={(v) => setDraft({ ...draft, glyph: v })}
              />
            </div>

            <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end' }}>
              <Button variant="ghost" onClick={() => setDraft(null)}>
                Отмена
              </Button>
              <Button
                variant="primary"
                icon="save"
                loading={save.isPending}
                disabled={draft.name.trim().length === 0}
                onClick={() => save.mutate(draft)}
              >
                Сохранить
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
    onError: (e) => toastError(apiErrorMessage(e)),
  });
  const detach = useMutation({
    mutationFn: (fileId: string) => assetModelsApi.detachFile(workspaceId, model.id, fileId),
    onSuccess: invalidate,
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  return (
    <Modal open onClose={onClose} title={`Документы — ${model.name}`} size="lg">
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
