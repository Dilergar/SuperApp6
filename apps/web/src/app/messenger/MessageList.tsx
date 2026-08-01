'use client';

import { Glyph, useConfirm, type IconName } from '@/components/ui';
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Virtuoso, type Components, type VirtuosoHandle } from 'react-virtuoso';
import type { ChatMessage, QuickActionDescriptor, RichCardPayload } from '@superapp/shared';
import { PersonChip } from '../circles/PersonCard';
import { StatusTicks, formatBubbleTime } from './messenger-ui';
import { AttachmentContent } from './AttachmentContent';
import { RichCardWidget } from './RichCardWidget';
import { renderMessageContent } from './mention-render';

// ============================================================
// Лента сообщений — ВИРТУАЛИЗИРОВАННАЯ (react-virtuoso).
//
// Зачем: раньше в DOM жили ВСЕ загруженные сообщения. Полистал историю —
// и браузер держит 500–1000 пузырей (каждое фото, каждый плеер, каждая
// карточка), хотя на экране их полтора десятка. Теперь смонтированы только
// видимые плюс запас сверху и снизу; для человека это та же бесконечная
// лента (модель Telegram/WhatsApp).
//
// Виртуализатор взял на себя механику, которая раньше была ручной:
//  • прижатие к низу на новом сообщении — followOutput (срабатывает ТОЛЬКО
//    когда человек уже внизу, чтение истории не сбивается);
//  • догрузка старых страниц без прыжка — firstItemIndex (уменьшаем ровно на
//    число доклеенных сверху сообщений, позицию держит движок);
//  • переход к конкретному старому сообщению — scrollToIndex. getElementById
//    здесь больше НЕ годится: сообщение может быть загружено, но не
//    смонтировано, и поиск по DOM вернул бы null для половины истории;
//  • фото, голосовые и рич-карточки меняют высоту уже после появления —
//    ResizeObserver внутри virtuoso перемеряет строку и удерживает позицию.
//
// Компонент монтируется с `key={chatId}` — смена чата = чистый лист
// (никаких переносов позиции и замеров высот между разными чатами).
// ============================================================

/** Стартовый «абсолютный» индекс первого сообщения. Каждая догрузка старых уменьшает его. */
const BASE_ITEM_INDEX = 1_000_000;
/** Запас отрисовки за краями экрана — чтобы при быстрой прокрутке не мелькала пустота. */
const VIEWPORT_OVERSCAN = { bottom: 800, top: 800 };
/** «Внизу» — с тем же допуском, что был у прежней ручной прокрутки. */
const AT_BOTTOM_THRESHOLD = 80;
/** Подсказка движку о типичной высоте пузыря (точность первого прыжка в конец). */
const DEFAULT_ITEM_HEIGHT = 68;

export interface MessageListHandle {
  /**
   * Прокрутить к сообщению и вернуть true. false = его нет в загруженном окне —
   * зовущему нужно тянуть старые страницы и повторить.
   */
  scrollToMessage(messageId: string): boolean;
  /** Прижаться к низу и доехать туда же за ближайшим новым сообщением (отправка). */
  stickToBottom(): void;
}

interface ListContext {
  hasMore: boolean;
  loadingMore: boolean;
}

