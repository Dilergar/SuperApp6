// ============================================================
// Card Skins — render model (frontend)
//
// Types come from @superapp/shared (single source of truth, so backend skins
// render without drift). This file adds frontend-only bits: the built-in
// DEFAULT_SKIN, the size presets, and small helpers.
// ============================================================

import type { SkinRarity, CardSkinTokens, CardSkinRender } from '@superapp/shared';
export type { SkinRarity, CardSkinTokens, CardSkinRender };

export type CardSize = 'XL' | 'L' | 'M' | 'S' | 'XS';

/** Canonical rarity ladder — label + ring color (Diablo/WoW convention). */
export const RARITY_META: Record<SkinRarity, { label: string; color: string }> = {
  common: { label: 'Обычный', color: '#9a958a' },
  uncommon: { label: 'Необычный', color: '#2d7a3a' },
  rare: { label: 'Редкий', color: '#326a8b' },
  epic: { label: 'Эпический', color: '#7a3a8b' },
  legendary: { label: 'Легендарный', color: '#b8860b' },
  mythic: { label: 'Мифический', color: '#c61a1e' },
};

/** Built-in free skin — reproduces the current sketchbook look. */
export const DEFAULT_SKIN: CardSkinRender = {
  id: 'default',
  name: 'Скетчбук',
  rarity: 'common',
  decor: 'crayon',
  tokens: {
    cardBg: '#F4F1E8',
    cardBorder: '2px solid #CFC7B8',
    cardRadius: '1rem 1.5rem 1.2rem 1.4rem',
    cardShadow: '0 6px 24px rgba(56,57,45,0.08), 0 2px 8px rgba(198,26,30,0.04)',
    nameColor: 'var(--on-surface)',
    nameFont: 'var(--font-display)',
    metaColor: 'var(--on-surface-variant)',
    avatarBg: 'var(--secondary-container)',
    avatarColor: 'var(--secondary)',
    avatarRing: '2.5px solid rgba(167,159,144,0.4)',
    avatarInnerBorder: '2px solid rgba(207,199,184,0.55)',
    avatarRadius: '1rem 1.4rem 1.2rem 1.3rem',
    badgeBg: '#EADFC8',
    badgeColor: 'var(--on-surface)',
    badgeShadow: '0 0 0 1.5px rgba(207,199,184,0.5), 0 0 0 4px rgba(207,199,184,0.2)',
    accent: 'var(--primary)',
    effectPreset: null,
  },
};

/** Per-size behavior — WE decide what each size shows (not the user). */
export interface SizeConfig {
  avatar: number; // inner avatar px
  nameSize: string;
  metaSize: string;
  layout: 'stack' | 'row';
  padding: string;
  gap: string;
  showName: boolean;
  fields: 'all' | 'bio' | 'none';
  showPhone: boolean;
  showRole: boolean;
  showPresence: boolean;
  showRarity: boolean; // rarity shown only in XL
  effect: 'full' | 'subtle' | 'none'; // full = Lottie, subtle = light CSS, none = static
  fullLastName: boolean;
}

export const SIZE_CONFIG: Record<CardSize, SizeConfig> = {
  // XL — full detailed card, all info, Lottie effect, rarity
  XL: {
    avatar: 150, nameSize: '1.6rem', metaSize: '0.8rem', layout: 'stack',
    padding: 'var(--spacing-8) var(--spacing-6) var(--spacing-6)', gap: 'var(--spacing-3)',
    showName: true, fields: 'all', showPhone: true, showRole: true, showPresence: true,
    showRarity: true, effect: 'full', fullLastName: true,
  },
  // L — Имя Фамилия + «О себе» (if visible) + role. Uniform for 100+ grids. Lottie effect.
  L: {
    avatar: 96, nameSize: '1.25rem', metaSize: '0.75rem', layout: 'stack',
    padding: 'var(--spacing-6) var(--spacing-4)', gap: 'var(--spacing-2)',
    showName: true, fields: 'bio', showPhone: false, showRole: true, showPresence: false,
    showRarity: false, effect: 'full', fullLastName: true,
  },
  // M — avatar + name + role, one line. Comfortable list/picker card (task picker,
  // mention dropdown, shop, etc.). Light CSS effect.
  M: {
    avatar: 30, nameSize: '0.85rem', metaSize: '0.62rem', layout: 'row',
    padding: '0.25rem 0.5rem', gap: '0.4rem',
    showName: true, fields: 'none', showPhone: false, showRole: true, showPresence: false,
    showRarity: false, effect: 'subtle', fullLastName: false,
  },
  // S — avatar + name, one tight line (~1.7× shorter than M). Inline mentions. Light CSS.
  S: {
    avatar: 18, nameSize: '0.72rem', metaSize: '0.56rem', layout: 'row',
    padding: '0.08rem 0.3rem', gap: '0.25rem',
    showName: true, fields: 'none', showPhone: false, showRole: false, showPresence: false,
    showRarity: false, effect: 'subtle', fullLastName: false,
  },
  // XS — bare avatar only (skin frame), 2× smaller; tightest spots (e.g. calendar).
  XS: {
    avatar: 16, nameSize: '0.7rem', metaSize: '0.55rem', layout: 'row',
    padding: '0', gap: '0',
    showName: false, fields: 'none', showPhone: false, showRole: false, showPresence: false,
    showRarity: false, effect: 'none', fullLastName: false,
  },
};

/** First name + last-initial unless full last name is requested. */
export function displayName(first: string, last: string | null, fullLast: boolean): string {
  if (!last) return first;
  return fullLast ? `${first} ${last}` : `${first} ${last.charAt(0).toUpperCase()}.`;
}

export const CARD_SIZES: { key: CardSize; label: string }[] = [
  { key: 'XL', label: 'XL' },
  { key: 'L', label: 'L' },
  { key: 'M', label: 'M' },
  { key: 'S', label: 'S' },
  { key: 'XS', label: 'XS' },
];
