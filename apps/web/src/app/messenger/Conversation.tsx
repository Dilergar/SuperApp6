'use client';

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ChatDetail,
  ChatMessage,
  RichCardPayload,
  PresenceInfo,
  SearchResultItem,
  QuickActionDescriptor,
} from '@superapp/shared';
import { MESSENGER_LIMITS, SEARCH_LIMITS } from '@superapp/shared';
import { Avatar, PersonAvatar, StatusTicks, formatBubbleTime } from './messenger-ui';
import { PersonChip } from '../circles/PersonCard';
import { presenceStatusLine } from './presence-ui';
import { RichCardWidget } from './RichCardWidget';
import { FileAttachmentModal } from './FileAttachmentModal';
import { AttachmentContent } from './AttachmentContent';
import { VoiceRecordButton } from './VoiceRecordButton';
import { AttachCardModal } from './AttachCardModal';
import { MentionInput } from './MentionInput';
import { renderMessageContent } from './mention-render';
import { searchInChat, getQuickActions } from '@/lib/messenger-api';
import { QuickActionMenu, quickActionsKey } from './QuickActionMenu';
import { ScheduledPanel, usePendingScheduledCount, scheduledKey } from './ScheduledPanel';
import { CreateTaskModal, ScheduleMessageModal } from './QuickActionModals';

/** A message being quoted in the composer (Phase 7 reply). */
export interface ReplyTarget {
  id: string;
  authorName: string | null;
  text: string;
}

// Stable empty array — `data = []` in useQuery would mint a NEW [] every render while
// loading, defeating the MessageBubble memo below.
const EMPTY_ACTIONS: QuickActionDescriptor[] = [];

// ============================================================
// Right pane — the open conversation.
// Owns: bubble list, scroll-back (loads older via `before` seq),
// the composer (Enter to send / Shift+Enter newline), and inline
// edit / delete on my own messages.
// ============================================================

