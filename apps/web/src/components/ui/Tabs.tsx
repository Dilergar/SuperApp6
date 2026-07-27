'use client';

// ============================================================
// SegmentedControl (пилюля-переключатель из топбара) и Tabs (вкладки
// раздела с подчёркиванием). Оба — с клавиатурой по стрелкам.
// ============================================================
import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { Badge } from './Chip';
import { cx } from './tones';

export interface TabItem<K extends string = string> {
  key: K;
  label: ReactNode;
  icon?: IconName;
  /** Счётчик справа от подписи. */
  count?: number;
  disabled?: boolean;
}

interface BaseProps<K extends string> {
  items: TabItem<K>[];
  value: K;
  onChange: (key: K) => void;
  className?: string;
  'aria-label'?: string;
}

function useArrowNav<K extends string>(items: TabItem<K>[], value: K, onChange: (k: K) => void) {
  return (e: React.KeyboardEvent) => {
    const isArrow = e.key === 'ArrowRight' || e.key === 'ArrowLeft';
    const isEdge = e.key === 'Home' || e.key === 'End';
    if (!isArrow && !isEdge) return;
    e.preventDefault();
    const usable = items.filter((i) => !i.disabled);
    if (usable.length === 0) return;
    let next: TabItem<K>;
    if (e.key === 'Home') next = usable[0];
    else if (e.key === 'End') next = usable[usable.length - 1];
    else {
      const step = e.key === 'ArrowRight' ? 1 : -1;
      const cur = usable.findIndex((i) => i.key === value);
      next = usable[(cur + step + usable.length) % usable.length];
    }
    onChange(next.key);
    // Roving tabindex обязан ПЕРЕНОСИТЬ фокус: без .focus() кольцо остаётся на
    // старой кнопке, у которой уже tabIndex=-1, и следующая Tab-навигация ломается.
    e.currentTarget.querySelector<HTMLElement>(`[data-key="${CSS.escape(next.key)}"]`)?.focus();
  };
}

/**
 * Сегменты — это фильтр-пилюля, а не вкладки: role="group" + aria-pressed.
 * role="tablist" без связанных tabpanel был бы ложью для скринридера.
 */
export function SegmentedControl<K extends string = string>({ items, value, onChange, className, ...aria }: BaseProps<K>) {
  const onKeyDown = useArrowNav(items, value, onChange);
  return (
    <div className={cx('ui-segment', className)} role="group" aria-label={aria['aria-label']} onKeyDown={onKeyDown}>
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          data-key={it.key}
          className="ui-segment-item"
          aria-pressed={it.key === value}
          tabIndex={it.key === value ? 0 : -1}
          disabled={it.disabled}
          onClick={() => onChange(it.key)}
        >
          {it.icon && <Icon name={it.icon} size={15} style={{ marginRight: '0.35rem', verticalAlign: '-2px' }} />}
          {it.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<K extends string = string>({ items, value, onChange, className, ...aria }: BaseProps<K>) {
  const onKeyDown = useArrowNav(items, value, onChange);
  return (
    <div className={cx('ui-tabs', className)} role="tablist" aria-label={aria['aria-label']} onKeyDown={onKeyDown}>
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          data-key={it.key}
          role="tab"
          className="ui-tab"
          aria-selected={it.key === value}
          tabIndex={it.key === value ? 0 : -1}
          disabled={it.disabled}
          onClick={() => onChange(it.key)}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
            {it.icon && <Icon name={it.icon} size={16} />}
            {it.label}
            {it.count !== undefined && it.count > 0 && <Badge tone="neutral">{it.count}</Badge>}
          </span>
        </button>
      ))}
    </div>
  );
}
