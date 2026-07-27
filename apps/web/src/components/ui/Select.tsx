'use client';

// ============================================================
// Select — замена нативного <select> (их в приложении было 57).
//
// Нативный не годится системе: в него нельзя положить иконку, эмодзи-кружок
// или цветную метку, и он рисуется средствами ОС — то есть выпадает из
// дизайна на каждом экране. Здесь — свой список с клавиатурой и порталом.
//
// Для выбора ЧЕЛОВЕКА или ГРУППЫ это не тот компонент: там EntitySelector
// (он показывает карточку человека, чего требует продуктовое правило).
// ============================================================
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icon';
import { Field } from './Input';
import { cx } from './tones';
import { usePopover } from './usePopover';

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
  /** Иконка кита слева. */
  icon?: IconName;
  /** Эмодзи (пользовательские иконки из БД) — вместо icon. */
  emoji?: string | null;
  /** Цветная точка (статусы, цвета событий). */
  color?: string;
  hint?: string;
  disabled?: boolean;
}

export interface SelectProps<V extends string = string> {
  value: V | null;
  onChange: (value: V) => void;
  options: SelectOption<V>[];
  placeholder?: string;
  label?: string;
  hint?: string;
  error?: string | null;
  disabled?: boolean;
  /** Ширина обёртки. */
  width?: number | string;
  className?: string;
  id?: string;
  'aria-label'?: string;
}

export function Select<V extends string = string>({
  value,
  onChange,
  options,
  placeholder = 'Выберите…',
  label,
  hint,
  error,
  disabled,
  width,
  className,
  id,
  'aria-label': ariaLabel,
}: SelectProps<V>) {
  const { anchorRef, layerRef, open, setOpen, layerStyle } = usePopover<HTMLButtonElement>({ matchWidth: true });
  const [active, setActive] = useState(0);
  const [mounted, setMounted] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Прокручиваем список к активному пункту ТОЛЬКО после клавиатуры: скролл от
  // mouseenter двигал бы список под курсором → mouseenter на соседе → снова
  // скролл — самопроизвольная прокрутка.
  const kbdNav = useRef(false);

  useEffect(() => setMounted(true), []);

  // id-обвязка для скринридера: label→триггер, триггер→список, activedescendant
  const autoId = useId();
  const triggerId = id ?? autoId;
  const listboxId = `${triggerId}-list`;
  const descId = `${triggerId}-desc`;

  const selected = options.find((o) => o.value === value) ?? null;

  useEffect(() => {
    if (!open) return;
    const idx = options.findIndex((o) => o.value === value);
    setActive(idx >= 0 ? idx : 0);
  }, [open, options, value]);

  // Держим подсвеченный пункт в поле зрения при навигации стрелками
  useEffect(() => {
    if (!open || !kbdNav.current) return;
    kbdNav.current = false;
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  function move(step: number) {
    kbdNav.current = true;
    setActive((cur) => {
      let i = cur;
      for (let guard = 0; guard < options.length; guard += 1) {
        i = (i + step + options.length) % options.length;
        if (!options[i]?.disabled) return i;
      }
      return cur;
    });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Home') { e.preventDefault(); kbdNav.current = true; setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); kbdNav.current = true; setActive(options.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const opt = options[active];
      if (opt && !opt.disabled) { onChange(opt.value); setOpen(false); anchorRef.current?.focus(); }
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  }

  const trigger = (
    <button
      ref={anchorRef}
      id={triggerId}
      type="button"
      className="ui-select-trigger"
      data-placeholder={selected ? 'false' : 'true'}
      style={error ? { borderColor: 'var(--danger-base)' } : undefined}
      disabled={disabled}
      onClick={() => setOpen(!open)}
      onKeyDown={onKeyDown}
      role="combobox"
      aria-expanded={open}
      aria-haspopup="listbox"
      aria-controls={open ? listboxId : undefined}
      aria-activedescendant={open ? `${triggerId}-opt-${active}` : undefined}
      aria-label={ariaLabel ?? label}
      aria-invalid={error ? true : undefined}
      aria-describedby={error || hint ? descId : undefined}
    >
      <OptionFace opt={selected} placeholder={placeholder} />
      <Icon name="caretDown" size={14} style={{ marginLeft: 'auto', color: 'var(--label)' }} />
    </button>
  );

  const layer = open && mounted
    ? createPortal(
        <div ref={layerRef} className="ui-popover" style={layerStyle}>
          {/* role=listbox — на контейнере опций БЕЗ промежуточных узлов:
              generic-элемент между listbox и option рвёт родство ролей */}
          <div ref={listRef} id={listboxId} role="listbox" aria-label={ariaLabel ?? label}>
            {options.length === 0 && (
              <div style={{ padding: '0.75rem', fontSize: '0.75rem', color: 'var(--muted)' }}>Ничего нет</div>
            )}
            {options.map((o, i) => (
              <button
                key={o.value}
                type="button"
                id={`${triggerId}-opt-${i}`}
                data-idx={i}
                className="ui-option"
                data-selected={o.value === value ? 'true' : 'false'}
                data-active={i === active ? 'true' : 'false'}
                disabled={o.disabled}
                role="option"
                aria-selected={o.value === value}
                onMouseEnter={() => setActive(i)}
                onClick={() => { onChange(o.value); setOpen(false); anchorRef.current?.focus(); }}
              >
                <OptionFace opt={o} />
                {o.value === value && <Icon name="check" size={14} style={{ marginLeft: 'auto' }} />}
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )
    : null;

  const body = (
    <div className={cx(className)} style={{ width }}>
      {trigger}
      {layer}
    </div>
  );

  if (!label && !hint && !error) return body;
  return <Field label={label} hint={hint} error={error} htmlFor={triggerId} descId={descId}>{body}</Field>;
}

function OptionFace<V extends string>({ opt, placeholder }: { opt: SelectOption<V> | null; placeholder?: string }) {
  if (!opt) return <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{placeholder}</span>;
  return (
    <>
      {opt.color && (
        <span style={{ width: 8, height: 8, minWidth: 8, borderRadius: '50%', background: opt.color }} aria-hidden />
      )}
      {opt.emoji && <span aria-hidden style={{ fontSize: '0.9rem', lineHeight: 1 }}>{opt.emoji}</span>}
      {opt.icon && <Icon name={opt.icon} size={16} />}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{opt.label}</span>
      {opt.hint && <span style={{ fontSize: '0.6875rem', color: 'var(--muted)', fontWeight: 500 }}>{opt.hint}</span>}
    </>
  );
}
