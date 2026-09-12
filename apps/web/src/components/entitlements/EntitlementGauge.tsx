'use client';

import type { CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import type { EntitlementKey } from '@superapp/shared';
import { Chip, TickBar, type Tone } from '@/components/ui';
import { useEntitlement, type EntitlementView } from '@/lib/hooks/useEntitlements';
import { useBytes } from '@/lib/format';

// ============================================================
// Счётчик рядом с действием создания: «12 из 50» чипом — нейтральный до 80 %,
// warning от 80 %, danger на 100 %; квота в байтах — штриховой TickBar с подписью.
// Без ограничения — ничего не рисуем (не шумим). Только кит, своих стилей нет.
// ============================================================

export function toneOf(view: EntitlementView): Tone {
  if (view.ratio >= 1) return 'danger';
  if (view.ratio >= 0.8) return 'warning';
  return 'neutral';
}

export function EntitlementGauge({
  keyName,
  workspaceId,
  style,
}: {
  keyName: EntitlementKey;
  workspaceId?: string | null;
  style?: CSSProperties;
}) {
  const view = useEntitlement(keyName, workspaceId);
  const t = useTranslations('entitlements');
  const bytes = useBytes();
  if (view.loading || view.unlimited || view.used === null || typeof view.value !== 'number') return null;
  const tone = toneOf(view);
  if (view.unit === 'bytes') {
    return (
      <div style={{ minWidth: '12rem', ...style }}>
        <TickBar value={view.ratio * 100} tone={tone} label={t('gauge.usedOf', { used: bytes(view.used), total: bytes(view.value) })} />
      </div>
    );
  }
  return (
    <Chip tone={tone} size="sm" title={t(view.labelKey.replace(/^entitlements\./, ''))} style={style}>
      {t('gauge.of', { used: view.used, total: view.value })}
    </Chip>
  );
}
