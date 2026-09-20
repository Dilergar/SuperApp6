'use client';

// ============================================================
// Карточка оборудования: Данные / Документы / Перемещения / Обслуживание /
// Хроника. Деньги (цена, баланс, стоимость ремонтов) рисуются по `caps.payrollView`
// из ответа — сервер таких полей без права не отдаёт вовсе.
// ============================================================

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
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

import { dmyOrDash } from '@/lib/dates';
import { useFormatters } from '@/lib/format';
import { moneyTiyn } from '@/lib/objects-money';
import { assetChatterKey, assetFilesKey, assetKey, objectAssetsKey } from '@/lib/queries';
import { assetsApi, fetchAssetCard } from '../../../objects-api';

import { toastApiError } from '@/lib/api-errors';
type TabKey = 'data' | 'files' | 'moves' | 'service' | 'history';

const STATUS_META = new Map(ASSET_STATUSES.map((s) => [s.value, s]));
const HOLDING_KNOWN = new Set<string>(HOLDING_KINDS);
const SERVICE_KNOWN = new Set<string>(ASSET_SERVICE_KINDS);

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
  return v ? moneyTiyn(v, currency) : '—';
}

export default function AssetCardPage() {
  const t = useTranslations('objects');
  const tc = useTranslations('common');
  const f = useFormatters();
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
    onError: (e) => toastApiError(e),
  });
  const setHolding = useMutation({
    mutationFn: (holdingKind: string) => assetsApi.setHolding(id, assetId, { holdingKind }),
    onSuccess: invalidate,
    onError: (e) => toastApiError(e),
  });
  const closeService = useMutation({
    mutationFn: (recId: string) =>
      assetsApi.updateService(id, assetId, recId, { status: 'done', finishedAt: new Date().toISOString() }),
    onSuccess: invalidate,
    onError: (e) => toastApiError(e),
  });

  const setStatus = useMutation({
    mutationFn: (status: string) => assetsApi.setStatus(id, assetId, { status }),
    onSuccess: invalidate,
    onError: (e) => toastApiError(e),
  });
  const setCustodian = useMutation({
    mutationFn: (custodianUserId: string | null) => assetsApi.setCustodian(id, assetId, { custodianUserId }),
    onSuccess: invalidate,
    onError: (e) => toastApiError(e),
  });
  const moveAsset = useMutation({
    mutationFn: (branchId: string) => assetsApi.move(id, assetId, { branchId }),
    onSuccess: invalidate,
    onError: (e) => toastApiError(e),
  });
  const attach = useMutation({
    mutationFn: (fileId: string) => apiPost(`/workspaces/${id}/assets/${assetId}/files`, { fileId }),
    onSuccess: () => {
      invalidateFiles();
      invalidate();
    },
    onError: (e) => toastApiError(e),
  });
  const detach = useMutation({
    mutationFn: (fileId: string) => apiDelete(`/workspaces/${id}/assets/${assetId}/files/${fileId}`),
    onSuccess: () => {
      invalidateFiles();
      invalidate();
    },
    onError: (e) => toastApiError(e),
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
          title={t('assets.notOpened')}
          description={error ? apiErrorMessage(error) : t('assets.notOpenedHint')}
          action={
            <Button variant="primary" icon="arrowLeft" href={`/workspaces/${id}/objects/${objectId}/assets`}>
              {t('assets.backToList')}
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
    { key: 'data', label: t('assets.tabData'), icon: 'file' },
    { key: 'files', label: t('models.files'), icon: 'docs', count: files?.length },
    { key: 'moves', label: t('assets.tabMoves'), icon: 'truck', count: card.moves.length },
    { key: 'service', label: t('assets.tabService'), icon: 'wrench', count: card.services.length },
    { key: 'history', label: t('tabs.history'), icon: 'journal' },
  ];

  return (
    <>
      <PageHeader
        breadcrumb={a.branchName}
        title={a.name}
        chip={
          <Chip tone={(meta?.tone ?? 'neutral') as 'success' | 'warning' | 'neutral'}>
            {meta ? t(`assetStatus.${a.status}`) : a.status}
          </Chip>
        }
        description={[a.modelName, a.inventoryNumber ? t('assets.inventoryShort', { number: a.inventoryNumber }) : null]
          .filter(Boolean)
          .join(' · ')}
        actions={
          caps.manage ? (
            <>
              <Select
                aria-label={t('assets.condition')}
                value={a.status}
                onChange={(v) => setStatus.mutate(v)}
                options={(retired ? ASSET_STATUSES : LIVE_STATUSES).map((s) => ({
                  value: s.value,
                  label: t(`assetStatus.${s.value}`),
                }))}
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
                        title: t('assets.retireTitle'),
                        message: t('assets.retireMessage', { name: a.name }),
                        confirmLabel: t('assets.retire'),
                        danger: true,
                      },
                      () => setStatus.mutateAsync('written_off').then(() => undefined),
                    )
                  }
                >
                  {t('assets.retire')}
                </Button>
              )}
            </>
          ) : undefined
        }
      />

      <div style={{ marginBottom: 'var(--spacing-6)' }}>
        <Tabs items={tabs} value={tab} onChange={setTab} aria-label={t('assets.tabsAria')} />
      </div>

      {tab === 'data' && (
        <Card>
          <CardHeader title={t('assets.tabData')} />
          <div className="ui-stack" style={{ gap: 'var(--spacing-3)' }}>
            <Row label={t('models.one')} value={[a.modelName, a.manufacturer].filter(Boolean).join(' · ')} />
            <Row label={t('assets.serialNumber')} value={a.serialNumber ?? '—'} />
            <Row label={t('entity')} value={a.branchName} />
            <Row label={t('assets.locationNote')} value={a.locationNote ?? '—'} />
            <div style={{ display: 'flex', gap: 'var(--spacing-3)', alignItems: 'center', fontSize: '0.85rem' }}>
              <span style={{ color: 'var(--on-surface-variant)', minWidth: 190 }}>{t('assets.custodian')}</span>
              {a.custodianUserId && a.custodianName ? (
                <PersonChip size="S" userId={a.custodianUserId} firstName={a.custodianName} />
              ) : (
                <span style={{ fontWeight: 500 }}>—</span>
              )}
            </div>
            <Row label={t('assets.partOf')} value={a.parentAssetName ?? '—'} />
            <Row label={t('assets.purchasedOn')} value={dmyOrDash(a.purchasedOn)} />
            <Row label={t('assets.commissionedOn')} value={dmyOrDash(a.commissionedOn)} />
            <Row label={t('assets.warrantyUntil')} value={dmyOrDash(a.warrantyUntil)} />
            {caps.payrollView && (
              <>
                <div style={{ display: 'flex', gap: 'var(--spacing-3)', alignItems: 'center', fontSize: '0.85rem' }}>
                  <span style={{ color: 'var(--on-surface-variant)', minWidth: 190 }}>{t('assets.holding')}</span>
                  {caps.manage ? (
                    <Select
                      value={a.holdingKind ?? 'owned'}
                      onChange={(v) => setHolding.mutate(v)}
                      options={HOLDING_KINDS.map((h) => ({ value: h, label: t(`holdingKind.${h}`) }))}
                    />
                  ) : (
                    <span style={{ fontWeight: 500 }}>
                      {HOLDING_KNOWN.has(a.holdingKind ?? 'owned') ? t(`holdingKind.${a.holdingKind ?? 'owned'}`) : '—'}
                    </span>
                  )}
                </div>
                <Row label={t('assets.balanceEntity')} value={a.balanceLegalEntityName ?? '—'} />
                <Row label={t('assets.holdingParty')} value={a.holdingCounterpartyName ?? '—'} />
                <Row label={t('assets.purchasePrice')} value={money(a.purchasePrice, a.currency)} />
                {/* TCO считает СЕРВЕР (`serviceCost`): клиентская сумма врала, как
                    только журнал не помещался в отданную страницу. */}
                <Row label={t('assets.serviceCost')} value={money(a.serviceCost, a.currency)} />
              </>
            )}
            {a.note && <Row label={t('form.note')} value={a.note} />}
          </div>

          {caps.manage && (
            <div className="ui-stack" style={{ gap: 'var(--spacing-3)', marginTop: 'var(--spacing-6)' }}>
              <div className="grid md:grid-cols-3" style={{ gap: 'var(--spacing-3)' }}>
                <Input
                  label={tc('labels.name')}
                  defaultValue={a.name}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== a.name) saveFields.mutate({ name: v });
                  }}
                />
                <Input
                  label={t('assets.inventoryNumber')}
                  defaultValue={a.inventoryNumber ?? ''}
                  onBlur={(e) => {
                    const v = e.target.value.trim() || null;
                    if (v !== a.inventoryNumber) saveFields.mutate({ inventoryNumber: v });
                  }}
                />
                <Input
                  label={t('assets.serialNumber')}
                  defaultValue={a.serialNumber ?? ''}
                  onBlur={(e) => {
                    const v = e.target.value.trim() || null;
                    if (v !== a.serialNumber) saveFields.mutate({ serialNumber: v });
                  }}
                />
              </div>
              <span className="label-sm" style={{ fontWeight: 600 }}>{t('assets.custodian')}</span>
              <EntitySelector
                types={['user']}
                context={{ workspaceId: id }}
                value={a.custodianUserId ? [{ type: 'user', id: a.custodianUserId }] : []}
                onChange={(next) => setCustodian.mutate(next[next.length - 1]?.id ?? null)}
                placeholder={t('assets.custodianEmpty')}
              />
              <span className="label-sm" style={{ fontWeight: 600 }}>{t('assets.moveToSite')}</span>
              <EntitySelector
                types={['branch']}
                context={{ workspaceId: id }}
                value={[{ type: 'branch', id: a.branchId }]}
                onChange={(next) => {
                  const target = next[next.length - 1]?.id;
                  if (target && target !== a.branchId) moveAsset.mutate(target);
                }}
                placeholder={t('entity')}
              />
            </div>
          )}
        </Card>
      )}

      {tab === 'files' && (
        <Card>
          <CardHeader title={t('card.files')} subtitle={t('assets.filesHint')} />
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
          <CardHeader title={t('assets.tabMoves')} subtitle={t('assets.movesHint')} />
          {card.moves.length === 0 ? (
            <EmptyState icon="truck" title={t('assets.movesEmpty')} />
          ) : (
            <div className="ui-stack" style={{ gap: 'var(--spacing-2)' }}>
              {card.moves.map((m) => (
                <div key={m.id} style={{ display: 'flex', gap: 'var(--spacing-3)', flexWrap: 'wrap', alignItems: 'center' }}>
                  <Chip tone="neutral">{MOVE_KEYS[m.kind] ? t(MOVE_KEYS[m.kind]) : m.kind}</Chip>
                  <span className="label-sm">
                    {[m.fromLabel ?? '—', m.toLabel ?? '—'].join(' → ')}
                  </span>
                  <span className="label-sm" style={{ opacity: 0.6 }}>
                    {f.dateTime(m.movedAt)} · {m.movedByName ?? ''}
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
          <CardHeader title={t('tabs.history')} subtitle={t('assets.historyHint')} />
          {chatterPending ? (
            <LoadingBlock />
          ) : (
            <ChronicleFeed
              entries={chatter?.items ?? []}
              actors={chatter?.actors ?? {}}
              emptyText={t('assets.historyEmpty')}
            />
          )}
        </Card>
      )}
      {confirmUI}
    </>
  );
}

/** Вид записи журнала перемещений → ключ каталога (реестр слов не хранит). */
const MOVE_KEYS: Record<string, string> = {
  placement: 'assets.movePlacement',
  custodian: 'assets.custodian',
  holding: 'assets.holding',
  status: 'assets.condition',
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
  const t = useTranslations('objects');
  const f = useFormatters();
  const [kind, setKind] = useState('repair');
  const [title, setTitle] = useState('');
  const [cost, setCost] = useState('');
  const [description, setDescription] = useState('');

  const log = useMutation({
    mutationFn: async () => {
      const clean = cost.replace(/\s/g, '').replace(',', '.');
      const tiyn = clean ? String(Math.round(Number(clean) * 100)) : null;
      if (clean && !Number.isFinite(Number(clean))) throw new Error(t('assets.costIsNumber'));
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
    onError: (e) => toastApiError(e),
  });

  return (
    <Card>
      <CardHeader title={t('assets.tabService')} subtitle={t('assets.serviceHint')} />
      {card.services.length === 0 ? (
        <EmptyState icon="wrench" title={t('assets.serviceEmpty')} description={t('assets.serviceEmptyHint')} />
      ) : (
        <div className="ui-stack" style={{ gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-4)' }}>
          {card.services.map((r) => (
            <div key={r.id} style={{ display: 'flex', gap: 'var(--spacing-3)', flexWrap: 'wrap', alignItems: 'center' }}>
              <Chip tone="neutral">{SERVICE_KNOWN.has(r.kind) ? t(`assetServiceKind.${r.kind}`) : r.kind}</Chip>
              <span style={{ fontWeight: 600 }}>{r.title}</span>
              {card.caps.payrollView && r.cost && <span className="label-sm">{money(r.cost, r.currency)}</span>}
              <span className="label-sm" style={{ opacity: 0.6 }}>
                {f.date(r.createdAt)}
              </span>
              {card.caps.manage && r.status !== 'done' && r.status !== 'cancelled' && (
                <Button size="sm" variant="ghost" onClick={() => onClose(r.id)}>
                  {t('assetServiceStatus.done')}
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
              label={t('assets.serviceKind')}
              value={kind}
              onChange={setKind}
              options={ASSET_SERVICE_KINDS.map((k) => ({ value: k, label: t(`assetServiceKind.${k}`) }))}
            />
            <Input label={t('assets.serviceTitle')} value={title} onChange={(e) => setTitle(e.target.value)} />
            {card.caps.payrollView && (
              <Input
                label={t('assets.serviceCostField')}
                placeholder="35 000"
                inputMode="decimal"
                value={cost}
                onChange={(e) => setCost(e.target.value)}
              />
            )}
          </div>
          <Textarea
            label={t('assets.serviceDetails')}
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button variant="primary" loading={log.isPending} disabled={!title.trim()} onClick={() => log.mutate()}>
              {t('attendance.record')}
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
