'use client';

import type { MessageDeliveryStatus, CardSkinRender } from '@superapp/shared';
import { usePersonSkin } from '@/lib/person-skins';

// ============================================================
// Small presentational helpers shared across the Messenger UI.
// Sketchbook look: warm paper layers, no 1px gray borders.
// ============================================================

/**
 * Initials/photo block — mirrors the circles Avatar. When a `skin` is given it
 * adopts the person's skin colors + frame ring (the small-size skin surface).
 */
export function Avatar({
  name,
  avatar,
  size = 'md',
  skin,
}: {
  name: string;
  avatar?: string | null;
  size?: 'sm' | 'md' | 'lg';
  skin?: CardSkinRender | null;
}) {
  const dims = size === 'lg' ? '3rem' : size === 'sm' ? '2rem' : '2.6rem';
  const fs = size === 'lg' ? '1.2rem' : size === 'sm' ? '0.8rem' : '1rem';
  const initial = (name || '?').charAt(0).toUpperCase();
  const t = skin?.tokens;
  const radius = t?.avatarRadius || 'var(--radius-sketch)';

  const inner = avatar ? (
    <img
      src={avatar}
      alt={name}
      style={{
        width: dims, height: dims, borderRadius: radius, objectFit: 'cover',
        flexShrink: 0, border: t?.avatarInnerBorder,
      }}
    />
  ) : (
    <div
      style={{
        width: dims, height: dims, borderRadius: radius,
        background: t?.avatarBg || 'var(--secondary-container)',
        color: t?.avatarColor || 'var(--secondary)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: fs,
        flexShrink: 0, border: t?.avatarInnerBorder,
      }}
    >
      {initial}
    </div>
  );

  // No skin → plain avatar. With a skin → wrap in the skin's frame ring.
  if (!t) return inner;
  return (
    <div style={{ display: 'inline-flex', padding: 2, borderRadius: radius, border: t.avatarRing, flexShrink: 0 }}>
      {inner}
    </div>
  );
}

/**
 * Reusable "person avatar" — resolves the person's equipped skin (batched +
 * cached) and renders the skin-aware Avatar. Use this anywhere a person is
 * shown so the skin is consistent everywhere. Falls back to the plain avatar
 * when there is no userId or no equipped skin.
 */
export function PersonAvatar({
  userId,
  name,
  avatar,
  size = 'md',
}: {
  userId?: string | null;
  name: string;
  avatar?: string | null;
  size?: 'sm' | 'md' | 'lg';
}) {
  const skin = usePersonSkin(userId);
  return <Avatar name={name} avatar={avatar} size={size} skin={skin} />;
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