export function Conversation({
  detail,
  messages,
  currentUserId,
  loadingMessages,
  hasMore,
  loadingMore,
  peerPresence,
  typingUserNames,
  highlightMessageId,
  onHighlightConsumed,
  onTypingChange,
  onLoadOlder,
  onSend,
  onEdit,
  onDelete,
  onManage,
  onCardUpdated,
  onCardAttached,
  onMessagesChanged,
  onSendAttachments,
}: {
  detail: ChatDetail;
  messages: ChatMessage[];
  currentUserId: string;
  loadingMessages: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  /** DM peer presence (online / lastSeen / contextual). Null for group/context. */
  peerPresence?: PresenceInfo | null;
  /** Display names of people currently typing in THIS chat (never me). */
  typingUserNames?: string[];
  /** A message to scroll-to + briefly flash (deep link from the Mentions Hub). */
  highlightMessageId?: string | null;
  /** Called once the highlight has been applied, so the parent clears it. */
  onHighlightConsumed?: () => void;
  /** Fired by the composer: true on keystroke, false on send/blur. */
  onTypingChange?: (typing: boolean) => void;
  onLoadOlder: () => void;
  /** Send a message; `replyToId` quotes another message in this chat (Phase 7). */
  onSend: (content: string, replyToId?: string) => void;
  onEdit: (messageId: string, content: string) => void;
  onDelete: (messageId: string) => void;
  /** Opens the group-management modal — only wired for group chats. */
  onManage?: () => void;
  /** Patch a rich-card message's payload in cache after a button executes. */
  onCardUpdated?: (messageId: string, card: RichCardPayload) => void;
  /** Called after a card is attached via the 📎 picker — optional cache-refetch fallback. */
  onCardAttached?: () => void;
  /** Called after a quick-action posts a card — refetch messages as a fallback to socket. */
  onMessagesChanged?: () => void;
  /** Ф9: отправить альбом вложений (файлы уже загружены; ids + подпись + цитата). */
  onSendAttachments?: (fileIds: string[], caption: string, replyToId?: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const [showAttach, setShowAttach] = useState(false);
  const [showAttachFiles, setShowAttachFiles] = useState(false);
  // Phase 7 — message being quoted (reply), the "Запланировано" panel, and the
  // message-scope quick-action modals opened from a bubble's corner menu.
  const [replyingTo, setReplyingTo] = useState<ReplyTarget | null>(null);
  const [showScheduled, setShowScheduled] = useState(false);
  const [msgModal, setMsgModal] = useState<{ kind: 'task' | 'schedule'; text: string } | null>(null);

  // Message-scope quick actions for this chat (drives each bubble's corner menu).
  const { data: messageActions = EMPTY_ACTIONS } = useQuery<QuickActionDescriptor[]>({
    queryKey: quickActionsKey(detail.id, 'message'),
    queryFn: () => getQuickActions(detail.id, 'message'),
  });

  // Stable handler identities (refs) so the memoized bubbles/composer never re-render
  // just because the parent re-rendered (presence/typing events arrive constantly).
  const onSendRef = useRef(onSend); onSendRef.current = onSend;
  const onSendAttachmentsRef = useRef(onSendAttachments); onSendAttachmentsRef.current = onSendAttachments;
  const onEditRef = useRef(onEdit); onEditRef.current = onEdit;
  const onDeleteRef = useRef(onDelete); onDeleteRef.current = onDelete;
  const onTypingRef = useRef(onTypingChange); onTypingRef.current = onTypingChange;
  const stableEdit = useCallback((id: string, content: string) => onEditRef.current(id, content), []);
  const stableDelete = useCallback((id: string) => onDeleteRef.current(id), []);
  const stableTyping = useCallback((typing: boolean) => onTypingRef.current?.(typing), []);
  // Pending scheduled-message count for the header ⏰ button.
  const pendingScheduled = usePendingScheduledCount(detail.id, true);

  // Refetch the chat's scheduled list (header count + panel share one key).
  const queryClient = useQueryClient();
  const refreshScheduled = () =>
    queryClient.invalidateQueries({ queryKey: scheduledKey(detail.id) });
  // Message id currently flashing (deep link from the Mentions Hub, or in-chat search).
  const [flashId, setFlashId] = useState<string | null>(null);
  const flashClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A jump target not yet in the loaded window — pull older pages until it appears.
  const pendingJumpRef = useRef<{ id: string; tries: number } | null>(null);

  // ---- In-chat search (Phase 6) ----
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchRaw, setSearchRaw] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [matches, setMatches] = useState<SearchResultItem[]>([]);
  const [matchIndex, setMatchIndex] = useState(0);
  const [searching, setSearching] = useState(false);

  // Shared jump-to-message: flash the bubble + scroll its #msg-<id> to center. If the
  // message isn't in the loaded DOM yet (older than the loaded page), remember it and
  // pull older pages until it appears (the pending-jump effect below resolves it).
  const flashNow = useCallback((messageId: string) => {
    setFlashId(messageId);
    if (flashClearTimer.current) clearTimeout(flashClearTimer.current);
    flashClearTimer.current = setTimeout(() => setFlashId(null), 2300);
  }, []);
  const jumpToMessage = useCallback((messageId: string) => {
    atBottomRef.current = false; // don't let the bottom-pin fight the jump
    const node = document.getElementById(`msg-${messageId}`);
    if (node) {
      pendingJumpRef.current = null;
      node.scrollIntoView({ block: 'center', behavior: 'smooth' });
      flashNow(messageId);
    } else {
      pendingJumpRef.current = { id: messageId, tries: 0 };
      if (hasMore && !loadingMore) onLoadOlder();
    }
  }, [flashNow, hasMore, loadingMore, onLoadOlder]);

  // Debounce the in-chat query, then fetch message hits for this chat.
  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(searchRaw.trim()), 250);
    return () => clearTimeout(t);
  }, [searchRaw]);

  useEffect(() => {
    if (!searchOpen) return;
    if (searchDebounced.length < SEARCH_LIMITS.minQueryLength) {
      setMatches([]);
      setMatchIndex(0);
      return;
    }
    let cancelled = false;
    setSearching(true);
    searchInChat(detail.id, searchDebounced)
      .then((page) => {
        if (cancelled) return;
        setMatches(page.items);
        setMatchIndex(0);
        if (page.items[0]?.messageId) jumpToMessage(page.items[0].messageId);
      })
      .catch(() => {
        if (!cancelled) setMatches([]);
      })
      .finally(() => {
        if (!cancelled) setSearching(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchDebounced, searchOpen, detail.id]);

  const stepMatch = (dir: 1 | -1) => {
    if (matches.length === 0) return;
    const next = (matchIndex + dir + matches.length) % matches.length;
    setMatchIndex(next);
    const id = matches[next]?.messageId;
    if (id) jumpToMessage(id);
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchRaw('');
    setSearchDebounced('');
    setMatches([]);
    setMatchIndex(0);
    pendingJumpRef.current = null;
    if (flashClearTimer.current) clearTimeout(flashClearTimer.current);
    setFlashId(null);
  };

  // Close the search bar + clear its state when switching chats.
  useEffect(() => {
    closeSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.id]);

  // Track whether the user is pinned to the bottom; only auto-scroll then so we
  // don't yank them away while they read history.
  const atBottomRef = useRef(true);
  // Preserve scroll position when older messages are prepended.
  const prevScrollHeightRef = useRef<number | null>(null);
  const lastSeqRef = useRef<number | null>(null);

  const msgCount = messages.length;
  const newestSeq = messages.length ? messages[messages.length - 1].seq : null;

  // Detect scroll position + trigger older-page load near the top.
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 60 && hasMore && !loadingMore) {
      prevScrollHeightRef.current = el.scrollHeight;
      onLoadOlder();
    }
  };

  // Single scroll-management pass, keyed on what actually changed (msgCount/seq) —
  // NOT on every render. Two cases:
  //  • older page prepended (prevScrollHeight set) → restore anchor, no auto-scroll
  //  • newest message grew while pinned to bottom → scroll to bottom
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (prevScrollHeightRef.current != null) {
      el.scrollTop = el.scrollHeight - prevScrollHeightRef.current;
      prevScrollHeightRef.current = null;
      lastSeqRef.current = newestSeq;
      return;
    }
    const grew = lastSeqRef.current == null || (newestSeq != null && newestSeq > lastSeqRef.current);
    lastSeqRef.current = newestSeq;
    if (grew && atBottomRef.current) {
      bottomRef.current?.scrollIntoView({ block: 'end' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msgCount, newestSeq]);

  // Reset scroll state when switching chats.
  useEffect(() => {
    atBottomRef.current = true;
    lastSeqRef.current = null;
    requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: 'end' }));
  }, [detail.id]);

  // Resolve a pending in-chat-search jump: when older pages have loaded, scroll to the
  // target if it's now in the DOM; otherwise keep pulling older pages (bounded) until it
  // appears or there's no more history.
  useEffect(() => {
    const pending = pendingJumpRef.current;
    if (!pending) return;
    const node = document.getElementById(`msg-${pending.id}`);
    if (node) {
      pendingJumpRef.current = null;
      node.scrollIntoView({ block: 'center', behavior: 'smooth' });
      flashNow(pending.id);
    } else if (hasMore && !loadingMore && pending.tries < 12) {
      pending.tries += 1;
      onLoadOlder();
    } else if (!hasMore) {
      pendingJumpRef.current = null; // message not reachable — give up
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msgCount, hasMore, loadingMore]);

  // Deep link from the Mentions Hub: once the target message is in the loaded
  // window, scroll it to center + flash it ~2s, then tell the parent to clear the
  // request. If it's older than the loaded page we leave the chat at the bottom
  // (the hub at least opened the right chat).
  useEffect(() => {
    if (!highlightMessageId) return;
    if (!messages.some((m) => m.id === highlightMessageId)) return; // not loaded yet
    const node = document.getElementById(`msg-${highlightMessageId}`);
    onHighlightConsumed?.();
    if (!node) return;
    atBottomRef.current = false; // don't let the bottom-pin fight the jump
    const t = setTimeout(() => {
      node.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setFlashId(highlightMessageId);
    }, 120); // let the initial open/bottom-scroll settle first
    const clear = setTimeout(() => setFlashId(null), 2300);
    return () => {
      clearTimeout(t);
      clearTimeout(clear);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightMessageId, msgCount]);

  // Clear the in-chat-search flash timer on unmount.
  useEffect(() => {
    return () => {
      if (flashClearTimer.current) clearTimeout(flashClearTimer.current);
    };
  }, []);

  // Send path for the (memoized) Composer below — the draft lives THERE now, so a
  // keystroke re-renders only the composer, not every bubble in the conversation.
  const replyingToRef = useRef(replyingTo); replyingToRef.current = replyingTo;
  const handleComposerSend = useCallback((text: string) => {
    onSendRef.current(text, replyingToRef.current?.id);
    setReplyingTo(null);
    onTypingRef.current?.(false); // stop the typing indicator the moment we send
    atBottomRef.current = true;
    requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: 'end' }));
  }, []);

  // Голосовое: файл уже загружен профилем voice_message → шлём существующим
  // attachment-путём (ровно как FileAttachmentModal)
  const handleVoiceSent = useCallback((fileId: string) => {
    onSendAttachmentsRef.current?.([fileId], '', replyingToRef.current?.id);
    setReplyingTo(null);
    atBottomRef.current = true;
    requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: 'end' }));
  }, []);

  // Start a reply from a bubble's corner menu: stash the quoted target so the
  // composer shows the quoted bar and the next send carries replyToId.
  const startReply = useCallback((m: ChatMessage) => {
    const fallback = m.type === 'attachment' ? '📎 Вложения' : '';
    setReplyingTo({
      id: m.id,
      authorName: m.authorName,
      text: (m.content || fallback).slice(0, 200),
    });
  }, []);
  const openMsgModal = useCallback((kind: 'task' | 'schedule', text: string) => {
    setMsgModal({ kind, text });
  }, []);

  // Clear the reply draft + scheduled panel when switching chats.
  useEffect(() => {
    setReplyingTo(null);
    setShowScheduled(false);
    setMsgModal(null);
  }, [detail.id]);

  // ---- live header status line ----
  // Priority: typing → DM contextual/online/lastSeen → nothing.
  // Group/context chats show ONLY typing (no presence line).
  const isDm = detail.type === 'dm';
  const typingNames = typingUserNames ?? [];
  const typingLabel =
    typingNames.length === 0
      ? null
      : typingNames.length === 1
        ? `${typingNames[0]} печатает…`
        : typingNames.length <= 3
          ? `${typingNames.join(', ')} печатают…`
          : `${typingNames.slice(0, 2).join(', ')} и ещё ${typingNames.length - 2} печатают…`;

  const presenceLabel = isDm ? presenceStatusLine(peerPresence) : null;
  const statusLine = typingLabel ?? presenceLabel;
  const statusIsTyping = !!typingLabel;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'var(--surface-container-low)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
      }}
    >
      {/* Header — glassmorphism over the paper layer */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--spacing-3)',
          padding: 'var(--spacing-3) var(--spacing-5)',
          background: 'rgba(245, 245, 220, 0.7)',
          backdropFilter: 'blur(10px)',
        }}
      >
        <PersonAvatar userId={detail.peerUserId} name={detail.title} avatar={detail.avatar} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            className="title-md"
            style={{ fontSize: '1.05rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
          >
            {detail.title}
          </div>
          {statusLine ? (
            <div
              className="label-sm"
              style={{
                fontSize: '0.72rem',
                color: statusIsTyping ? 'var(--secondary)' : 'var(--on-surface-variant)',
                fontStyle: statusIsTyping ? 'italic' : 'normal',
                fontWeight: statusIsTyping ? 600 : 400,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {statusLine}
            </div>
          ) : (
            detail.type !== 'dm' && (
              <div className="label-sm" style={{ fontSize: '0.72rem', opacity: 0.7 }}>
                {detail.participants.length} участник(ов)
              </div>
            )
          )}
        </div>
        <button
          onClick={() => setShowScheduled(true)}
          title="Запланированные сообщения"
          aria-label="Запланированные сообщения"
          style={{
            flexShrink: 0,
            background: pendingScheduled > 0 ? 'var(--secondary-container)' : 'var(--surface-container-high)',
            border: 'none',
            cursor: 'pointer',
            height: '2.2rem',
            padding: pendingScheduled > 0 ? '0 0.7rem' : 0,
            width: pendingScheduled > 0 ? 'auto' : '2.2rem',
            borderRadius: 'var(--radius-sketch)',
            fontSize: '0.95rem',
            color: pendingScheduled > 0 ? 'var(--secondary)' : 'var(--on-surface-variant)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.25rem',
            fontWeight: 600,
          }}
        >
          ⏰
          {pendingScheduled > 0 && <span style={{ fontSize: '0.78rem' }}>{pendingScheduled}</span>}
        </button>
        <button
          onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
          title="Поиск в чате"
          aria-label="Поиск в чате"
          style={{
            flexShrink: 0,
            background: searchOpen ? 'var(--secondary-container)' : 'var(--surface-container-high)',
            border: 'none',
            cursor: 'pointer',
            width: '2.2rem',
            height: '2.2rem',
            borderRadius: 'var(--radius-sketch)',
            fontSize: '1rem',
            color: searchOpen ? 'var(--secondary)' : 'var(--on-surface-variant)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          🔍
        </button>
        {detail.type === 'group' && onManage && (detail.myRole === 'owner' || detail.myRole === 'admin') && (
          <button
            onClick={onManage}
            title="Управление группой"
            aria-label="Управление группой"
            style={{
              flexShrink: 0,
              background: 'var(--surface-container-high)',
              border: 'none',
              cursor: 'pointer',
              width: '2.2rem',
              height: '2.2rem',
              borderRadius: 'var(--radius-sketch)',
              fontSize: '1rem',
              color: 'var(--on-surface-variant)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            ⚙
          </button>
        )}
      </div>

      {/* In-chat search bar (toggled by the 🔍 header button) */}
      {searchOpen && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--spacing-2)',
            padding: 'var(--spacing-2) var(--spacing-5)',
            background: 'var(--surface-container)',
          }}
        >
          <input
            type="text"
            value={searchRaw}
            onChange={(e) => setSearchRaw(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                closeSearch();
              } else if (e.key === 'Enter') {
                e.preventDefault();
                stepMatch(e.shiftKey ? -1 : 1);
              }
            }}
            placeholder="Поиск в этом чате…"
            maxLength={SEARCH_LIMITS.maxQueryLength}
            autoFocus
            aria-label="Поиск в чате"
            style={{
              flex: 1,
              minWidth: 0,
              padding: '0.45rem 0.8rem',
              fontSize: '0.82rem',
              fontFamily: 'var(--font-body)',
              color: 'var(--on-surface)',
              background: 'var(--surface)',
              border: 'none',
              borderRadius: 'var(--radius-md)',
              outline: 'none',
              boxShadow: '0 2px 8px rgba(56, 57, 45, 0.05)',
            }}
          />
          <span
            className="label-sm"
            style={{ fontSize: '0.72rem', flexShrink: 0, color: 'var(--on-surface-variant)', minWidth: '2.6rem', textAlign: 'center' }}
          >
            {searching
              ? '…'
              : searchDebounced.length < SEARCH_LIMITS.minQueryLength
                ? ''
                : matches.length === 0
                  ? '0'
                  : `${matchIndex + 1}/${matches.length}`}
          </span>
          <button
            onClick={() => stepMatch(-1)}
            disabled={matches.length === 0}
            title="Предыдущее совпадение"
            aria-label="Предыдущее совпадение"
            style={searchStepBtn(matches.length === 0)}
          >
            ↑
          </button>
          <button
            onClick={() => stepMatch(1)}
            disabled={matches.length === 0}
            title="Следующее совпадение"
            aria-label="Следующее совпадение"
            style={searchStepBtn(matches.length === 0)}
          >
            ↓
          </button>
          <button
            onClick={closeSearch}
            title="Закрыть поиск"
            aria-label="Закрыть поиск"
            style={{
              flexShrink: 0,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: '1.1rem',
              lineHeight: 1,
              color: 'var(--on-surface-variant)',
              opacity: 0.6,
              padding: '0 0.2rem',
            }}
          >
            ×
          </button>
        </div>
      )}
      {searchOpen &&
        searchDebounced.length >= SEARCH_LIMITS.minQueryLength &&
        !searching &&
        matches.length === 0 && (
          <div
            className="label-sm"
            style={{
              padding: '0.3rem var(--spacing-5) 0.5rem',
              fontSize: '0.74rem',
              color: 'var(--on-surface-variant)',
              background: 'var(--surface-container)',
            }}
          >
            Ничего не найдено
          </div>
        )}

      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 'var(--spacing-5)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--spacing-2)',
        }}
      >
        {loadingMore && (
          <p className="label-sm" style={{ textAlign: 'center', padding: 'var(--spacing-2)' }}>Загрузка...</p>
        )}

        {loadingMessages && messages.length === 0 && (
          <p className="label-sm" style={{ textAlign: 'center', padding: 'var(--spacing-4)' }}>Загрузка...</p>
        )}

        {!loadingMessages && messages.length === 0 && (
          <div style={{ margin: 'auto', textAlign: 'center', padding: 'var(--spacing-8)' }}>
            <p className="label-md">Пока нет сообщений</p>
            <p className="label-sm" style={{ opacity: 0.7, marginTop: 'var(--spacing-1)' }}>
              Напишите первое сообщение ниже
            </p>
          </div>
        )}

        {messages.map((m) =>
          m.type === 'system' ? (
            <SystemPlaque key={m.id} message={m} />
          ) : m.type === 'rich_card' ? (
            <RichCardWidget
              key={m.id}
              payload={m.payload as unknown as RichCardPayload}
              onActionDone={(card) => onCardUpdated?.(m.id, card)}
            />
          ) : (
            <MessageBubble
              key={m.id}
              message={m}
              mine={m.authorId === currentUserId}
              currentUserId={currentUserId}
              showAuthor={detail.type !== 'dm'}
              highlighted={m.id === flashId}
              messageActions={messageActions}
              onEdit={stableEdit}
              onDelete={stableDelete}
              onReply={startReply}
              onJumpTo={jumpToMessage}
              onMessageAction={openMsgModal}
            />
          ),
        )}
        <div ref={bottomRef} />
      </div>

      {/* Reply / quote bar — shown once replying; ✕ cancels (Phase 7). */}
      {replyingTo && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--spacing-3)',
            margin: '0 var(--spacing-5)',
            padding: 'var(--spacing-2) var(--spacing-3)',
            background: 'var(--surface-container)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          <span
            aria-hidden
            style={{ width: '3px', alignSelf: 'stretch', borderRadius: '2px', background: 'var(--secondary)', flexShrink: 0 }}
          />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: '0.74rem', fontWeight: 700, color: 'var(--secondary)' }}>
              Ответ {replyingTo.authorName ? `· ${replyingTo.authorName}` : ''}
            </div>
            <div
              className="label-sm"
              style={{
                fontSize: '0.78rem',
                opacity: 0.75,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {replyingTo.text || 'Сообщение'}
            </div>
          </div>
          <button
            onClick={() => setReplyingTo(null)}
            title="Отменить ответ"
            aria-label="Отменить ответ"
            style={{
              flexShrink: 0,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: '1.1rem',
              lineHeight: 1,
              color: 'var(--on-surface-variant)',
              opacity: 0.6,
              padding: '0 0.2rem',
            }}
          >
            ×
          </button>
        </div>
      )}

      {/* Composer */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 'var(--spacing-3)',
          padding: 'var(--spacing-3) var(--spacing-5) var(--spacing-4)',
        }}
      >
        <QuickActionMenu
          chatId={detail.id}
          onPosted={onMessagesChanged}
          onScheduled={refreshScheduled}
        />
        {onSendAttachments && (
          <button
            onClick={() => setShowAttachFiles(true)}
            title="Прикрепить файлы"
            aria-label="Прикрепить файлы"
            style={{
              flexShrink: 0,
              background: 'var(--surface-container-high)',
              border: 'none',
              cursor: 'pointer',
              width: '2.6rem',
              height: '2.6rem',
              borderRadius: 'var(--radius-md)',
              fontSize: '1.15rem',
              color: 'var(--on-surface-variant)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            📎
          </button>
        )}
        <button
          onClick={() => setShowAttach(true)}
          title="Прикрепить карточку"
          aria-label="Прикрепить карточку"
          style={{
            flexShrink: 0,
            background: 'var(--surface-container-high)',
            border: 'none',
            cursor: 'pointer',
            width: '2.6rem',
            height: '2.6rem',
            borderRadius: 'var(--radius-md)',
            fontSize: '1.15rem',
            color: 'var(--on-surface-variant)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          🏷️
        </button>
        {onSendAttachments && <VoiceRecordButton onSent={handleVoiceSent} />}
        <Composer chatId={detail.id} onSend={handleComposerSend} onTypingChange={stableTyping} />
      </div>

      {showAttachFiles && (
        <FileAttachmentModal
          onClose={() => setShowAttachFiles(false)}
          onSend={(files, caption) => {
            onSendAttachmentsRef.current?.(files.map((f) => f.id), caption, replyingToRef.current?.id);
            setReplyingTo(null);
            setShowAttachFiles(false);
            atBottomRef.current = true;
            requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: 'end' }));
          }}
        />
      )}

      {showAttach && (
        <AttachCardModal
          chatId={detail.id}
          onClose={() => setShowAttach(false)}
          onShared={onCardAttached}
        />
      )}

      {showScheduled && (
        <ScheduledPanel chatId={detail.id} onClose={() => setShowScheduled(false)} />
      )}

      {/* Message-scope quick actions opened from a bubble's corner menu,
          prefilled with that message's text. */}
      {msgModal?.kind === 'task' && (
        <CreateTaskModal
          chatId={detail.id}
          prefillDescription={msgModal.text}
          onClose={() => setMsgModal(null)}
          onPosted={onMessagesChanged}
        />
      )}
      {msgModal?.kind === 'schedule' && (
        <ScheduleMessageModal
          chatId={detail.id}
          prefillContent={msgModal.text}
          onClose={() => setMsgModal(null)}
          onScheduled={() => refreshScheduled()}
        />
      )}
    </div>
  );
}

