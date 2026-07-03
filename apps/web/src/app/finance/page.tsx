'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FinAccountDto, FinPersonDto, FinTransactionDto } from '@superapp/shared';
import { api } from '@/lib/api';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import {
  financeOverviewKey,
  financeTransactionsKey,
  financePeopleKey,
  financeSharedBooksKey,
  fetchFinanceOverview,
  fetchFinanceTransactions,
  fetchFinancePeople,
  fetchFinanceSharedBooks,
} from '@/lib/queries';
import { BookSwitcher, AccessModal } from './finance-access';
import { CoinsView } from './finance-coins';
import { EntitySelector } from '@/components/EntitySelector';
import { PersonChip } from '../circles/PersonCard';
import { ShareCardModal } from '../messenger/ShareCardModal';
import { currencySymbol, formatDayLabel, formatMoney, localToday, parseMoneyInput, parseSignedMoneyInput } from './finance-lib';
import { ReportView } from './finance-report';
import { DebtsPanel, RecurringPanel } from './finance-debts';

type EntryTab = 'expense' | 'income' | 'transfer';
type MainView = 'feed' | 'report' | 'coins';

const CURRENCIES = ['KZT', 'USD', 'EUR', 'RUB'];
const SUBTYPES: Array<{ value: string; label: string }> = [
  { value: 'cash', label: 'Наличные' },
  { value: 'card', label: 'Карта' },
  { value: 'savings', label: 'Депозит' },
  { value: 'other', label: 'Другое' },
];

