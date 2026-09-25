'use client';

import { useTranslations } from 'next-intl';
import {
  ENTITLEMENT_REGISTRY,
  ENTITLEMENT_SERVICES,
  freePlanOf,
  type EntitlementKey,
  type EntitlementServiceKey,
  type EntitlementSnapshotDto,
  type EntitlementValueDto,
} from '@superapp/shared';
import { BentoGrid, Card, CardHeader, Chip, Icon, Skeleton, StatTile, TickBar, type IconName, type Tone } from '@/components/ui';
import { useEntitlements, viewOf } from '@/lib/hooks/useEntitlements';
import { useBytes, useFormatters } from '@/lib/format';
import { toneOf } from './EntitlementGauge';

// ============================================================
// «Тариф и лимиты» — один компонент на два адреса (профиль и организация):
// карточка плана со статусом чипом, у организации — плитка мест, дальше бенто
// карточек по сервисам: лимиты чипом-счётчиком, квоты штрихом, фичи чипом
// «доступно/недоступно», `null` — «без ограничения», источник — чипом рядом.
// Цен и кнопок оплаты нет (правило PRODUCT.md). Пустых состояний нет: у любого
// субъекта есть free-значения.
// ============================================================

const SERVICE_ICON: Record<EntitlementServiceKey, IconName> = {
  workspaces: 'workspace',
  files: 'drive',
  contacts: 'people',
  shop: 'cart',
  objects: 'workspace',
  keys: 'key',
  legalEntities: 'file',
  cardSkins: 'crown',
  notifications: 'bell',
  audit: 'shield',
  visibility: 'eye',
  lifecycle: 'archive',
};

/** Ключ каталога подписи → относительный (внутри неймспейса `entitlements`). */
const rel = (key: string) => key.replace(/^entitlements\./, '');

/** Чип состояния плана: пробный до даты · активен · льготный период · истёк · бесплатный. */
export function PlanStatusChip({ snapshot, size = 'md' }: { snapshot: EntitlementSnapshotDto; size?: 'sm' | 'md' }) {
  const t = useTranslations('entitlements');
  const f = useFormatters();
  const sub = snapshot.subscription;
  let tone: Tone = 'neutral';
  let text: string;
  if (sub?.status === 'trialing') {
    tone = 'warning';
    text = t('status.trialing', { date: sub.trialEndsAt ? f.date(sub.trialEndsAt) : '' });
  } else if (sub?.status === 'active') {
    tone = 'success';
    text = t('status.active');
  } else if (sub?.status === 'past_due') {
    tone = 'warning';
    text = t('status.past_due', { date: sub.graceUntil ? f.date(sub.graceUntil) : '' });
  } else if (snapshot.recentlyEnded) {
    tone = 'danger';
    text = t('status.expired');
  } else {
    text = t('status.free');
  }
  return (
    <Chip tone={tone} size={size} icon="crown">
      {text}
    </Chip>
  );
}

function ValueCell({ dto, workspaceId }: { dto: EntitlementValueDto; workspaceId?: string | null }) {
  const t = useTranslations('entitlements');
  const bytes = useBytes();
  const f = useFormatters();
  const view = viewOf({ values: { [dto.key]: dto } } as unknown as EntitlementSnapshotDto, dto.key, false);
  void workspaceId;
  if (dto.kind === 'feature') {
    return (
      <Chip tone={dto.value === true ? 'success' : 'neutral'} size="sm">
        {dto.value === true ? t('page.available') : t('page.unavailable')}
      </Chip>
    );
  }
  if (dto.value === null) {
    return (
      <span className="label-sm">
        {t('page.unlimited')}
        {dto.used !== null && dto.used > 0 ? ` · ${dto.unit === 'bytes' ? bytes(dto.used) : f.number(dto.used)}` : ''}
      </span>
    );
  }
  const total = typeof dto.value === 'number' ? dto.value : 0;
  if (dto.unit === 'bytes') {
    return (
      <div style={{ minWidth: '12rem', flex: 1 }}>
        <TickBar value={view.ratio * 100} tone={toneOf(view)} label={t('page.usage', { used: bytes(dto.used ?? 0), total: bytes(total) })} />
      </div>
    );
  }
  if (dto.used === null) {
    return <Chip tone="neutral" size="sm">{f.number(total)}</Chip>;
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
      <Chip tone={toneOf(view)} size="sm">{t('page.usage', { used: f.number(dto.used), total: f.number(total) })}</Chip>
      {dto.resetAt && <span className="label-sm">{t('page.resetAt', { date: f.date(dto.resetAt) })}</span>}
    </span>
  );
}