export const MessageList = forwardRef<MessageListHandle, {
  messages: ChatMessage[];
  currentUserId: string;
  /** true в группах и контекстных чатах: подписывать чужие пузыри автором. */
  showAuthor: boolean;
  loadingMessages: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadOlder: () => void;
  /** Сообщение, которое сейчас вспыхивает подсветкой (дип-линк, поиск, цитата). */
  flashId: string | null;
  messageActions: QuickActionDescriptor[];
  onEdit: (messageId: string, content: string) => void;
  onDelete: (messageId: string) => void;
  onReply: (message: ChatMessage) => void;
  onJumpTo: (messageId: string) => void;
  onMessageAction: (kind: 'task' | 'schedule', text: string) => void;
  onCardUpdated?: (messageId: string, card: RichCardPayload) => void;
}>(function MessageList(
  {
    messages,
    currentUserId,
    showAuthor,
    loadingMessages,
    hasMore,
    loadingMore,
    onLoadOlder,
    flashId,
    messageActions,
    onEdit,
    onDelete,
    onReply,
    onJumpTo,
    onMessageAction,
    onCardUpdated,
  },
  ref,
) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  // Лента закончила стартовую установку позиции (см. засов startReached ниже).
  const settledRef = useRef(false);

  // ---- якорь догрузки старых страниц ----------------------------------
  // Virtuoso удерживает картинку на месте, когда firstItemIndex УМЕНЬШАЕТСЯ ровно
  // на число доклеенных сверху записей. Считаем это число, отыскав прежнюю первую
  // запись в новом массиве (правки/удаления в середине id не меняют, так что
  // безопасно). Считать надо в рендере, а не в эффекте: индекс и данные обязаны
  // приехать к движку одним коммитом, иначе он увидит вставку на кадр позже и
  // лента дёрнется.
  const firstItemIndexRef = useRef(BASE_ITEM_INDEX);
  const firstIdRef = useRef<string | null>(null);
  const resyncBottomRef = useRef(false);
  const firstId = messages.length > 0 ? messages[0].id : null;
  if (firstId !== firstIdRef.current) {
    if (firstIdRef.current !== null && firstId !== null) {
      const prepended = messages.findIndex((m) => m.id === firstIdRef.current);
      if (prepended > 0) {
        firstItemIndexRef.current -= prepended;
      } else if (prepended < 0) {
        // Прежняя голова пропала целиком — это не догрузка, а замена набора
        // (рефетч после разрыва сокета отдаёт только последнюю страницу).
        // Позиция после такого не определена — начинаем заново и уезжаем вниз.
        firstItemIndexRef.current = BASE_ITEM_INDEX;
        resyncBottomRef.current = true;
      }
    }
    firstIdRef.current = firstId;
  }
  const firstItemIndex = firstItemIndexRef.current;

  // Намеренно БЕЗ списка зависимостей: флаг взводится прямо в рендере, и проверить
  // его надо на том же коммите, а не дожидаясь смены каких-то пропсов.
  useEffect(() => {
    if (!resyncBottomRef.current) return;
    resyncBottomRef.current = false;
    virtuosoRef.current?.scrollToIndex({ align: 'end', behavior: 'auto', index: 'LAST' });
  });

  // ---- прижатие к низу -------------------------------------------------
  // followOutput вызывается на КАЖДУЮ прибавку в конце ленты. По умолчанию
  // едем вниз, только если человек и так внизу; флаг stick — разовое
  // исключение для своей отправки (её видно всегда, как в любом мессенджере).
  const stickRef = useRef(false);
  // Идёт переход к старому сообщению — до этого момента прижим к низу выключён.
  // Иначе он выигрывает гонку: последняя догруженная страница приходит ТЕМ ЖЕ
  // коммитом, в котором мы уводим ленту к цели, followOutput видит «человек внизу»
  // и утаскивает её обратно. Снаружи это выглядело так, будто переход из поиска
  // просто не работает: история дотягивалась, а лента оставалась на последних.
  const jumpUntilRef = useRef(0);
  const followOutput = useCallback((isAtBottom: boolean) => {
    if (Date.now() < jumpUntilRef.current) return false;
    if (stickRef.current) {
      stickRef.current = false;
      return 'auto' as const;
    }
    return isAtBottom ? ('auto' as const) : false;
  }, []);

  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    // Доехали до низа — значит стартовая установка позиции закончилась.
    if (atBottom) settledRef.current = true;
    // Человек ушёл вверх, пока его сообщение летело на сервер (вложения ждут
    // ответа POST) — снимаем взвод, чтобы не выдернуть его из чтения.
    else stickRef.current = false;
  }, []);

  // ---- догрузка старых при подходе к верху ------------------------------
  // Свой засов помимо loadingMore: startReached может выстрелить несколько раз
  // подряд, пока состояние загрузки ещё не доехало до пропса.
  const olderPendingRef = useRef(false);
  useEffect(() => {
    olderPendingRef.current = false;
  }, [messages.length, hasMore, loadingMore]);

  // Пока движок не встал в конец ленты, startReached — ЛОЖНЫЙ: до первых замеров
  // отрисовка начинается с самого старого сообщения, то есть «верх достигнут»
  // сразу на монтировании. Без этого засова открытие чата вытягивало ВСЮ историю
  // подряд (страница → она снова начинается с нулевого элемента → ещё страница),
  // проверено по сети: 7 запросов на 332 сообщения при открытии.
  //
  // Установка считается законченной, когда лента доехала до низа (atBottom) ИЛИ
  // когда прокрутка вообще сдвинулась с нуля — второй признак страхует первый.
  const scrollerElRef = useRef<HTMLElement | null>(null);
  const setScroller = useCallback((el: HTMLElement | Window | null) => {
    scrollerElRef.current = el && 'scrollTop' in el ? (el as HTMLElement) : null;
  }, []);

  const handleStartReached = useCallback(() => {
    if (!settledRef.current && !((scrollerElRef.current?.scrollTop ?? 0) > 0)) return;
    settledRef.current = true;
    if (!hasMore || loadingMore || olderPendingRef.current) return;
    olderPendingRef.current = true;
    onLoadOlder();
  }, [hasMore, loadingMore, onLoadOlder]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToMessage(messageId: string) {
        const index = messagesRef.current.findIndex((m) => m.id === messageId);
        if (index < 0) return false;
        // Плавно — только если пузырь уже смонтирован (цитата рядом). Прыжок через
        // тысячу неизмеренных строк плавным быть не может: движок доедет,
        // перемеряет и доскочит — рывками. Далёкий переход делаем мгновенным,
        // как в Telegram: цель и так подсвечивается вспышкой.
        const rendered = !!document.getElementById(`msg-${messageId}`);
        jumpUntilRef.current = Date.now() + 1200;
        virtuosoRef.current?.scrollToIndex({
          align: 'center',
          behavior: rendered ? 'smooth' : 'auto',
          index,
        });
        // Повтор следующим кадром — на случай, если прижим к низу успел поставить
        // свою прокрутку в очередь до нас. Для мгновенного перехода это незаметно:
        // если мы уже на месте, повтор ничего не двигает.
        if (!rendered) {
          requestAnimationFrame(() => {
            if (messagesRef.current[index]?.id === messageId) {
              virtuosoRef.current?.scrollToIndex({ align: 'center', behavior: 'auto', index });
            }
          });
        }
        return true;
      },
      stickToBottom() {
        jumpUntilRef.current = 0; // человек сам попросил вниз — переход больше не в приоритете
        stickRef.current = true;
        virtuosoRef.current?.scrollToIndex({ align: 'end', behavior: 'auto', index: 'LAST' });
      },
    }),
    [],
  );

  const itemContent = useCallback(
    (_index: number, m: ChatMessage) => (
      // Отступы ленты живут ЗДЕСЬ, а не на прокручиваемом контейнере: нижний
      // отступ подменяет прежний flex-gap. Через margin делать нельзя — движок
      // меряет offsetHeight строки, а внешние отступы в него не входят, и
      // высоты «поехали» бы на всю ленту.
      <div
        style={{
          paddingBottom: 'var(--spacing-2)',
          paddingLeft: 'var(--spacing-5)',
          paddingRight: 'var(--spacing-5)',
        }}
      >
        {m.type === 'system' ? (
          <SystemPlaque message={m} />
        ) : m.type === 'rich_card' ? (
          <CardRow message={m} onCardUpdated={onCardUpdated} />
        ) : (
          <MessageBubble
            message={m}
            mine={m.authorId === currentUserId}
            currentUserId={currentUserId}
            showAuthor={showAuthor}
            highlighted={m.id === flashId}
            messageActions={messageActions}
            onEdit={onEdit}
            onDelete={onDelete}
            onReply={onReply}
            onJumpTo={onJumpTo}
            onMessageAction={onMessageAction}
          />
        )}
      </div>
    ),
    [
      currentUserId,
      showAuthor,
      flashId,
      messageActions,
      onEdit,
      onDelete,
      onReply,
      onJumpTo,
      onMessageAction,
      onCardUpdated,
    ],
  );

  const computeItemKey = useCallback((_index: number, m: ChatMessage) => m.id, []);
  const components = useMemo<Components<ChatMessage, ListContext>>(
    () => ({ Footer: ListFooter, Header: ListHeader }),
    [],
  );
  const context = useMemo<ListContext>(() => ({ hasMore, loadingMore }), [hasMore, loadingMore]);

  if (loadingMessages && messages.length === 0) {
    return (
      <div style={{ flex: 1, minHeight: 0, padding: 'var(--spacing-5)' }}>
        <p className="label-sm" style={{ padding: 'var(--spacing-4)', textAlign: 'center' }}>Загрузка...</p>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div
        style={{
          alignItems: 'center',
          display: 'flex',
          flex: 1,
          flexDirection: 'column',
          justifyContent: 'center',
          minHeight: 0,
          padding: 'var(--spacing-8)',
          textAlign: 'center',
        }}
      >
        <p className="label-md">Пока нет сообщений</p>
        <p className="label-sm" style={{ marginTop: 'var(--spacing-1)', opacity: 0.7 }}>
          Напишите первое сообщение ниже
        </p>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0 }}>
      <Virtuoso<ChatMessage, ListContext>
        ref={virtuosoRef}
        // Короткая переписка прижимается к НИЗУ, к полю ввода (модель Telegram/
        // WhatsApp): лента растёт снизу вверх, и новое сообщение появляется там,
        // где его ждут. Пустое место остаётся сверху, а не под сообщениями.
        alignToBottom
        atBottomStateChange={handleAtBottomStateChange}
        atBottomThreshold={AT_BOTTOM_THRESHOLD}
        components={components}
        computeItemKey={computeItemKey}
        context={context}
        data={messages}
        defaultItemHeight={DEFAULT_ITEM_HEIGHT}
        firstItemIndex={firstItemIndex}
        followOutput={followOutput}
        increaseViewportBy={VIEWPORT_OVERSCAN}
        // Читается один раз при монтировании — поэтому лента и не монтируется,
        // пока не приехали сообщения (иначе открытый чат встал бы на САМОМ
        // СТАРОМ сообщении вместо свежих).
        initialTopMostItemIndex={messages.length - 1}
        itemContent={itemContent}
        scrollerRef={setScroller}
        startReached={handleStartReached}
        style={{ height: '100%' }}
      />
    </div>
  );
});