export default function FinancePage() {
  const { isReady, user: me } = useRequireAuth();
  const qc = useQueryClient();

  const [accountFilter, setAccountFilter] = useState<string | null>(null);
  const [editingTx, setEditingTx] = useState<FinTransactionDto | null>(null);
  const [view, setView] = useState<MainView>('feed');
  const [shareTxId, setShareTxId] = useState<string | null>(null);
  const [activeBookId, setActiveBookId] = useState<string | null>(null);
  const [showAccess, setShowAccess] = useState(false);

  const { data: overview } = useQuery({
    queryKey: financeOverviewKey(activeBookId),
    queryFn: () => fetchFinanceOverview(activeBookId),
    enabled: isReady,
  });
  const { data: people = [] } = useQuery({
    queryKey: financePeopleKey(activeBookId),
    queryFn: () => fetchFinancePeople(activeBookId),
    enabled: isReady,
  });
  const { data: sharedBooks = [] } = useQuery({
    queryKey: financeSharedBooksKey,
    queryFn: fetchFinanceSharedBooks,
    enabled: isReady,
  });

  const canEdit = (overview?.book.myRole ?? 'owner') !== 'viewer';
  const isOwnBook = !activeBookId;

  const txFilter = useMemo(
    () => ({
      ...(accountFilter ? { accountId: accountFilter } : {}),
      ...(activeBookId ? { bookId: activeBookId } : {}),
    }),
    [accountFilter, activeBookId],
  );
  const txQuery = useInfiniteQuery({
    queryKey: financeTransactionsKey(txFilter),
    queryFn: ({ pageParam }) =>
      fetchFinanceTransactions({ ...txFilter, cursor: (pageParam as string | undefined) || undefined }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: isReady,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['finance'] });
  };

  const accounts = useMemo(() => (overview?.accounts ?? []).filter((a) => !a.archived), [overview]);
  const categories = overview?.categories ?? [];
  const accountById = useMemo(() => {
    const map = new Map<string, FinAccountDto>();
    for (const a of overview?.accounts ?? []) map.set(a.id, a);
    for (const c of categories) map.set(c.id, c);
    return map;
  }, [overview, categories]);

  const transactions = useMemo(() => (txQuery.data?.pages ?? []).flatMap((p) => p.items), [txQuery.data]);

  if (!isReady) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="label-md" style={{ fontSize: '1rem' }}>Загрузка...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--surface)' }}>
      <nav className="fixed top-0 w-full z-50 px-6 py-4" style={{ background: 'rgba(245, 245, 220, 0.7)', backdropFilter: 'blur(10px)' }}>
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center" style={{ gap: 'var(--spacing-4)' }}>
            <Link href="/dashboard" className="label-md" style={{ textDecoration: 'none' }}>← SuperApp6</Link>
            <span className="title-md" style={{ color: 'var(--primary)' }}>Финансы</span>
          </div>
        </div>
      </nav>

      <div className="max-w-6xl mx-auto px-6 pt-24" style={{ paddingBottom: 'var(--spacing-16)' }}>
        {/* Переключатель книги + управление доступом */}
        <div className="flex items-center" style={{ gap: 'var(--spacing-3)', marginBottom: 'var(--spacing-6)', flexWrap: 'wrap' }}>
          <BookSwitcher activeBookId={activeBookId} sharedBooks={sharedBooks} onSwitch={(id) => { setActiveBookId(id); setAccountFilter(null); setEditingTx(null); }} />
          {isOwnBook && (
            <button className="btn-secondary" style={{ padding: '0.3rem 1rem', fontSize: '0.8rem' }} onClick={() => setShowAccess(true)}>
              Доступ
            </button>
          )}
          {!isOwnBook && !canEdit && (
            <span className="wash-secondary label-sm" style={{ padding: '0.25rem 0.8rem' }}>только просмотр</span>
          )}
        </div>

        <div className="grid lg:grid-cols-[320px_1fr]" style={{ gap: 'var(--spacing-8)', alignItems: 'start' }}>
          {/* ==== Левая колонка: счета + категории ==== */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-6)' }}>
            <AccountsRail
              accounts={accounts}
              activeId={accountFilter}
              onSelect={(id) => setAccountFilter((cur) => (cur === id ? null : id))}
              onChanged={invalidate}
              bookId={activeBookId}
              canEdit={canEdit}
            />
            <DebtsPanel accounts={accounts} categories={categories} people={people} onChanged={invalidate} bookId={activeBookId} canEdit={canEdit} meId={me?.id ?? null} meName={me?.firstName ?? 'Я'} />
            <RecurringPanel accounts={accounts} categories={categories} onChanged={invalidate} bookId={activeBookId} canEdit={canEdit} />
            <PeoplePanel people={people} onChanged={invalidate} bookId={activeBookId} canEdit={canEdit} />
            <CategoriesPanel categories={categories} onChanged={invalidate} bookId={activeBookId} canEdit={canEdit} />
          </div>

          {/* ==== Правая колонка: быстрый ввод + лента / отчёт ==== */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-6)' }}>
            <div className="flex" style={{ gap: 'var(--spacing-2)' }}>
              {([['feed', 'Лента'], ['report', 'Отчёт'], ...(isOwnBook ? [['coins', 'Коины 🪙'] as [MainView, string]] : [])] as Array<[MainView, string]>).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setView(key)}
                  style={{
                    border: 'none',
                    cursor: 'pointer',
                    padding: '0.4rem 1.4rem',
                    borderRadius: 'var(--radius-sketch)',
                    fontFamily: 'var(--font-display)',
                    fontWeight: 700,
                    fontSize: '0.95rem',
                    background: view === key ? 'var(--secondary-container)' : 'transparent',
                    color: 'var(--on-surface)',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            {view === 'report' && (
              <ReportView categories={categories} bookId={overview?.book.id ?? null} queryBookId={activeBookId} canEdit={canEdit} />
            )}

            {view === 'coins' && isOwnBook && <CoinsView />}

            {view === 'feed' && (
              <>
            {canEdit && (
            <QuickEntry
              accounts={accounts}
              categories={categories}
              people={people}
              editingTx={editingTx}
              onCancelEdit={() => setEditingTx(null)}
              onSaved={() => {
                setEditingTx(null);
                invalidate();
              }}
              bookId={activeBookId}
              meId={me?.id ?? null}
              meName={me?.firstName ?? 'Я'}
            />
            )}
            <TransactionFeed
              canEdit={canEdit}
              bookId={activeBookId}
              meId={me?.id ?? null}
              transactions={transactions}
              accountById={accountById}
              filterLabel={accountFilter ? accountById.get(accountFilter)?.name ?? null : null}
              onClearFilter={() => setAccountFilter(null)}
              onEdit={(tx) => {
                setEditingTx(tx);
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
              onShare={(tx) => setShareTxId(tx.id)}
              onDeleted={invalidate}
              hasMore={!!txQuery.hasNextPage}
              loadingMore={txQuery.isFetchingNextPage}
              onLoadMore={() => txQuery.fetchNextPage()}
            />
              </>
            )}
          </div>
        </div>
      </div>

      {shareTxId && (
        <ShareCardModal
          refType="fin_transaction"
          refId={shareTxId}
          title="Отправить операцию в чат"
          onClose={() => setShareTxId(null)}
        />
      )}
      {showAccess && <AccessModal onClose={() => setShowAccess(false)} />}
    </div>
  );
}

/** axios-config с bookId для запросов в чужую книгу. */
const bookParams = (bookId: string | null | undefined) => (bookId ? { params: { bookId } } : undefined);

// ============================================================
// Счета
// ============================================================

function AccountsRail({
  accounts,
  activeId,
  onSelect,
  onChanged,
  bookId,
  canEdit,
}: {
  accounts: FinAccountDto[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onChanged: () => void;
  bookId: string | null;
  canEdit: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [balanceFor, setBalanceFor] = useState<string | null>(null);

  const totals = useMemo(() => {
    const byCur = new Map<string, number>();
    for (const a of accounts.filter((x) => x.kind === 'asset')) {
      byCur.set(a.currencyCode, (byCur.get(a.currencyCode) ?? 0) + a.balance);
    }
    return [...byCur.entries()];
  }, [accounts]);

  return (
    <div className="card" style={{ transform: 'rotate(-0.4deg)' }}>
      <div className="flex items-center justify-between" style={{ marginBottom: 'var(--spacing-4)' }}>
        <h2 className="title-md">Счета</h2>
        {canEdit && (
          <button className="btn-secondary" style={{ padding: '0.25rem 0.8rem', fontSize: '0.75rem' }} onClick={() => setAdding((v) => !v)}>
            {adding ? 'Скрыть' : '+ Счёт'}
          </button>
        )}
      </div>

      {totals.length > 0 && (
        <div className="label-sm" style={{ marginBottom: 'var(--spacing-4)' }}>
          Всего:{' '}
          <span style={{ fontWeight: 700, color: 'var(--on-surface)' }}>
            {totals.map(([code, sum]) => formatMoney(sum, code)).join(' · ')}
          </span>
        </div>
      )}

      {adding && canEdit && <NewAccountForm bookId={bookId} onDone={() => { setAdding(false); onChanged(); }} />}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)' }}>
        {accounts.map((a) => (
          <div
            key={a.id}
            onClick={() => onSelect(a.id)}
            style={{
              background: activeId === a.id ? 'var(--secondary-container)' : 'var(--surface-container-lowest)',
              borderRadius: 'var(--radius-sketch)',
              padding: 'var(--spacing-3) var(--spacing-4)',
              cursor: 'pointer',
              boxShadow: '0 3px 14px rgba(56,57,45,0.05)',
            }}
          >
            <div className="flex items-center justify-between">
              <span style={{ fontWeight: 600 }}>
                <span style={{ marginRight: '0.45rem' }}>{a.icon ?? '💼'}</span>
                {a.name}
              </span>
              <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: a.balance < 0 ? 'var(--danger)' : 'var(--on-surface)' }}>
                {formatMoney(a.balance, a.currencyCode)}
              </span>
            </div>
            <div className="flex items-center justify-between" style={{ marginTop: '0.2rem' }}>
              <span className="label-sm">{SUBTYPES.find((s) => s.value === a.subtype)?.label ?? a.subtype}</span>
              {canEdit && a.kind === 'asset' && (
                <button
                  className="label-sm"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--secondary)' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setBalanceFor(balanceFor === a.id ? null : a.id);
                  }}
                >
                  остаток…
                </button>
              )}
            </div>
            {balanceFor === a.id && canEdit && (
              <SetBalanceForm
                account={a}
                bookId={bookId}
                onDone={() => {
                  setBalanceFor(null);
                  onChanged();
                }}
              />
            )}
          </div>
        ))}
        {accounts.length === 0 && <p className="label-md">Счетов пока нет — добавьте первый.</p>}
      </div>
    </div>
  );
}

