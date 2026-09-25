'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { lifecycleCeilingKeyOf, type LifecycleDuration, type LifecycleSettingsClassDto, type WorkspaceMember } from '@superapp/shared';
import { Button, Card, CardHeader, Chip, Input, TickBar, Tooltip, useConfirm } from '@/components/ui';
import { PersonChip } from '@/app/circles/PersonCard';
import { splitName } from '@/app/workspaces/[id]/members/members-lib';
import { useFormatters } from '@/lib/format';
import { toastApiError } from '@/lib/api-errors';
import { useEntitlement, useEntitlementDenied } from '@/lib/hooks/useEntitlements';
import { lockTextOf } from '@/components/entitlements/EntitlementLock';
import { lifecycleRootKey } from '@/lib/queries';
import { cancelLifecyclePending, previewLifecycleSetting, updateLifecycleSetting } from '@/lib/lifecycle-api';
import { durationValue, useDurationLabel } from './duration';

const DAY_MS = 86_400_000;

/**
 * Карточка класса данных на странице «Данные и сроки хранения» (DESIGN.md, план §11.2):
 * срок — пресет, не число («Вечно · 1 год · 90 · 30 · 7 · 1 день», «Другое…» вторым шагом);
 * пресет выше тарифа — тот же чип с замком, клик ведёт к тарифу. Последствия — ДО действия:
 * сервер считает, сколько записей окажется старше срока, окно подтверждения просит ввести
 * название организации. Отложенное сокращение видно с датой, tick-прогрессом и «Отменить».
 */
