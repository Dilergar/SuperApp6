'use client';

// ============================================================
// Tooltip — подсказка по наведению и фокусу с клавиатуры.
// Слой в портале и position:fixed, чтобы не обрезался overflow родителя.
// ============================================================
import { cloneElement, useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface TooltipProps {
  content: ReactNode;
  children: ReactElement<Record<string, unknown>>;
  placement?: 'top' | 'bottom';
  /** Задержка появления, мс — чтобы подсказки не мигали при проводке мышью. */
  delay?: number;
}

export function Tooltip({ content, children, placement = 'top', delay = 350 }: TooltipProps) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const timer = useRef<number | null>(null);

  const show = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const el = anchor.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPos({
        top: placement === 'top' ? r.top - 8 : r.bottom + 8,
        left: Math.min(Math.max(8, r.left + r.width / 2), window.innerWidth - 8),
      });
    }, delay);
  }, [delay, placement]);

  const hide = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    setPos(null);
  }, []);

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  // Пока подсказка видна: прокрутка/клик/ресайз её прячут. Иначе она (а) отстаёт
  // от якоря при скролле (позиция считается один раз) и (б) виснет поверх модалки,
  // открытой кликом — mouseleave в этот момент браузер не шлёт.
  useEffect(() => {
    if (!pos) return;
    const off = () => hide();
    window.addEventListener('scroll', off, { capture: true, passive: true });
    window.addEventListener('resize', off, { passive: true });
    document.addEventListener('pointerdown', off, true);
    return () => {
      window.removeEventListener('scroll', off, true);
      window.removeEventListener('resize', off);
      document.removeEventListener('pointerdown', off, true);
    };
  }, [pos, hide]);

  const child = cloneElement(children, {
    ref: (node: HTMLElement | null) => {
      anchor.current = node;
      // React 19: ref лежит в props, обращение к element.ref удалено.
      const r = (children.props as { ref?: unknown }).ref;
      if (typeof r === 'function') (r as (n: HTMLElement | null) => void)(node);
    },
    onMouseEnter: show,
    onMouseLeave: hide,
    onFocus: show,
    onBlur: hide,
  });

  return (
    <>
      {child}
      {pos &&
        createPortal(
          <div
            role="tooltip"
            className="ui-tooltip"
            style={{
              top: pos.top,
              left: pos.left,
              transform: placement === 'top' ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
            }}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}
