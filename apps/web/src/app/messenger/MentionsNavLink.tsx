'use client';

import Link from 'next/link';

// ============================================================
// "@ Упоминания" nav link with a wax-red unread count badge.
// Reusable across nav bars (messenger, dashboard). Badge appears
// only when unread > 0. Sketchbook look — no 1px borders.
// ============================================================

export function MentionsNavLink({ unread }: { unread: number }) {
  return (
    <Link
      href="/mentions"
      className="btn-secondary"
      title="Упоминания"
      style={{
        position: 'relative',
        padding: '0.4rem 1rem',
        fontSize: '0.8rem',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.35rem',
      }}
    >
      <span style={{ fontWeight: 800, color: 'var(--secondary)' }}>@</span>
      Упоминания
      {unread > 0 && (
        <span
          aria-label={`${unread} непрочитанных`}
          style={{
            position: 'absolute',
            top: '-0.45rem',
            right: '-0.45rem',
            minWidth: '1.2rem',
            height: '1.2rem',
            padding: '0 0.35rem',
            borderRadius: '0.6rem 0.7rem 0.62rem 0.66rem',
            background: 'var(--primary)',
            color: 'var(--on-primary)',
            fontSize: '0.68rem',
            fontWeight: 700,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 2px 8px rgba(198, 26, 30, 0.3)',
          }}
        >
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </Link>
  );
}
