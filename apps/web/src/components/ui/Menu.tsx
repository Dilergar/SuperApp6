'use client';

// ============================================================
// Menu — контекстное меню «три точки» и любые выпадающие действия.
// Клавиатура: стрелки, Enter, Esc; слой — в портале (не режется overflow).
// ============================================================
import { useEffect, useRef, useState, type ReactNode } from 'react';
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
  trigger?: (props: { ref: React.Ref<HTMLButtonElement>; onClick: () => void; 'aria-expanded': boolean }) => ReactNode;
  label?: string;
  align?: 'start' | 'end';
  className?: string;
}

export function Menu({ items, trigger, label = 'Действия', align = 'end', className }: MenuProps) {
  const { anchorRef, layerRef, open, setOpen, layerStyle } = usePopover<HTMLButtonElement>({ align });
  const [active, setActive] = useState(-1);
  const [mounted, setMounted] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => setMounted(true), []);
  useEffect(() => { if (!open) setActive(-1); }, [open]);

  const usable = items.filter((i) => !i.disabled);

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((c) => {
        const n = usable.length;
        if (n === 0) return -1;
        return (c + step + n) % n;
      });
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      const it = usable[active];
      if (it?.onClick) { it.onClick(); setOpen(false); }
    }
  }

  return (
    <span className={cx(className)} onKeyDown={onKeyDown}>
      {trigger ? (
        trigger({ ref: anchorRef, onClick: () => setOpen(!open), 'aria-expanded': open })
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
          <div ref={layerRef} className="ui-popover" style={layerStyle} role="menu" aria-label={label}>
            <div ref={listRef}>
              {items.map((it) => {
                const idx = usable.indexOf(it);
                const cls = cx('ui-menu-item', it.danger && 'ui-menu-item--danger');
                const content = (
                  <>
                    {it.icon && <Icon name={it.icon} size={16} />}
                    {it.label}
                  </>
                );
                return (
                  <span key={it.key}>
                    {it.separatorBefore && <span className="ui-menu-sep" />}
                    {it.href && !it.disabled ? (
                      <Link href={it.href} className={cls} role="menuitem" data-active={idx === active ? 'true' : 'false'} onClick={() => setOpen(false)}>
                        {content}
                      </Link>
                    ) : (
                      <button
                        type="button"
                        className={cls}
                        role="menuitem"
                        disabled={it.disabled}
                        data-active={idx === active ? 'true' : 'false'}
                        onMouseEnter={() => setActive(idx)}
                        onClick={() => { it.onClick?.(); setOpen(false); }}
                      >
                        {content}
                      </button>
                    )}
                  </span>
                );
              })}
            </div>
          </div>,
          document.body,
        )}
    </span>
  );
}
