'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { RichCardPayload, RichCardAction } from '@superapp/shared';
import { executeRichCardAction } from '@/lib/messenger-api';
import { ShareCardModal } from './ShareCardModal';

// ============================================================
// Rich Card (Phase 3) — an interactive, service-posted card in the
// message stream. Generic: driven entirely by the RichCardPayload
// (order / listing / crowdfunding / task / event). A button POSTs an
// action key to the server, which re-checks permissions and returns
// the UPDATED card — we patch it in place via onActionDone.
//
// Rendered full-width-ish (centred, ~80%), like a system block but
// tactile and interactive. Never editable/deletable via bubble hover.
// ============================================================

export function RichCardWidget({
  payload,
  onActionDone,
}: {
  payload: RichCardPayload;
  /** Lift the freshly re-rendered card so the parent patches the message's payload in cache. */
  onActionDone?: (updatedCard: RichCardPayload) => void;
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [noteIsError, setNoteIsError] = useState(false);
  const [showShare, setShowShare] = useState(false);

  const runAction = async (action: RichCardAction) => {
    if (busyKey) return;
    setBusyKey(action.key);
    setNote(null);
    setNoteIsError(false);
    try {
      const result = await executeRichCardAction(action.key, payload.ref, action.payload);
      onActionDone?.(result.card);
      if (result.message) {
        setNote(result.message);
        setNoteIsError(false);
      }
    } catch (e) {
      setNote(errMsg(e));
      setNoteIsError(true);
    } finally {
      setBusyKey(null);
    }
  };

  const progress = payload.progress;
  const pct =
    progress && progress.target > 0
      ? Math.min(100, Math.round((progress.current / progress.target) * 100))
      : 0;

  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '0.3rem 0' }}>
      <div
        className="card-elevated"
        style={{
          width: '100%',
          maxWidth: '80%',
          background: 'var(--surface-container-high)',
          borderRadius: 'var(--radius-sketch)',
          padding: 'var(--spacing-4)',
          boxShadow: '0 4px 16px rgba(56, 57, 45, 0.10)',
          transform: 'rotate(-0.4deg)',
        }}
      >
        {/* Header: icon + title (+ status chip) + subtitle */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--spacing-3)' }}>
          <div
            style={{
              fontSize: '1.6rem',
              lineHeight: 1,
              flexShrink: 0,
              marginTop: '0.1rem',
            }}
          >
            {payload.icon ?? CARD_TYPE_ICON[payload.cardType] ?? '🗂️'}
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
              {payload.href ? (
                <Link
                  href={payload.href}
                  className="title-md"
                  style={{ fontSize: '1rem', color: 'var(--secondary)', textDecoration: 'none' }}
                >
                  {payload.title}
                </Link>
              ) : (
                <span className="title-md" style={{ fontSize: '1rem' }}>
                  {payload.title}
                </span>
              )}
              {payload.status && (
                <span
                  className="label-sm"
                  style={{
                    fontSize: '0.66rem',
                    fontWeight: 600,
                    color: 'var(--secondary)',
                    background: 'var(--secondary-container)',
                    padding: '0.1rem 0.55rem',
                    borderRadius: 'var(--radius-sketch)',
                  }}
                >
                  {payload.status}
                </span>
              )}
            </div>
            {payload.subtitle && (
              <p
                className="label-sm"
                style={{ fontSize: '0.76rem', opacity: 0.7, marginTop: '0.1rem' }}
              >
                {payload.subtitle}
              </p>
            )}
          </div>
          {/* Share affordance */}
          <button
            onClick={() => setShowShare(true)}
            title="Поделиться карточкой"
            aria-label="Поделиться карточкой"
            style={{
              flexShrink: 0,
              background: 'var(--surface-container)',
              border: 'none',
              cursor: 'pointer',
              width: '1.9rem',
              height: '1.9rem',
              borderRadius: 'var(--radius-sketch)',
              fontSize: '0.85rem',
              color: 'var(--on-surface-variant)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            ↗
          </button>
        </div>

        {/* Optional image */}
        {payload.imageUrl && (
          <img
            src={payload.imageUrl}
            alt={payload.title}
            style={{
              width: '100%',
              maxHeight: '11rem',
              objectFit: 'cover',
              borderRadius: 'var(--radius-md)',
              marginTop: 'var(--spacing-3)',
            }}
          />
        )}

        {/* Fields */}
        {payload.fields.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '0.3rem',
              marginTop: 'var(--spacing-3)',
            }}
          >
            {payload.fields.map((f, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  gap: 'var(--spacing-3)',
                }}
              >
                <span className="label-sm" style={{ fontSize: '0.74rem', opacity: 0.65 }}>
                  {f.label}
                </span>
                <span
                  style={{
                    fontSize: '0.82rem',
                    fontWeight: 500,
                    textAlign: 'right',
                    wordBreak: 'break-word',
                  }}
                >
                  {f.value}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Progress bar (e.g. crowdfunding goal) */}
        {progress && (
          <div style={{ marginTop: 'var(--spacing-3)' }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: '0.72rem',
                opacity: 0.85,
                marginBottom: '0.2rem',
              }}
            >
              <span>{progress.label ?? `${progress.current} / ${progress.target}`}</span>
              <span>{pct}%</span>
            </div>
            <div
              style={{
                height: 7,
                background: 'rgba(56, 57, 45, 0.10)',
                borderRadius: 5,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${pct}%`,
                  height: '100%',
                  background: pct >= 100 ? 'var(--secondary)' : 'var(--primary)',
                }}
              />
            </div>
          </div>
        )}

        {/* Inline note (action result message OR error) */}
        {note && (
          <p
            className="label-sm"
            style={{
              fontSize: '0.74rem',
              marginTop: 'var(--spacing-2)',
              color: noteIsError ? 'var(--danger)' : 'var(--secondary)',
            }}
          >
            {note}
          </p>
        )}

        {/* Action buttons */}
        {payload.actions.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 'var(--spacing-2)',
              marginTop: 'var(--spacing-4)',
            }}
          >
            {payload.actions.map((action) => (
              <button
                key={action.key}
                onClick={() => runAction(action)}
                disabled={busyKey != null}
                className={action.style === 'primary' ? 'btn-primary' : 'btn-secondary'}
                style={{
                  fontSize: '0.78rem',
                  padding: '0.3rem 0.95rem',
                  opacity: busyKey != null && busyKey !== action.key ? 0.5 : 1,
                  ...(action.style === 'danger'
                    ? { color: 'var(--danger)' }
                    : {}),
                }}
              >
                {busyKey === action.key ? '…' : action.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {showShare && (
        <ShareCardModal
          refType={payload.ref.type}
          refId={payload.ref.id}
          title={payload.title}
          onClose={() => setShowShare(false)}
        />
      )}
    </div>
  );
}

const CARD_TYPE_ICON: Record<string, string> = {
  order: '📦',
  listing: '🎁',
  crowdfunding: '🎯',
  task: '✅',
  event: '📅',
};

function errMsg(e: unknown, fallback = 'Не удалось выполнить'): string {
  const ax = e as { response?: { data?: { message?: string; error?: string } } };
  const m = ax?.response?.data?.message || ax?.response?.data?.error;
  return Array.isArray(m) ? m.join(', ') : m || fallback;
}
