'use client';

import type { MessageDeliveryStatus } from '@superapp/shared';

// ============================================================
// Small presentational helpers shared across the Messenger UI.
// Sketchbook look: warm paper layers, no 1px gray borders.
// ============================================================

/** Initials block — mirrors the circles Avatar (irregular rounding, blue crayon). */
export function Avatar({
  name,
  avatar,
  size = 'md',
}: {
  name: string;
  avatar?: string | null;
  size?: 'sm' | 'md' | 'lg';
}) {
  const dims = size === 'lg' ? '3rem' : size === 'sm' ? '2rem' : '2.6rem';
  const fs = size === 'lg' ? '1.2rem' : size === 'sm' ? '0.8rem' : '1rem';
  const initial = (name || '?').charAt(0).toUpperCase();

  if (avatar) {
    return (
      <img
        src={avatar}
        alt={name}
        style={{
          width: dims,
          height: dims,
          borderRadius: 'var(--radius-sketch)',
          objectFit: 'cover',
          flexShrink: 0,
        }}
      />
    );
  }

  return (
    <div
      style={{
        width: dims,
        height: dims,
        borderRadius: 'var(--radius-sketch)',
        background: 'var(--secondary-container)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'var(--font-display)',
        fontWeight: 700,
        fontSize: fs,
        color: 'var(--secondary)',
        flexShrink: 0,
      }}
    >
      {initial}
    </div>
  );
}

/** Delivery ticks on MY messages: ✓ sent / ✓✓ delivered / ✓✓ (blue) read. */
export function StatusTicks({ status }: { status?: MessageDeliveryStatus }) {
  if (!status) return null;
  const read = status === 'read';
  const doubled = status === 'delivered' || status === 'read';
  return (
    <span
      title={status === 'sent' ? 'Отправлено' : status === 'delivered' ? 'Доставлено' : 'Прочитано'}
      style={{
        fontSize: '0.7rem',
        letterSpacing: '-0.18em',
        marginLeft: '0.15rem',
        color: read ? 'var(--secondary)' : 'rgba(255,255,255,0.75)',
        fontWeight: 700,
      }}
    >
      {doubled ? '✓✓' : '✓'}
    </span>
  );
}

// ---- time formatting (ru-RU) ----

/** Short relative-ish label for the inbox list. */
export function formatListTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'вчера';

  const days = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (days < 7) return d.toLocaleDateString('ru-RU', { weekday: 'short' });
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

/** Clock under a message bubble. */
export function formatBubbleTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}
