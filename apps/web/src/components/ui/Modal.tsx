'use client';

// ============================================================
// Modal — единственная модалка приложения.
//
// До кита их было 27 самодельных, и ни одна не делала того, что модалка
// обязана делать: role="dialog", закрытие по Esc, ловушка фокуса (Tab не
// должен уходить на страницу под окном), возврат фокуса на кнопку-источник,
// блокировка прокрутки фона. Всё это здесь — один раз.
// ============================================================
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './Button';
import { CloseChip } from './Button';
import { cx } from './tones';

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  /** Подзаголовок под названием. */
  subtitle?: ReactNode;
  size?: ModalSize;
  children: ReactNode;
  /** Правая часть подвала (кнопки действий). */
  footer?: ReactNode;
  /** Клик по затемнению закрывает окно (по умолчанию да). */
  closeOnBackdrop?: boolean;
  /** Спрятать крестик (когда закрытие только через кнопки подвала). */
  hideClose?: boolean;
  className?: string;
}

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  size = 'md',
  children,
  footer,
  closeOnBackdrop = true,
  hideClose,
  className,
}: ModalProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const [mounted, setMounted] = useState(false);
  const titleId = useId();

  useEffect(() => setMounted(true), []);

  // Блокировка прокрутки фона. Сдвиг от исчезнувшего скроллбара гасится не
  // паддингом (он не действует на position:fixed — топбар всё равно прыгал бы),
  // а `scrollbar-gutter: stable` на html в globals.css.
  useEffect(() => {
    if (!open) return;
    const { body } = document;
    const prevOverflow = body.style.overflow;
    body.style.overflow = 'hidden';
    return () => {
      body.style.overflow = prevOverflow;
    };
  }, [open]);

  // Фокус: запоминаем источник, уводим внутрь окна, на закрытии возвращаем
  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const t = window.setTimeout(() => {
      const box = boxRef.current;
      if (!box) return;
      // Приоритет: явный autoFocus → первое поле формы → любой фокусируемый.
      // Просто «первый фокусируемый» — это крестик закрытия в шапке, и форма
      // открывалась бы с курсором на кнопке «Закрыть» вместо первого поля.
      const target =
        box.querySelector<HTMLElement>('[autofocus],[data-autofocus]') ??
        box.querySelector<HTMLElement>('input:not([type="hidden"]):not([disabled]),textarea:not([disabled])') ??
        box.querySelector<HTMLElement>(FOCUSABLE);
      (target ?? box).focus();
    }, 0);
    return () => {
      window.clearTimeout(t);
      restoreRef.current?.focus?.();
    };
  }, [open]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const box = boxRef.current;
      if (!box) return;
      const items = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  if (!open || !mounted) return null;

  return createPortal(
    <div
      className="ui-backdrop"
      onMouseDown={(e) => {
        // именно mousedown по самому фону: клик, начатый внутри окна и
        // отпущенный на фоне (выделение текста), закрывать не должен
        if (closeOnBackdrop && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={boxRef}
        className={cx('ui-modal', `ui-modal--${size}`, className)}
        role="dialog"
        aria-modal="true"
        // aria-labelledby переживает и НЕстроковый title (например «Задача <b>№12</b>»),
        // с которым aria-label оставлял окно безымянным
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        {(title || !hideClose) && (
          <div className="ui-modal-head">
            <div style={{ minWidth: 0 }}>
              {title && <div id={titleId} className="title-md">{title}</div>}
              {subtitle && <div className="label-sm" style={{ marginTop: '0.25rem' }}>{subtitle}</div>}
            </div>
            {!hideClose && <CloseChip size={32} onClick={onClose} />}
          </div>
        )}
        <div className="ui-modal-body">{children}</div>
        {footer && <div className="ui-modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Опасное действие — кнопка подтверждения красная. */
  danger?: boolean;
  loading?: boolean;
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = 'Подтвердить',
  cancelLabel = 'Отмена',
  danger,
  loading,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{cancelLabel}</Button>
          {/* DESIGN.md §1: опасное подтверждение — сплошная красная, обычное —
              зелёная («Подтвердить/Принять»). Матовая кнопка тут выглядела бы
              слабее безопасной «Отмены». */}
          <Button
            variant="primary"
            tone={danger ? 'danger' : 'success'}
            loading={loading}
            onClick={() => void onConfirm()}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {typeof message === 'string' ? <p className="body-sm" style={{ margin: 0 }}>{message}</p> : message}
    </Modal>
  );
}