function NewAccountForm({ bookId, onDone }: { bookId: string | null; onDone: () => void }) {
  const [name, setName] = useState('');
  const [subtype, setSubtype] = useState('card');
  const [currency, setCurrency] = useState('KZT');
  const [opening, setOpening] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim() || busy) return;
    const openingMinor = opening.trim() ? parseMoneyInput(opening) : null;
    setBusy(true);
    try {
      await api.post('/finance/accounts', {
        name: name.trim(),
        subtype,
        currencyCode: currency,
        ...(openingMinor ? { openingBalance: openingMinor } : {}),
      }, bookParams(bookId));
      onDone();
    } catch (e) {
      alert((e as { response?: { data?: { message?: string } } }).response?.data?.message ?? 'Не удалось создать счёт');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wash-secondary" style={{ padding: 'var(--spacing-4)', marginBottom: 'var(--spacing-4)' }}>
      <input className="input-sketch" placeholder="Название (Kaspi Gold…)" value={name} onChange={(e) => setName(e.target.value)} />
      <div className="grid grid-cols-2" style={{ gap: 'var(--spacing-3)', marginTop: 'var(--spacing-3)' }}>
        <select className="input-sketch" value={subtype} onChange={(e) => setSubtype(e.target.value)}>
          {SUBTYPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <select className="input-sketch" value={currency} onChange={(e) => setCurrency(e.target.value)}>
          {CURRENCIES.map((c) => <option key={c} value={c}>{c} {currencySymbol(c)}</option>)}
        </select>
      </div>
      <input
        className="input-sketch"
        placeholder="Сейчас на счёте (необязательно)"
        inputMode="decimal"
        value={opening}
        onChange={(e) => setOpening(e.target.value)}
        style={{ marginTop: 'var(--spacing-3)' }}
      />
      <button className="btn-primary" style={{ marginTop: 'var(--spacing-4)', padding: '0.45rem 1.4rem', fontSize: '0.85rem' }} onClick={submit} disabled={busy}>
        Создать
      </button>
    </div>
  );
}

function SetBalanceForm({ account, bookId, onDone }: { account: FinAccountDto; bookId: string | null; onDone: () => void }) {
  const [value, setValue] = useState(String(account.balance / 100));
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const minor = parseSignedMoneyInput(value);
    if (minor === null || busy) return;
    setBusy(true);
    try {
      await api.post(`/finance/accounts/${account.id}/set-balance`, { balance: minor }, bookParams(bookId));
      onDone();
    } catch (e) {
      alert((e as { response?: { data?: { message?: string } } }).response?.data?.message ?? 'Не удалось изменить остаток');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center" style={{ gap: 'var(--spacing-2)', marginTop: 'var(--spacing-2)' }} onClick={(e) => e.stopPropagation()}>
      <input className="input-sketch" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} style={{ fontSize: '0.85rem' }} />
      <button className="btn-secondary" style={{ padding: '0.25rem 0.8rem', fontSize: '0.75rem' }} onClick={submit} disabled={busy}>
        OK
      </button>
    </div>
  );
}

// ============================================================
// «Близкие» — быстрый список для «на кого» (Принцип 2: человек = карточка)
// ============================================================