export function RetentionClassCard({
  workspaceId,
  workspaceName,
  cls,
  presets,
  delayDays,
  member,
}: {
  workspaceId: string;
  workspaceName: string;
  cls: LifecycleSettingsClassDto;
  presets: LifecycleDuration[];
  delayDays: number;
  member: (userId: string) => WorkspaceMember | undefined;
}) {
  const t = useTranslations('lifecycle');
  const te = useTranslations('entitlements');
  const fmt = useFormatters();
  const label = useDurationLabel();
  const router = useRouter();
  const qc = useQueryClient();
  const denied = useEntitlementDenied();
  const [confirm, confirmUI] = useConfirm();
  const [custom, setCustom] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ceilingView = useEntitlement(lifecycleCeilingKeyOf(cls.dataClass), workspaceId);

  const title = t(`settings.classes.${cls.dataClass}.title`);
  const refresh = () => qc.invalidateQueries({ queryKey: lifecycleRootKey(workspaceId) });
  const locked = (d: LifecycleDuration) => cls.planCeiling !== null && durationValue(d) > durationValue(cls.planCeiling);
  const visible = presets.filter((d) => durationValue(d) >= cls.min && durationValue(d) <= durationValue(cls.policyMax));

  const choose = async (days: LifecycleDuration) => {
    if (busy || days === cls.current) return;
    setBusy(true);
    try {
      const pv = await previewLifecycleSetting(workspaceId, { dataClass: cls.dataClass, days });
      const rows = pv.counts.reduce((a, c) => a + c.rows, 0);
      const capped = pv.counts.some((c) => c.capped);
      const save = async () => {
        try {
          await updateLifecycleSetting(workspaceId, { dataClass: cls.dataClass, days });
          setCustom(null);
          await refresh();
        } catch (err) {
          if (!denied(err)) toastApiError(err);
          throw err;
        }
      };
      if (pv.shortened) {
        confirm(
          {
            title: t('retention.confirmShortenTitle'),
            message: t('retention.confirmShortenText', {
              duration: label(days),
              rows: `${fmt.number(rows)}${capped ? '+' : ''}`,
              date: fmt.date(pv.effectiveAt ?? new Date(Date.now() + delayDays * DAY_MS).toISOString()),
              delay: delayDays,
            }),
            confirmLabel: t('retention.confirmShortenAction'),
            danger: true,
            requireText: workspaceName,
            requireTextLabel: t('retention.confirmShortenType', { name: workspaceName }),
          },
          save,
        );
      } else {
        confirm({ title: t('retention.lengthenTitle'), message: t('retention.lengthenText', { duration: label(days) }), confirmLabel: t('retention.apply') }, save);
      }
    } catch (err) {
      if (!denied(err)) toastApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const cancelPending = () =>
    confirm({ title: t('retention.cancelTitle'), message: t('retention.cancelText', { duration: label(cls.current) }), confirmLabel: t('retention.cancelPending') }, async () => {
      try {
        await cancelLifecyclePending(workspaceId, cls.dataClass);
        await refresh();
      } catch (err) {
        toastApiError(err);
        throw err;
      }
    });

  const pendingLeft = cls.pending ? Math.max(0, Math.ceil((new Date(cls.pending.effectiveAt).getTime() - Date.now()) / DAY_MS)) : 0;
  const changer = cls.changedById ? member(cls.changedById) : undefined;
  const customDays = custom === null ? null : Number(custom);
  const customValid = customDays !== null && Number.isInteger(customDays) && customDays >= cls.min && customDays <= durationValue(cls.max);
  const lockText = ceilingView.loading ? '' : lockTextOf(ceilingView, te);

  return (
    <Card span={12}>
      <CardHeader
        title={title}
        actions={
          <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <Chip tone={cls.custom ? 'accent' : 'neutral'} size="sm">{t('retention.current', { duration: label(cls.current) })}</Chip>
            {!cls.custom && <Chip tone="neutral" size="sm">{t('retention.default')}</Chip>}
            {cls.aboveCeiling && <Chip tone="warning" size="sm" icon="lock">{t('retention.aboveCeiling')}</Chip>}
          </div>
        }
      />
      <p className="body-sm" style={{ margin: '0 0 var(--spacing-3)' }}>{t(`settings.classes.${cls.dataClass}.description`)}</p>

      {cls.pending && (
        <div className="ui-stack" style={{ gap: 'var(--spacing-2)', padding: 'var(--spacing-3)', borderRadius: 'var(--radius-md)', background: 'var(--surface-container)', marginBottom: 'var(--spacing-3)' }}>
          <div style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between' }}>
            <Chip tone="waiting" icon="hourglass" size="sm">
              {t('retention.pending', { duration: label(cls.pending.days), date: fmt.date(cls.pending.effectiveAt) })}
            </Chip>
            <Button size="sm" variant="outline" icon="undo" onClick={cancelPending}>{t('retention.cancelPending')}</Button>
          </div>
          <TickBar value={((delayDays - pendingLeft) / delayDays) * 100} tone="waiting" label={t('retention.pendingDaysLeft', { days: pendingLeft })} />
        </div>
      )}

      <div role="group" aria-label={title} style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap', alignItems: 'center' }}>
        {visible.map((d) => {
          const isLocked = locked(d);
          const chip = (
            <Chip
              key={String(d)}
              tone="accent"
              selected={d === cls.current}
              icon={isLocked ? 'lock' : undefined}
              onClick={() => (isLocked ? router.push(`/workspaces/${workspaceId}/profile/subscription`) : void choose(d))}
            >
              {label(d)}
            </Chip>
          );
          return isLocked ? (
            <Tooltip key={String(d)} content={lockText}>
              {chip}
            </Tooltip>
          ) : (
            chip
          );
        })}
        {custom === null ? (
          <Chip tone="accent" onClick={() => setCustom('')}>{t('retention.custom')}</Chip>
        ) : (
          <div style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ width: '12rem', maxWidth: '100%' }}>
              <Input
                type="number"
                inputMode="numeric"
                min={cls.min}
                max={cls.max === 'forever' ? undefined : cls.max}
                label={t('retention.customLabel')}
                hint={t('retention.range', { min: label(cls.min), max: label(cls.max) })}
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
              />
            </div>
            <Button size="sm" variant="primary" disabled={!customValid || busy} loading={busy} onClick={() => customValid && void choose(customDays!)}>
              {t('retention.apply')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCustom(null)}>{t('retention.customCancel')}</Button>
          </div>
        )}
      </div>

      {cls.changedAt && (
        <div style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'center', marginTop: 'var(--spacing-3)', flexWrap: 'wrap' }}>
          <span className="label-sm">{t('retention.changedBy', { date: fmt.date(cls.changedAt) })}</span>
          {changer &&
            (() => {
              const [fn, ln] = splitName(changer.userName);
              return <PersonChip size="XS" userId={changer.userId} firstName={fn} lastName={ln} avatar={changer.userAvatar} />;
            })()}
        </div>
      )}
      {confirmUI}
    </Card>
  );
}
