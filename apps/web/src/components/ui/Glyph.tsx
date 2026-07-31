'use client';

// ============================================================
// Glyph — ЕДИНСТВЕННОЕ место, где решается «как нарисовать значок».
//
// До него эта логика была скопирована четырежды (FinGlyph в Финансах,
// EntityGlyph в Окружении, CardGlyph в мессенджере, ручные проверки
// `icon in ICONS`), и каждая копия знала только про два случая из пяти.
// Теперь все они — тонкие обёртки над этим компонентом.
// ============================================================

import { memo, type CSSProperties } from 'react';
import { Icon, type IconName } from './Icon';
import { fluentUrl, parseGlyph, useIconPaths } from './glyph-data';
import { toneVars, type Tone } from './tones';

/** Предметная иконка каталога: контур приезжает из /glyphs/icons.json. */
const ObjectIcon = memo(function ObjectIcon({ name, size }: { name: string; size: number }) {
  const paths = useIconPaths();
  const d = paths?.[name];
  // Пока файл не приехал (первая иконка за сессию) — пустая коробка того же
  // размера: подставлять чужую иконку нельзя, иначе значок «моргает» другим.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill="currentColor"
      aria-hidden
      // inline-block, а не block: значок встречается и ПОСРЕДИ строки текста
      // («держит 120 🪙»), где блочный элемент разрывает поток.
      style={{ flex: 'none', display: 'inline-block', verticalAlign: '-0.15em' }}
    >
      {d && <path d={d} />}
    </svg>
  );
});

export interface GlyphProps {
  /** Значение из БД: 'ph:car' | 'fl:1f697' | 'nt:1f697' | 'receipt' | '🚗'. */
  value: string | null | undefined;
  /** Оптический размер значка в px. */
  size?: number;
  /** Чем заполнить, если значка нет. */
  fallback?: IconName;
  /** Подпись для скринридера; без неё значок декоративный. */
  label?: string;
}

export const Glyph = memo(function Glyph({ value, size = 20, fallback, label }: GlyphProps) {
  const g = parseGlyph(value);

  if (g.kind === 'icon') return <Icon name={g.name} size={size} label={label} />;
  if (g.kind === 'object') return <ObjectIcon name={g.name} size={size} />;
  if (g.kind === 'image') {
    return (
      // Картинка, а не фон: так работает alt для скринридера и ленивая загрузка
      // (в сетке выбора видимых значков десятки, а всего их полторы тысячи).
      <img
        src={fluentUrl(g.hex)}
        width={size}
        height={size}
        alt={label ?? ''}
        aria-hidden={label ? undefined : true}
        loading="lazy"
        decoding="async"
        draggable={false}
        style={{ flex: 'none', display: 'inline-block', verticalAlign: '-0.15em', objectFit: 'contain' }}
      />
    );
  }
  if (g.kind === 'text') {
    return (
      <span
        className="ui-emoji"
        aria-hidden={label ? undefined : true}
        aria-label={label}
        role={label ? 'img' : undefined}
        style={{ fontSize: size, lineHeight: 1, flex: 'none' }}
      >
        {g.char}
      </span>
    );
  }
  return fallback ? <Icon name={fallback} size={size} label={label} /> : null;
});

/**
 * Значок в матовом круге/квадрате — так система подаёт ВЫБРАННЫЙ человеком
 * значок (Группа, валюта, категория, лот), чтобы он не выглядел случайным
 * рядом с тонким штрихом иконок. Приём из дизайн-пакета (иконки сервисов).
 *
 * Проп называется `emoji` по историческим причинам: раньше сюда приходил
 * только символ. Теперь это ЛЮБОЕ значение значка — разбирает его Glyph.
 */
export interface EmojiIconProps {
  emoji: string | null | undefined;
  /** Размер подложки в px. */
  size?: number;
  /** Матовый тон подложки. */
  tone?: Tone;
  /** Квадрат со скруглением вместо круга. */
  square?: boolean;
  /** Чем заполнить, если значка нет. */
  fallback?: IconName;
  className?: string;
  style?: CSSProperties;
}

// Своей карты тонов здесь нет намеренно: это была пятая копия одного и того же
// соответствия «тон → заливка+бордер». Тон раскладывается общим `toneVars`,
// поэтому новый тон системы подхватывается сам.

export function EmojiIcon({
  emoji,
  size = 34,
  tone = 'neutral',
  square = false,
  fallback,
  className,
  style,
}: EmojiIconProps) {
  return (
    <span
      className={className}
      style={{
        ...toneVars(tone),
        width: size,
        height: size,
        minWidth: size,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: square ? 'var(--radius-md)' : 'var(--radius-pill)',
        background: 'var(--tone-bg)',
        border: '1px solid var(--tone-border)',
        lineHeight: 1,
        ...style,
      }}
    >
      <Glyph value={emoji} size={Math.round(size * 0.54)} fallback={fallback} />
    </span>
  );
}
