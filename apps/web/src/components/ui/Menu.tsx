'use client';

// ============================================================
// Menu — контекстное меню «три точки» и любые выпадающие действия.
// Клавиатура: стрелки, Enter, Esc; слой — в портале (не режется overflow).
// ============================================================
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { Icon, type IconName } from './Icon';
import { IconButton } from './Button';
import { cx } from './tones';
import { usePopover } from './usePopover';

export interface MenuAction {
  key: string;
  label: string;
  icon?: IconName;
  onClick?: () => void;
  href?: string;
  /** Опасное действие — красный пункт. */
  danger?: boolean;
  disabled?: boolean;
  /** Разделитель ПЕРЕД этим пунктом. */
  separatorBefore?: boolean;
}

export interface MenuProps {
  items: MenuAction[];
  /** Своя кнопка-триггер. По умолчанию — «три точки». */
  trigger?: (props: { ref: React.Ref<HTMLButtonElement>; onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu' }) => ReactNode;
  label?: string;
  align?: 'start' | 'end';
  className?: string;
}

export function Menu({ items, trigger, label = 'Действия', align = 'end', className }: MenuProps) {
  const { anchorRef, layerRef, open, setOpen, layerStyle } = usePopover<HTMLButtonElement>({ align });
  const [active, setActive] = useState(-1);
  const [mounted, setMounted] = useState(false);
  const itemRefs = useRef<Array<HTMLElement | null>>([]);

  useEffect(() => setMounted(true), []);
  useEffect(() => { if (!open) setActive(-1); }, [open]);

  const usable = items.filter((i) => !i.disabled);

  // Настоящий roving-фокус (APG menu): active двигает ФОКУС на пункт, и Enter/
  // Space активируют его нативно (кнопка кликается, ссылка переходит) — свой
  // Enter-обработчик не нужен и не двоит срабатывание.
  useEffect(() => {
    if (open && active >= 0) itemRefs.current[active]?.focus();
  }, [active, open]);
  // Открытие клавиатурой/кликом заводит фокус на первый пункт (портал должен
  // успеть смонтироваться, отсюда таймаут 0).
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => setActive((c) => (c === -1 ? 0 : c)), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) return;
    const n = usable.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((c) => (n === 0 ? -1 : (c + step + n) % n));
    } else if (e.key === 'Home') {
      e.preventDefault();
      if (n > 0) setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      if (n > 0) setActive(n - 1);
    } else if (e.key === 'Tab') {
      // По APG меню закрывается на Tab, фокус идёт дальше по странице
      setOpen(false);
    }
  }

  let usableIdx = -1;

  return (
    <span className={cx(className)} onKeyDown={onKeyDown}>
      {trigger ? (
        trigger({ ref: anchorRef, onClick: () => setOpen(!open), 'aria-expanded': open, 'aria-haspopup': 'menu' })
      ) : (
        <IconButton
          ref={anchorRef}
          icon="more"
          label={label}
          size={36}
          round={false}
          variant="outline"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-haspopup="menu"
        />
      )}

      {open && mounted &&
        createPortal(
          // role="menu" держит пункты ПРЯМЫМИ детьми (фрагменты не в счёт):
          // generic-обёртка между menu и menuitem рвала родство ролей
          <div ref={layerRef} className="ui-popover" style={layerStyle} role="menu" aria-label={label}>
            {items.map((it) => {
              const idx = it.disabled ? -1 : (usableIdx += 1);
              const cls = cx('ui-menu-item', it.danger && 'ui-menu-item--danger');
              const setRef = (el: HTMLElement | null) => { if (idx >= 0) itemRefs.current[idx] = el; };
              const content = (
                <>
                  {it.icon && <Icon name={it.icon} size={16} />}
                  {it.label}
                </>
              );
              return (
                <Fragment key={it.key}>
                  {it.separatorBefore && <span className="ui-menu-sep" role="separator" />}
                  {it.href && !it.disabled ? (
                    <Link
                      ref={setRef as React.Ref<HTMLAnchorElement>}
                      href={it.href}
                      className={cls}
                      role="menuitem"
                      tabIndex={-1}
                      data-active={idx >= 0 && idx === active ? 'true' : 'false'}
                      onMouseEnter={() => setActive(idx)}
                      onClick={() => setOpen(false)}
                    >
                      {content}
                    </Link>
                  ) : (
                    <button
                      ref={setRef}
                      type="button"
                      className={cls}
                      role="menuitem"
                      tabIndex={-1}
                      disabled={it.disabled}
                      data-active={idx >= 0 && idx === active ? 'true' : 'false'}
                      onMouseEnter={() => setActive(idx)}
                      onClick={() => { it.onClick?.(); setOpen(false); }}
                    >
                      {content}
                    </button>
                  )}
                </Fragment>
              );
            })}
          </div>,
          document.body,
        )}
    </span>
  );
}
