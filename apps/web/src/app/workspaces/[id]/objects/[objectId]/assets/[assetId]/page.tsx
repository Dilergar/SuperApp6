'use client';

// ============================================================
// Карточка оборудования: Данные / Документы / Перемещения / Обслуживание /
// Хроника. Деньги (цена, баланс, стоимость ремонтов) рисуются по `caps.payrollView`
// из ответа — сервер таких полей без права не отдаёт вовсе.
// ============================================================

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ASSET_SERVICE_KINDS,
  ASSET_STATUSES,
  HOLDING_KINDS,
  type AssetCardDto,
  type ChatterPageDto,
  type FileDto,
} from '@superapp/shared';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import {
  Button,
  Card,
  CardHeader,
  Chip,
  EmptyState,
  Input,
  LoadingBlock,
  PageHeader,
  Select,
  Tabs,
  Textarea,
  useConfirm,
  type TabItem,
} from '@/components/ui';
import { PersonChip } from '@/app/circles/PersonCard';
import { AttachmentsSection } from '@/components/files/AttachmentsSection';
import { ChronicleFeed } from '@/components/chatter/ChronicleFeed';
import { EntitySelector } from '@/components/EntitySelector';
import { apiDelete, apiErrorMessage, apiGet, apiPost } from '@/lib/api';
import { toastError } from '@/lib/toast';
import { assetChatterKey, assetFilesKey, assetKey, objectAssetsKey } from '@/lib/queries';
import { assetsApi, fetchAssetCard } from '../../../objects-api';

type TabKey = 'data' | 'files' | 'moves' | 'service' | 'history';

const STATUS_META = new Map(ASSET_STATUSES.map((s) => [s.value, s]));
const HOLDING_LABEL = new Map(HOLDING_KINDS.map((h) => [h.value, h.label]));
const SERVICE_LABEL = new Map(ASSET_SERVICE_KINDS.map((k) => [k.value, k.label]));

/**
 * Списание уводит актив из ЖИВЫХ списков (сервер ставит `archivedAt`), поэтому оно
 * не может быть строкой выпадашки рядом с «В ремонте»: промах мышью прятал технику
 * без единого вопроса. Эти два статуса — отдельное действие с подтверждением.
 */
const RETIRE_STATUSES = ['written_off', 'disposed'] as const;
const LIVE_STATUSES = ASSET_STATUSES.filter(
  (s) => !(RETIRE_STATUSES as readonly string[]).includes(s.value),
);

function money(v: string | null | undefined, currency = 'KZT'): string {
  if (!v) return '—';
  return `${(Number(v) / 100).toLocaleString('ru-RU')} ${currency === 'KZT' ? '₸' : currency}`;
}

