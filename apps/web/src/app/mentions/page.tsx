'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { MentionItem, MentionFeed } from '@superapp/shared';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { getMentions, markMentionsRead } from '@/lib/messenger-api';
import { PersonAvatar } from '../messenger/messenger-ui';
import { renderMessageContent } from '../messenger/mention-render';
import { mentionsFeedKey } from '@/lib/hooks/useMentionsUnread';

// ============================================================
// Mentions Hub (Phase 5) — a feed of "mentions of me" across the app
// (messenger / task / calendar / listing). Each row: who mentioned me,
// where (context), a snippet, relative time, unread dot. Clicking a row
// deep-links into the source and marks that one read. "Прочитать все"
// clears the lot. Sketchbook look — warm paper, no white surfaces.
// ============================================================

export default function MentionsPage() {
  const { isReady, user } = useRequireAuth();
  const currentUserId = user?.id ?? '';
  const router = useRouter();
  const queryClient = useQueryClient();

  // Accumulated pages (cursor-driven "показать ещё").
  const [extraPages, setExtraPages] = useState<MentionItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const firstPageQuery = useQuery({
    queryKey: mentionsFeedKey,
    queryFn: () => getMentions(),
    enabled: isReady,
  });
  const firstPage: MentionFeed | undefined = firstPageQuery.data;

  const items = useMemo<MentionItem[]>(
    () => [...(firstPage?.items ?? []), ...extraPages],
    [firstPage, extraPages],
  );
  const unreadCount = firstPage?.unreadCount ?? 0;
  // The "next" cursor: from the latest manual page if we've paged, else page 1.
  const nextCursor = cursor !== null ? cursor : (firstPage?.nextCursor ?? null);
  const hasMore = nextCursor != null;

  const loadMore = useCallback(async () => {
    if (!hasMore || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await getMentions(nextCursor ?? undefined);
      setExtraPages((old) => [...old, ...page.items]);
      setCursor(page.nextCursor);
    } catch {
      /* leave cursor as-is so the button retries */
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, loadingMore, nextCursor]);

  // Optimistically flip a row to read in the cached first page + extra pages,
  // and decrement the unread badge. Caller (openMention) only invokes this for a
  // currently-UNREAD row, so the badge always drops by exactly 1 — regardless of
  // whether the row lives in page 1 or a "Показать ещё" page (unreadCount is a
  // global count on the first page, not per-page).
  const markOneReadLocally = useCallback(
    (id: string) => {
      queryClient.setQueryData<MentionFeed>(mentionsFeedKey, (old) =>
        old
          ? {
              ...old,
              items: old.items.map((it) => (it.id === id ? { ...it, read: true } : it)),
              unreadCount: Math.max(0, old.unreadCount - 1),
            }
          : old,
      );
      setExtraPages((old) => old.map((it) => (it.id === id ? { ...it, read: true } : it)));
    },
    [queryClient],
  );

  const openMention = useCallback(
    (item: MentionItem) => {
      if (!item.read) {
        markOneReadLocally(item.id);
        markMentionsRead([item.id]).catch(() => {});
      }
      // For chat mentions, target the exact message so it scrolls into view + flashes
      // (the server `url` only opens the chat). Other sources use their url as-is.
      const target =
        item.sourceType === 'messenger' && item.chatId && item.messageId
          ? `/messenger?chat=${item.chatId}&msg=${item.messageId}`
          : item.url;
      router.push(target);
    },
    [markOneReadLocally, router],
  );

  const markAllRead = useCallback(async () => {
    queryClient.setQueryData<MentionFeed>(mentionsFeedKey, (old) =>
      old ? { ...old, items: old.items.map((it) => ({ ...it, read: true })), unreadCount: 0 } : old,
    );
    setExtraPages((old) => old.map((it) => ({ ...it, read: true })));
    try {
      await markMentionsRead();
    } finally {
      queryClient.invalidateQueries({ queryKey: mentionsFeedKey });
    }
  }, [queryClient]);

  if (!isReady) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="label-md" style={{ fontSize: '1rem' }}>Загрузка...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--surface)' }}>
      {/* Nav — glassmorphism, matches messenger/dashboard */}
      <nav
        className="fixed top-0 w-full z-50 px-6 py-4"
        style={{ background: 'rgba(245, 245, 220, 0.7)', backdropFilter: 'blur(10px)' }}
      >
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <Link href="/dashboard" className="title-md" style={{ color: 'var(--primary)' }}>
            SuperApp6
          </Link>
          <div style={{ display: 'flex', gap: 'var(--spacing-3)' }}>
            <Link href="/messenger" className="btn-secondary" style={{ padding: '0.4rem 1rem', fontSize: '0.8rem' }}>
              Мессенджер
            </Link>
            <Link href="/dashboard" className="btn-secondary" style={{ padding: '0.4rem 1rem', fontSize: '0.8rem' }}>
              Главная
            </Link>
          </div>
        </div>
      </nav>

      <div className="max-w-3xl mx-auto px-6 pt-24" style={{ paddingBottom: 'var(--spacing-12)' }}>
        {/* Header — asymmetric, with the "mark all" action */}
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: 'var(--spacing-4)',
            marginBottom: 'var(--spacing-8)',
            paddingLeft: 'var(--spacing-2)',
          }}
        >
          <div>
            <h1 className="display-md" style={{ marginBottom: 'var(--spacing-1)' }}>
              Упоминания
            </h1>
            <p className="label-md" style={{ fontSize: '0.9rem', opacity: 0.75 }}>
              {unreadCount > 0 ? `${unreadCount} ${pluralMentions(unreadCount)}` : 'Все прочитано'}
            </p>
          </div>
          {unreadCount > 0 && (
            <button
              onClick={markAllRead}
              className="btn-secondary"
              style={{ padding: '0.45rem 1.1rem', fontSize: '0.82rem', flexShrink: 0 }}
            >
              Прочитать все
            </button>
          )}
        </div>

        {/* Feed */}
        {firstPageQuery.isLoading && (
          <p className="label-md" style={{ padding: 'var(--spacing-6)', textAlign: 'center' }}>Загрузка...</p>
        )}

        {!firstPageQuery.isLoading && items.length === 0 && (
          <div
            style={{
              background: 'var(--surface-container-low)',
              borderRadius: 'var(--radius-md)',
              padding: 'var(--spacing-12) var(--spacing-6)',
              textAlign: 'center',
            }}
          >
            <div
              aria-hidden
              style={{
                width: '3.5rem',
                height: '3.5rem',
                margin: '0 auto var(--spacing-4)',
                borderRadius: 'var(--radius-sketch)',
                background: 'var(--secondary-container)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '1.5rem',
                color: 'var(--secondary)',
                fontFamily: 'var(--font-display)',
                fontWeight: 700,
                transform: 'rotate(-5deg)',
              }}
            >
              @
            </div>
            <p className="title-md" style={{ marginBottom: 'var(--spacing-1)' }}>Пока нет упоминаний</p>
            <p className="label-sm" style={{ opacity: 0.7, maxWidth: '22rem', margin: '0 auto' }}>
              Когда кто-то упомянет вас через @ в чате, задаче или событии — это появится здесь
            </p>
          </div>
        )}

        {items.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
            {items.map((item, i) => (
              <MentionRow
                key={item.id}
                item={item}
                currentUserId={currentUserId}
                tilt={i % 2 === 0 ? -0.4 : 0.4}
                onOpen={() => openMention(item)}
              />
            ))}
          </div>
        )}

        {hasMore && items.length > 0 && (
          <div style={{ textAlign: 'center', marginTop: 'var(--spacing-6)' }}>
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="btn-secondary"
              style={{ padding: '0.5rem 1.4rem', fontSize: '0.82rem', opacity: loadingMore ? 0.6 : 1 }}
            >
              {loadingMore ? 'Загрузка...' : 'Показать ещё'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// One feed row. Unread → brighter paper + a wax-red dot. Clicking
// deep-links into the source. Snippet renders @-tokens as chips.
// ============================================================

function MentionRow({
  item,
  currentUserId,
  tilt,
  onOpen,
}: {
  item: MentionItem;
  currentUserId: string;
  tilt: number;
  onOpen: () => void;
}) {
  return (
    <button
      onClick={onOpen}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--spacing-3)',
        width: '100%',
        textAlign: 'left',
        padding: 'var(--spacing-4)',
        background: item.read ? 'var(--surface-container-low)' : 'var(--surface-container)',
        border: 'none',
        borderRadius: 'var(--radius-md)',
        cursor: 'pointer',
        boxShadow: item.read ? 'none' : '0 2px 14px rgba(198, 26, 30, 0.07)',
        transform: `rotate(${tilt}deg)`,
        transition: 'background 0.15s ease, box-shadow 0.15s ease',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--surface-container-high)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = item.read ? 'var(--surface-container-low)' : 'var(--surface-container)';
      }}
    >
      <div style={{ position: 'relative', flexShrink: 0 }}>
        <PersonAvatar userId={item.mentionerUserId} name={item.mentionerName} avatar={item.mentionerAvatar} />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 700, fontSize: '0.92rem', color: 'var(--on-surface)' }}>
            {item.mentionerName}
          </span>
          <span className="label-sm" style={{ fontSize: '0.74rem', opacity: 0.7 }}>
            упомянул(а) вас
          </span>
          <span
            className="label-sm"
            style={{
              fontSize: '0.66rem',
              fontWeight: 600,
              color: 'var(--secondary)',
              background: 'var(--secondary-container)',
              padding: '0.05rem 0.45rem',
              borderRadius: 'var(--radius-sketch)',
            }}
          >
            {sourceLabel(item.sourceType)}
          </span>
        </div>

        {item.contextTitle && (
          <div
            className="label-sm"
            style={{
              fontSize: '0.78rem',
              fontWeight: 600,
              color: 'var(--on-surface-variant)',
              marginTop: '0.2rem',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {item.contextTitle}
          </div>
        )}

        {item.snippet && (
          <div
            style={{
              fontSize: '0.85rem',
              color: 'var(--on-surface)',
              marginTop: '0.25rem',
              opacity: 0.92,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {renderMessageContent(item.snippet, currentUserId)}
          </div>
        )}

        <div className="label-sm" style={{ fontSize: '0.7rem', opacity: 0.6, marginTop: '0.3rem' }}>
          {formatMentionTime(item.createdAt)}
        </div>
      </div>

      {!item.read && (
        <span
          aria-label="Непрочитано"
          style={{
            flexShrink: 0,
            width: '0.6rem',
            height: '0.6rem',
            marginTop: '0.4rem',
            borderRadius: '0.2rem 0.28rem 0.22rem 0.25rem',
            background: 'var(--primary)',
          }}
        />
      )}
    </button>
  );
}

// ---- helpers ----

function sourceLabel(t: MentionItem['sourceType']): string {
  switch (t) {
    case 'task':
      return 'Задача';
    case 'calendar':
      return 'Событие';
    case 'listing':
      return 'Товар';
    case 'messenger':
    default:
      return 'Чат';
  }
}

function pluralMentions(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  let word: string;
  if (mod10 === 1 && mod100 !== 11) word = 'новое упоминание';
  else if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) word = 'новых упоминания';
  else word = 'новых упоминаний';
  return word;
}

/** Russian relative time for the feed: только что / N мин/ч назад / dd.MM в HH:MM. */
function formatMentionTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diffSec < 60) return 'только что';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} мин назад`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} ${hourWord(diffHr)} назад`;
  const d = new Date(iso);
  const date = d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return `${date} в ${time}`;
}

function hourWord(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'час';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'часа';
  return 'часов';
}