/**
 * Шапка ленты: верхний отступ + место под индикатор догрузки. Высота места
 * ПОСТОЯННА, пока история не кончилась: скачущая шапка сдвигала бы сообщения
 * ровно в тот момент, когда человек читает верх ленты.
 */
const ListHeader: Components<ChatMessage, ListContext>['Header'] = ({ context }) => (
  <div style={{ paddingTop: 'var(--spacing-5)' }}>
    {context?.hasMore && (
      <div style={{ alignItems: 'center', display: 'flex', height: 28, justifyContent: 'center' }}>
        {context.loadingMore && (
          <span className="label-sm" style={{ fontSize: '0.75rem', opacity: 0.75 }}>Загрузка...</span>
        )}
      </div>
    )}
  </div>
);

/** Подвал: добирает нижний отступ ленты до прежнего (у последней строки уже есть свой). */
const ListFooter: Components<ChatMessage, ListContext>['Footer'] = () => (
  <div style={{ height: 'calc(var(--spacing-5) - var(--spacing-2))' }} />
);

/** Рич-карточка отдельной строкой: memo, чтобы вспышка соседа её не перерисовывала. */
const CardRow = memo(function CardRow({
  message,
  onCardUpdated,
}: {
  message: ChatMessage;
  onCardUpdated?: (messageId: string, card: RichCardPayload) => void;
}) {
  return (
    <RichCardWidget
      payload={message.payload as unknown as RichCardPayload}
      onActionDone={(card) => onCardUpdated?.(message.id, card)}
    />
  );
});

