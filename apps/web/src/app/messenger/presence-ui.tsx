'use client';

import { useTranslations } from 'next-intl';
import type { PresenceInfo } from '@superapp/shared';
import { useFormatters } from '@/lib/format';

// ============================================================
// Presence presentation helpers (Phase 4) — shared between the
// messenger conversation header, chat-list dots and PersonCard.
// Sketchbook look: warm secondary green, no 1px gray borders.
// ============================================================

/**
 * «Был(а) в сети» относительным временем НА ЯЗЫКЕ ЗРИТЕЛЯ.
 *
 * Раньше здесь жил свой русский склонятель (`plural(n, 'мин', 'мин', 'мин')`) и
 * `toLocaleDateString('ru-RU')` — то есть и язык, и регион были зашиты навсегда.
 * Множественное число — правило ЯЗЫКА, и живёт оно ICU-веткой в каталоге.
 */
export function useLastSeen(): (iso: string) => string {
  const t = useTranslations('common');
  const f = useFormatters();
  return (iso: string) => {
    const diffSec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (diffSec < 60) return t('presence.justNow');

    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return t('presence.minutesAgo', { n: diffMin });

    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return t('presence.hoursAgo', { n: diffHr });

    return t('presence.at', { date: f.date(iso, 'dayMonth'), time: f.time(iso) });
  };
}

/**
 * Строка присутствия собеседника, по приоритету:
 *   контекст («На тренировке до 19:00») > в сети > был(а) в сети > ничего.
 * Печатает — забота вызывающего (это сильнее всего перечисленного).
 */
export function usePresenceLine(): (p: PresenceInfo | null | undefined) => string | null {
  const t = useTranslations('common');
  const lastSeen = useLastSeen();
  return (p) => {
    if (!p) return null;
    if (p.contextual) return p.contextual.label;
    if (p.online) return t('presence.online');
    if (p.lastSeen) return t('presence.lastSeen', { when: lastSeen(p.lastSeen) });
    // Человек не показывает этому зрителю точное время (его «Был в сети» или взаимность) —
    // только корзина «недавно / на неделе / в месяце / давно» (core/visibility, time_bucket)
    if (p.lastSeenBucket) return t(`guarded.presence.${p.lastSeenBucket}`);
    return null;
  };
}

/**
 * Small green presence dot for an avatar corner — crayon-style irregular
 * circle in the secondary green, ringed by the surface so it reads on paper.
 */
export function OnlineDot({ size = 11 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden
      style={{
        position: 'absolute',
        bottom: -1,
        right: -1,
        zIndex: 2,
        filter: 'drop-shadow(0 1px 2px rgba(0, 0, 0, 0.2))',
      }}
    >
      <path
        d="M8 2 C10 1.8, 13 3.5, 13.5 6 C14 8.5, 13 12, 10 13.5 C7.5 14.5, 3.5 13, 2.5 10 C1.5 7, 2.5 3, 5 2.2 C6.5 1.8, 7.5 2, 8 2Z"
        fill="var(--secondary)"
        stroke="var(--surface-container-low)"
        strokeWidth="2"
      />
    </svg>
  );
}
