'use client';

import { useState } from 'react';
import type { ChatSummary, RichCardRefType } from '@superapp/shared';
import { listChats, shareRichCard } from '@/lib/messenger-api';
import { Avatar } from './messenger-ui';

// ============================================================
// Share modal (flow B) — pick a chat (DM/group/context), drop an
// entity's live card into it. Reuses the inbox list (GET /messenger/chats)
// and posts via POST /rich-cards/share. The server re-checks that the
// sharer can see both the chat and the entity, then renders + posts the
// card (which arrives live over socket in the open chat).
//
// Used by:
//  • RichCardWidget ↗ (re-share a card already in a chat)
//  • "Переслать в чат" buttons on task / event / lot pages
// ============================================================

export function ShareCardModal({
  refType,
  refId,
  title,
  onClose,
}: {
  refType: RichCardRefType;
  refId: string;
  title: string;
  onClose: () => void;
}) {
  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [sendingTo, setSendingTo] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Lazy-load the inbox once when the modal opens.
  if (chats === null && !loadFailed) {
    listChats()
      .then((c) => setChats(c))
      .catch(() => setLoadFailed(true));
  }

  const share = async (chatId: string) => {
    if (sendingTo) return;
    setSendingTo(chatId);
    setError(null);
    try {
      await shareRichCard(chatId, refType, refId);
      setSentTo(chatId);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setSendingTo(null);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(56,57,45,0.35)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
        padding: '1rem',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card-elevated"
        style={{
          background: 'var(--surface-container-low)',
          padding: 'var(--spacing-6)',
          maxWidth: 420,
          width: '100%',
          maxHeight: '80vh',
          overflowY: 'auto',
          borderRadius: 'var(--radius-md)',
          transform: 'rotate(-0.3deg)',
        }}
      >
        <h3 className="title-md" style={{ marginBottom: 'var(--spacing-1)' }}>
          Переслать: {title}
        </h3>
        <p className="label-sm" style={{ opacity: 0.7, marginBottom: 'var(--spacing-4)' }}>
          Выберите чат, куда отправить карточку.
        </p>

        {error && (
          <p style={{ color: 'var(--danger)', fontSize: '0.8rem', marginBottom: 'var(--spacing-3)' }}>
            {error}
          </p>
        )}

        {chats === null && !loadFailed && (
          <p className="label-sm" style={{ opacity: 0.7 }}>Загрузка…</p>
        )}
        {loadFailed && (
          <p className="label-sm" style={{ color: 'var(--danger)' }}>Не удалось загрузить чаты.</p>
        )}
        {chats && chats.length === 0 && (
          <p className="label-sm" style={{ opacity: 0.7 }}>Чатов пока нет.</p>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
          {(chats ?? []).map((c) => {
            const done = sentTo === c.id;
            return (
              <button
                key={c.id}
                onClick={() => share(c.id)}
                disabled={!!sendingTo || done}
                className="card"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--spacing-3)',
                  padding: '0.4rem 0.7rem',
                  textAlign: 'left',
                  cursor: done ? 'default' : 'pointer',
                  opacity: sendingTo && sendingTo !== c.id ? 0.5 : 1,
                }}
              >
                <Avatar name={c.title} avatar={c.avatar} size="sm" />
                <span style={{ flex: 1, fontSize: '0.88rem', fontWeight: 500 }}>{c.title}</span>
                {done ? (
                  <span className="label-sm" style={{ fontSize: '0.72rem', color: 'var(--secondary)' }}>
                    Отправлено ✓
                  </span>
                ) : sendingTo === c.id ? (
                  <span className="label-sm" style={{ fontSize: '0.72rem', opacity: 0.6 }}>…</span>
                ) : null}
              </button>
            );
          })}
        </div>

        <div style={{ marginTop: 'var(--spacing-4)', textAlign: 'right' }}>
          <button onClick={onClose} className="btn-secondary" style={{ fontSize: '0.85rem' }}>
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}

export function errMsg(e: unknown, fallback = 'Не удалось выполнить'): string {
  const ax = e as { response?: { data?: { message?: string; error?: string } } };
  const m = ax?.response?.data?.message || ax?.response?.data?.error;
  return Array.isArray(m) ? m.join(', ') : m || fallback;
}
