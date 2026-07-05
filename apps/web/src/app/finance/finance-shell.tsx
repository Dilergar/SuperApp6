'use client';

// ============================================================
// FinanceShell — сайдбар-каркас сервиса «Финансы» поверх ServiceShell.
//
// Держит контекст книги (?book= в URL — ссылка на чужую книгу шарится и
// переживает F5), общие запросы (обзор/близкие/доступные книги) и раздаёт
// их разделам через useFinanceBook(). В шапке сайдбара — переключатель книг
// (паттерн «переключатель воркспейса» Notion/Slack) + «Доступ» (владелец).
// ============================================================

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { FinAccountDto, FinBookOverviewDto, FinPersonDto, FinSharedBookDto } from '@superapp/shared';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import {
  financeOverviewKey,
  financePeopleKey,
  financeSharedBooksKey,
  fetchFinanceOverview,
  fetchFinancePeople,
  fetchFinanceSharedBooks,
} from '@/lib/queries';
import { getServiceNav } from '@/lib/service-nav';
import { ServiceShell } from '@/components/shell/ServiceShell';
import { PersonChip } from '../circles/PersonCard';
import { AccessModal } from './finance-access';

export interface FinanceBookCtx {
  /** null = моя книга; id = чужая (query-параметр ?book=). */
  bookId: string | null;
  isOwnBook: boolean;
  canEdit: boolean;
  meId: string | null;
  meName: string;
  overview: FinBookOverviewDto | undefined;
  /** Активные (не архивные) счета книги. */
  accounts: FinAccountDto[];
  /** Все категории книги (как отдаёт бэкенд). */
  categories: FinAccountDto[];
  people: FinPersonDto[];
  invalidate: () => void;
  /** href с сохранением контекста книги (+доп. параметры). */
  withBook: (href: string, extra?: Record<string, string>) => string;
}

const Ctx = createContext<FinanceBookCtx | null>(null);

export function useFinanceBook(): FinanceBookCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useFinanceBook вне FinanceShell');
  return v;
}

export function FinanceShell({ defaultCollapsed, children }: { defaultCollapsed?: boolean; children: React.ReactNode }) {
  const { isReady, user: me } = useRequireAuth();
  const qc = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();

  const bookId = search.get('book');
  const isOwnBook = !bookId;
  const [showAccess, setShowAccess] = useState(false);

  const { data: overview } = useQuery({
    queryKey: financeOverviewKey(bookId),
    queryFn: () => fetchFinanceOverview(bookId),
    enabled: isReady,
  });
  const { data: people = [] } = useQuery({
    queryKey: financePeopleKey(bookId),
    queryFn: () => fetchFinancePeople(bookId),
    enabled: isReady,
  });
  const { data: sharedBooks = [] } = useQuery({
    queryKey: financeSharedBooksKey,
    queryFn: fetchFinanceSharedBooks,
    enabled: isReady,
  });

  const canEdit = (overview?.book.myRole ?? 'owner') !== 'viewer';

  const withBook = useCallback(
    (href: string, extra?: Record<string, string>) => {
      const qs = new URLSearchParams();
      if (bookId) qs.set('book', bookId);
      for (const [k, v] of Object.entries(extra ?? {})) qs.set(k, v);
      const s = qs.toString();
      return s ? `${href}?${s}` : href;
    },
    [bookId],
  );

  const switchBook = useCallback(
    (nextBookId: string | null) => {
      // Коины есть только в своей книге — при переходе в чужую уводим на Обзор
      const target = nextBookId && pathname === '/finance/coins' ? '/finance' : pathname;
      router.push(nextBookId ? `${target}?book=${nextBookId}` : target);
    },
    [pathname, router],
  );

  const ctx = useMemo<FinanceBookCtx>(
    () => ({
      bookId,
      isOwnBook,
      canEdit,
      meId: me?.id ?? null,
      meName: me?.firstName ?? 'Я',
      overview,
      accounts: (overview?.accounts ?? []).filter((a) => !a.archived),
      categories: overview?.categories ?? [],
      people,
      invalidate: () => qc.invalidateQueries({ queryKey: ['finance'] }),
      withBook,
    }),
    [bookId, isOwnBook, canEdit, me?.id, me?.firstName, overview, people, qc, withBook],
  );

  const nav = useMemo(() => getServiceNav('finance', { isOwnBook }), [isOwnBook]);

  if (!isReady) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="label-md" style={{ fontSize: '1rem' }}>Загрузка...</p>
      </div>
    );
  }

  return (
    <>
      <ServiceShell
        nav={nav}
        defaultCollapsed={defaultCollapsed}
        headerSlot={
          <FinanceBookCard
            activeBookId={bookId}
            sharedBooks={sharedBooks}
            isOwnBook={isOwnBook}
            canEdit={canEdit}
            onSwitch={switchBook}
            onAccess={() => setShowAccess(true)}
          />
        }
      >
        {/* key = книга: смена книги ПЕРЕМОНТИРУЕТ раздел — все локальные
            состояния страниц (фильтр по счёту, режим правки, формы) не
            переживают смену контекста (паритет со сбросами старого onSwitch) */}
        <Ctx.Provider key={bookId ?? 'own'} value={ctx}>{children}</Ctx.Provider>
      </ServiceShell>
      {showAccess && <AccessModal onClose={() => setShowAccess(false)} />}
    </>
  );
}

