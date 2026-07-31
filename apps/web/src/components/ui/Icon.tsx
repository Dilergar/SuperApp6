// ============================================================
// <Icon /> — единственный способ нарисовать интерфейсную иконку.
//
// Правило системы (DESIGN.md): интерфейсные иконки — Phosphor, начертание
// Light (тонкий штрих ~1.5px). Прямой импорт из '@phosphor-icons/react' в
// страницах ЗАПРЕЩЁН — иначе набор расползётся, а сменить поставщика иконок
// станет невозможно.
//
// Рисунки живут в СТАТИЧЕСКОМ СПРАЙТЕ /icons/sprite.svg (вечный кэш в
// next.config.ts), компонент рисует <use href>. Раньше сюда импортировались
// компоненты @phosphor-icons/react, и каждый def-модуль тянул в чанк кита ВСЕ
// 6 начертаний (~60–80 КБ gzip лишних на каждой странице) — теперь пакет в
// рантайм-бандле не участвует вовсе.
//
// КАК ДОБАВИТЬ ИКОНКУ: строка в icons.manifest.json (семантический ключ →
// имя компонента Phosphor, ключ описывает СМЫСЛ — «delete», а не «trash»)
// → pnpm --filter ./apps/web gen:icons (пересобирает спрайт; незнакомое имя
// валит сборку списком, молча пустых иконок не бывает).
//
// Эмодзи, которые пользователь выбрал САМ и которые лежат в БД (иконка
// Группы, своей валюты, категории финансов, лота, хотелки), иконками НЕ
// заменяются — они остаются эмодзи и подаются через <EmojiIcon/>.
// ============================================================
import manifest from './icons.manifest.json';
import { ICON_SPRITE_URL } from './icon-sprite.generated';
import { memo, type CSSProperties } from 'react';

/**
 * Реестр иконок: семантический ключ → имя иконки Phosphor (для генератора
 * спрайта). Потребителям реестр нужен как НАБОР КЛЮЧЕЙ: `name in ICONS`
 * (глифы, паспорта нод Процессов) и `Object.keys(ICONS)` (витрина /dev/ui).
 */
export const ICONS = manifest;

export type IconName = keyof typeof ICONS;

export interface IconProps {
  name: IconName;
  /** Размер в px. Нав — 20, в карточках 16–22. */
  size?: number;
  /** По умолчанию наследует цвет текста. */
  color?: string;
  className?: string;
  style?: CSSProperties;
  /** Иконка декоративная (по умолчанию) — скрыта от скринридеров.
   *  Если иконка единственный смысл кнопки, передай подпись. */
  label?: string;
}

// memo: иконка — самый массовый компонент приложения (строки списков, меню,
// карточки); пропсы примитивные, так что ре-рендер родителя не перестраивает SVG.
export const Icon = memo(function Icon({ name, size = 20, color, className, style, label }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill={color ?? 'currentColor'}
      className={className}
      style={{ flex: 'none', ...style }}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
    >
      <use href={`${ICON_SPRITE_URL}#${name}`} />
    </svg>
  );
});

// EmojiIcon (значок в матовом круге) переехал в Glyph.tsx — туда же, где живёт
// разбор значения значка. Иначе получалось кольцо импортов: Glyph берёт отсюда
// Icon, а Icon брал бы оттуда разбор.
