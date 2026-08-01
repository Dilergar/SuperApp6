'use client';

import { GlyphPickerButton, Icon, IconButton, parseGlyph } from '@/components/ui';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CallActiveDto,
  ChatDetail,
  ChatMessage,
  RichCardPayload,
  PresenceInfo,
  SearchResultItem,
  QuickActionDescriptor,
} from '@superapp/shared';
import { MESSENGER_LIMITS, SEARCH_LIMITS } from '@superapp/shared';
import { PersonAvatar } from './messenger-ui';
import { presenceStatusLine } from './presence-ui';
import { MessageList, type MessageListHandle } from './MessageList';
import { FileAttachmentModal } from './FileAttachmentModal';
import { VoiceRecordButton } from './VoiceRecordButton';
import { AttachCardModal } from './AttachCardModal';
import { MentionInput } from './MentionInput';
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
  callsEnabled,
  activeCall,
  inCall,
  onStartCall,
  onBack,
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
  /** Движок звонков поднят (GET /calls/status) — иначе кнопка 📞 скрыта. */
  callsEnabled?: boolean;
  /** Живой созвон в этом чате (call:state поверх DTO) — баннер «Идёт звонок». */
  activeCall?: CallActiveDto | null;
  /** Оверлей звонка этого чата уже открыт у меня — баннер не показываем. */
  inCall?: boolean;
  /** Начать звонок / присоединиться (страница открывает CallOverlay). */
  onStartCall?: () => void;
  /** Телефон, одноколоночный режим: «← к списку чатов» в шапке диалога. */
  onBack?: () => void;
}) {
  // Лента виртуализирована (MessageList): прокруткой распоряжается она, а сюда
  // отдаёт две команды — «прижмись к низу» и «покажи вот это сообщение».
  const listRef = useRef<MessageListHandle | null>(null);
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

  // Shared jump-to-message: flash the bubble + scroll it to center. Ищем сообщение
  // по ЗАГРУЖЕННОМУ СПИСКУ, а не по DOM: лента виртуализирована, и половина
  // загруженной истории в DOM просто не смонтирована. Нет в списке вовсе (старше
  // загруженной страницы) — запоминаем и тянем старые страницы, пока не появится.
  const flashNow = useCallback((messageId: string) => {
    setFlashId(messageId);
    if (flashClearTimer.current) clearTimeout(flashClearTimer.current);
    flashClearTimer.current = setTimeout(() => setFlashId(null), 2300);
  }, []);
  const jumpToMessage = useCallback((messageId: string) => {
    if (listRef.current?.scrollToMessage(messageId)) {
      pendingJumpRef.current = null;
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

  const msgCount = messages.length;

  // Resolve a pending in-chat-search jump: when older pages have loaded, scroll to the
  // target if it's now in the loaded window; otherwise keep pulling older pages
  // (bounded) until it appears or there's no more history.
  useEffect(() => {
    const pending = pendingJumpRef.current;
    if (!pending) return;
    if (listRef.current?.scrollToMessage(pending.id)) {
      pendingJumpRef.current = null;
      flashNow(pending.id);
    } else if (!hasMore || pending.tries >= 12) {
      pendingJumpRef.current = null; // тянуть больше нечего либо некуда — сдаёмся
    } else if (!loadingMore) {
      pending.tries += 1;
      onLoadOlder();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msgCount, hasMore, loadingMore]);

  // Дип-линк (глобальный поиск, «упоминания обо мне», уведомление): переход идёт
  // ТЕМ ЖЕ путём, что и клик по цитате, — jumpToMessage сам дотянет старые
  // страницы, если сообщение старше загруженного окна. Раньше здесь стояла
  // проверка «есть ли оно уже в загруженных», и на ней всё молча заканчивалось:
  // чат открывался, но к сообщению не переходил и не подсвечивал его — а именно
  // так выглядит ЛЮБОЙ переход из поиска по старой переписке.
  //
  // Таймер живёт в ref, а НЕ в уборщике эффекта. Тонкость, на которой этот переход
  // ломался и раньше: `onHighlightConsumed` гасит запрос у родителя сразу, от этого
  // меняется зависимость эффекта, React вызывает уборщик — и тот отменял таймер
  // ДО того, как он успевал сработать. Чистим только при размонтировании.
  const jumpRef = useRef(jumpToMessage);
  jumpRef.current = jumpToMessage;
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!highlightMessageId) return;
    const targetId = highlightMessageId;
    onHighlightConsumed?.();
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    // дать ленте встать в конец, прежде чем уводить её к цели
    highlightTimer.current = setTimeout(() => jumpRef.current(targetId), 150);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightMessageId]);

  // Clear the flash / deep-link timers on unmount.
  useEffect(() => {
    return () => {
      if (flashClearTimer.current) clearTimeout(flashClearTimer.current);
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
    };
  }, []);

  // Send path for the (memoized) Composer below — the draft lives THERE now, so a
  // keystroke re-renders only the composer, not every bubble in the conversation.
  const replyingToRef = useRef(replyingTo); replyingToRef.current = replyingTo;
  const handleComposerSend = useCallback((text: string) => {
    onSendRef.current(text, replyingToRef.current?.id);
    setReplyingTo(null);
    onTypingRef.current?.(false); // stop the typing indicator the moment we send
    listRef.current?.stickToBottom(); // своё сообщение видно всегда, где бы ты ни читал
  }, []);

  // Голосовое: файл уже загружен профилем voice_message → шлём существующим
  // attachment-путём (ровно как FileAttachmentModal)
  const handleVoiceSent = useCallback((fileId: string) => {
    onSendAttachmentsRef.current?.([fileId], '', replyingToRef.current?.id);
    setReplyingTo(null);
    listRef.current?.stickToBottom();
  }, []);

  // Start a reply from a bubble's corner menu: stash the quoted target so the
  // composer shows the quoted bar and the next send carries replyToId.
  const startReply = useCallback((m: ChatMessage) => {
    const fallback = m.type === 'attachment' ? 'Вложения' : '';
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
          background: 'color-mix(in srgb, var(--page) 70%, transparent)',
          backdropFilter: 'blur(10px)',
        }}
      >
        {onBack && (
          <IconButton icon="arrowLeft" label="К списку чатов" size={34} onClick={onBack} style={{ flexShrink: 0 }} />
        )}
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
        {callsEnabled && onStartCall && detail.parentType !== 'office_room' && !activeCall && (
          <button
            onClick={onStartCall}
            title="Позвонить"
            aria-label="Позвонить"
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
          ><Icon name="call" size={15} /></button>
        )}
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
        ><Icon name="search" size={15} /></button>
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
          ><Icon name="settings" size={15} /></button>
        )}
      </div>

      {/* Баннер живого звонка (Telegram-модель: присоединиться в любой момент) */}
      {activeCall && !inCall && detail.parentType !== 'office_room' && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--spacing-3)',
            padding: 'var(--spacing-2) var(--spacing-5)',
            background: 'var(--secondary-container)',
          }}
        >
          <span className="label-md" style={{ color: 'var(--secondary)', fontWeight: 700 }}>
            <Icon name="call" size={15} /> Идёт звонок · {activeCall.participantUserIds.length}
            {activeCall.recording ? ' · ● Запись' : ''}
          </span>
          {onStartCall && (
            <button
              className="btn-ghost-inline"
              style={{ padding: '0.3rem 0.9rem', fontSize: '0.8rem' }}
              onClick={onStartCall}
            >
              Присоединиться
            </button>
          )}
        </div>
      )}

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
              boxShadow: 'var(--shadow-card)',
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

      {/* Messages — виртуализированная лента (в DOM только видимое + запас).
          key на чат: смена диалога = чистый лист прокрутки и замеров высот. */}
      <MessageList
        key={detail.id}
        ref={listRef}
        messages={messages}
        currentUserId={currentUserId}
        showAuthor={detail.type !== 'dm'}
        loadingMessages={loadingMessages}
        hasMore={hasMore}
        loadingMore={loadingMore}
        onLoadOlder={onLoadOlder}
        flashId={flashId}
        messageActions={messageActions}
        onEdit={stableEdit}
        onDelete={stableDelete}
        onReply={startReply}
        onJumpTo={jumpToMessage}
        onMessageAction={openMsgModal}
        onCardUpdated={onCardUpdated}
      />

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
          ><Icon name="attach" size={15} /></button>
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
          <Icon name="flag" size={16} />
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
            listRef.current?.stickToBottom();
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
      {/* В текст едет САМ символ (не пометка набора) — сообщение остаётся
          обычной строкой, и её одинаково прочитает мобильное приложение. */}
      <GlyphPickerButton
        label="Эмодзи"
        only="noto"
        keepOpen
        size={42}
        onSelect={(v) => {
          const g = parseGlyph(v);
          if (g.kind === 'text') setDraft((d) => d + g.char);
        }}
      />
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
        className="btn-success"
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