function PeoplePanel({ people, onChanged, bookId, canEdit }: { people: FinPersonDto[]; onChanged: () => void; bookId: string | null; canEdit: boolean }) {
  const [adding, setAdding] = useState(false);

  const add = async (userId: string) => {
    try {
      await api.post('/finance/people', { userId }, bookParams(bookId));
      setAdding(false);
      onChanged();
    } catch (e) {
      alert((e as { response?: { data?: { message?: string } } }).response?.data?.message ?? 'Не удалось добавить');
    }
  };
  const remove = async (userId: string) => {
    try {
      await api.delete(`/finance/people/${userId}`, bookParams(bookId));
      onChanged();
    } catch {
      /* noop */
    }
  };

  return (
    <div className="card" style={{ transform: 'rotate(0.35deg)' }}>
      <div className="flex items-center justify-between" style={{ marginBottom: 'var(--spacing-2)' }}>
        <h2 className="title-md">Близкие</h2>
        {canEdit && (
          <button className="btn-secondary" style={{ padding: '0.25rem 0.8rem', fontSize: '0.75rem' }} onClick={() => setAdding((v) => !v)}>
            {adding ? 'Скрыть' : '+ Из окружения'}
          </button>
        )}
      </div>
      <p className="label-sm" style={{ marginBottom: 'var(--spacing-4)' }}>
        Быстрый выбор для поля «на кого» — человек об этом не узнаёт.
      </p>
      {adding && (
        <div style={{ marginBottom: 'var(--spacing-4)' }}>
          <EntitySelector value={[]} onChange={(next) => next[0] && add(next[0].id)} types={['user']} multi={false} placeholder="Кого добавить…" />
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-2)' }}>
        {people.map((p) => (
          <span key={p.userId} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
            <PersonChip size="S" userId={p.userId} firstName={p.name} avatar={p.avatar} />
            {canEdit && (
              <button
                onClick={() => remove(p.userId)}
                title="Убрать из близких"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', fontWeight: 700, padding: 0 }}
              >
                ×
              </button>
            )}
          </span>
        ))}
        {people.length === 0 && <p className="label-md">Список пуст.</p>}
      </div>
    </div>
  );
}

// ============================================================
// Категории
// ============================================================

function CategoriesPanel({ categories, onChanged, bookId, canEdit }: { categories: FinAccountDto[]; onChanged: () => void; bookId: string | null; canEdit: boolean }) {
  const [kind, setKind] = useState<'expense' | 'income'>('expense');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('');
  const [parentId, setParentId] = useState('');
  const [busy, setBusy] = useState(false);

  const visible = categories.filter((c) => c.kind === kind && !c.archived);
  const roots = visible.filter((c) => !c.parentId);
  const childrenOf = (id: string) => visible.filter((c) => c.parentId === id);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await api.post('/finance/categories', {
        kind,
        name: name.trim(),
        ...(icon.trim() ? { icon: icon.trim() } : {}),
        ...(parentId ? { parentId } : {}),
      }, bookParams(bookId));
      setName(''); setIcon(''); setParentId(''); setAdding(false);
      onChanged();
    } catch (e) {
      alert((e as { response?: { data?: { message?: string } } }).response?.data?.message ?? 'Не удалось создать категорию');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (cat: FinAccountDto) => {
    if (!window.confirm(`Удалить категорию «${cat.name}»? Если по ней есть операции — она уйдёт в архив.`)) return;
    try {
      await api.delete(`/finance/categories/${cat.id}`, bookParams(bookId));
      onChanged();
    } catch (e) {
      alert((e as { response?: { data?: { message?: string } } }).response?.data?.message ?? 'Не удалось удалить');
    }
  };

  return (
    <div className="card" style={{ transform: 'rotate(0.3deg)' }}>
      <div className="flex items-center justify-between" style={{ marginBottom: 'var(--spacing-4)' }}>
        <h2 className="title-md">Категории</h2>
        {canEdit && (
          <button className="btn-secondary" style={{ padding: '0.25rem 0.8rem', fontSize: '0.75rem' }} onClick={() => setAdding((v) => !v)}>
            {adding ? 'Скрыть' : '+ Категория'}
          </button>
        )}
      </div>

      <div className="flex" style={{ gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-4)' }}>
        {(['expense', 'income'] as const).map((k) => (
          <button
            key={k}
            onClick={() => { setKind(k); setParentId(''); }}
            style={{
              border: 'none',
              cursor: 'pointer',
              padding: '0.3rem 1rem',
              borderRadius: 'var(--radius-sketch)',
              fontFamily: 'var(--font-display)',
              fontWeight: 600,
              fontSize: '0.8rem',
              background: kind === k ? 'var(--primary-container)' : 'transparent',
              color: 'var(--on-surface)',
            }}
          >
            {k === 'expense' ? 'Расходы' : 'Доходы'}
          </button>
        ))}
      </div>

      {adding && (
        <div className="wash-primary" style={{ padding: 'var(--spacing-4)', marginBottom: 'var(--spacing-4)' }}>
          <div className="grid grid-cols-[1fr_60px]" style={{ gap: 'var(--spacing-3)' }}>
            <input className="input-sketch" placeholder="Название" value={name} onChange={(e) => setName(e.target.value)} />
            <input className="input-sketch" placeholder="🙂" value={icon} onChange={(e) => setIcon(e.target.value)} />
          </div>
          <select className="input-sketch" value={parentId} onChange={(e) => setParentId(e.target.value)} style={{ marginTop: 'var(--spacing-3)' }}>
            <option value="">Без родителя (корневая)</option>
            {roots.map((r) => <option key={r.id} value={r.id}>Внутри «{r.name}»</option>)}
          </select>
          <button className="btn-primary" style={{ marginTop: 'var(--spacing-4)', padding: '0.45rem 1.4rem', fontSize: '0.85rem' }} onClick={submit} disabled={busy}>
            Создать
          </button>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
        {roots.map((root) => (
          <div key={root.id}>
            <CategoryChip cat={root} onRemove={canEdit ? () => remove(root) : undefined} />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-2)', margin: '0.3rem 0 0 var(--spacing-6)' }}>
              {childrenOf(root.id).map((child) => (
                <CategoryChip key={child.id} cat={child} small onRemove={canEdit ? () => remove(child) : undefined} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CategoryChip({ cat, small, onRemove }: { cat: FinAccountDto; small?: boolean; onRemove?: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <span
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="ghost-border"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.35rem',
        padding: small ? '0.15rem 0.6rem' : '0.25rem 0.8rem',
        fontSize: small ? '0.75rem' : '0.85rem',
        background: 'var(--surface-container-lowest)',
      }}
    >
      <span>{cat.icon ?? '•'}</span>
      <span>{cat.name}</span>
      {hover && onRemove && (
        <button
          onClick={onRemove}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', fontWeight: 700, padding: 0, lineHeight: 1 }}
          title="Удалить"
        >
          ×
        </button>
      )}
    </span>
  );
}

// ============================================================
// Быстрый ввод (создание + правка)
// ============================================================

function QuickEntry({
  accounts,
  categories,
  people,
  editingTx,
  onCancelEdit,
  onSaved,
  bookId,
  meId,
  meName,
}: {
  accounts: FinAccountDto[];
  categories: FinAccountDto[];
  people: FinPersonDto[];
  editingTx: FinTransactionDto | null;
  onCancelEdit: () => void;
  onSaved: () => void;
  bookId: string | null;
  meId: string | null;
  meName: string;
}) {
  const [tab, setTab] = useState<EntryTab>('expense');
  const [amount, setAmount] = useState('');
  const [amountTo, setAmountTo] = useState('');
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [date, setDate] = useState(localToday());
  const [note, setNote] = useState('');
  const [personUserId, setPersonUserId] = useState<string | null>(null);
  const [personPickerOpen, setPersonPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const money = accounts.filter((a) => a.kind === 'asset' || a.kind === 'liability');
  const expenseCats = categories.filter((c) => c.kind === 'expense' && !c.archived);
  const incomeCats = categories.filter((c) => c.kind === 'income' && !c.archived);

  // Сигнатуры по id (не по .length): archive-одного + add-другого не меняет длину, но
  // меняет набор — иначе fromId залипал бы на архивном счёте и submit писал бы не туда.
  const accountIds = accounts.map((a) => a.id).join(',');
  const categoryIds = categories.map((c) => c.id).join(',');

  // Дефолты по вкладке
  useEffect(() => {
    if (editingTx) return;
    if (tab === 'expense') {
      setFromId((cur) => (money.some((m) => m.id === cur) ? cur : money[0]?.id ?? ''));
      setToId((cur) => (expenseCats.some((c) => c.id === cur) ? cur : expenseCats[0]?.id ?? ''));
    } else if (tab === 'income') {
      setFromId((cur) => (incomeCats.some((c) => c.id === cur) ? cur : incomeCats[0]?.id ?? ''));
      setToId((cur) => (money.some((m) => m.id === cur) ? cur : money[0]?.id ?? ''));
    } else {
      setFromId((cur) => (money.some((m) => m.id === cur) ? cur : money[0]?.id ?? ''));
      setToId((cur) => {
        const second = money.find((m) => m.id !== (money[0]?.id ?? ''));
        return money.some((m) => m.id === cur) && cur !== fromId ? cur : second?.id ?? '';
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, accountIds, categoryIds, editingTx]);

  // Режим правки: заполняем форму из операции
  useEffect(() => {
    if (!editingTx) return;
    const t = editingTx.type === 'debt_payment' || editingTx.type === 'debt_draw' ? 'transfer' : editingTx.type;
    if (t === 'expense' || t === 'income' || t === 'transfer') setTab(t);
    setAmount(String(editingTx.amount / 100));
    setAmountTo(editingTx.amountTo != null ? String(editingTx.amountTo / 100) : '');
    setFromId(editingTx.fromAccountId);
    setToId(editingTx.toAccountId);
    setDate(editingTx.occurredOn);
    setNote(editingTx.note ?? '');
    setPersonUserId(editingTx.personUserId);
  }, [editingTx]);

  const fromAcc = money.find((m) => m.id === fromId);
  const toAcc = money.find((m) => m.id === toId);
  const needsAmountTo = tab === 'transfer' && fromAcc && toAcc && fromAcc.currencyCode !== toAcc.currencyCode;

  const reset = () => {
    setAmount(''); setAmountTo(''); setNote(''); setDate(localToday()); setPersonUserId(null); setPersonPickerOpen(false);
  };

  const submit = async () => {
    const minor = parseMoneyInput(amount);
    if (!minor || !fromId || !toId || busy) return;
    const minorTo = needsAmountTo ? parseMoneyInput(amountTo) : null;
    if (needsAmountTo && !minorTo) { alert('Укажите сумму зачисления во второй валюте'); return; }
    setBusy(true);
    try {
      const personAllowed = tab === 'expense' || tab === 'income';
      const payload = {
        fromAccountId: fromId,
        toAccountId: toId,
        amount: minor,
        ...(needsAmountTo ? { amountTo: minorTo } : {}),
        occurredOn: date,
        ...(note.trim() ? { note: note.trim() } : editingTx ? { note: null } : {}),
        ...(personAllowed && personUserId ? { personUserId } : editingTx ? { personUserId: null } : {}),
      };
      if (editingTx) await api.patch(`/finance/transactions/${editingTx.id}`, payload, bookParams(bookId));
      else await api.post('/finance/transactions', payload, bookParams(bookId));
      reset();
      onSaved();
    } catch (e) {
      alert((e as { response?: { data?: { message?: string } } }).response?.data?.message ?? 'Не удалось сохранить операцию');
    } finally {
      setBusy(false);
    }
  };

  const catOptions = (cats: FinAccountDto[]) => {
    const roots = cats.filter((c) => !c.parentId);
    return roots.map((root) => {
      const children = cats.filter((c) => c.parentId === root.id);
      if (children.length === 0) {
        return <option key={root.id} value={root.id}>{root.icon ? `${root.icon} ` : ''}{root.name}</option>;
      }
      return (
        <optgroup key={root.id} label={`${root.icon ? `${root.icon} ` : ''}${root.name}`}>
          <option value={root.id}>{root.name} (в целом)</option>
          {children.map((c) => <option key={c.id} value={c.id}>{c.icon ? `${c.icon} ` : ''}{c.name}</option>)}
        </optgroup>
      );
    });
  };
  const moneyOptions = money.map((m) => (
    <option key={m.id} value={m.id}>{m.icon ? `${m.icon} ` : ''}{m.name} · {currencySymbol(m.currencyCode)}</option>
  ));

  return (
    <div className="card-elevated" style={{ transform: 'rotate(0.25deg)' }}>
      <div className="flex items-center justify-between" style={{ marginBottom: 'var(--spacing-4)' }}>
        <h2 className="title-md">{editingTx ? 'Исправить операцию' : 'Записать'}</h2>
        {editingTx && (
          <button className="label-sm" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--secondary)' }} onClick={() => { reset(); onCancelEdit(); }}>
            отменить правку
          </button>
        )}
      </div>

      <div className="flex" style={{ gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-6)' }}>
        {([['expense', 'Расход'], ['income', 'Доход'], ['transfer', 'Перевод']] as Array<[EntryTab, string]>).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            style={{
              border: 'none',
              cursor: 'pointer',
              padding: '0.4rem 1.2rem',
              borderRadius: 'var(--radius-sketch)',
              fontFamily: 'var(--font-display)',
              fontWeight: 600,
              fontSize: '0.9rem',
              background: tab === key
                ? key === 'expense' ? 'var(--primary-container)' : key === 'income' ? 'rgba(45,122,58,0.2)' : 'var(--secondary-container)'
                : 'transparent',
              color: 'var(--on-surface)',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-4) var(--spacing-6)' }}>
        <div>
          <div className="label-sm" style={{ marginBottom: '0.2rem' }}>Сумма{fromAcc && tab !== 'income' ? ` (${currencySymbol(fromAcc.currencyCode)})` : ''}</div>
          <input className="input-sketch" inputMode="decimal" placeholder="2 500" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ fontSize: '1.4rem', fontFamily: 'var(--font-display)', fontWeight: 700 }} />
        </div>
        <div>
          <div className="label-sm" style={{ marginBottom: '0.2rem' }}>Дата</div>
          <input type="date" className="input-sketch" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>

        {tab === 'expense' && (
          <>
            <div>
              <div className="label-sm" style={{ marginBottom: '0.2rem' }}>Со счёта</div>
              <select className="input-sketch" value={fromId} onChange={(e) => setFromId(e.target.value)}>{moneyOptions}</select>
            </div>
            <div>
              <div className="label-sm" style={{ marginBottom: '0.2rem' }}>Категория</div>
              <select className="input-sketch" value={toId} onChange={(e) => setToId(e.target.value)}>{catOptions(expenseCats)}</select>
            </div>
          </>
        )}
        {tab === 'income' && (
          <>
            <div>
              <div className="label-sm" style={{ marginBottom: '0.2rem' }}>Источник</div>
              <select className="input-sketch" value={fromId} onChange={(e) => setFromId(e.target.value)}>{catOptions(incomeCats)}</select>
            </div>
            <div>
              <div className="label-sm" style={{ marginBottom: '0.2rem' }}>На счёт</div>
              <select className="input-sketch" value={toId} onChange={(e) => setToId(e.target.value)}>{moneyOptions}</select>
            </div>
          </>
        )}
        {tab === 'transfer' && (
          <>
            <div>
              <div className="label-sm" style={{ marginBottom: '0.2rem' }}>Со счёта</div>
              <select className="input-sketch" value={fromId} onChange={(e) => setFromId(e.target.value)}>{moneyOptions}</select>
            </div>
            <div>
              <div className="label-sm" style={{ marginBottom: '0.2rem' }}>На счёт</div>
              <select className="input-sketch" value={toId} onChange={(e) => setToId(e.target.value)}>{moneyOptions}</select>
            </div>
            {needsAmountTo && (
              <div>
                <div className="label-sm" style={{ marginBottom: '0.2rem' }}>Зачислено ({toAcc ? currencySymbol(toAcc.currencyCode) : ''})</div>
                <input className="input-sketch" inputMode="decimal" placeholder="100" value={amountTo} onChange={(e) => setAmountTo(e.target.value)} />
              </div>
            )}
          </>
        )}

        <div style={{ gridColumn: '1 / -1' }}>
          <div className="label-sm" style={{ marginBottom: '0.2rem' }}>Заметка</div>
          <input className="input-sketch" placeholder="Magnum, подарок…" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>

        {(tab === 'expense' || tab === 'income') && (
          <div style={{ gridColumn: '1 / -1' }}>
            <div className="label-sm" style={{ marginBottom: '0.3rem' }}>
              {tab === 'expense' ? 'На кого (не обязательно)' : 'От кого (не обязательно)'}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--spacing-2)' }}>
              {/* «Я» — всегда первый: потратил/получил на себя (моя карточка). */}
              {meId && (
                <button
                  onClick={() => setPersonUserId((cur) => (cur === meId ? null : meId))}
                  style={{
                    background: personUserId === meId ? 'var(--secondary-container)' : 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    borderRadius: 'var(--radius-sketch)',
                    padding: '0.15rem 0.3rem',
                  }}
                  title={personUserId === meId ? 'Убрать' : tab === 'income' ? 'От себя' : 'На себя'}
                >
                  <PersonChip size="S" userId={meId} firstName={meName} role="Я" />
                </button>
              )}
              {people.filter((p) => p.userId !== meId).map((p) => (
                <button
                  key={p.userId}
                  onClick={() => setPersonUserId((cur) => (cur === p.userId ? null : p.userId))}
                  style={{
                    background: personUserId === p.userId ? 'var(--secondary-container)' : 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    borderRadius: 'var(--radius-sketch)',
                    padding: '0.15rem 0.3rem',
                  }}
                  title={personUserId === p.userId ? 'Убрать' : `На ${p.name}`}
                >
                  <PersonChip size="S" userId={p.userId} firstName={p.name} avatar={p.avatar} />
                </button>
              ))}
              <button
                className="label-sm"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--secondary)' }}
                onClick={() => setPersonPickerOpen((v) => !v)}
              >
                {personPickerOpen ? 'скрыть' : 'из окружения…'}
              </button>
              {personUserId && personUserId !== meId && !people.some((p) => p.userId === personUserId) && (
                <span className="wash-secondary label-sm" style={{ padding: '0.2rem 0.6rem' }}>
                  выбран человек
                  <button onClick={() => setPersonUserId(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', fontWeight: 700, marginLeft: '0.3rem' }}>×</button>
                </span>
              )}
            </div>
            {personPickerOpen && (
              <div style={{ marginTop: 'var(--spacing-2)' }}>
                <EntitySelector
                  value={personUserId ? [{ type: 'user', id: personUserId }] : []}
                  onChange={(next) => setPersonUserId(next[0]?.id ?? null)}
                  types={['user']}
                  multi={false}
                  placeholder="Найти человека…"
                />
              </div>
            )}
          </div>
        )}
      </div>

      <button className="btn-primary" style={{ marginTop: 'var(--spacing-6)' }} onClick={submit} disabled={busy}>
        {editingTx ? 'Сохранить правку' : 'Записать'}
      </button>
    </div>
  );
}

// ============================================================
// Лента операций
// ============================================================

function TransactionFeed({
  transactions,
  accountById,
  filterLabel,
  onClearFilter,
  onEdit,
  onShare,
  onDeleted,
  hasMore,
  loadingMore,
  onLoadMore,
  canEdit,
  bookId,
  meId,
}: {
  transactions: FinTransactionDto[];
  accountById: Map<string, FinAccountDto>;
  filterLabel: string | null;
  onClearFilter: () => void;
  onEdit: (tx: FinTransactionDto) => void;
  onShare: (tx: FinTransactionDto) => void;
  onDeleted: () => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  canEdit: boolean;
  bookId: string | null;
  meId: string | null;
}) {
  const groups = useMemo(() => {
    const byDay = new Map<string, FinTransactionDto[]>();
    for (const t of transactions) {
      const list = byDay.get(t.occurredOn) ?? [];
      list.push(t);
      byDay.set(t.occurredOn, list);
    }
    return [...byDay.entries()];
  }, [transactions]);

  const remove = async (tx: FinTransactionDto) => {
    if (!window.confirm('Удалить операцию? Удаление останется в аудите книги.')) return;
    try {
      await api.delete(`/finance/transactions/${tx.id}`, bookParams(bookId));
      onDeleted();
    } catch (e) {
      alert((e as { response?: { data?: { message?: string } } }).response?.data?.message ?? 'Не удалось удалить');
    }
  };

  return (
    <div className="card" style={{ transform: 'rotate(-0.2deg)' }}>
      <div className="flex items-center justify-between" style={{ marginBottom: 'var(--spacing-4)' }}>
        <h2 className="title-md">Операции</h2>
        {filterLabel && (
          <button className="wash-secondary label-sm" style={{ border: 'none', cursor: 'pointer', padding: '0.25rem 0.8rem' }} onClick={onClearFilter}>
            {filterLabel} ×
          </button>
        )}
      </div>

      {groups.length === 0 && (
        <p className="label-md" style={{ padding: 'var(--spacing-4) 0' }}>
          Пока пусто. Задайте остаток счёта слева и запишите первую трату.
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
        {groups.map(([day, items]) => {
          const dayExpense = items
            .filter((t) => t.type === 'expense')
            .reduce((acc, t) => {
              acc.set(t.currencyCode, (acc.get(t.currencyCode) ?? 0) + t.amount);
              return acc;
            }, new Map<string, number>());
          return (
            <div key={day}>
              <div className="flex items-center justify-between" style={{ marginBottom: 'var(--spacing-2)' }}>
                <span className="label-md" style={{ fontWeight: 700 }}>{formatDayLabel(day)}</span>
                {dayExpense.size > 0 && (
                  <span className="label-sm">
                    −{[...dayExpense.entries()].map(([code, sum]) => formatMoney(sum, code)).join(' · ')}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
                {items.map((t) => (
                  <TransactionRow key={t.id} tx={t} accountById={accountById} canEdit={canEdit} meId={meId} onEdit={() => onEdit(t)} onShare={() => onShare(t)} onRemove={() => remove(t)} />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {hasMore && (
        <div style={{ textAlign: 'center', marginTop: 'var(--spacing-6)' }}>
          <button className="btn-secondary" style={{ padding: '0.4rem 1.4rem', fontSize: '0.85rem' }} onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? 'Загружаю…' : 'Показать ещё'}
          </button>
        </div>
      )}
    </div>
  );
}

function TransactionRow({
  tx,
  accountById,
  canEdit,
  meId,
  onEdit,
  onShare,
  onRemove,
}: {
  tx: FinTransactionDto;
  accountById: Map<string, FinAccountDto>;
  canEdit: boolean;
  meId: string | null;
  onEdit: () => void;
  onShare: () => void;
  onRemove: () => void;
}) {
  const [hover, setHover] = useState(false);
  const from = accountById.get(tx.fromAccountId);
  const to = accountById.get(tx.toAccountId);

  let icon = '🔁';
  let title = '';
  let sign: '+' | '−' | '' = '';
  let color = 'var(--on-surface)';
  switch (tx.type) {
    case 'expense':
      icon = to?.icon ?? '🧾';
      title = to?.name ?? 'Расход';
      sign = '−';
      color = 'var(--danger)';
      break;
    case 'income':
      icon = from?.icon ?? '💰';
      title = from?.name ?? 'Доход';
      sign = '+';
      color = 'var(--success)';
      break;
    case 'transfer':
      icon = '🔁';
      title = `${from?.name ?? '—'} → ${to?.name ?? '—'}`;
      break;
    case 'debt_payment':
      icon = '📉';
      title = `Платёж: ${to?.name ?? 'долг'}`;
      break;
    case 'debt_draw':
      icon = '🏦';
      title = `Кредит: ${from?.name ?? 'долг'}`;
      sign = '+';
      color = 'var(--success)';
      break;
    case 'opening':
      icon = '⚖️';
      title = 'Корректировка остатка';
      break;
  }

  const editable = tx.type !== 'opening';

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--spacing-3)',
        background: 'var(--surface-container-lowest)',
        borderRadius: 'var(--radius-sketch)',
        padding: '0.55rem var(--spacing-4)',
      }}
    >
      <span style={{ fontSize: '1.15rem' }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
          <span>{title}</span>
          {tx.personName && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
              <span className="label-sm">{tx.type === 'income' ? 'от' : 'на'}</span>
              <PersonChip size="S" userId={tx.personUserId} firstName={tx.personName} />
            </span>
          )}
          {tx.createdByName && meId && tx.createdById !== meId && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
              <span className="label-sm">внёс(ла)</span>
              <PersonChip size="S" userId={tx.createdById} firstName={tx.createdByName} />
            </span>
          )}
        </div>
        {(tx.note || tx.type === 'expense') && (
          <div className="label-sm" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {tx.note ?? (tx.type === 'expense' ? `со счёта: ${from?.name ?? '—'}` : '')}
          </div>
        )}
      </div>
      {hover && (
        <div className="flex" style={{ gap: 'var(--spacing-2)' }}>
          <button onClick={onShare} title="Отправить в чат" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.9rem' }}>💬</button>
          {editable && canEdit && (
            <button onClick={onEdit} title="Исправить" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.9rem' }}>✎</button>
          )}
          {canEdit && (
            <button onClick={onRemove} title="Удалить" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', fontWeight: 700 }}>×</button>
          )}
        </div>
      )}
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color }}>
          {sign}{formatMoney(tx.amount, tx.currencyCode)}
        </div>
        {tx.amountTo != null && to && (
          <div className="label-sm">→ {formatMoney(tx.amountTo, to.currencyCode)}</div>
        )}
      </div>
    </div>
  );
}
