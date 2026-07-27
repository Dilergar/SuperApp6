'use client';

// ============================================================
// Calendar (сетка месяца) и DatePicker (поле + всплывающая сетка).
//
// Неделя с понедельника. Даты сравниваются по ЛОКАЛЬНЫМ частям (год-месяц-
// день), а не по timestamp: сравнение через toISOString даёт вчерашнее число
// восточнее Гринвича — у нас пояс +05, и «сегодня» подсвечивалось бы неверно.
// ============================================================
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { Field } from './Input';
import { IconButton } from './Button';
import { cx } from './tones';
import { usePopover } from './usePopover';

const MONTHS = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

/** Ключ локального дня — для сравнения без часовых поясов. */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Сколько пустых ячеек перед 1-м числом при неделе с понедельника. */
function leadingBlanks(year: number, month: number): number {
  return (new Date(year, month, 1).getDay() + 6) % 7;
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

export interface CalendarProps {
  value: Date | null;
  onChange: (date: Date) => void;
  /** Месяц, показанный при открытии (по умолчанию — месяц значения или текущий). */
  defaultMonth?: Date;
  min?: Date;
  max?: Date;
  className?: string;
}

export function Calendar({ value, onChange, defaultMonth, min, max, className }: CalendarProps) {
  const start = value ?? defaultMonth ?? new Date();
  const [cursor, setCursor] = useState(() => new Date(start.getFullYear(), start.getMonth(), 1));

  const today = useMemo(() => new Date(), []);
  const y = cursor.getFullYear();
  const m = cursor.getMonth();
  const blanks = leadingBlanks(y, m);
  const total = daysInMonth(y, m);

  const selectedKey = value ? dayKey(value) : null;
  const todayKey = dayKey(today);

  function disabled(d: Date) {
    if (min && d < new Date(min.getFullYear(), min.getMonth(), min.getDate())) return true;
    if (max && d > new Date(max.getFullYear(), max.getMonth(), max.getDate())) return true;
    return false;
  }

  return (
    <div className={cx(className)}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--spacing-3)' }}>
        <div className="title-sm">{MONTHS[m]} {y}</div>
        <div style={{ display: 'flex', gap: '0.25rem' }}>
          <IconButton icon="caretLeft" label="Предыдущий месяц" size={26} iconSize={13} onClick={() => setCursor(new Date(y, m - 1, 1))} />
          <IconButton icon="caretRight" label="Следующий месяц" size={26} iconSize={13} onClick={() => setCursor(new Date(y, m + 1, 1))} />
        </div>
      </div>

      <div className="ui-cal-grid" style={{ marginBottom: '0.25rem' }}>
        {WEEKDAYS.map((w) => (
          <div key={w} style={{ textAlign: 'center', fontSize: '0.5625rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--label)' }}>
            {w}
          </div>
        ))}
      </div>

      <div className="ui-cal-grid" role="grid">
        {Array.from({ length: blanks }, (_, i) => <span key={`b${i}`} aria-hidden />)}
        {Array.from({ length: total }, (_, i) => {
          const d = new Date(y, m, i + 1);
          const k = dayKey(d);
          const off = disabled(d);
          return (
            <button
              key={k}
              type="button"
              className="ui-cal-day"
              aria-selected={k === selectedKey}
              data-today={k === todayKey ? 'true' : 'false'}
              disabled={off}
              onClick={() => onChange(d)}
            >
              {i + 1}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export interface DatePickerProps {
  value: Date | null;
  onChange: (date: Date | null) => void;
  label?: string;
  hint?: string;
  error?: string | null;
  placeholder?: string;
  min?: Date;
  max?: Date;
  disabled?: boolean;
  clearable?: boolean;
  width?: number | string;
  className?: string;
}

function formatDate(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

export function DatePicker({
  value,
  onChange,
  label,
  hint,
  error,
  placeholder = 'Выберите дату',
  min,
  max,
  disabled,
  clearable = true,
  width,
  className,
}: DatePickerProps) {
  const { anchorRef, layerRef, open, setOpen, layerStyle } = usePopover<HTMLButtonElement>({ maxHeight: 340 });
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const body = (
    <div className={cx(className)} style={{ width }}>
      <button
        ref={anchorRef}
        type="button"
        className="ui-select-trigger"
        data-placeholder={value ? 'false' : 'true'}
        style={error ? { borderColor: 'var(--danger-base)' } : undefined}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Icon name="calendar" size={16} style={{ color: 'var(--label)' }} />
        <span>{value ? formatDate(value) : placeholder}</span>
        {clearable && value && !disabled ? (
          <span
            role="button"
            tabIndex={0}
            aria-label="Очистить дату"
            style={{ marginLeft: 'auto', display: 'inline-flex', opacity: 0.6 }}
            onClick={(e) => { e.stopPropagation(); onChange(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onChange(null); } }}
          >
            <Icon name="close" size={13} />
          </span>
        ) : (
          <Icon name="caretDown" size={14} style={{ marginLeft: 'auto', color: 'var(--label)' }} />
        )}
      </button>

      {open && mounted &&
        createPortal(
          <div ref={layerRef} className="ui-popover" style={{ ...layerStyle, width: 288, padding: 'var(--spacing-4)' }} role="dialog" aria-label="Выбор даты">
            <Calendar
              value={value}
              min={min}
              max={max}
              onChange={(d) => { onChange(d); setOpen(false); anchorRef.current?.focus(); }}
            />
          </div>,
          document.body,
        )}
    </div>
  );

  if (!label && !hint && !error) return body;
  return <Field label={label} hint={hint} error={error}>{body}</Field>;
}
