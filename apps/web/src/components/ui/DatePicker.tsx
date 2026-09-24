'use client';

// ============================================================
// Calendar (сетка месяца) и DatePicker (поле + всплывающая сетка).
//
// Неделя с понедельника. Даты сравниваются по ЛОКАЛЬНЫМ частям (год-месяц-
// день), а не по timestamp: сравнение через toISOString даёт вчерашнее число
// восточнее Гринвича — у нас пояс +05, и «сегодня» подсвечивалось бы неверно.
// ============================================================
import { useEffect, useId, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { Field } from './Input';
import { IconButton } from './Button';
import { cx } from './tones';
import { usePopover } from './usePopover';
import { useTranslations, useLocale } from 'next-intl';
import { formatDate as formatRegionDate } from '@superapp/i18n/format';
import type { Locale } from '@superapp/shared';

/**
 * Названия месяцев и дней недели даёт `Intl` НА ЯЗЫКЕ зрителя — своего массива
 * здесь быть не может: он был бы двенадцатью строками одного языка навсегда, и
 * в нём же пришлось бы держать склонения каждого следующего.
 *
 * Неделя начинается с ПОНЕДЕЛЬНИКА — это правило РЕГИОНА (RegionProfile), а не
 * языка: календарь не должен переезжать на воскресенье вместе с English.
 */
function monthNames(locale: string): string[] {
  const f = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
  return Array.from({ length: 12 }, (_, i) => f.format(new Date(Date.UTC(2021, i, 15))));
}

function weekdayNames(locale: string): string[] {
  const f = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
  // 2021-03-01 — понедельник; берём семь дней подряд от него.
  return Array.from({ length: 7 }, (_, i) => f.format(new Date(Date.UTC(2021, 2, 1 + i))));
}

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

  // Внешняя смена значения (кнопка «Завтра», сброс формы) перелистывает сетку
  // к месяцу нового значения — иначе открытый календарь показывает старый месяц.
  useEffect(() => {
    if (!value) return;
    setCursor((c) =>
      c.getFullYear() === value.getFullYear() && c.getMonth() === value.getMonth()
        ? c
        : new Date(value.getFullYear(), value.getMonth(), 1),
    );
  }, [value]);

  const locale = useLocale();
  // Имена месяцев, дней и подписи дат — из `Intl` БРАУЗЕРА: у Node на сервере бывает урезанный
  // ICU (казахский месяц там — «M09»), серверная разметка расходилась с клиентской → ошибка
  // гидрации. Календарь интерактивный — на сервере не рисуется (см. заглушку ниже).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const MONTHS = useMemo(() => monthNames(locale), [locale]);
  const WEEKDAYS = useMemo(() => weekdayNames(locale), [locale]);
  const t = useTranslations('common');
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

  // До монтирования — пустое место той же высоты (шапка + 6 недель): без скачка вёрстки
  if (!mounted) return <div className={cx(className)} style={{ minHeight: 272 }} aria-hidden />;

  return (
    <div className={cx(className)}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--spacing-3)' }}>
        <div className="title-sm">{MONTHS[m]} {y}</div>
        <div style={{ display: 'flex', gap: '0.25rem' }}>
          <IconButton icon="caretLeft" label={t('calendar.prevMonth')} size={26} iconSize={13} onClick={() => setCursor(new Date(y, m - 1, 1))} />
          <IconButton icon="caretRight" label={t('calendar.nextMonth')} size={26} iconSize={13} onClick={() => setCursor(new Date(y, m + 1, 1))} />
        </div>
      </div>

      <div className="ui-cal-grid" style={{ marginBottom: '0.25rem' }}>
        {WEEKDAYS.map((w) => (
          <div key={w} style={{ textAlign: 'center', fontSize: '0.5625rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--label)' }}>
            {w}
          </div>
        ))}
      </div>

      {/* Без role="grid": полноценная grid-семантика требует row/gridcell и
          стрелочную навигацию — честнее набор кнопок с полными именами.
          aria-pressed вместо aria-selected: selected валиден только в
          grid/listbox-контексте. */}
      <div className="ui-cal-grid">
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
              aria-pressed={k === selectedKey}
              aria-label={formatRegionDate(d, { locale: locale as Locale }, 'long')}
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

/** Числовая дата в правилах РЕГИОНА (03.09.2026) — от языка не зависит. */
function formatDate(d: Date, locale: Locale): string {
  return formatRegionDate(d, { locale }, 'short');
}

export function DatePicker({
  value,
  onChange,
  label,
  hint,
  error,
  placeholder,
  min,
  max,
  disabled,
  clearable = true,
  width,
  className,
}: DatePickerProps) {
  const t = useTranslations('common');
  const locale = useLocale() as Locale;
  const { anchorRef, layerRef, open, setOpen, layerStyle } = usePopover<HTMLButtonElement>({ maxHeight: 340 });
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const triggerId = useId();
  const descId = `${triggerId}-desc`;
  const showClear = !!(clearable && value && !disabled);

  const body = (
    <div className={cx(className)} style={{ width, position: 'relative' }}>
      <button
        ref={anchorRef}
        id={triggerId}
        type="button"
        className="ui-select-trigger"
        data-placeholder={value ? 'false' : 'true'}
        style={error ? { borderColor: 'var(--danger-base)' } : undefined}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? descId : undefined}
      >
        <Icon name="calendar" size={16} style={{ color: 'var(--label)' }} />
        <span>{value ? formatDate(value, locale) : placeholder ?? t('calendar.pickDate')}</span>
        {!showClear && <Icon name="caretDown" size={14} style={{ marginLeft: 'auto', color: 'var(--label)' }} />}
      </button>

      {/* Крестик очистки — СОСЕДНЯЯ кнопка, не вложенная в триггер:
          интерактивный элемент внутри <button> — невалидный HTML,
          и в Firefox такой «крестик» не получал фокус вовсе. */}
      {showClear && (
        <button
          type="button"
          aria-label={t('calendar.clearDate')}
          className="ui-iconbtn"
          style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', width: 24, height: 24, borderRadius: 'var(--radius-pill)' }}
          onClick={() => onChange(null)}
        >
          <Icon name="close" size={13} />
        </button>
      )}

      {open && mounted &&
        createPortal(
          <div ref={layerRef} className="ui-popover" style={{ ...layerStyle, width: 288, padding: 'var(--spacing-4)' }} role="dialog" aria-label={t('calendar.pickDate')}>
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
  return <Field label={label} hint={hint} error={error} htmlFor={triggerId} descId={descId}>{body}</Field>;
}