function SourceChip({ dto }: { dto: EntitlementValueDto }) {
  const t = useTranslations('entitlements');
  const f = useFormatters();
  if (dto.source === 'grant') {
    return (
      <Chip tone="accent" size="sm" icon="gift">
        {dto.sourceUntil ? t('source.grant', { date: f.date(dto.sourceUntil) }) : t('source.grantNoEnd')}
      </Chip>
    );
  }
  if (dto.source === 'override') {
    return (
      <Chip tone="accent" size="sm" icon="edit">
        {t('source.override', { date: dto.sourceUntil ? f.date(dto.sourceUntil) : '' })}
      </Chip>
    );
  }
  return null;
}

export function PlanAndLimits({ workspaceId, membersHref }: { workspaceId?: string | null; membersHref?: string }) {
  const t = useTranslations('entitlements');
  const f = useFormatters();
  const q = useEntitlements(workspaceId);
  const snap = q.data;

  if (!snap) {
    return (
      <BentoGrid>
        <Card span={5}>
          <Skeleton width="40%" height={14} />
          <div style={{ height: 'var(--spacing-3)' }} />
          <Skeleton width="70%" height={28} />
        </Card>
        <Card span={7}>
          <Skeleton width="50%" height={14} />
          <div style={{ height: 'var(--spacing-3)' }} />
          <Skeleton height={14} />
        </Card>
      </BentoGrid>
    );
  }

  const contextType = snap.contextType === 'workspace' ? 'workspace' : 'user';
  const planName = snap.subscription
    ? t(rel(snap.subscription.planLabelKey))
    : t(`plans.${freePlanOf(contextType) ?? 'free'}`);
  const seats = workspaceId ? snap.values['workspace.seats'] : null;

  // Группировка ключей по сервису в порядке реестра
  const byService = new Map<EntitlementServiceKey, EntitlementValueDto[]>();
  for (const dto of Object.values(snap.values) as EntitlementValueDto[]) {
    const service = ENTITLEMENT_REGISTRY[dto.key as EntitlementKey]?.service;
    if (!service) continue;
    const list = byService.get(service) ?? [];
    list.push(dto);
    byService.set(service, list);
  }
  const services = [...byService.keys()].sort((a, b) => ENTITLEMENT_SERVICES[a].order - ENTITLEMENT_SERVICES[b].order);

  return (
    <>
      <BentoGrid>
        <Card span={seats ? 7 : 12}>
          <CardHeader title={workspaceId ? t('page.orgPlanCard') : t('page.planCard')} subtitle={t('page.subtitle')} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
            <span className="title-lg">{planName}</span>
            <PlanStatusChip snapshot={snap} />
          </div>
          {snap.subscription?.expiresAt && snap.subscription.status === 'active' && (
            <p className="label-sm" style={{ marginTop: 'var(--spacing-3)' }}>{t('page.periodEnd', { date: f.date(snap.subscription.expiresAt) })}</p>
          )}
        </Card>
        {seats && (
          <StatTile
            span={5}
            label={t('page.seats')}
            icon="staff"
            tone={typeof seats.value === 'number' && seats.used !== null && seats.used >= seats.value ? 'danger' : 'accent'}
            value={seats.value === null ? t('page.unlimited') : t('page.usage', { used: f.number(seats.used ?? 0), total: f.number(seats.value as number) })}
            href={membersHref}
          />
        )}
      </BentoGrid>

      <h3 className="title-md" style={{ margin: 'var(--spacing-8) 0 var(--spacing-4)' }}>{t('page.limitsTitle')}</h3>
      <BentoGrid>
        {services.map((service) => (
          <Card span={4} key={service}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: 'var(--spacing-4)' }}>
              <Icon name={SERVICE_ICON[service]} size={18} />
              <span className="label-caps">{t(`services.${service}`)}</span>
            </div>
            <div className="ui-stack" style={{ gap: 'var(--spacing-3)' }}>
              {(byService.get(service) ?? []).map((dto) => (
                <div key={dto.key} style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                  <span className="body-sm">{t(rel(ENTITLEMENT_REGISTRY[dto.key as EntitlementKey].labelKey))}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                    <ValueCell dto={dto} workspaceId={workspaceId} />
                    <SourceChip dto={dto} />
                  </div>
                </div>
              ))}
            </div>
          </Card>
        ))}
      </BentoGrid>
    </>
  );
}
