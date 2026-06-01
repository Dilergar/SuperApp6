'use client';

import type { PresenceInfo } from '@superapp/shared';

// ============================================================
// Presence presentation helpers (Phase 4) — shared between the
// messenger conversation header, chat-list dots and PersonCard.
// Sketchbook look: warm secondary green, no 1px gray borders.
// ============================================================

/**
 * Russian relative "был(а) в сети" formatter:
 *   только что / N мин назад / N ч назад / dd.MM в HH:MM.
 */
export function formatLastSeen(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffSec = Math.max(0, Math.floor((now - then) / 1000));

  if (diffSec < 60) return 'только что';

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} ${plural(diffMin, 'мин', 'мин', 'мин')} назад`;

  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} ${plural(diffHr, 'час', 'часа', 'часов')} назад`;

  const d = new Date(iso);
  const date = d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return `${date} в ${time}`;
}

/** Russian plural picker (1 мин / 2 минуты-form / 5 минут-form). */
function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/**
 * Single-line status string for a DM peer, by priority:
 *   contextual ("На тренировке до 19:00") > online ("в сети") >
 *   lastSeen ("был(а) в сети <relative>") > null.
 * Typing is handled by the caller (it outranks all of these).
 */
export function presenceStatusLine(p: PresenceInfo | null | undefined): string | null {
  if (!p) return null;
  if (p.contextual) return p.contextual.label;
  if (p.online) return 'в сети';
  if (p.lastSeen) return `был(а) в сети ${formatLastSeen(p.lastSeen)}`;
  return null;
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
        filter: 'drop-shadow(0 1px 2px rgba(56, 57, 45, 0.2))',
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
