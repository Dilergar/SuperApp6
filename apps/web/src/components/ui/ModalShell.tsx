'use client';

// ============================================================
// ModalShell — «оболочка окна» для мест, где содержимое уже свёрстано.
//
// Зачем отдельно от <Modal/>: у 28 самодельных окон приложения свои шапки,
// подвалы и панели — переписывать их содержимое значит переписывать формы
// целиком. Оболочка даёт им то, чего у них НЕТ, не трогая содержимое:
// role="dialog", закрытие по Esc, ловушку Tab, возврат фокуса на источник
// и блокировку прокрутки фона с компенсацией скроллбара.
//
// Замена на месте: внешний <div onClick={close} style={{position:'fixed'…}}>
// превращается в <ModalShell onClose={close}>. Внутренний div с
// stopPropagation можно оставить — он безвреден.
// ============================================================

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from './tones';

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export interface ModalShellProps {
  onClose: () => void;
  children: ReactNode;
  /** Прижать окно к верху (длинные формы) вместо центра. */
  align?: 'center' | 'top';
  /** Клик по затемнению закрывает (по умолчанию да). */
  closeOnBackdrop?: boolean;
  /** Подпись окна для скринридера, если внутри нет своего заголовка. */
  label?: string;
  /** Слой поверх других окон (вложенные подтверждения). */
  zIndex?: number;
  className?: string;
}

export function ModalShell({
  onClose,
  children,
  align = 'center',
  closeOnBackdrop = true,
  label,
  zIndex,
  className,
}: ModalShellProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  // Блокировка прокрутки фона; сдвиг скроллбара гасит `scrollbar-gutter: stable`
  // на html (паддинг тут не помогал бы — он не действует на position:fixed топбар).
  useEffect(() => {
    const { body } = document;
    const prevOverflow = body.style.overflow;
    body.style.overflow = 'hidden';
    return () => {
      body.style.overflow = prevOverflow;
    };
  }, []);

  // Фокус: запомнить источник → увести внутрь → вернуть при закрытии.
  // Фолбэк — ПОДЛОЖКА (реальный бокс с tabIndex=-1): контейнер содержимого
  // это display:contents, у него focus() не работает — фокус оставался бы на
  // кнопке ПОД окном, и Esc/ловушка Tab не включались, пока не кликнешь внутрь.
  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    const t = window.setTimeout(() => {
      const box = boxRef.current;
      if (!box) return;
      const target =
        box.querySelector<HTMLElement>('[autofocus],[data-autofocus]') ??
        box.querySelector<HTMLElement>('input:not([type="hidden"]):not([disabled]),textarea:not([disabled])') ??
        box.querySelector<HTMLElement>(FOCUSABLE);
      (target ?? backdropRef.current)?.focus();
    }, 0);
    return () => {
      window.clearTimeout(t);
      restoreRef.current?.focus?.();
    };
  }, []);

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
      if (items.length === 0) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    },
    [onClose],
  );

  if (!mounted) return null;

  return createPortal(
    // role="dialog" и клавиатура — на ПОДЛОЖКЕ: это реальный элемент (в отличие
    // от display:contents-обёртки, которую Chrome выкидывает из дерева
    // доступности вместе с ролью), и keydown ловится отовсюду внутри окна.
    <div
      ref={backdropRef}
      className={cx('ui-backdrop', align === 'center' && 'ui-backdrop--center', className)}
      // Центровка — классом, не инлайном: инлайн-стиль перекрывал медиазапрос
      // «на телефоне окно прижато к низу», и ModalShell вёл себя не как Modal.
      style={{ zIndex }}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => {
        // именно по самому фону: выделение текста, начатое внутри окна и
        // отпущенное на подложке, закрывать не должно
        if (closeOnBackdrop && e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={boxRef} style={{ display: 'contents' }}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
