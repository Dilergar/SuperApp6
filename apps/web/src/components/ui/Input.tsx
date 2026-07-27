'use client';

// ============================================================
// Поля ввода: Field (обёртка с подписью и ошибкой), Input, Textarea,
// SearchField (пилюля из топбара).
// ============================================================
import { useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { Icon, type IconName } from './Icon';
import { cx } from './tones';

export interface FieldProps {
  label?: string;
  /** Пояснение под полем. */
  hint?: string;
  /** Текст ошибки: показывается вместо подсказки и красит рамку. */
  error?: string | null;
  required?: boolean;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
  /** id блока ошибки/подсказки — контрол ссылается на него aria-describedby,
   *  иначе скринридер знает, ЧТО поле невалидно, но не ПОЧЕМУ. */
  descId?: string;
}

export function Field({ label, hint, error, required, children, className, htmlFor, descId }: FieldProps) {
  return (
    <div className={className}>
      {label && (
        <label className="ui-field-label" htmlFor={htmlFor}>
          {label}
          {required && <span style={{ color: 'var(--danger)' }}> *</span>}
        </label>
      )}
      {children}
      {error ? <div id={descId} className="ui-field-error">{error}</div> : hint ? <div id={descId} className="ui-field-hint">{hint}</div> : null}
    </div>
  );
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: string;
  hint?: string;
  error?: string | null;
  /** Иконка внутри поля слева. */
  icon?: IconName;
  /** Скруглить в пилюлю (поиск, компактные фильтры). */
  pill?: boolean;
  /** Класс на внешнюю обёртку (ширина, отступы). */
  wrapClassName?: string;
}

export function Input({ label, hint, error, icon, pill, wrapClassName, className, id, required, ...rest }: InputProps) {
  const auto = useId();
  const inputId = id ?? auto;
  const descId = `${inputId}-desc`;
  const field = (
    <div style={{ position: 'relative' }}>
      {icon && (
        <Icon
          name={icon}
          size={16}
          style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--label)' }}
        />
      )}
      <input
        id={inputId}
        className={cx('ui-input', pill && 'ui-input--pill', icon && 'ui-input--with-icon', error && 'ui-input--invalid', className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? descId : undefined}
        required={required}
        {...rest}
      />
    </div>
  );
  if (!label && !hint && !error) return <div className={wrapClassName}>{field}</div>;
  return (
    <Field label={label} hint={hint} error={error} required={required} htmlFor={inputId} descId={descId} className={wrapClassName}>
      {field}
    </Field>
  );
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  hint?: string;
  error?: string | null;
  wrapClassName?: string;
}

export function Textarea({ label, hint, error, wrapClassName, className, id, required, ...rest }: TextareaProps) {
  const auto = useId();
  const areaId = id ?? auto;
  const descId = `${areaId}-desc`;
  const field = (
    <textarea
      id={areaId}
      className={cx('ui-input', error && 'ui-input--invalid', className)}
      aria-invalid={error ? true : undefined}
      aria-describedby={error || hint ? descId : undefined}
      required={required}
      {...rest}
    />
  );
  if (!label && !hint && !error) return <div className={wrapClassName}>{field}</div>;
  return (
    <Field label={label} hint={hint} error={error} required={required} htmlFor={areaId} descId={descId} className={wrapClassName}>
      {field}
    </Field>
  );
}

export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'type'> {
  /** Кнопка очистки: показывается, когда есть значение. */
  onClear?: () => void;
  width?: number | string;
}

export function SearchField({ onClear, width = 240, className, style, value, ...rest }: SearchFieldProps) {
  const hasValue = value !== undefined && value !== null && String(value).length > 0;
  return (
    <div style={{ position: 'relative', width, ...style }}>
      <Icon
        name="search"
        size={16}
        style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--label)' }}
      />
      <input
        type="search"
        // Подпись у поиска всегда одна — сама иконка лупы, а её скринридер не читает.
        // Дефолт здесь чинит все места разом (в топбаре поиск на КАЖДОЙ странице);
        // конкретное место может уточнить своим aria-label через ...rest.
        aria-label="Поиск"
        className={cx('ui-input', 'ui-input--pill', 'ui-input--with-icon', className)}
        value={value}
        style={hasValue && onClear ? { paddingRight: '2.25rem' } : undefined}
        {...rest}
      />
      {hasValue && onClear && (
        <button
          type="button"
          onClick={onClear}
          aria-label="Очистить"
          className="ui-iconbtn"
          style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', width: 24, height: 24, borderRadius: 'var(--radius-pill)' }}
        >
          <Icon name="close" size={13} />
        </button>
      )}
    </div>
  );
}
