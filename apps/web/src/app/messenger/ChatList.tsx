'use client';

import type { ChatSummary, PresenceInfo } from '@superapp/shared';
import { Avatar, formatListTime } from './messenger-ui';
import { OnlineDot } from './presence-ui';
import { stripMentions } from './mention-render';

// ============================================================
// Left pane — inbox list of chats (already sorted pinned-first
// then recent by the server).
// ============================================================

export function ChatList({
  chats,
  activeChatId,
  currentUserId,
  loading,
  presence,
  onSelect,
  onNewChat,
  embedded = false,
}: {
  chats: ChatSummary[];
  activeChatId: string | null;
  currentUserId: string;
  loading: boolean;
  /** Per-user presence (online flag drives the DM avatar dot). */
  presence: Map<string, PresenceInfo>;
  onSelect: (chatId: string) => void;
  onNewChat: () => void;
  /** When hosted inside the global-search shell, drop the own paper layer so the
   *  surrounding container provides it (no doubled surface / radius). */
  embedded?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: embedded ? 'transparent' : 'var(--surface-container-low)',
        borderRadius: embedded ? 0 : 'var(--radius-md)',
        overflow: 'hidden',
      }}
    >
      {/* Header + New chat */}
      <div
        style={{
          padding: 'var(--spacing-4) var(--spacing-4) var(--spacing-3)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--spacing-2)',
        }}
      >
        <h2 className="title-md" style={{ fontSize: '1.1rem' }}>Чаты</h2>
        <button
          onClick={onNewChat}
          className="btn-primary"
          style={{ fontSize: '0.78rem', padding: '0.35rem 0.9rem' }}
        >
          + Новый чат
        </button>
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 var(--spacing-2) var(--spacing-2)' }}>
        {loading && <p className="label-sm" style={{ padding: 'var(--spacing-4)' }}>Загрузка...</p>}

        {!loading && chats.length === 0 && (
          <div style={{ padding: 'var(--spacing-8) var(--spacing-4)', textAlign: 'center' }}>
            <p className="label-md" style={{ marginBottom: 'var(--spacing-1)' }}>Пока нет чатов</p>
            <p className="label-sm" style={{ opacity: 0.7 }}>
              Нажмите «Новый чат», чтобы написать кому-то из окружения
            </p>
          </div>
        )}

        {chats.map((chat) => (
          <ChatRow
            key={chat.id}
            chat={chat}
            active={chat.id === activeChatId}
            currentUserId={currentUserId}
            peerOnline={chat.type === 'dm' && !!chat.peerUserId && !!presence.get(chat.peerUserId)?.online}
            onSelect={() => onSelect(chat.id)}
          />
        ))}
      </div>
    </div>
  );
}

function ChatRow({
  chat,
  active,
  currentUserId,
  peerOnline,
  onSelect,
}: {
  chat: ChatSummary;
  active: boolean;
  currentUserId: string;
  /** DM peer is online → show a green presence dot on the avatar. */
  peerOnline: boolean;
  onSelect: () => void;
}) {
  const last = chat.lastMessage;
  const mineLast = !!last && last.authorId === currentUserId && !last.deleted && last.type !== 'system';
  const isMulti = chat.type !== 'dm';

  let preview: string;
  if (!last) preview = isMulti && chat.memberCount != null ? `${chat.memberCount} участник(ов)` : 'Нет сообщений';
  else if (last.deleted) preview = 'Сообщение удалено';
  else preview = stripMentions(last.text);
  // In group/context, prefix a non-mine, non-system last message with the author.
  const previewAuthor =
    isMulti && last && !last.deleted && last.type !== 'system' && last.authorId !== currentUserId && last.authorName
      ? `${last.authorName}: `
      : '';

  return (
    <button
      onClick={onSelect}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--spacing-3)',
        width: '100%',
        padding: 'var(--spacing-3)',
        marginBottom: '0.2rem',
        background: active ? 'var(--surface)' : 'none',
        border: 'none',
        borderRadius: 'var(--radius-md)',
        cursor: 'pointer',
        textAlign: 'left',
        boxShadow: active ? '0 2px 14px rgba(56, 57, 45, 0.08)' : 'none',
        transition: 'background 0.15s ease',
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = 'var(--surface-container)';
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = 'none';
      }}
    >
      <div style={{ position: 'relative' }}>
        <Avatar name={chat.title} avatar={chat.avatar} />
        {!isMulti && peerOnline && <OnlineDot />}
        {isMulti && (
          <span
            title={chat.type === 'group' ? 'Группа' : 'Чат задачи'}
            style={{
              position: 'absolute',
              bottom: -3,
              right: -3,
              fontSize: '0.7rem',
              lineHeight: 1,
              background: 'var(--surface-container-low)',
              borderRadius: 'var(--radius-sketch)',
              padding: '0.05rem 0.1rem',
            }}
          >
            {chat.type === 'group' ? '👥' : '📋'}
          </span>
        )}
        {chat.pinned && (
          <span
            title="Закреплён"
            style={{ position: 'absolute', top: -4, left: -4, fontSize: '0.6rem', transform: 'rotate(-20deg)' }}
          >
            📌
          </span>
        )}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 'var(--spacing-2)' }}>
          <span
            style={{
              fontWeight: 600,
              fontSize: '0.9rem',
              color: 'var(--on-surface)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {chat.title}
          </span>
          <span className="label-sm" style={{ fontSize: '0.68rem', flexShrink: 0 }}>
            {last ? formatListTime(last.createdAt) : ''}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', marginTop: '0.1rem' }}>
          <span
            className="label-sm"
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: '0.78rem',
              fontStyle: last?.deleted ? 'italic' : 'normal',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              opacity: last?.deleted ? 0.7 : 1,
            }}
          >
            {mineLast && <span style={{ marginRight: '0.25rem', color: 'var(--on-surface-variant)', fontWeight: 600 }}>Вы:</span>}
            {previewAuthor && <span style={{ color: 'var(--on-surface-variant)', fontWeight: 600 }}>{previewAuthor}</span>}
            {preview}
          </span>

          {chat.unreadCount > 0 && (
            <span
              style={{
                flexShrink: 0,
                minWidth: '1.25rem',
                height: '1.25rem',
                padding: '0 0.4rem',
                borderRadius: '0.65rem',
                background: 'var(--primary)',
                color: 'var(--on-primary)',
                fontSize: '0.7rem',
                fontWeight: 700,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {chat.unreadCount > 99 ? '99+' : chat.unreadCount}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}