// ============================================================
// One message bubble. Mine = right, primary color. Others = left,
// paper layer. Tombstone for deleted; "(изменено)" for edited.
// Memoized: presence/typing churn re-renders the parent constantly — with stable
// handler props (refs in Conversation) unchanged bubbles skip re-rendering entirely.
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
  // Кнопка «⋯» больше не завязана на mouse-state: она ВСЕГДА в DOM (Tab до неё
  // доходит), а видимость решает CSS .msg-row (:hover/:focus-within/тач).
  // Бонус: движение мыши по ленте перестало ре-рендерить баблы.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [confirmDelete, confirmDeleteUI] = useConfirm();

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
      className="msg-row"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: mine ? 'flex-end' : 'flex-start',
        maxWidth: '100%',
        // Сама подсветка — на ПУЗЫРЕ (класс msg-bubble--flash ниже). Здесь только
        // подъём строки: пульсирующее кольцо выходит за её границы и иначе
        // оказалось бы под фоном соседнего сообщения.
        position: 'relative',
        zIndex: highlighted ? 1 : undefined,
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
        {!deleted && persisted && !editing && (
          <div ref={menuRef} className={`msg-actions${menuOpen ? ' msg-actions--open' : ''}`} style={{ position: 'relative', flexShrink: 0, order: mine ? 0 : 2, zIndex: menuOpen ? 2 : undefined }}>
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
                      icon="edit"
                      label={message.type === 'attachment' ? 'Изменить подпись' : 'Редактировать'}
                      onClick={() => {
                        setMenuOpen(false);
                        setEditDraft(message.content ?? '');
                        setEditing(true);
                      }}
                    />
                    <CornerMenuItem
                      icon="delete"
                      label="Удалить"
                      danger
                      onClick={() => {
                        setMenuOpen(false);
                        confirmDelete(
                          { title: 'Удалить сообщение?', message: 'Оно исчезнет у всех участников чата.', confirmLabel: 'Удалить', danger: true },
                          () => onDelete(message.id),
                        );
                      }}
                    />
                  </>
                )}
              </div>
            )}
          </div>
        )}

        <div
          className={highlighted ? 'msg-bubble--flash' : undefined}
          style={{
            order: 1,
            padding: 'var(--spacing-2) var(--spacing-4)',
            borderRadius: mine ? '1rem 1rem 0.3rem 1rem' : '1rem 1rem 1rem 0.3rem',
            // «Мой» бабл — фирменный градиент от светлой базы (возвращён по
            // решению пользователя 2026-08-01: тёмный вариант «чересчур строгий»;
            // осознанное отступление от AA на светлом краю градиента)
            background: deleted
              ? 'var(--surface-container)'
              : mine
                ? 'linear-gradient(135deg, var(--primary), var(--primary-dim))'
                : 'var(--surface-container-high)',
            color: deleted ? 'var(--on-surface-variant)' : mine ? 'var(--on-primary)' : 'var(--on-surface)',
            boxShadow: 'var(--shadow-card)',
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
              <AttachmentContent payload={message.payload as never} messageId={message.id} />
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
      {confirmDeleteUI}
    </div>
  );
});

// ============================================================
// System message — a centered grey plaque (group/task lifecycle).
// No bubble, no author, no ticks. Never counted as unread.
// ============================================================

const SystemPlaque = memo(function SystemPlaque({ message }: { message: ChatMessage }) {
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
});

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
      <MenuGlyph icon={icon} />
      <span style={{ minWidth: 0 }}>{label}</span>
    </button>
  );
}

/**
 * Значок пункта меню. Реестр быстрых действий (core/quick-actions) отдаёт
 * иконку строкой-эмодзи, а кит — семантическим именем: известные эмодзи
 * переводим в имя, остальное разбирает `Glyph`.
 */
function MenuGlyph({ icon }: { icon: string }) {
  return <Glyph value={QUICK_ACTION_GLYPH[icon] ?? icon} size={15} />;
}

/** Эмодзи из реестра быстрых действий → иконка системы. */
const QUICK_ACTION_GLYPH: Record<string, IconName> = {
  '✅': 'checkCircle', '✓': 'check', '⏰': 'clock', '🔔': 'bell',
  '📅': 'calendar', '🗓': 'calendar', '💸': 'finance', '💰': 'coins',
  '📝': 'edit', '↩': 'arrowLeft',
};

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