// ============================================================
// Composer — owns the draft LOCALLY, so a keystroke re-renders only this small
// component. When the draft lived in Conversation, every keypress re-rendered
// every bubble (mention-parsing included) — typing got sluggish on long chats.
// ============================================================

const Composer = memo(function Composer({
  chatId,
  onSend,
  onTypingChange,
}: {
  chatId: string;
  onSend: (content: string) => void;
  onTypingChange?: (typing: boolean) => void;
}) {
  const [draft, setDraft] = useState('');
  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft('');
  };
  return (
    <>
      <MentionInput
        chatId={chatId}
        value={draft}
        onChange={setDraft}
        onSend={submit}
        onTypingChange={onTypingChange}
        placeholder="Написать сообщение..."
        maxLength={MESSENGER_LIMITS.maxMessageLength}
      />
      <button
        onClick={submit}
        disabled={!draft.trim()}
        className="btn-primary"
        style={{
          fontSize: '0.85rem',
          padding: '0.6rem 1.3rem',
          opacity: draft.trim() ? 1 : 0.5,
          flexShrink: 0,
        }}
      >
        Отправить
      </button>
    </>
  );
});

// ============================================================
// One message bubble. Mine = right, primary color. Others = left,
// paper layer. Tombstone for deleted; "(изменено)" for edited.
// Memoized: presence/typing churn re-renders the parent constantly — with stable
// handler props (refs above) unchanged bubbles skip re-rendering entirely.
// ============================================================