// ------------------------------------------------------------
// Карточка книги в шапке сайдбара: текущий контекст + дропдаун книг + Доступ
// ------------------------------------------------------------

function FinanceBookCard({
  activeBookId,
  sharedBooks,
  isOwnBook,
  canEdit,
  onSwitch,
  onAccess,
}: {
  activeBookId: string | null;
  sharedBooks: FinSharedBookDto[];
  isOwnBook: boolean;
  canEdit: boolean;
  onSwitch: (bookId: string | null) => void;
  onAccess: () => void;
}) {
  const [open, setOpen] = useState(false);
  const active = sharedBooks.find((b) => b.bookId === activeBookId);
  const hasChoice = sharedBooks.length > 0;

  return (
    <div style={{ position: 'relative' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          background: 'var(--surface-container)',
          borderRadius: 'var(--radius-sketch)',
          padding: '0.45rem 0.55rem',
          boxShadow: '0 2px 10px rgba(56,57,45,0.05)',
        }}
      >
        <button
          onClick={() => hasChoice && setOpen((v) => !v)}
          aria-expanded={open}
          aria-haspopup={hasChoice ? 'menu' : undefined}
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            background: 'none',
            border: 'none',
            cursor: hasChoice ? 'pointer' : 'default',
            padding: 0,
            textAlign: 'left',
          }}
        >
          <span style={{ fontSize: '1.05rem' }} aria-hidden>📒</span>
          {active ? (
            /* Принцип 2: человек — только карточкой (скины видны и здесь) */
            <PersonChip size="S" userId={active.ownerUserId} firstName={active.ownerName} avatar={active.ownerAvatar} />
          ) : (
            <span
              style={{
                fontFamily: 'var(--font-display)',
                fontWeight: 600,
                fontSize: '0.85rem',
                color: 'var(--on-surface)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              Моя книга
            </span>
          )}
          {hasChoice && (
            <svg
              width="13"
              height="13"
              viewBox="0 0 12 12"
              fill="none"
              aria-hidden
              style={{
                flexShrink: 0,
                marginLeft: 'auto',
                color: 'var(--on-surface-variant)',
                transition: 'transform 0.15s ease',
                transform: open ? 'rotate(180deg)' : undefined,
              }}
            >
              <path d="M2.4 4.3 6 7.9l3.6-3.6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
        {isOwnBook && (
          <button
            onClick={onAccess}
            title="Доступ к моим финансам"
            aria-label="Доступ к моим финансам"
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.95rem', padding: '0 0.15rem' }}
          >
            🔑
          </button>
        )}
      </div>

      {!isOwnBook && !canEdit && (
        <div className="wash-secondary label-sm" style={{ marginTop: '0.35rem', padding: '0.2rem 0.6rem', display: 'inline-block' }}>
          только просмотр
        </div>
      )}

      {open && (
        <>
          {/* прозрачная подложка — клик мимо закрывает дропдаун */}
          <div style={{ position: 'fixed', inset: 0, zIndex: 68 }} onClick={() => setOpen(false)} />
          <div
            className="card-elevated"
            style={{
              position: 'absolute',
              top: 'calc(100% + 0.4rem)',
              left: 0,
              right: 0,
              zIndex: 69,
              background: 'var(--surface-container-lowest)',
              padding: '0.4rem',
              borderRadius: 'var(--radius-md)',
              maxHeight: '50vh',
              overflowY: 'auto',
            }}
          >
            <button
              onClick={() => { onSwitch(null); setOpen(false); }}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                background: isOwnBook ? 'var(--secondary-container)' : 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '0.5rem 0.6rem',
                borderRadius: 'var(--radius-sm)',
                fontWeight: 600,
                fontSize: '0.85rem',
              }}
            >
              📒 Моя книга
            </button>
            {sharedBooks.map((b) => (
              <button
                key={b.bookId}
                onClick={() => { onSwitch(b.bookId); setOpen(false); }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  width: '100%',
                  textAlign: 'left',
                  background: activeBookId === b.bookId ? 'var(--secondary-container)' : 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '0.4rem 0.6rem',
                  borderRadius: 'var(--radius-sm)',
                }}
              >
                <PersonChip size="S" userId={b.ownerUserId} firstName={b.ownerName} avatar={b.ownerAvatar} />
                <span className="label-sm">{b.myRole === 'editor' ? 'ведёте вместе' : 'смотрите'}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
