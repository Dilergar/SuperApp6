'use client';

// ============================================================
// «Видимость данных» организации (core/visibility, §5.10 B) — ОДНО место «кто видит что в
// наших данных»: пресеты при первом входе, матрица правил по типу записи (черновик с
// автосейвом), публикация с диффом (строгие поля — SMS-подтверждение; «четыре глаза» —
// заявка второму владельцу/админу), версии, «Проверить сотрудника» (объяснение сервера) и
// настройки политики (правит владелец). Сотрудники видят правила только после публикации.
// ============================================================

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import {
  VISIBILITY_PRESET_KEYS,
  type VisibilityPolicyDto,
  type VisibilityPresetKey,
  type VisibilityRuleInput,
  type Workspace,
} from '@superapp/shared';
import {
  Alert,
  BentoGrid,
  Button,
  Card,
  CardHeader,
  Chip,
  EmptyState,
  LoadingBlock,
  Select,
  Tabs,
  Toggle,
  useConfirm,
} from '@/components/ui';
import { EntitlementLock } from '@/components/entitlements';
import { PolicyMatrix } from '@/components/visibility/PolicyMatrix';
import { PublishPolicyModal } from '@/components/visibility/PublishPolicyModal';
import { PolicyVersions } from '@/components/visibility/PolicyVersions';
import { ExplainPanel } from '@/components/visibility/ExplainPanel';
import { useStepUp } from '@/components/verify/useStepUp';
import {
  applyVisibilityPreset,
  discardVisibilityDraft,
  fetchVisibilityOverview,
  fetchVisibilityPolicy,
  saveVisibilityDraft,
  updateVisibilitySettings,
} from '@/lib/visibility-api';
import { wsVisibilityOverviewKey, wsVisibilityPolicyKey, wsVisibilityRootKey } from '@/lib/queries';
import { toast } from '@/lib/toast';
import { toastApiError } from '@/lib/api-errors';

type Tab = 'matrix' | 'versions' | 'explain';

