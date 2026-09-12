'use client';

import { useTranslations } from 'next-intl';
import type { EntitlementKey } from '@superapp/shared';
import { Chip } from '@/components/ui';
import { useEntitlement, type EntitlementView } from '@/lib/hooks/useEntitlements';

// ============================================================
// Замок у действия: объяснение, почему кнопка выключена, — видимое без наведения
// (телефон), связывается с кнопкой через aria-describedby. Кнопок покупки/заявки
// НЕТ (решение продукта): личный контекст — «доступно на тарифе X», организация —
// «лимит тарифа организации, решает владелец».
// ============================================================

export function lockTextOf(view: EntitlementView, t: ReturnType<typeof useTranslations<'entitlements'>>): string {
  if (view.unlock.by === 'workspace_owner') return t('lock.workspace');
  if (view.kind === 'quota') return view.unlock.plan ? t('lock.self', { plan: t(`plans.${view.unlock.plan}`) }) : t('lock.quotaFull');
  return view.unlock.plan ? t('lock.self', { plan: t(`plans.${view.unlock.plan}`) }) : t('lock.selfNoPlan');
}

/** Хук для кнопки: `disabled` + `aria-describedby` к чипу-объяснению. */
export function useEntitlementGate(keyName: EntitlementKey, workspaceId?: string | null, id?: string) {
  const view = useEntitlement(keyName, workspaceId);
  const lockId = id ?? `ent-lock-${keyName.replace(/\W/g, '-')}`;
  return { view, blocked: view.blocked, lockId, describedBy: view.blocked ? lockId : undefined };
}

export function EntitlementLock({
  keyName,
  workspaceId,
  id,
}: {
  keyName: EntitlementKey;
  workspaceId?: string | null;
  /** id для aria-describedby кнопки (по умолчанию — из ключа) */
  id?: string;
}) {
  const view = useEntitlement(keyName, workspaceId);
  const t = useTranslations('entitlements');
  if (view.loading || !view.blocked) return null;
  const lockId = id ?? `ent-lock-${keyName.replace(/\W/g, '-')}`;
  return (
    <span id={lockId} style={{ display: 'inline-flex' }}>
      <Chip tone="neutral" icon="lock" size="sm">
        {lockTextOf(view, t)}
      </Chip>
    </span>
  );
}
