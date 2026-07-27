'use client';

// ============================================================
// usePopover — общий механизм всплывающих слоёв (селект, меню, подсказка).
//
// Один на всех, потому что три вещи легко забыть в каждой копии:
//  • закрытие по клику вне и по Esc;
//  • переворот вверх, когда снизу нет места (иначе список уезжает за экран);
//  • пересчёт позиции при скролле и ресайзе.
// Слой рендерится в портал у <body> — иначе overflow:hidden родителя
// обрезает выпадашку (частая болезнь в таблицах и панелях).
// ============================================================
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface PopoverPosition {
  top: number;
  left: number;
  width: number;
  /** true — слой развернулся вверх (не хватило места снизу). */
  flipped: boolean;
}

export interface UsePopoverOptions {
  /** Ширина слоя равна ширине якоря (нужно селекту). */
  matchWidth?: boolean;
  /** Зазор между якорем и слоем, px. */
  gap?: number;
  /** Максимальная высота слоя, px — от неё считается переворот. */
  maxHeight?: number;
  /** Выравнивание по горизонтали относительно якоря. */
  align?: 'start' | 'end';
}

export function usePopover<A extends HTMLElement = HTMLElement>({
  matchWidth = false,
  gap = 6,
  maxHeight = 280,
  align = 'start',
}: UsePopoverOptions = {}) {
  const anchorRef = useRef<A | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<PopoverPosition>({ top: 0, left: 0, width: 0, flipped: false });

  const measure = useCallback(() => {
    const a = anchorRef.current;
    if (!a) return;
    const r = a.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - gap;
    const above = r.top - gap;
    const flipped = below < Math.min(maxHeight, 160) && above > below;
    const width = matchWidth ? r.width : Math.max(r.width, 180);
    const left = align === 'end' ? Math.max(8, r.right - width) : Math.min(r.left, window.innerWidth - width - 8);
    const next = {
      top: flipped ? Math.max(8, r.top - gap) : r.bottom + gap,
      left: Math.max(8, left),
      width,
      flipped,
    };
    // Позиция не изменилась → тот же объект, без ре-рендера портала.
    setPos((p) => (p.top === next.top && p.left === next.left && p.width === next.width && p.flipped === next.flipped ? p : next));
  }, [align, gap, matchWidth, maxHeight]);

  useLayoutEffect(() => {
    if (open) measure();
  }, [open, measure]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t) || layerRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // capture-фаза: Esc гасится ЗДЕСЬ, иначе модалка под слоем закроется тем же
        // нажатием и человек потеряет заполненную форму (React слушает на корне —
        // это ниже document по дереву, наш обработчик срабатывает раньше).
        e.stopPropagation();
        e.preventDefault();
        setOpen(false);
        anchorRef.current?.focus();
      }
    };
    // capture у скролла — ловим прокрутку любого родителя, не только окна.
    // Пересчёт не чаще кадра: сырой scroll стреляет на каждый тик, и каждый вызов
    // measure() — это принудительный layout + setState.
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; measure(); });
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onScroll, { passive: true });
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, measure]);

  /** Стиль слоя: позиция + ограничение высоты (с учётом переворота). */
  const layerStyle = {
    position: 'fixed' as const,
    top: pos.flipped ? undefined : pos.top,
    bottom: pos.flipped ? window.innerHeight - pos.top : undefined,
    left: pos.left,
    width: matchWidth ? pos.width : undefined,
    minWidth: matchWidth ? undefined : pos.width,
    maxHeight,
  };

  return { anchorRef, layerRef, open, setOpen, pos, layerStyle, measure };
}