export function VisibilitySection({ workspaceId, ws }: { workspaceId: string; ws: Workspace }) {
  const t = useTranslations('visibility');
  const qc = useQueryClient();
  const [confirm, confirmDialog] = useConfirm();
  const canEdit = ws.myRole === 'owner' || ws.myRole === 'admin';
  const isOwner = ws.myRole === 'owner';
  const overview = useQuery({ queryKey: wsVisibilityOverviewKey(workspaceId), queryFn: () => fetchVisibilityOverview(workspaceId), enabled: canEdit });
  const [tab, setTab] = useState<Tab>('matrix');
  const [typeKey, setTypeKey] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const settingsStepUp = useStepUp('visibility_manage', { title: t('org.settings.stepUpTitle') });

  const types = overview.data?.types ?? [];
  const type = typeKey ?? types[0]?.recordType ?? null;
  const meta = types.find((x) => x.recordType === type) ?? null;
  const pol = overview.data?.policies.find((p) => p.recordType === type) ?? null;
  const status: 'draft' | 'published' = pol?.draft ? 'draft' : 'published';
  const policy = useQuery({
    queryKey: wsVisibilityPolicyKey(workspaceId, type ?? '-', status),
    queryFn: () => fetchVisibilityPolicy(workspaceId, type!, status),
    enabled: !!type && canEdit,
  });
  const nothingYet = !!overview.data && overview.data.policies.every((p) => !p.published && !p.draft);

  const invalidate = () => void qc.invalidateQueries({ queryKey: wsVisibilityRootKey(workspaceId) });

  // Автосейв черновика: ячейка → весь набор правил типа (сервер держит ровно одну строку на цель×адресата)
  const save = useMutation({
    mutationFn: (rules: VisibilityRuleInput[]) => saveVisibilityDraft(workspaceId, type!, { rules }),
    onSuccess: (dto: VisibilityPolicyDto) => {
      qc.setQueryData(wsVisibilityPolicyKey(workspaceId, type!, 'draft'), dto);
      void qc.invalidateQueries({ queryKey: wsVisibilityOverviewKey(workspaceId) });
      toast(t('org.draft.saved'), 'success');
    },
    onError: (err) => {
      toastApiError(err);
      invalidate();
    },
  });

  const preset = useMutation({
    mutationFn: (key: VisibilityPresetKey) => applyVisibilityPreset(workspaceId, key),
    onSuccess: () => {
      setStarted(true);
      invalidate();
      toast(t('org.draft.saved'), 'success');
    },
    onError: toastApiError,
  });

  const discard = () =>
    confirm(
      { title: t('org.draft.discard'), message: t('org.draft.discardConfirm'), confirmLabel: t('org.draft.discard'), danger: true },
      async () => {
        await discardVisibilityDraft(workspaceId, type!);
        invalidate();
      },
    );

  const settings = overview.data?.settings;
  const setSetting = async (patch: Partial<{ notifyOnReveal: boolean; dualControl: boolean; allowDelegation: boolean }>) => {
    try {
      const res = await settingsStepUp.withStepUpOnDemand(() => updateVisibilitySettings(workspaceId, patch));
      if (res) {
        invalidate();
        toast(t('org.settings.saved'), 'success');
      }
    } catch (err) {
      toastApiError(err);
    }
  };

  const typeOptions = useMemo(() => types.map((x) => ({ value: x.recordType, label: t(`types.${x.recordType}.title`) })), [types, t]);

  if (!canEdit) return <Alert tone="neutral">{t('org.settings.ownerOnly')}</Alert>;
  if (overview.isPending) return <LoadingBlock />;
  if (!overview.data) return null;

  // ---- Первый вход: умолчания платформы уже защищают, пресет — черновик на правку ----
  if (nothingYet && !started) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gap-grid)' }}>
        <EmptyState icon="eye" title={t('org.emptyTitle')} description={t('org.emptyBody')} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)' }}>
          <h3 className="title-md" style={{ margin: 0 }}>{t('org.presets.title')}</h3>
          <EntitlementLock keyName="visibility.presets" workspaceId={workspaceId} />
        </div>
        <BentoGrid>
          {VISIBILITY_PRESET_KEYS.map((key) => (
            <Card key={key} span={4}>
              <CardHeader title={t(`org.presets.${key}.title`)} subtitle={t(`org.presets.${key}.body`)} />
              <Button variant="outline" loading={preset.isPending && preset.variables === key} onClick={() => preset.mutate(key)}>
                {t('org.presets.apply')}
              </Button>
            </Card>
          ))}
        </BentoGrid>
        <div>
          <Button variant="ghost" icon="sliders" onClick={() => setStarted(true)}>{t('org.startDefaults')}</Button>
        </div>
      </div>
    );
  }

  const rulesUsed = overview.data.rulesUsed;
  const rulesLimit = overview.data.rulesLimit;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gap-grid)' }}>
      <p className="label-md" style={{ margin: 0, opacity: 0.8 }}>{t('org.subtitle')}</p>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--spacing-3)', flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <div style={{ minWidth: 220, flex: '0 1 320px' }}>
          <Select label={t('org.recordType')} value={type ?? ''} onChange={(v) => setTypeKey(v)} options={typeOptions} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
          {pol?.draft && <Chip tone="waiting" icon="pending">{t('org.draft.chip')}</Chip>}
          <span className="label-sm">{rulesLimit === null ? null : t('org.rulesUsed', { used: rulesUsed, limit: rulesLimit })}</span>
          {pol?.draft && (
            <Button variant="ghost" size="sm" onClick={discard}>{t('org.draft.discard')}</Button>
          )}
          <Button variant="primary" tone="success" icon="check" disabled={!pol?.draft} onClick={() => setPublishOpen(true)}>
            {t('org.draft.publish')}
          </Button>
        </div>
      </div>
      {!pol?.draft && <p className="label-sm" style={{ margin: 0, opacity: 0.7 }}>{t('org.draft.none')}</p>}

      <Tabs<Tab>
        aria-label={t('org.title')}
        value={tab}
        onChange={setTab}
        items={[
          { key: 'matrix', label: t('org.tabs.matrix') },
          { key: 'versions', label: t('org.tabs.versions') },
          { key: 'explain', label: t('org.tabs.explain') },
        ]}
      />

      {tab === 'matrix' && meta && (
        <BentoGrid>
          <Card span={12}>
            {policy.isPending ? (
              <LoadingBlock />
            ) : (
              <PolicyMatrix
                workspaceId={workspaceId}
                meta={meta}
                rules={policy.data?.rules ?? []}
                canEdit={canEdit && !save.isPending}
                orgAudiences={overview.data.features.orgAudiences}
                onRulesChange={(rules) => save.mutate(rules)}
              />
            )}
          </Card>
          {settings && (
            <Card span={12}>
              <CardHeader title={t('org.settings.title')} subtitle={isOwner ? undefined : t('org.settings.ownerOnly')} />
              <div className="ui-stack" style={{ gap: 'var(--spacing-3)' }}>
                <Toggle checked={settings.notifyOnReveal} disabled={!isOwner} onChange={(v) => void setSetting({ notifyOnReveal: v })} label={t('org.settings.notifyOnReveal')} />
                <Toggle checked={settings.dualControl} disabled={!isOwner} onChange={(v) => void setSetting({ dualControl: v })} label={t('org.settings.dualControl')} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)' }}>
                  <Toggle
                    checked={settings.allowDelegation}
                    disabled={!isOwner || (!overview.data.features.revealDelegation && !settings.allowDelegation)}
                    onChange={(v) => void setSetting({ allowDelegation: v })}
                    label={t('org.settings.allowDelegation')}
                  />
                  <EntitlementLock keyName="visibility.revealDelegation" workspaceId={workspaceId} />
                </div>
              </div>
            </Card>
          )}
        </BentoGrid>
      )}
      {tab === 'versions' && type && <PolicyVersions workspaceId={workspaceId} recordType={type} onRestored={invalidate} />}
      {tab === 'explain' && <ExplainPanel workspaceId={workspaceId} types={types} />}

      {publishOpen && type && (
        <PublishPolicyModal
          workspaceId={workspaceId}
          recordType={type}
          onClose={() => setPublishOpen(false)}
          onDone={() => {
            setPublishOpen(false);
            invalidate();
          }}
        />
      )}
      {settingsStepUp.dialog}
      {confirmDialog}
    </div>
  );
}
