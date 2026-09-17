'use client';

// Статус ключа/бота/endpoint'а — ЧИП (смысл несёт форма): живой — успех, истекает —
// предупреждение, заморожен / ждёт проверки — ожидание (мяч у владельца), отозван и
// истёк — нейтральный с замком.

import { memo } from 'react';
import { useTranslations } from 'next-intl';
import type { ApiKeyStatus, WebhookEndpointStatus } from '@superapp/shared';
import { Chip, type IconName, type Tone } from '@/components/ui';

export type AnyKeyStatus = ApiKeyStatus | WebhookEndpointStatus;

const TONE: Record<AnyKeyStatus, Tone> = {
  active: 'success',
  expiring: 'warning',
  expired: 'neutral',
  revoked: 'neutral',
  frozen: 'waiting',
  pending_verification: 'waiting',
  disabled: 'neutral',
};

const ICON: Partial<Record<AnyKeyStatus, IconName>> = {
  expiring: 'hourglass',
  expired: 'clock',
  revoked: 'lock',
  frozen: 'snowflake',
  pending_verification: 'hourglass',
  disabled: 'blocked',
};

export const KeyStatusChip = memo(function KeyStatusChip({ status, days, size = 'sm' }: { status: AnyKeyStatus; days?: number | null; size?: 'sm' | 'md' }) {
  const t = useTranslations('keys');
  const label = status === 'expiring' && typeof days === 'number' ? t('status.expiringIn', { days }) : t(`status.${status}`);
  return (
    <Chip tone={TONE[status]} icon={ICON[status]} size={size}>
      {label}
    </Chip>
  );
});
