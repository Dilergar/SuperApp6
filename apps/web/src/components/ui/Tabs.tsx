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
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const step = e.key === 'ArrowRight' ? 1 : -1;
    const cur = items.findIndex((i) => i.key === value);
    let i = cur;
    for (let guard = 0; guard < items.length; guard += 1) {
      i = (i + step + items.length) % items.length;
      if (!items[i]?.disabled) { onChange(items[i].key); return; }
    }
  };
}

export function SegmentedControl<K extends string = string>({ items, value, onChange, className, ...aria }: BaseProps<K>) {
  const onKeyDown = useArrowNav(items, value, onChange);
  return (
    <div className={cx('ui-segment', className)} role="tablist" aria-label={aria['aria-label']} onKeyDown={onKeyDown}>
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          role="tab"
          className="ui-segment-item"
          aria-selected={it.key === value}
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
