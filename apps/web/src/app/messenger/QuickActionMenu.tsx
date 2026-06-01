'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { QuickActionDescriptor } from '@superapp/shared';
import { getQuickActions } from '@/lib/messenger-api';
import { CreateTaskModal, CreateEventModal, ScheduleMessageModal } from './QuickActionModals';

// ============================================================
// Phase 7 — the composer ＋ menu. DATA-DRIVEN: it fetches the chat's
// composer-scope quick actions (GET /quick-actions?scope=composer) and renders
// a small sketchbook popover (icon + label) above the composer, like the
// @-mention popover. Clicking an action maps its `key` → modal:
//   task.create     → CreateTaskModal
//   event.create    → CreateEventModal
//   message.schedule→ ScheduleMessageModal
// Unknown keys render as a disabled (no-op) row — forward-compatible.
// ============================================================

export const quickActionsKey = (chatId: string, scope: 'composer' | 'message') =>
  ['quick-actions', chatId, scope] as const;

/** Keys this UI build knows how to handle. */
const KNOWN_KEYS = new Set(['task.create', 'event.create', 'message.schedule']);

type ModalKey = 'task.create' | 'event.create' | 'message.schedule';

export function QuickActionMenu({
  chatId,
  onPosted,
  onScheduled,
}: {
  chatId: string;
  /** Invalidate messages after a task/event card lands (socket is primary path). */
  onPosted?: () => void;
  /** Refetch the scheduled list after a message is scheduled. */
  onScheduled?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState<ModalKey | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const { data: actions = [] } = useQuery({
    queryKey: quickActionsKey(chatId, 'composer'),
    queryFn: () => getQuickActions(chatId, 'composer'),
  });

  // Close the popover on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (a: QuickActionDescriptor) => {
    if (!KNOWN_KEYS.has(a.key)) return; // forward-compatible: ignore unknown
    setOpen(false);
    setModal(a.key as ModalKey);
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        title="Быстрые действия"
        aria-label="Быстрые действия"
        aria-expanded={open}
        style={{
          background: open ? 'var(--secondary-container)' : 'var(--surface-container-high)',
          border: 'none',
          cursor: 'pointer',
          width: '2.6rem',
          height: '2.6rem',
          borderRadius: 'var(--radius-md)',
          fontSize: '1.35rem',
          lineHeight: 1,
          color: open ? 'var(--secondary)' : 'var(--on-surface-variant)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        ＋
      </button>

      {open && (
        <div
          role="menu"
          className="card-elevated"
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 0.5rem)',
            left: 0,
            minWidth: '14rem',
            background: 'var(--surface-container-low)',
            borderRadius: 'var(--radius-md)',
            padding: '0.4rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.2rem',
            zIndex: 60,
            transform: 'rotate(-0.4deg)',
          }}
        >
          {actions.length === 0 && (
            <span className="label-sm" style={{ opacity: 0.6, padding: '0.4rem 0.6rem' }}>
              Нет доступных действий
            </span>
          )}
          {actions.map((a) => {
            const known = KNOWN_KEYS.has(a.key);
            return (
              <button
                key={a.key}
                role="menuitem"
                onClick={() => pick(a)}
                disabled={!known}
                title={a.description ?? a.label}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--spacing-3)',
                  padding: '0.5rem 0.6rem',
                  background: 'none',
                  border: 'none',
                  borderRadius: 'var(--radius-sm)',
                  cursor: known ? 'pointer' : 'default',
                  textAlign: 'left',
                  width: '100%',
                  opacity: known ? 1 : 0.4,
                  transition: 'background 0.15s ease',
                }}
                onMouseEnter={(e) => {
                  if (known) e.currentTarget.style.background = 'var(--surface-container)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'none';
                }}
              >
                <span style={{ fontSize: '1.2rem', flexShrink: 0, lineHeight: 1 }}>{a.icon}</span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: 'block', fontSize: '0.88rem', fontWeight: 600, color: 'var(--on-surface)' }}>
                    {a.label}
                  </span>
                  {a.description && (
                    <span className="label-sm" style={{ fontSize: '0.7rem', opacity: 0.65 }}>
                      {a.description}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {modal === 'task.create' && (
        <CreateTaskModal chatId={chatId} onClose={() => setModal(null)} onPosted={onPosted} />
      )}
      {modal === 'event.create' && (
        <CreateEventModal chatId={chatId} onClose={() => setModal(null)} onPosted={onPosted} />
      )}
      {modal === 'message.schedule' && (
        <ScheduleMessageModal chatId={chatId} onClose={() => setModal(null)} onScheduled={onScheduled} />
      )}
    </div>
  );
}
