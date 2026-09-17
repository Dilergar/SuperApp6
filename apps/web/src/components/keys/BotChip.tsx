'use client';

// ============================================================
// Бот в интерфейсе — БОТ-ЧИП, не PersonChip (правило платформы §7.2: человек —
// карточка, бот — чип со значком). Три размера: xs (строка таблицы/хроники),
// sm (списки), md (карточка бота). Замороженный бот несёт точку ожидания.
// ============================================================

import { memo } from 'react';
import { useTranslations } from 'next-intl';
import type { BotFrozenReason, BotStatus } from '@superapp/shared';
import { Glyph, StatusDot, Tooltip } from '@/components/ui';

export type BotChipSize = 'xs' | 'sm' | 'md';

const AVATAR_PX: Record<BotChipSize, number> = { xs: 22, sm: 28, md: 40 };
const FONT: Record<BotChipSize, string> = { xs: '0.8rem', sm: '0.88rem', md: '1rem' };

/** Квадратный значок бота (аналог PersonAvatar): значок из реестра либо робот. */
export const BotAvatar = memo(function BotAvatar({ glyph, name, size = 'sm' }: { glyph?: string | null; name: string; size?: BotChipSize }) {
  const px = AVATAR_PX[size];
  return (
    <span
      role="img"
      aria-label={name}
      style={{
        width: px,
        height: px,
        minWidth: px,
        borderRadius: 'var(--radius-sm)',
        background: 'var(--surface-container)',
        border: '1px solid var(--outline-variant)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--on-surface-variant)',
      }}
    >
      <Glyph value={glyph} size={Math.round(px * 0.55)} fallback="robot" />
    </span>
  );
});

export const BotChip = memo(function BotChip({
  name,
  glyph,
  size = 'sm',
  status,
  frozenReason,
  rank,
  onClick,
}: {
  name: string;
  glyph?: string | null;
  size?: BotChipSize;
  status?: BotStatus | null;
  frozenReason?: BotFrozenReason | null;
  rank?: 'member' | 'manager' | null;
  onClick?: () => void;
}) {
  const t = useTranslations('keys');
  const frozen = status === 'frozen';
  const archived = status === 'archived';
  const body = (
    <span
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: size === 'md' ? 'var(--spacing-3)' : 'var(--spacing-2)',
        minWidth: 0,
        cursor: onClick ? 'pointer' : 'default',
        opacity: archived ? 0.6 : 1,
      }}
    >
      <BotAvatar glyph={glyph} name={name} size={size} />
      <span style={{ display: 'inline-flex', flexDirection: 'column', minWidth: 0 }}>
        <span style={{ fontSize: FONT[size], fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
          {name}
          {frozen && <StatusDot tone="waiting" title={t('status.frozen')} />}
        </span>
        {size === 'md' && (
          <span className="label-sm" style={{ opacity: 0.8 }}>
            {t('bot.kindLabel')}{rank ? ` · ${t(`bot.rank.${rank}`)}` : ''}
          </span>
        )}
      </span>
    </span>
  );
  if (frozen && frozenReason) return <Tooltip content={t(`frozenReason.${frozenReason}`)}>{body}</Tooltip>;
  return body;
});