const MessageBubble = memo(function MessageBubble({
  message,
  mine,
  currentUserId,
  showAuthor,
  highlighted,
  messageActions,
  onEdit,
  onDelete,
  onReply,
  onJumpTo,
  onMessageAction,
}: {
  message: ChatMessage;
  mine: boolean;
  /** Viewer id — decides which mention chips render as "me" (stronger tint). */
  currentUserId: string;
  /** True in group/context chats: label non-mine bubbles with author + role tag. */
  showAuthor: boolean;
  /** Briefly flashed when deep-linked from the Mentions Hub. */
  highlighted?: boolean;
  /** Message-scope quick actions for this chat (Phase 7 corner menu). */
  messageActions: QuickActionDescriptor[];
  onEdit: (messageId: string, content: string) => void;
  onDelete: (messageId: string) => void;
  /** Start a quote-reply to this message (Phase 7). */
  onReply: (message: ChatMessage) => void;
  /** Jump+flash the quoted message when its preview is clicked (Phase 7). */
  onJumpTo: (messageId: string) => void;
  /** Open a message-scope quick-action modal prefilled with this message's text. */
  onMessageAction: (kind: 'task' | 'schedule', text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(message.content ?? '');
  const [hover, setHover] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close the corner menu on outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const deleted = !!message.deletedAt;
  const edited = !deleted && !!message.editedAt;
  // Optimistic temp messages get a 'temp-' id; hide actions until persisted.
  const persisted = !message.id.startsWith('temp-');
  // Author label only on OTHERS' messages in group/context chats.
  const labelAuthor = showAuthor && !mine;

  const saveEdit = () => {
    const text = editDraft.trim();
    if (!text || text === message.content) {
      setEditing(false);
      return;
    }
    onEdit(message.id, text);
    setEditing(false);
  };

  return (
    <div
      id={`msg-${message.id}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: mine ? 'flex-end' : 'flex-start',
        maxWidth: '100%',
        // Deep-link flash: a soft secondary wash that fades out.
        background: highlighted ? 'var(--secondary-container)' : 'transparent',
        borderRadius: 'var(--radius-md)',
        padding: highlighted ? 'var(--spacing-2)' : 0,
        margin: highlighted ? 'calc(var(--spacing-2) * -1)' : 0,
        boxShadow: highlighted ? '0 2px 16px rgba(50, 106, 139, 0.18)' : 'none',
        transition: 'background 0.6s ease, box-shadow 0.6s ease',
      }}
    >
      {labelAuthor && (message.authorName || message.authorRoleTag) && (
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: '0.35rem',
            margin: '0 0 0.15rem 0.3rem',
            maxWidth: '78%',
          }}
        >
          {message.authorName && (
            <PersonChip size="S" userId={message.authorId} firstName={message.authorName} />
          )}
          {message.authorRoleTag && (
            <span
              className="label-sm"
              style={{
                fontSize: '0.66rem',
                fontWeight: 600,
                color: 'var(--on-surface-variant)',
                background: 'var(--surface-container)',
                padding: '0.05rem 0.4rem',
                borderRadius: 'var(--radius-sketch)',
              }}
            >
              {message.authorRoleTag}
            </span>
          )}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', maxWidth: '78%' }}>
        {/* Corner menu — Ответить (any message) + message quick actions + Edit/Delete (mine).
            Sits LEFT of mine bubbles, RIGHT of others. */}
        {!deleted && persisted && !editing && (hover || menuOpen) && (
          <div ref={menuRef} style={{ position: 'relative', flexShrink: 0, order: mine ? 0 : 2 }}>
            <button
              onClick={() => setMenuOpen((v) => !v)}
              title="Действия с сообщением"
              aria-label="Действия с сообщением"
              aria-expanded={menuOpen}
              style={iconBtnStyle}
            >
              ⋯
            </button>
            {menuOpen && (
              <div
                role="menu"
                className="card-elevated"
                style={{
                  position: 'absolute',
                  top: '1.4rem',
                  [mine ? 'left' : 'right']: 0,
                  minWidth: '11rem',
                  background: 'var(--surface-container-low)',
                  borderRadius: 'var(--radius-md)',
                  padding: '0.3rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.1rem',
                  zIndex: 70,
                  transform: 'rotate(-0.4deg)',
                }}
              >
                <CornerMenuItem
                  icon="↩"
                  label="Ответить"
                  onClick={() => {
                    setMenuOpen(false);
                    onReply(message);
                  }}
                />
                {messageActions.map((a) => {
                  const kind: 'task' | 'schedule' | null =
                    a.key === 'task.create' ? 'task' : a.key === 'message.schedule' ? 'schedule' : null;
                  if (!kind) return null; // forward-compatible: skip unknown message actions
                  return (
                    <CornerMenuItem
                      key={a.key}
                      icon={a.icon}
                      label={a.label}
                      onClick={() => {
                        setMenuOpen(false);
                        onMessageAction(kind, message.content ?? '');
                      }}
                    />
                  );
                })}
                {mine && (
                  <>
                    <CornerMenuItem
                      icon="✎"
                      label={message.type === 'attachment' ? 'Изменить подпись' : 'Редактировать'}
                      onClick={() => {
                        setMenuOpen(false);
                        setEditDraft(message.content ?? '');
                        setEditing(true);
                      }}
                    />
                    <CornerMenuItem
                      icon="🗑"
                      label="Удалить"
                      danger
                      onClick={() => {
                        setMenuOpen(false);
                        if (confirm('Удалить сообщение?')) onDelete(message.id);
                      }}
                    />
                  </>
                )}
              </div>
            )}
          </div>
        )}

        <div
          style={{
            order: 1,
            padding: 'var(--spacing-2) var(--spacing-4)',
            borderRadius: mine ? '1rem 1rem 0.3rem 1rem' : '1rem 1rem 1rem 0.3rem',
            background: deleted
              ? 'var(--surface-container)'
              : mine
                ? 'linear-gradient(135deg, var(--primary), var(--primary-dim))'
                : 'var(--surface-container-high)',
            color: deleted ? 'var(--on-surface-variant)' : mine ? 'var(--on-primary)' : 'var(--on-surface)',
            boxShadow: '0 2px 10px rgba(56, 57, 45, 0.06)',
            minWidth: 0,
          }}
        >
          {/* Quoted message (reply preview) — click to jump to the original. */}
          {!deleted && !editing && message.replyTo && (
            <button
              type="button"
              onClick={() => onJumpTo(message.replyTo!.id)}
              style={{
                display: 'flex',
                gap: '0.5rem',
                alignItems: 'stretch',
                width: '100%',
                textAlign: 'left',
                marginBottom: '0.35rem',
                padding: '0.3rem 0.5rem',
                borderRadius: 'var(--radius-sm)',
                border: 'none',
                cursor: 'pointer',
                background: mine ? 'rgba(255,255,255,0.18)' : 'var(--surface-container)',
              }}
            >
              <span
                aria-hidden
                style={{
                  width: '3px',
                  borderRadius: '2px',
                  flexShrink: 0,
                  background: mine ? 'rgba(255,255,255,0.7)' : 'var(--secondary)',
                }}
              />
              <span style={{ minWidth: 0 }}>
                <span
                  style={{
                    display: 'block',
                    fontSize: '0.7rem',
                    fontWeight: 700,
                    color: mine ? 'rgba(255,255,255,0.9)' : 'var(--secondary)',
                  }}
                >
                  {message.replyTo.authorName ?? 'Сообщение'}
                </span>
                <span
                  style={{
                    display: 'block',
                    fontSize: '0.76rem',
                    opacity: message.replyTo.deleted ? 0.6 : 0.85,
                    fontStyle: message.replyTo.deleted ? 'italic' : 'normal',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    maxWidth: '16rem',
                    color: mine ? 'var(--on-primary)' : 'var(--on-surface)',
                  }}
                >
                  {message.replyTo.deleted ? 'Сообщение удалено' : message.replyTo.text ?? ''}
                </span>
              </span>
            </button>
          )}
          {deleted ? (
            <span style={{ fontStyle: 'italic', fontSize: '0.85rem' }}>Сообщение удалено</span>
          ) : editing ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)', minWidth: '12rem' }}>
              <textarea
                value={editDraft}
                onChange={(e) => setEditDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    saveEdit();
                  }
                  if (e.key === 'Escape') setEditing(false);
                }}
                autoFocus
                rows={2}
                style={{
                  resize: 'vertical',
                  padding: 'var(--spacing-2)',
                  borderRadius: 'var(--radius-sm)',
                  border: 'none',
                  fontFamily: 'var(--font-body)',
                  fontSize: '0.85rem',
                  color: 'var(--on-surface)',
                  outline: 'none',
                }}
              />
              <div style={{ display: 'flex', gap: 'var(--spacing-2)', justifyContent: 'flex-end' }}>
                <button onClick={() => setEditing(false)} style={miniBtnGhost}>Отмена</button>
                <button onClick={saveEdit} style={miniBtnSolid}>Сохранить</button>
              </div>
            </div>
          ) : message.type === 'attachment' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
              <AttachmentContent payload={message.payload as never} />
              {message.content && (
                <span style={{ fontSize: '0.9rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {renderMessageContent(message.content, currentUserId)}
                </span>
              )}
            </div>
          ) : (
            <span style={{ fontSize: '0.9rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {renderMessageContent(message.content, currentUserId)}
            </span>
          )}
        </div>
      </div>

      {/* Meta line: time · (изменено) · ticks */}
      {!editing && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.3rem',
            marginTop: '0.15rem',
            padding: '0 0.3rem',
          }}
        >
          <span className="label-sm" style={{ fontSize: '0.66rem', opacity: 0.7 }}>
            {formatBubbleTime(message.createdAt)}
          </span>
          {edited && (
            <span className="label-sm" style={{ fontSize: '0.66rem', opacity: 0.6, fontStyle: 'italic' }}>
              (изменено)
            </span>
          )}
          {mine && !deleted && <StatusTicks status={message.status} />}
        </div>
      )}
    </div>
  );
});

// ============================================================
// System message — a centered grey plaque (group/task lifecycle).
// No bubble, no author, no ticks. Never counted as unread.
// ============================================================

function SystemPlaque({ message }: { message: ChatMessage }) {
  const text = (message.payload?.text as string | undefined) ?? message.content ?? '';
  if (!text) return null;
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '0.2rem 0' }}>
      <span
        className="label-sm"
        style={{
          fontSize: '0.72rem',
          fontStyle: 'italic',
          color: 'var(--on-surface-variant)',
          background: 'var(--surface-container)',
          padding: '0.25rem 0.85rem',
          borderRadius: 'var(--radius-sketch)',
          textAlign: 'center',
          maxWidth: '80%',
          opacity: 0.85,
        }}
      >
        {text}
      </span>
    </div>
  );
}

const iconBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  fontSize: '1rem',
  opacity: 0.5,
  padding: '0.1rem 0.25rem',
  lineHeight: 1,
};

/** One row in a message's corner menu (Ответить / quick actions / Edit / Delete). */
function CornerMenuItem({
  icon,
  label,
  danger,
  onClick,
}: {
  icon: string;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--spacing-2)',
        padding: '0.4rem 0.55rem',
        background: 'none',
        border: 'none',
        borderRadius: 'var(--radius-sm)',
        cursor: 'pointer',
        textAlign: 'left',
        width: '100%',
        fontSize: '0.82rem',
        fontWeight: 600,
        color: danger ? 'var(--danger)' : 'var(--on-surface)',
        transition: 'background 0.15s ease',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-container)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
    >
      <span style={{ fontSize: '0.95rem', flexShrink: 0, lineHeight: 1 }}>{icon}</span>
      <span style={{ minWidth: 0 }}>{label}</span>
    </button>
  );
}

/** ↑/↓ stepper button in the in-chat search bar (dimmed when no matches). */
function searchStepBtn(disabled: boolean): React.CSSProperties {
  return {
    flexShrink: 0,
    background: 'var(--surface-container-high)',
    border: 'none',
    cursor: disabled ? 'default' : 'pointer',
    width: '1.9rem',
    height: '1.9rem',
    borderRadius: 'var(--radius-sketch)',
    fontSize: '0.9rem',
    fontWeight: 700,
    color: 'var(--on-surface-variant)',
    opacity: disabled ? 0.4 : 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };
}

const miniBtnGhost: React.CSSProperties = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  fontSize: '0.75rem',
  color: 'var(--on-surface-variant)',
  fontWeight: 600,
};

const miniBtnSolid: React.CSSProperties = {
  background: 'var(--secondary)',
  color: 'var(--on-secondary)',
  border: 'none',
  cursor: 'pointer',
  fontSize: '0.75rem',
  borderRadius: 'var(--radius-sm)',
  padding: '0.25rem 0.7rem',
  fontWeight: 600,
};
