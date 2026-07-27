'use client';

// ============================================================
// FinanceShell — контекст книги Финансов (выбор книги + доступ).
//
// Держит контекст книги (?book= в URL — ссылка на чужую книгу шарится и
// переживает F5), общие запросы (обзор/близкие/доступные книги) и раздаёт
// их разделам через useFinanceBook(). В шапке сайдбара — переключатель книг
// (паттерн «переключатель воркспейса» Notion/Slack) + «Доступ» (владелец).
// ============================================================

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
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
import { Chip, Icon, IconButton, LoadingBlock, usePopover } from '@/components/ui';
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


  if (!isReady) return <LoadingBlock />;

  // Разделы Финансов переехали в ГЛОБАЛЬНЫЙ сайдбар (AppShell). Здесь
  // остаётся контекст книги и её переключатель — он привязан к сервису,
  // а не к приложению, поэтому живёт над содержимым раздела.
  return (
    <>
      <div style={{ marginBottom: 'var(--spacing-4)' }}>
        <FinanceBookCard
          activeBookId={bookId}
          sharedBooks={sharedBooks}
          isOwnBook={isOwnBook}
          canEdit={canEdit}
          onSwitch={switchBook}
          onAccess={() => setShowAccess(true)}
        />
      </div>
      {/* key = книга: смена книги ПЕРЕМОНТИРУЕТ раздел — все локальные
          состояния страниц (фильтр по счёту, режим правки, формы) не
          переживают смену контекста (паритет со сбросами старого onSwitch) */}
      <Ctx.Provider key={bookId ?? 'own'} value={ctx}>{children}</Ctx.Provider>
      {showAccess && <AccessModal onClose={() => setShowAccess(false)} />}
    </>
  );
}

// ------------------------------------------------------------
// Пилюля книги над содержимым раздела: текущий контекст + выбор книги + Доступ
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
  // Механизм всплывания — из кита (закрытие по Esc и клику вне, переворот,
  // портал). Готовый Menu тут не годится: его пункты — текстовые, а книгу
  // называет ЧЕЛОВЕК, и по принципу 2 он рисуется карточкой PersonChip.
  const { anchorRef, layerRef, open, setOpen, layerStyle } = usePopover<HTMLButtonElement>({ matchWidth: true, maxHeight: 320 });
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const active = sharedBooks.find((b) => b.bookId === activeBookId);
  const hasChoice = sharedBooks.length > 0;

  const pick = (bookId: string | null) => {
    onSwitch(bookId);
    setOpen(false);
  };

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.375rem',
        background: 'var(--block)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-pill)',
        padding: '0.25rem 0.375rem 0.25rem 0.625rem',
        boxShadow: 'var(--shadow-card)',
      }}
    >
      <Icon name="finance" size={17} style={{ color: 'var(--primary-dim)', flex: 'none' }} />
      <button
        ref={anchorRef}
        type="button"
        onClick={() => hasChoice && setOpen(!open)}
        aria-expanded={hasChoice ? open : undefined}
        aria-haspopup={hasChoice ? 'listbox' : undefined}
        disabled={!hasChoice}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.375rem',
          minWidth: 0,
          background: 'none',
          border: 'none',
          padding: '0.125rem 0',
          cursor: hasChoice ? 'pointer' : 'default',
          textAlign: 'left',
          color: 'var(--on-surface)',
        }}
      >
        {active ? (
          /* Принцип 2: человек — только карточкой (скины видны и здесь) */
          <PersonChip size="S" userId={active.ownerUserId} firstName={active.ownerName} avatar={active.ownerAvatar} />
        ) : (
          <span className="title-sm" style={{ whiteSpace: 'nowrap' }}>Моя книга</span>
        )}
        {hasChoice && <Icon name="caretDown" size={13} style={{ color: 'var(--label)', flex: 'none' }} />}
      </button>

      {!isOwnBook && !canEdit && <Chip size="sm" tone="warning" icon="eye">только просмотр</Chip>}

      {isOwnBook && (
        <IconButton icon="key" label="Доступ к моим финансам" size={30} onClick={onAccess} />
      )}

      {open && mounted && createPortal(
        <div ref={layerRef} className="ui-popover" style={layerStyle} role="listbox" aria-label="Книга финансов">
          <button
            type="button"
            className="ui-option"
            role="option"
            aria-selected={isOwnBook}
            data-selected={isOwnBook ? 'true' : 'false'}
            onClick={() => pick(null)}
          >
            <Icon name="finance" size={16} />
            <span>Моя книга</span>
          </button>
          {sharedBooks.map((b) => (
            <button
              key={b.bookId}
              type="button"
              className="ui-option"
              role="option"
              aria-selected={activeBookId === b.bookId}
              data-selected={activeBookId === b.bookId ? 'true' : 'false'}
              onClick={() => pick(b.bookId)}
            >
              <PersonChip size="S" userId={b.ownerUserId} firstName={b.ownerName} avatar={b.ownerAvatar} />
              <span className="label-sm" style={{ marginLeft: 'auto' }}>
                {b.myRole === 'editor' ? 'ведёте вместе' : 'смотрите'}
              </span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
