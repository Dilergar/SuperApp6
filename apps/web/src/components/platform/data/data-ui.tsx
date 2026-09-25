'use client';

import { useTranslations } from 'next-intl';
import type { LifecycleAttentionCode, LifecycleHealthLevel } from '@superapp/shared';
import { Chip, type Tone } from '@/components/ui';

/** Светофор плитки: цвет — только тон чипа, красный лишь у критического (план §11.4). */
export const LEVEL_TONE: Record<LifecycleHealthLevel, Tone> = { ok: 'success', warning: 'warning', critical: 'danger', unknown: 'neutral' };
const LEVEL_ICON = { ok: 'checkCircle', warning: 'warning', critical: 'warningCircle', unknown: 'hourglass' } as const;

export function LevelChip({ level }: { level: LifecycleHealthLevel }) {
  const t = useTranslations('platform');
  return (
    <Chip size="sm" tone={LEVEL_TONE[level]} icon={LEVEL_ICON[level]}>
      {t(`data.level.${level}`)}
    </Chip>
  );
}

export type DataTab = 'overview' | 'storage' | 'retention' | 'erasure' | 'backups' | 'canary';
export const DATA_TABS: readonly DataTab[] = ['overview', 'storage', 'retention', 'erasure', 'backups', 'canary'];

/** Куда ведёт строка «Нужно внимание» — вкладка, где лечится причина. */
export const ATTENTION_TAB: Record<LifecycleAttentionCode, DataTab> = {
  backup_never: 'backups',
  backup_missing: 'backups',
  backup_failed: 'backups',
  drill_failed: 'backups',
  partition_runway_low: 'storage',
  detach_pending: 'storage',
  retention_lag: 'retention',
  erasure_stuck: 'erasure',
  erasure_held: 'erasure',
  canary_failed: 'canary',
  canary_unseeded: 'canary',
  xid_age_high: 'storage',
  replica_lag: 'storage',
  invalid_indexes: 'storage',
};

/** Факт плитки: подпись слева, значение справа. */
export function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--spacing-3)', alignItems: 'baseline' }}>
      <span className="label-sm">{label}</span>
      <span className="body-sm" style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>{value}</span>
    </div>
  );
}