export default function AssetCardPage() {
  const { isReady } = useRequireAuth();
  const { id, objectId, assetId } = useParams<{ id: string; objectId: string; assetId: string }>();
  const qc = useQueryClient();
  const [confirm, confirmUI] = useConfirm();
  const [tab, setTab] = useState<TabKey>('data');

  const { data, isPending, error } = useQuery({
    queryKey: assetKey(id, assetId),
    queryFn: () => fetchAssetCard(id, assetId),
    enabled: isReady && !!assetId,
  });

  const { data: files } = useQuery({
    queryKey: assetFilesKey(id, assetId),
    queryFn: () => apiGet<FileDto[]>(`/workspaces/${id}/assets/${assetId}/files`),
    enabled: isReady && !!assetId,
  });

  // Хроника оборудования: движения, ответственный, владение, ремонты.
  const { data: chatter, isPending: chatterPending } = useQuery({
    queryKey: assetChatterKey(id, assetId),
    queryFn: () => apiGet<ChatterPageDto>(`/chatter/asset/${assetId}`, { params: { limit: 50 } }),
    enabled: isReady && !!assetId && tab === 'history',
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: assetKey(id, assetId) });
    // Префикс ленты объекта (все фильтры) — из общего ключа, без литерала.
    void qc.invalidateQueries({ queryKey: objectAssetsKey(id, objectId, '').slice(0, -1) });
    void qc.invalidateQueries({ queryKey: assetChatterKey(id, assetId) });
  };
  const invalidateFiles = () => void qc.invalidateQueries({ queryKey: assetFilesKey(id, assetId) });

  const saveFields = useMutation({
    mutationFn: (body: Record<string, unknown>) => assetsApi.update(id, assetId, body),
    onSuccess: invalidate,
    onError: (e) => toastError(apiErrorMessage(e)),
  });
  const setHolding = useMutation({
    mutationFn: (holdingKind: string) => assetsApi.setHolding(id, assetId, { holdingKind }),
    onSuccess: invalidate,
    onError: (e) => toastError(apiErrorMessage(e)),
  });
  const closeService = useMutation({
    mutationFn: (recId: string) =>
      assetsApi.updateService(id, assetId, recId, { status: 'done', finishedAt: new Date().toISOString() }),
    onSuccess: invalidate,
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const setStatus = useMutation({
    mutationFn: (status: string) => assetsApi.setStatus(id, assetId, { status }),
    onSuccess: invalidate,
    onError: (e) => toastError(apiErrorMessage(e)),
  });
  const setCustodian = useMutation({
    mutationFn: (custodianUserId: string | null) => assetsApi.setCustodian(id, assetId, { custodianUserId }),
    onSuccess: invalidate,
    onError: (e) => toastError(apiErrorMessage(e)),
  });
  const moveAsset = useMutation({
    mutationFn: (branchId: string) => assetsApi.move(id, assetId, { branchId }),
    onSuccess: invalidate,
    onError: (e) => toastError(apiErrorMessage(e)),
  });
  const attach = useMutation({
    mutationFn: (fileId: string) => apiPost(`/workspaces/${id}/assets/${assetId}/files`, { fileId }),
    onSuccess: () => {
      invalidateFiles();
      invalidate();
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });
  const detach = useMutation({
    mutationFn: (fileId: string) => apiDelete(`/workspaces/${id}/assets/${assetId}/files/${fileId}`),
    onSuccess: () => {
      invalidateFiles();
      invalidate();
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  if (!isReady) return null;
  if (isPending) return <LoadingBlock />;
  // Без карточки страница показывала пустоту — человек не понимал, списан актив,
  // закрыт правами или отвалилась сеть.
  if (!data) {
    return (
      <Card>
        <EmptyState
          icon="blocked"
          title="Оборудование не открылось"
          description={
            error
              ? apiErrorMessage(error)
              : 'Единица удалена или у вас нет доступа к её объекту.'
          }
          action={
            <Button variant="primary" icon="arrowLeft" href={`/workspaces/${id}/objects/${objectId}/assets`}>
              К оборудованию объекта
            </Button>
          }
        />
      </Card>
    );
  }

  const card = data as AssetCardDto;
  const a = card.asset;
  const caps = card.caps;
  const meta = STATUS_META.get(a.status);
  const retired = (RETIRE_STATUSES as readonly string[]).includes(a.status);

  const tabs: TabItem<TabKey>[] = [
    { key: 'data', label: 'Данные', icon: 'file' },
    { key: 'files', label: 'Документы', icon: 'docs', count: files?.length },
    { key: 'moves', label: 'Перемещения', icon: 'truck', count: card.moves.length },
    { key: 'service', label: 'Обслуживание', icon: 'wrench', count: card.services.length },
    { key: 'history', label: 'Хроника', icon: 'journal' },
  ];

  return (
    <>
      <PageHeader
        breadcrumb={a.branchName}
        title={a.name}
        chip={<Chip tone={(meta?.tone ?? 'neutral') as 'success' | 'warning' | 'neutral'}>{meta?.label ?? a.status}</Chip>}
        description={[a.modelName, a.inventoryNumber ? `инв. ${a.inventoryNumber}` : null].filter(Boolean).join(' · ')}
        actions={
          caps.manage ? (
            <>
              <Select
                aria-label="Состояние"
                value={a.status}
                onChange={(v) => setStatus.mutate(v)}
                options={
                  retired
                    ? ASSET_STATUSES.map((s) => ({ value: s.value, label: s.label }))
                    : LIVE_STATUSES.map((s) => ({ value: s.value, label: s.label }))
                }
              />
              {!retired && (
                <Button
                  size="sm"
                  variant="ghost"
                  tone="danger"
                  icon="archive"
                  loading={setStatus.isPending}
                  onClick={() =>
                    confirm(
                      {
                        title: 'Списать оборудование?',
                        message: `«${a.name}» уйдёт из живых списков объекта: карточка, журналы и расходы сохранятся, но в перечне оборудования единица больше не появится. Инвентарный номер освободится.`,
                        confirmLabel: 'Списать',
                        danger: true,
                      },
                      () => setStatus.mutateAsync('written_off').then(() => undefined),
                    )
                  }
                >
                  Списать
                </Button>
              )}
            </>
          ) : undefined
        }
      />

      <div style={{ marginBottom: 'var(--spacing-6)' }}>
        <Tabs items={tabs} value={tab} onChange={setTab} aria-label="Разделы оборудования" />
      </div>

      {tab === 'data' && (
        <Card>
          <CardHeader title="Данные" />
          <div className="ui-stack" style={{ gap: 'var(--spacing-3)' }}>
            <Row label="Модель" value={[a.modelName, a.manufacturer].filter(Boolean).join(' · ')} />
            <Row label="Серийный номер" value={a.serialNumber ?? '—'} />
            <Row label="Объект" value={a.branchName} />
            <Row label="Где именно" value={a.locationNote ?? '—'} />
            <div style={{ display: 'flex', gap: 'var(--spacing-3)', alignItems: 'center', fontSize: '0.85rem' }}>
              <span style={{ color: 'var(--on-surface-variant)', minWidth: 190 }}>Ответственный</span>
              {a.custodianUserId && a.custodianName ? (
                <PersonChip size="S" userId={a.custodianUserId} firstName={a.custodianName} />
              ) : (
                <span style={{ fontWeight: 500 }}>—</span>
              )}
            </div>
            <Row label="В составе" value={a.parentAssetName ?? '—'} />
            <Row label="Куплено" value={a.purchasedOn ?? '—'} />
            <Row label="Введено в работу" value={a.commissionedOn ?? '—'} />
            <Row label="Гарантия до" value={a.warrantyUntil ?? '—'} />
            {caps.payrollView && (
              <>
                <div style={{ display: 'flex', gap: 'var(--spacing-3)', alignItems: 'center', fontSize: '0.85rem' }}>
                  <span style={{ color: 'var(--on-surface-variant)', minWidth: 190 }}>Владение</span>
                  {caps.manage ? (
                    <Select
                      value={a.holdingKind ?? 'owned'}
                      onChange={(v) => setHolding.mutate(v)}
                      options={HOLDING_KINDS.map((h) => ({ value: h.value, label: h.label }))}
                    />
                  ) : (
                    <span style={{ fontWeight: 500 }}>{HOLDING_LABEL.get(a.holdingKind ?? 'owned') ?? '—'}</span>
                  )}
                </div>
                <Row label="На балансе" value={a.balanceLegalEntityName ?? '—'} />
                <Row label="Владелец/арендодатель" value={a.holdingCounterpartyName ?? '—'} />
                <Row label="Цена покупки" value={money(a.purchasePrice, a.currency)} />
                {/* TCO считает СЕРВЕР (`serviceCost`): клиентская сумма врала, как
                    только журнал не помещался в отданную страницу. */}
                <Row label="Расходы на обслуживание" value={money(a.serviceCost, a.currency)} />
              </>
            )}
            {a.note && <Row label="Заметка" value={a.note} />}
          </div>

          {caps.manage && (
            <div className="ui-stack" style={{ gap: 'var(--spacing-3)', marginTop: 'var(--spacing-6)' }}>
              <div className="grid md:grid-cols-3" style={{ gap: 'var(--spacing-3)' }}>
                <Input
                  label="Название"
                  defaultValue={a.name}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== a.name) saveFields.mutate({ name: v });
                  }}
                />
                <Input
                  label="Инвентарный номер"
                  defaultValue={a.inventoryNumber ?? ''}
                  onBlur={(e) => {
                    const v = e.target.value.trim() || null;
                    if (v !== a.inventoryNumber) saveFields.mutate({ inventoryNumber: v });
                  }}
                />
                <Input
                  label="Серийный номер"
                  defaultValue={a.serialNumber ?? ''}
                  onBlur={(e) => {
                    const v = e.target.value.trim() || null;
                    if (v !== a.serialNumber) saveFields.mutate({ serialNumber: v });
                  }}
                />
              </div>
              <span className="label-sm" style={{ fontWeight: 600 }}>Ответственный</span>
              <EntitySelector
                types={['user']}
                context={{ workspaceId: id }}
                value={a.custodianUserId ? [{ type: 'user', id: a.custodianUserId }] : []}
                onChange={(next) => setCustodian.mutate(next[next.length - 1]?.id ?? null)}
                placeholder="Не назначен"
              />
              <span className="label-sm" style={{ fontWeight: 600 }}>Переместить в объект</span>
              <EntitySelector
                types={['branch']}
                context={{ workspaceId: id }}
                value={[{ type: 'branch', id: a.branchId }]}
                onChange={(next) => {
                  const target = next[next.length - 1]?.id;
                  if (target && target !== a.branchId) moveAsset.mutate(target);
                }}
                placeholder="Объект"
              />
            </div>
          )}
        </Card>
      )}

      {tab === 'files' && (
        <Card>
          <CardHeader title="Фото и документы" subtitle="Фото единицы, паспорт, чеки ремонтов" />
          {/* Два профиля: `asset_photo` принимает ТОЛЬКО картинки, `document` — только
              документы. Оба разрешены движком для типа `asset`, поэтому карточка
              берёт и фото, и PDF-паспорт. */}
          <AttachmentsSection
            files={files ?? []}
            canEdit={caps.manage}
            profile="document"
            imageProfile="asset_photo"
            onAttach={(f) => attach.mutate(f.id)}
            onRemove={(fileId) => detach.mutate(fileId)}
          />
        </Card>
      )}

      {tab === 'moves' && (
        <Card>
          <CardHeader title="Перемещения" subtitle="Журнал: место, ответственный, владение, состояние" />
          {card.moves.length === 0 ? (
            <EmptyState icon="truck" title="Движений не было" />
          ) : (
            <div className="ui-stack" style={{ gap: 'var(--spacing-2)' }}>
              {card.moves.map((m) => (
                <div key={m.id} style={{ display: 'flex', gap: 'var(--spacing-3)', flexWrap: 'wrap', alignItems: 'center' }}>
                  <Chip tone="neutral">{MOVE_LABEL[m.kind] ?? m.kind}</Chip>
                  <span className="label-sm">
                    {[m.fromLabel ?? '—', m.toLabel ?? '—'].join(' → ')}
                  </span>
                  <span className="label-sm" style={{ opacity: 0.6 }}>
                    {new Date(m.movedAt).toLocaleString('ru-RU')} · {m.movedByName ?? ''}
                  </span>
                  {m.reason && <span className="label-sm" style={{ opacity: 0.7 }}>{m.reason}</span>}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {tab === 'service' && (
        <ServiceTab
          workspaceId={id}
          assetId={assetId}
          card={card}
          onSaved={invalidate}
          onClose={(recId) => closeService.mutate(recId)}
        />
      )}

      {tab === 'history' && (
        <Card>
          <CardHeader title="Хроника" subtitle="Перемещения, ответственный, владение, состояние и ремонты" />
          {chatterPending ? (
            <LoadingBlock />
          ) : (
            <ChronicleFeed
              entries={chatter?.items ?? []}
              actors={chatter?.actors ?? {}}
              emptyText="Пока пусто — события единицы появятся здесь"
            />
          )}
        </Card>
      )}
      {confirmUI}
    </>
  );
}

const MOVE_LABEL: Record<string, string> = {
  placement: 'Место',
  custodian: 'Ответственный',
  holding: 'Владение',
  status: 'Состояние',
};

function ServiceTab({
  workspaceId,
  assetId,
  card,
  onSaved,
  onClose,
}: {
  workspaceId: string;
  assetId: string;
  card: AssetCardDto;
  onSaved: () => void;
  /** Отметить запланированную работу выполненной */
  onClose: (recordId: string) => void;
}) {
  const [kind, setKind] = useState('repair');
  const [title, setTitle] = useState('');
  const [cost, setCost] = useState('');
  const [description, setDescription] = useState('');

  const log = useMutation({
    mutationFn: async () => {
      const clean = cost.replace(/\s/g, '').replace(',', '.');
      const tiyn = clean ? String(Math.round(Number(clean) * 100)) : null;
      if (clean && !Number.isFinite(Number(clean))) throw new Error('Стоимость — это число');
      return assetsApi.logService(workspaceId, assetId, {
        kind,
        title: title.trim(),
        description: description.trim() || null,
        ...(tiyn ? { cost: tiyn } : {}),
      });
    },
    onSuccess: () => {
      setTitle('');
      setCost('');
      setDescription('');
      onSaved();
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  return (
    <Card>
      <CardHeader title="Обслуживание" subtitle="Ремонты и осмотры; сумма расходов — на вкладке «Данные»" />
      {card.services.length === 0 ? (
        <EmptyState icon="wrench" title="Записей нет" description="Запишите ремонт или плановое обслуживание." />
      ) : (
        <div className="ui-stack" style={{ gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-4)' }}>
          {card.services.map((r) => (
            <div key={r.id} style={{ display: 'flex', gap: 'var(--spacing-3)', flexWrap: 'wrap', alignItems: 'center' }}>
              <Chip tone="neutral">{SERVICE_LABEL.get(r.kind) ?? r.kind}</Chip>
              <span style={{ fontWeight: 600 }}>{r.title}</span>
              {card.caps.payrollView && r.cost && <span className="label-sm">{money(r.cost, r.currency)}</span>}
              <span className="label-sm" style={{ opacity: 0.6 }}>
                {new Date(r.createdAt).toLocaleDateString('ru-RU')}
              </span>
              {card.caps.manage && r.status !== 'done' && r.status !== 'cancelled' && (
                <Button size="sm" variant="ghost" onClick={() => onClose(r.id)}>
                  Выполнено
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {card.caps.manage && (
        <div className="ui-stack" style={{ gap: 'var(--spacing-3)' }}>
          <div className="grid md:grid-cols-3" style={{ gap: 'var(--spacing-3)' }}>
            <Select
              label="Вид"
              value={kind}
              onChange={setKind}
              options={ASSET_SERVICE_KINDS.map((k) => ({ value: k.value, label: k.label }))}
            />
            <Input label="Что делали" value={title} onChange={(e) => setTitle(e.target.value)} />
            {card.caps.payrollView && (
              <Input label="Стоимость" placeholder="35 000" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} />
            )}
          </div>
          <Textarea label="Подробности" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button variant="primary" loading={log.isPending} disabled={!title.trim()} onClick={() => log.mutate()}>
              Записать
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: 'var(--spacing-3)', fontSize: '0.85rem', lineHeight: 1.6 }}>
      <span style={{ color: 'var(--on-surface-variant)', minWidth: 190 }}>{label}</span>
      <span style={{ fontWeight: 500 }}>{value}</span>
    </div>
  );
}
