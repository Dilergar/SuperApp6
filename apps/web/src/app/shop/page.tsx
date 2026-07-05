'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { executeRichCardAction, getOrderChat } from '@/lib/messenger-api';
import { ShareCardModal } from '../messenger/ShareCardModal';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { EntitySelector } from '@/components/EntitySelector';
import { PersonChip } from '../circles/PersonCard';
import {
  LISTING_ITEM_TYPE_LABELS,
  SHOP_LIMITS,
  type Shop,
  type Showcase,
  type Listing,
  type ListingPriceDto,
  type ContributionLine,
  type AccessibleCurrencyDto,
  type ShopStaffDto,
  type ShowcaseShareDto,
  type AccessibleShopRef,
  type Contact,
  type Circle,
  type Order,
  type WishItem,
  type AccessibleWishlistRef,
  type FileDto,
} from '@superapp/shared';
import { useFileUpload } from '@/lib/hooks/useFileUpload';
import { FileDropzone } from '@/components/files/FileDropzone';
import { UploadProgressList } from '@/components/files/UploadProgressList';

function errMsg(e: unknown, fallback = 'Ошибка'): string {
  const ax = e as { response?: { data?: { message?: string; error?: string } } };
  const m = ax?.response?.data?.message || ax?.response?.data?.error;
  return Array.isArray(m) ? m.join(', ') : m || fallback;
}
const fmtAmount = (amount: number, scale: number) =>
  (scale > 0 ? amount / 10 ** scale : amount).toLocaleString('ru-RU');
/** Render a (possibly cross-currency) price as "100 🍎 + 50 🌟". */
const fmtPrices = (prices: Pick<ListingPriceDto, 'amount' | 'scale' | 'currencyIcon'>[]) =>
  prices.length ? prices.map((p) => `${fmtAmount(p.amount, p.scale)} ${p.currencyIcon}`).join(' + ') : '—';
const personName = (c: Contact) => `${c.them.firstName} ${c.them.lastName ?? ''}`.trim();

/** Pair each goal price line with how much has been raised so far (crowdfunding progress). */
const progressLines = (prices: ListingPriceDto[], raised?: ContributionLine[]) => {
  const r = new Map((raised ?? []).map((x) => [x.currencyId, x.amount]));
  return prices.map((p) => ({ ...p, raised: r.get(p.currencyId) ?? 0 }));
};

/** Per-currency progress bars for a crowdfunding goal. */
function CampaignBars({ prices, raised }: { prices: ListingPriceDto[]; raised?: ContributionLine[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', margin: '0.4rem 0' }}>
      {progressLines(prices, raised).map((l) => {
        const pct = l.amount > 0 ? Math.min(100, Math.round((l.raised / l.amount) * 100)) : 0;
        return (
          <div key={l.currencyId}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', opacity: 0.85 }}>
              <span>{l.currencyIcon} {fmtAmount(l.raised, l.scale)} / {fmtAmount(l.amount, l.scale)}</span>
              <span>{pct}%</span>
            </div>
            <div style={{ height: 6, background: 'rgba(0,0,0,0.08)', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ width: `${pct}%`, height: '100%', background: pct >= 100 ? 'var(--secondary)' : 'var(--primary)' }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function ShopPage() {
  const { isReady, user } = useRequireAuth();
  const router = useRouter();

  const [tab, setTab] = useState<'shops' | 'wishlist' | 'orders'>('shops');
  const [viewOwnerId, setViewOwnerId] = useState<string | null>(null); // null = my shop
  const [accessible, setAccessible] = useState<AccessibleShopRef[]>([]);
  const [shop, setShop] = useState<Shop | null>(null);
  const [showcases, setShowcases] = useState<Showcase[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [listings, setListings] = useState<Listing[]>([]);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [loading, setLoading] = useState(true);

  // owner pickers
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [circles, setCircles] = useState<Circle[]>([]);

  // ui
  const [newShowcase, setNewShowcase] = useState('');
  const [listingModal, setListingModal] = useState<{ showcaseId: string; editing?: Listing } | null>(null);
  const [sharePanel, setSharePanel] = useState<Showcase | null>(null);
  const [staffOpen, setStaffOpen] = useState(false);
  const [contributeModal, setContributeModal] = useState<Listing | null>(null);
  const [forwardListing, setForwardListing] = useState<Listing | null>(null);

  const canManage = shop?.canManage ?? false;

  const loadShop = useCallback(async () => {
    setError('');
    try {
      const url = viewOwnerId ? `/shop/of/${viewOwnerId}` : '/shop';
      const r = await api.get(url);
      const sc: Showcase[] = r.data.data.showcases;
      setShop(r.data.data.shop);
      setShowcases(sc);
      setSelectedId((prev) => (prev && sc.some((s) => s.id === prev) ? prev : sc[0]?.id ?? null));
    } catch (e) {
      setError(errMsg(e, 'Не удалось загрузить магазин'));
      setShop(null);
      setShowcases([]);
      setSelectedId(null);
    } finally {
      setLoading(false);
    }
  }, [viewOwnerId]);

  useEffect(() => {
    if (isReady) loadShop();
  }, [isReady, loadShop]);

  useEffect(() => {
    if (!isReady) return;
    api.get('/shop/accessible').then((r) => setAccessible(r.data.data)).catch(() => {});
  }, [isReady]);

  // listings for the selected showcase
  useEffect(() => {
    if (!selectedId) { setListings([]); return; }
    api.get(`/shop/showcases/${selectedId}/listings`)
      .then((r) => setListings(r.data.data))
      .catch((e) => setError(errMsg(e)));
  }, [selectedId]);

  // owner pickers (only when managing my own shop)
  useEffect(() => {
    if (!isReady || viewOwnerId || !canManage) return;
    api.get('/contacts').then((r) => setContacts(r.data.data)).catch(() => {});
    api.get('/circles').then((r) => setCircles(r.data.data)).catch(() => {});
  }, [isReady, viewOwnerId, canManage]);

  const reload = async () => { await loadShop(); if (selectedId) { try { const r = await api.get(`/shop/showcases/${selectedId}/listings`); setListings(r.data.data); } catch {} } };

  const createShowcase = async () => {
    if (!newShowcase.trim()) return;
    try { await api.post('/shop/showcases', { name: newShowcase.trim() }); setNewShowcase(''); await loadShop(); }
    catch (e) { setError(errMsg(e)); }
  };
  const renameShowcase = async (s: Showcase) => {
    const name = window.prompt('Название витрины', s.name);
    if (name == null) return;
    try { await api.patch(`/shop/showcases/${s.id}`, { name: name.trim() }); await loadShop(); } catch (e) { setError(errMsg(e)); }
  };
  const deleteShowcase = async (s: Showcase) => {
    if (!window.confirm(`Удалить витрину «${s.name}» со всеми товарами?`)) return;
    try { await api.delete(`/shop/showcases/${s.id}`); if (selectedId === s.id) setSelectedId(null); await loadShop(); } catch (e) { setError(errMsg(e)); }
  };
  const deleteListing = async (l: Listing) => {
    if (!window.confirm(`Удалить «${l.title}»?`)) return;
    try { await api.delete(`/shop/listings/${l.id}`); await reload(); } catch (e) { setError(errMsg(e)); }
  };
  const buy = async (l: Listing) => {
    setError(''); setOk('');
    try {
      await api.post(`/shop/listings/${l.id}/buy`);
      setOk(`Заказ оформлен: «${l.title}». Коины заморожены до подтверждения продавцом (вкладка «Заказы»).`);
      setTimeout(() => setOk(''), 5000);
    } catch (e) { setError(errMsg(e)); }
  };
  // "Поговорить" — open a buyer↔seller DM with the listing card dropped in,
  // then jump to the messenger (to that seller's DM when we know the owner).
  const talk = async (l: Listing) => {
    setError('');
    try {
      await executeRichCardAction('listing.talk', { type: 'listing', id: l.id });
    } catch (e) {
      setError(errMsg(e));
      return;
    }
    router.push(viewOwnerId ? `/messenger?dm=${viewOwnerId}` : '/messenger');
  };

  if (!isReady || loading) {
    return <div className="min-h-screen flex items-center justify-center"><p className="label-md">Загрузка…</p></div>;
  }

  const selected = showcases.find((s) => s.id === selectedId) ?? null;

  return (
    <div className="min-h-screen" style={{ background: 'var(--surface)' }}>
      <nav className="fixed top-0 w-full z-40 px-6 py-4" style={{ background: 'rgba(245,245,220,0.7)', backdropFilter: 'blur(10px)' }}>
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <Link href="/dashboard" className="title-md" style={{ color: 'var(--primary)' }}>← SuperApp6</Link>
          {/* Shop switcher */}
          <select
            value={viewOwnerId ?? 'me'}
            onChange={(e) => { setSelectedId(null); setViewOwnerId(e.target.value === 'me' ? null : e.target.value); }}
            className="input-sketch"
            style={{ maxWidth: 240, fontSize: '0.85rem', padding: '0.4rem 0.8rem' }}
          >
            <option value="me">Мой магазин</option>
            {accessible.map((a) => <option key={a.shopId} value={a.ownerId}>{a.name}</option>)}
          </select>
        </div>
      </nav>

      <div className="max-w-5xl mx-auto px-6 pt-24" style={{ paddingBottom: 'var(--spacing-16)' }}>
        <h1 className="display-md" style={{ marginBottom: 'var(--spacing-2)' }}>My Wish &amp; Shop</h1>
        <p className="label-md" style={{ marginBottom: 'var(--spacing-6)' }}>
          {viewOwnerId ? `Магазин: ${shop?.name ?? ''}` : 'Витрины подарков за коины и списки желаний'}
        </p>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-6)' }}>
          {(['shops', 'wishlist', 'orders'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={tab === t ? 'btn-primary' : 'btn-secondary'}
              style={{ fontSize: '0.85rem' }}>
              {t === 'shops' ? 'Shops' : t === 'wishlist' ? 'Wishlist' : 'Заказы'}
            </button>
          ))}
          {canManage && tab === 'shops' && (
            <button onClick={() => setStaffOpen(true)} className="btn-secondary" style={{ fontSize: '0.85rem', marginLeft: 'auto' }}>Сотрудники</button>
          )}
        </div>

        {error && <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginBottom: 'var(--spacing-4)' }}>{error}</p>}
        {ok && <p style={{ color: 'var(--secondary)', fontSize: '0.85rem', marginBottom: 'var(--spacing-4)' }}>{ok}</p>}

        {tab === 'wishlist' ? (
          <WishlistView onError={setError} onOk={setOk} />
        ) : tab === 'orders' ? (
          <OrdersView onError={setError} />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 'var(--spacing-6)' }}>
            {/* Left: showcases */}
            <aside>
              <div className="label-sm" style={{ marginBottom: 'var(--spacing-2)', opacity: 0.6 }}>ВИТРИНЫ</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-1)' }}>
                {showcases.length === 0 && <p className="label-sm" style={{ opacity: 0.6 }}>Витрин пока нет.</p>}
                {showcases.map((s) => (
                  <div key={s.id}
                    className={selectedId === s.id ? 'wash-secondary' : 'card'}
                    style={{ padding: 'var(--spacing-2) var(--spacing-3)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.4rem' }}
                    onClick={() => setSelectedId(s.id)}>
                    <span style={{ fontSize: '1.1rem' }}>{s.icon ?? '🗂️'}</span>
                    <span style={{ flex: 1, fontSize: '0.88rem', fontWeight: 500 }}>{s.name}</span>
                    <span className="label-sm" style={{ opacity: 0.5, fontSize: '0.7rem' }}>{s.listingCount}</span>
                  </div>
                ))}
              </div>
              {canManage && (
                <div style={{ marginTop: 'var(--spacing-3)' }}>
                  <div style={{ display: 'flex', gap: '0.3rem' }}>
                    <input value={newShowcase} onChange={(e) => setNewShowcase(e.target.value)} placeholder="Новая витрина"
                      className="input-sketch" style={{ flex: 1, padding: '0.35rem 0.6rem', fontSize: '0.8rem' }}
                      onKeyDown={(e) => e.key === 'Enter' && createShowcase()} />
                    <button onClick={createShowcase} className="btn-primary" style={{ padding: '0.35rem 0.7rem', fontSize: '0.8rem' }}>+</button>
                  </div>
                </div>
              )}
            </aside>

            {/* Right: listings */}
            <main>
              {selected && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', marginBottom: 'var(--spacing-4)' }}>
                  <h2 className="title-lg" style={{ flex: 1 }}>{selected.icon ?? '🗂️'} {selected.name}</h2>
                  {canManage && (
                    <>
                      <button onClick={() => setSharePanel(selected)} className="btn-secondary" style={{ fontSize: '0.78rem' }}>Поделиться</button>
                      <button onClick={() => renameShowcase(selected)} className="btn-secondary" style={{ fontSize: '0.78rem' }}>✎</button>
                      <button onClick={() => deleteShowcase(selected)} className="btn-secondary" style={{ fontSize: '0.78rem', color: 'var(--danger)' }}>🗑</button>
                      <button onClick={() => setListingModal({ showcaseId: selected.id })} className="btn-primary" style={{ fontSize: '0.8rem' }}>+ Товар</button>
                    </>
                  )}
                </div>
              )}
              {!selected && <p className="label-md" style={{ opacity: 0.7 }}>Выберите витрину слева.</p>}
              {selected && listings.length === 0 && <p className="label-md" style={{ opacity: 0.7 }}>В этой витрине пока нет товаров.</p>}
              <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 'var(--spacing-4)' }}>
                {listings.map((l) => (
                  <ListingCard key={l.id} l={l} canManage={canManage}
                    onEdit={() => setListingModal({ showcaseId: l.showcaseId, editing: l })}
                    onDelete={() => deleteListing(l)}
                    onBuy={!canManage && viewOwnerId ? () => buy(l) : undefined}
                    onTalk={!canManage && viewOwnerId ? () => talk(l) : undefined}
                    onForward={() => setForwardListing(l)}
                    onContribute={!canManage && viewOwnerId ? () => setContributeModal(l) : undefined} />
                ))}
              </div>
            </main>
          </div>
        )}
      </div>

      {listingModal && (
        <ListingForm
          init={listingModal.editing}
          showcaseId={listingModal.showcaseId}
          onClose={() => setListingModal(null)}
          onSaved={async () => { setListingModal(null); await reload(); }}
          onError={setError}
        />
      )}
      {sharePanel && (
        <SharePanel showcase={sharePanel}
          onClose={() => setSharePanel(null)} onChanged={loadShop} onError={setError} />
      )}
      {staffOpen && (
        <StaffPanel contacts={contacts} showcases={showcases} onClose={() => setStaffOpen(false)} onError={setError} />
      )}
      {contributeModal && (
        <ContributeModal listing={contributeModal}
          onClose={() => setContributeModal(null)}
          onDone={async () => { setContributeModal(null); await reload(); }}
          onError={setError} />
      )}
      {forwardListing && (
        <ShareCardModal
          refType={forwardListing.crowdfunding ? 'crowdfunding' : 'listing'}
          refId={forwardListing.id}
          title={forwardListing.title}
          onClose={() => setForwardListing(null)}
        />
      )}
    </div>
  );
}

function ListingCard({ l, canManage, onEdit, onDelete, onBuy, onTalk, onForward, onContribute }: { l: Listing; canManage: boolean; onEdit: () => void; onDelete: () => void; onBuy?: () => void; onTalk?: () => void; onForward?: () => void; onContribute?: () => void }) {
  const now = Date.now();
  const iPledged = (l.campaign?.myContribution?.length ?? 0) > 0;
  const discountActive = !!l.discountPercent && l.discountPercent > 0 && !!l.discountUntil && now < new Date(l.discountUntil).getTime();
  const effPrices = discountActive
    ? l.prices.map((p) => ({ ...p, amount: Math.max(1, Math.floor((p.amount * (100 - l.discountPercent!)) / 100)) }))
    : l.prices;
  const remaining = l.stockLimit != null ? Math.max(0, l.stockLimit - l.stockSold) : null;
  const soldOut = l.stockLimit != null && l.stockSold >= l.stockLimit;
  const notYet = !!l.availableFrom && now < new Date(l.availableFrom).getTime();
  const closed = !!l.availableUntil && now > new Date(l.availableUntil).getTime();
  const sellable = l.status === 'active' && !soldOut && !notYet && !closed;
  const reason = soldOut ? 'Распродано' : closed ? 'Закрыто' : notYet ? 'Скоро' : 'Недоступно';
  return (
    <div className="card-elevated" style={{ padding: 'var(--spacing-4)', position: 'relative', opacity: l.status === 'archived' ? 0.5 : 1 }}>
      {onForward && (
        <button onClick={onForward} title="Переслать в чат" aria-label="Переслать в чат"
          style={{ position: 'absolute', top: 'var(--spacing-3)', right: 'var(--spacing-3)', background: 'var(--surface-container)', border: 'none', cursor: 'pointer', width: '1.8rem', height: '1.8rem', borderRadius: 'var(--radius-sketch)', fontSize: '0.85rem', color: 'var(--on-surface-variant)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          ↗
        </button>
      )}
      {l.coverUrl ? (
        // Обложка = первое фото галереи (движок файлов, публичный класс); emoji — фолбэк
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={l.coverUrl}
          alt={l.title}
          style={{ width: '100%', height: '8.5rem', objectFit: 'cover', borderRadius: 'var(--radius-md)', marginBottom: 'var(--spacing-2)', display: 'block' }}
        />
      ) : (
        <div style={{ fontSize: '2rem', marginBottom: 'var(--spacing-2)' }}>{l.icon ?? '🎁'}</div>
      )}
      <div className="title-md" style={{ fontSize: '1rem', marginBottom: '0.2rem' }}>{l.title}</div>
      {l.description && <p className="label-sm" style={{ fontSize: '0.75rem', opacity: 0.7, marginBottom: '0.4rem' }}>{l.description}</p>}
      <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
        <span className="ghost-border" style={{ fontSize: '0.65rem', padding: '0.1rem 0.5rem' }}>{LISTING_ITEM_TYPE_LABELS[l.itemType]}</span>
        {l.withTask && <span className="ghost-border" style={{ fontSize: '0.65rem', padding: '0.1rem 0.5rem' }}>С задачей{l.taskDays ? ` · ${l.taskDays}д` : ''}</span>}
        {l.crowdfunding && <span className="ghost-border" style={{ fontSize: '0.65rem', padding: '0.1rem 0.5rem' }}>🎯 Сбор</span>}
        {discountActive && <span className="ghost-border" style={{ fontSize: '0.65rem', padding: '0.1rem 0.5rem', color: 'var(--primary)', fontWeight: 600 }}>−{l.discountPercent}%</span>}
        {remaining != null && <span className="ghost-border" style={{ fontSize: '0.65rem', padding: '0.1rem 0.5rem' }}>{soldOut ? 'Распродано' : `осталось ${remaining}`}</span>}
        {closed && <span className="ghost-border" style={{ fontSize: '0.65rem', padding: '0.1rem 0.5rem' }}>Закрыто</span>}
        {notYet && <span className="ghost-border" style={{ fontSize: '0.65rem', padding: '0.1rem 0.5rem' }}>Скоро</span>}
      </div>
      <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--primary)' }}>
        {discountActive ? (
          <>
            <span style={{ textDecoration: 'line-through', opacity: 0.5, fontWeight: 400, fontSize: '0.8em', marginRight: '0.4rem' }}>{fmtPrices(l.prices)}</span>
            {fmtPrices(effPrices)}
          </>
        ) : fmtPrices(l.prices)}
      </div>
      {l.crowdfunding && <CampaignBars prices={l.prices} raised={l.campaign?.raised} />}
      {canManage ? (
        <div style={{ display: 'flex', gap: '0.4rem', marginTop: 'var(--spacing-2)' }}>
          <button onClick={onEdit} className="btn-secondary" style={{ fontSize: '0.72rem', padding: '0.2rem 0.6rem' }}>Изменить</button>
          <button onClick={onDelete} className="btn-secondary" style={{ fontSize: '0.72rem', padding: '0.2rem 0.6rem', color: 'var(--danger)' }}>Удалить</button>
        </div>
      ) : l.crowdfunding && onContribute ? (
        <div style={{ marginTop: 'var(--spacing-2)' }}>
          {sellable ? (
            <button onClick={onContribute} className="btn-primary" style={{ fontSize: '0.78rem', padding: '0.25rem 0.9rem' }}>
              {iPledged ? 'Мой вклад' : 'Скинуться'}
            </button>
          ) : (
            <span className="label-sm" style={{ opacity: 0.55, fontSize: '0.7rem' }}>{reason}</span>
          )}
        </div>
      ) : onBuy || onTalk ? (
        <div style={{ marginTop: 'var(--spacing-2)', display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {onBuy && (sellable ? (
            <button onClick={onBuy} className="btn-primary" style={{ fontSize: '0.78rem', padding: '0.25rem 0.9rem' }}>Купить</button>
          ) : (
            <span className="label-sm" style={{ opacity: 0.55, fontSize: '0.7rem' }}>{reason}</span>
          ))}
          {onTalk && (
            <button onClick={onTalk} className="btn-secondary" style={{ fontSize: '0.78rem', padding: '0.25rem 0.9rem' }}>Поговорить</button>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Галерея фото лота внутри формы редактирования: грид тумбов с ✕ + дропзона (≤10) */
function ListingPhotosSection({ listingId, onError }: { listingId: string; onError: (m: string) => void }) {
  const [images, setImages] = useState<FileDto[]>([]);
  const reload = useCallback(() => {
    api.get(`/shop/listings/${listingId}/images`).then((r) => setImages(r.data.data)).catch(() => {});
  }, [listingId]);
  useEffect(() => { reload(); }, [reload]);

  const uploader = useFileUpload('listing_image', {
    onUploaded: (f) => {
      api.post(`/shop/listings/${listingId}/images`, { fileId: f.id })
        .then((r) => setImages(r.data.data))
        .catch((e) => onError(errMsg(e)));
    },
  });
  const remove = (fileId: string) => {
    api.delete(`/shop/listings/${listingId}/images/${fileId}`).then(reload).catch((e) => onError(errMsg(e)));
  };
  const thumbOf = (f: FileDto) =>
    f.publicUrl ? `${f.publicUrl}${f.variants?.some((v) => v.kind === 'thumb') ? '?variant=thumb' : ''}` : '';

  return (
    <div style={{ marginBottom: 'var(--spacing-3)' }}>
      <div className="label-sm" style={{ marginBottom: 'var(--spacing-1)' }}>
        Фото (до {SHOP_LIMITS.maxListingImages}; первое — обложка)
      </div>
      {images.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginBottom: '0.4rem' }}>
          {images.map((f) => (
            <div key={f.id} style={{ position: 'relative', width: 64, height: 64, borderRadius: 'var(--radius-md)', overflow: 'hidden', background: 'var(--surface-container-high)' }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={thumbOf(f)} alt={f.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              <button
                type="button"
                onClick={() => remove(f.id)}
                title="Убрать фото"
                style={{ position: 'absolute', top: 2, right: 2, width: 18, height: 18, border: 'none', borderRadius: '50%', background: 'rgba(56,57,45,0.65)', color: '#fff', fontSize: '0.6rem', cursor: 'pointer', lineHeight: 1 }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      {images.length < SHOP_LIMITS.maxListingImages && (
        <FileDropzone
          onFiles={(fs) => uploader.add(fs.slice(0, SHOP_LIMITS.maxListingImages - images.length))}
          accept="image/*"
          multiple
          compact
          label="Добавить фото"
        />
      )}
      <UploadProgressList items={uploader.items.filter((i) => i.status !== 'done')} onCancel={uploader.cancel} onRemove={uploader.remove} />
    </div>
  );
}

function ContributeModal({ listing, onClose, onDone, onError }: {
  listing: Listing; onClose: () => void; onDone: () => void; onError: (m: string) => void;
}) {
  const raisedMap = new Map((listing.campaign?.raised ?? []).map((x) => [x.currencyId, x.amount]));
  const mine = listing.campaign?.myContribution ?? [];
  const alreadyIn = mine.length > 0;
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const pledge = async () => {
    const contributions = listing.prices
      .map((p) => ({ currencyId: p.currencyId, amount: parseInt(amounts[p.currencyId] || '0', 10) }))
      .filter((c) => Number.isInteger(c.amount) && c.amount > 0);
    if (contributions.length === 0) return onError('Введите сумму хотя бы по одной валюте');
    setBusy(true);
    try { await api.post(`/shop/listings/${listing.id}/contribute`, { contributions }); onDone(); }
    catch (e) { onError(errMsg(e)); } finally { setBusy(false); }
  };
  const withdraw = async () => {
    if (!listing.campaign) return;
    setBusy(true);
    try { await api.post(`/shop/orders/${listing.campaign.orderId}/withdraw`); onDone(); }
    catch (e) { onError(errMsg(e)); } finally { setBusy(false); }
  };
  const mineText = mine
    .map((m) => { const p = listing.prices.find((x) => x.currencyId === m.currencyId); return `${fmtAmount(m.amount, p?.scale ?? 0)} ${p?.currencyIcon ?? '🪙'}`; })
    .join(' + ');

  return (
    <Overlay onClose={onClose}>
      <h3 className="title-md" style={{ marginBottom: 'var(--spacing-2)' }}>Скинуться: {listing.title}</h3>
      <CampaignBars prices={listing.prices} raised={listing.campaign?.raised} />
      {alreadyIn ? (
        <div style={{ marginTop: 'var(--spacing-3)' }}>
          <p className="label-sm" style={{ marginBottom: 'var(--spacing-3)' }}>Вы уже вложили <b>{mineText}</b>. Чтобы изменить — сначала отзовите вклад.</p>
          <button onClick={withdraw} disabled={busy} className="btn-secondary" style={{ fontSize: '0.85rem', color: 'var(--danger)' }}>Отозвать вклад</button>
        </div>
      ) : (
        <div style={{ marginTop: 'var(--spacing-3)' }}>
          {progressLines(listing.prices, listing.campaign?.raised).map((l) => {
            const remaining = Math.max(0, l.amount - l.raised);
            return (
              <label key={l.currencyId} className="label-sm" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                <span style={{ width: 120 }}>{l.currencyIcon} {l.currencyName}</span>
                <input type="number" min={0} max={remaining} disabled={remaining <= 0}
                  value={amounts[l.currencyId] ?? ''} onChange={(e) => setAmounts((s) => ({ ...s, [l.currencyId]: e.target.value }))}
                  className="input-sketch" style={{ width: 100, padding: '0.3rem 0.5rem' }} />
                <span style={{ opacity: 0.6, fontSize: '0.7rem' }}>осталось {fmtAmount(remaining, l.scale)}</span>
              </label>
            );
          })}
          <button onClick={pledge} disabled={busy} className="btn-primary" style={{ fontSize: '0.85rem', marginTop: 'var(--spacing-2)' }}>Скинуться</button>
        </div>
      )}
      <div style={{ marginTop: 'var(--spacing-4)', textAlign: 'right' }}>
        <button onClick={onClose} className="btn-secondary" style={{ fontSize: '0.85rem' }}>Закрыть</button>
      </div>
    </Overlay>
  );
}

function ListingForm({ init, showcaseId, onClose, onSaved, onError }: {
  init?: Listing; showcaseId: string; onClose: () => void; onSaved: () => void; onError: (m: string) => void;
}) {
  const [title, setTitle] = useState(init?.title ?? '');
  const [icon, setIcon] = useState(init?.icon ?? '🎁');
  const [description, setDescription] = useState(init?.description ?? '');
  const [itemType, setItemType] = useState<Listing['itemType']>(init?.itemType ?? 'material');
  const [withTask, setWithTask] = useState(init?.withTask ?? false);
  const [taskDays, setTaskDays] = useState(String(init?.taskDays ?? 7));
  const [crowdfunding, setCrowdfunding] = useState(init?.crowdfunding ?? false);
  const [currencies, setCurrencies] = useState<AccessibleCurrencyDto[]>([]);
  const [lines, setLines] = useState<{ currencyId: string; amount: string }[]>(
    init?.prices.map((p) => ({ currencyId: p.currencyId, amount: String(p.amount) })) ?? [],
  );
  const [busy, setBusy] = useState(false);
  const [stock, setStock] = useState(init?.stockLimit != null ? String(init.stockLimit) : '');
  const [limited, setLimited] = useState(!!init?.availableUntil);
  const [limitedDays, setLimitedDays] = useState('');
  const [discountPct, setDiscountPct] = useState(init?.discountPercent != null ? String(init.discountPercent) : '');
  const [discountDays, setDiscountDays] = useState('');

  // Currencies the owner can price in (own + окружение). Seed one default line for a new lot; keep
  // any currency the lot is already priced in (even if no longer accessible) so it stays selectable.
  useEffect(() => {
    api.get('/shop/currencies').then((r) => {
      const cs: AccessibleCurrencyDto[] = r.data.data;
      const extra: AccessibleCurrencyDto[] = (init?.prices ?? [])
        .filter((p) => !cs.some((c) => c.id === p.currencyId))
        .map((p) => ({ id: p.currencyId, name: p.currencyName, icon: p.currencyIcon, scale: p.scale, issuerId: '', issuerName: '—', isOwn: false }));
      const all = [...cs, ...extra];
      setCurrencies(all);
      setLines((prev) => (prev.length || all.length === 0 ? prev : [{ currencyId: all[0].id, amount: '100' }]));
    }).catch(() => {});
  }, []);

  const usedElsewhere = (idx: number) => new Set(lines.filter((_, i) => i !== idx).map((l) => l.currencyId));
  const setLine = (idx: number, patch: Partial<{ currencyId: string; amount: string }>) =>
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  const addLine = () => {
    const used = new Set(lines.map((l) => l.currencyId));
    const next = currencies.find((c) => !used.has(c.id));
    if (next) setLines((prev) => [...prev, { currencyId: next.id, amount: '50' }]);
  };
  const removeLine = (idx: number) => setLines((prev) => prev.filter((_, i) => i !== idx));
  const canAdd = lines.length < Math.min(currencies.length, SHOP_LIMITS.maxPriceLines);

  const save = async () => {
    if (!title.trim()) return onError('Введите название');
    if (lines.length === 0) return onError('Создайте свою валюту в «Кошельке», чтобы назначить цену');
    const prices = lines.map((l) => ({ currencyId: l.currencyId, amount: parseInt(l.amount, 10) }));
    if (prices.some((p) => !p.currencyId || !Number.isInteger(p.amount) || p.amount < 1))
      return onError('Каждая цена — валюта и целое число ≥ 1');
    if (new Set(prices.map((p) => p.currencyId)).size !== prices.length)
      return onError('Валюта повторяется — выберите разные');
    // Limits / time / discount (Phase 7). Days → a deadline from now; empty days while editing = keep.
    const dayMs = 86_400_000;
    const stockLimit = stock.trim() === '' ? null : Math.max(1, parseInt(stock, 10) || 1);
    let availableUntil: string | null | undefined;
    if (!limited) availableUntil = null;
    else {
      const d = parseInt(limitedDays, 10);
      if (d > 0) availableUntil = new Date(Date.now() + d * dayMs).toISOString();
      else if (init?.availableUntil) availableUntil = undefined; // keep existing
      else return onError('Укажите срок «ограниченного времени» в днях');
    }
    const pct = parseInt(discountPct, 10);
    let discountPercent: number | null | undefined;
    let discountUntil: string | null | undefined;
    if (!(pct > 0)) { discountPercent = null; discountUntil = null; }
    else {
      discountPercent = Math.min(99, pct);
      const dd = parseInt(discountDays, 10);
      if (dd > 0) discountUntil = new Date(Date.now() + dd * dayMs).toISOString();
      else if (init?.discountUntil) discountUntil = undefined; // keep existing
      else return onError('Укажите срок скидки в днях');
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        title: title.trim(), icon: icon || null, description: description.trim() || null,
        itemType, withTask, taskDays: withTask ? parseInt(taskDays, 10) || null : null,
        crowdfunding, prices, stockLimit,
      };
      if (availableUntil !== undefined) body.availableUntil = availableUntil;
      if (discountPercent !== undefined) body.discountPercent = discountPercent;
      if (discountUntil !== undefined) body.discountUntil = discountUntil;
      if (init) await api.patch(`/shop/listings/${init.id}`, body);
      else await api.post('/shop/listings', { ...body, showcaseId });
      onSaved();
    } catch (e) { onError(errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <Overlay onClose={onClose}>
      <h3 className="title-md" style={{ marginBottom: 'var(--spacing-4)' }}>{init ? 'Изменить товар' : 'Новый товар'}</h3>
      <div style={{ display: 'flex', gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-3)' }}>
        <input value={icon} onChange={(e) => setIcon(e.target.value)} maxLength={8} className="input-sketch" style={{ width: 56, textAlign: 'center', fontSize: '1.3rem' }} />
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Название" className="input-sketch" style={{ flex: 1 }} />
      </div>
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Описание (необязательно)" className="input-sketch" style={{ width: '100%', minHeight: 60, marginBottom: 'var(--spacing-3)' }} />

      {/* Галерея фото (движок файлов; только при редактировании — у нового лота ещё нет id) */}
      {init ? (
        <ListingPhotosSection listingId={init.id} onError={onError} />
      ) : (
        <p className="label-sm" style={{ opacity: 0.6, marginBottom: 'var(--spacing-3)', fontSize: '0.7rem' }}>
          Фото добавляются после создания товара (открой его через «Изменить»).
        </p>
      )}

      <div style={{ display: 'flex', gap: 'var(--spacing-3)', marginBottom: 'var(--spacing-3)', flexWrap: 'wrap' }}>
        <label className="label-sm">Тип{' '}
          <select value={itemType} onChange={(e) => setItemType(e.target.value as Listing['itemType'])} className="input-sketch" style={{ padding: '0.3rem 0.5rem' }}>
            <option value="material">Материальный</option>
            <option value="nonmaterial">Нематериальный</option>
          </select>
        </label>
      </div>

      {/* Cross-currency price editor: one line per currency (own + окружение). */}
      <div className="label-sm" style={{ marginBottom: '0.3rem', opacity: 0.7 }}>Цена</div>
      {currencies.length === 0 ? (
        <p className="label-sm" style={{ opacity: 0.7, marginBottom: 'var(--spacing-3)' }}>
          Нет доступных валют. Создайте свою в «Кошельке» — тогда сможете назначить цену.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginBottom: 'var(--spacing-3)' }}>
          {lines.map((line, idx) => {
            const used = usedElsewhere(idx);
            return (
              <div key={idx} style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                <input type="number" min={1} value={line.amount} onChange={(e) => setLine(idx, { amount: e.target.value })}
                  className="input-sketch" style={{ width: 90, padding: '0.3rem 0.5rem' }} />
                <select value={line.currencyId} onChange={(e) => setLine(idx, { currencyId: e.target.value })}
                  className="input-sketch" style={{ flex: 1, padding: '0.3rem 0.5rem', fontSize: '0.82rem' }}>
                  {currencies.filter((c) => c.id === line.currencyId || !used.has(c.id)).map((c) => (
                    <option key={c.id} value={c.id}>{c.icon} {c.name}{c.isOwn ? '' : ` · ${c.issuerName}`}</option>
                  ))}
                </select>
                {lines.length > 1 && (
                  <button onClick={() => removeLine(idx)} className="btn-secondary"
                    style={{ fontSize: '0.9rem', padding: '0.2rem 0.55rem', color: 'var(--danger)' }} title="Убрать валюту">×</button>
                )}
              </div>
            );
          })}
          {canAdd && (
            <button onClick={addLine} className="btn-secondary" style={{ fontSize: '0.78rem', alignSelf: 'flex-start' }}>+ Ещё валюта</button>
          )}
        </div>
      )}

      {/* Limits / time / FOMO discount (Phase 7) */}
      <div style={{ display: 'flex', gap: 'var(--spacing-3)', marginBottom: 'var(--spacing-3)', flexWrap: 'wrap', alignItems: 'center' }}>
        <label className="label-sm">Запас (штук){' '}
          <input type="number" min={1} value={stock} onChange={(e) => setStock(e.target.value)} placeholder="∞"
            className="input-sketch" style={{ width: 80, padding: '0.3rem 0.5rem' }} />
        </label>
        <label className="label-sm" style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
          <input type="checkbox" checked={limited} onChange={(e) => setLimited(e.target.checked)} /> Ограниченное время
        </label>
        {limited && (
          <label className="label-sm">дней{' '}
            <input type="number" min={1} value={limitedDays} onChange={(e) => setLimitedDays(e.target.value)}
              placeholder={init?.availableUntil ? '— без изм.' : '7'} className="input-sketch" style={{ width: 96, padding: '0.3rem 0.5rem' }} />
          </label>
        )}
      </div>
      <div style={{ display: 'flex', gap: 'var(--spacing-3)', marginBottom: 'var(--spacing-3)', flexWrap: 'wrap', alignItems: 'center' }}>
        <label className="label-sm">FOMO-скидка %{' '}
          <input type="number" min={0} max={99} value={discountPct} onChange={(e) => setDiscountPct(e.target.value)} placeholder="0"
            className="input-sketch" style={{ width: 70, padding: '0.3rem 0.5rem' }} />
        </label>
        {parseInt(discountPct, 10) > 0 && (
          <label className="label-sm">дней скидки{' '}
            <input type="number" min={1} value={discountDays} onChange={(e) => setDiscountDays(e.target.value)}
              placeholder={init?.discountUntil ? '— без изм.' : '3'} className="input-sketch" style={{ width: 96, padding: '0.3rem 0.5rem' }} />
          </label>
        )}
      </div>

      <div style={{ display: 'flex', gap: 'var(--spacing-4)', marginBottom: 'var(--spacing-4)', flexWrap: 'wrap' }}>
        <label className="label-sm" style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
          <input type="checkbox" checked={withTask} onChange={(e) => setWithTask(e.target.checked)} /> С задачей
        </label>
        {withTask && (
          <label className="label-sm">дней{' '}
            <input type="number" min={1} value={taskDays} onChange={(e) => setTaskDays(e.target.value)} className="input-sketch" style={{ width: 70, padding: '0.3rem 0.5rem' }} />
          </label>
        )}
        <label className="label-sm" style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
          <input type="checkbox" checked={crowdfunding} onChange={(e) => setCrowdfunding(e.target.checked)} /> Краудфандинг
        </label>
      </div>
      <div style={{ display: 'flex', gap: 'var(--spacing-2)', justifyContent: 'flex-end' }}>
        <button onClick={onClose} className="btn-secondary" style={{ fontSize: '0.85rem' }}>Отмена</button>
        <button onClick={save} disabled={busy} className="btn-primary" style={{ fontSize: '0.85rem' }}>{init ? 'Сохранить' : 'Создать'}</button>
      </div>
    </Overlay>
  );
}

function SharePanel({ showcase, onClose, onChanged, onError }: {
  showcase: Showcase; onClose: () => void; onChanged: () => void; onError: (m: string) => void;
}) {
  const [shares, setShares] = useState(showcase.shares ?? []);
  const has = (type: 'user' | 'circle', id: string) => shares.some((s) => s.principalType === type && s.principalId === id);

  const toggle = async (type: 'user' | 'circle', id: string) => {
    try {
      if (has(type, id)) {
        const r = await api.delete(`/shop/showcases/${showcase.id}/shares/${type}/${id}`);
        setShares(r.data.data);
      } else {
        const r = await api.post(`/shop/showcases/${showcase.id}/shares`, { principalType: type, principalId: id });
        setShares(r.data.data);
      }
      onChanged();
    } catch (e) { onError(errMsg(e)); }
  };

  return (
    <Overlay onClose={onClose}>
      <h3 className="title-md" style={{ marginBottom: 'var(--spacing-1)' }}>Доступ к «{showcase.name}»</h3>
      <p className="label-sm" style={{ opacity: 0.7, marginBottom: 'var(--spacing-4)' }}>Кому видна эта витрина — люди и Группы из вашего окружения.</p>
      <EntitySelector
        types={['user', 'circle']}
        multi
        value={shares.map((s) => ({ type: s.principalType, id: s.principalId }))}
        onChange={(next) => {
          const nxt = new Set(next.map((p) => `${p.type}:${p.id}`));
          const cur = new Set(shares.map((s) => `${s.principalType}:${s.principalId}`));
          for (const p of next) if (!cur.has(`${p.type}:${p.id}`)) toggle(p.type as 'user' | 'circle', p.id);
          for (const s of shares) if (!nxt.has(`${s.principalType}:${s.principalId}`)) toggle(s.principalType as 'user' | 'circle', s.principalId);
        }}
        placeholder="Добавьте людей или Группы…"
      />
      <div style={{ marginTop: 'var(--spacing-4)', textAlign: 'right' }}>
        <button onClick={onClose} className="btn-secondary" style={{ fontSize: '0.85rem' }}>Готово</button>
      </div>
    </Overlay>
  );
}

function StaffPanel({ contacts, showcases, onClose, onError }: {
  contacts: Contact[]; showcases: Showcase[]; onClose: () => void; onError: (m: string) => void;
}) {
  const [staff, setStaff] = useState<ShopStaffDto[]>([]);
  const [userId, setUserId] = useState('');
  const [scope, setScope] = useState<'shop' | 'showcase'>('shop');
  const [showcaseId, setShowcaseId] = useState('');

  const load = useCallback(() => { api.get('/shop/staff').then((r) => setStaff(r.data.data)).catch((e) => onError(errMsg(e))); }, [onError]);
  useEffect(() => { load(); }, [load]);

  const assign = async () => {
    if (!userId) return onError('Выберите человека');
    if (scope === 'showcase' && !showcaseId) return onError('Выберите витрину');
    try {
      await api.post('/shop/staff', { userId, scope, ...(scope === 'showcase' ? { showcaseId } : {}) });
      setUserId(''); load();
    } catch (e) { onError(errMsg(e)); }
  };
  const revoke = async (s: ShopStaffDto) => {
    try { await api.delete(`/shop/staff/${s.userId}?scope=${s.scope}${s.showcaseId ? `&showcaseId=${s.showcaseId}` : ''}`); load(); }
    catch (e) { onError(errMsg(e)); }
  };

  return (
    <Overlay onClose={onClose}>
      <h3 className="title-md" style={{ marginBottom: 'var(--spacing-1)' }}>Сотрудники</h3>
      <p className="label-sm" style={{ opacity: 0.7, marginBottom: 'var(--spacing-4)' }}>Сотрудник управляет товарами и заказами (как владелец).</p>
      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: 'var(--spacing-4)' }}>
        <div style={{ flex: 1, minWidth: 180 }}>
          <EntitySelector
            types={['user']}
            multi={false}
            options={contacts.map((c) => ({ type: 'user', id: c.them.id, title: personName(c), firstName: c.them.firstName, lastName: c.them.lastName, role: c.myRole }))}
            value={userId ? [{ type: 'user', id: userId }] : []}
            onChange={(p) => setUserId(p[0]?.id ?? '')}
            placeholder="— человек —"
          />
        </div>
        <select value={scope} onChange={(e) => setScope(e.target.value as 'shop' | 'showcase')} className="input-sketch" style={{ padding: '0.35rem 0.5rem', fontSize: '0.82rem' }}>
          <option value="shop">Весь магазин</option>
          <option value="showcase">Витрина</option>
        </select>
        {scope === 'showcase' && (
          <select value={showcaseId} onChange={(e) => setShowcaseId(e.target.value)} className="input-sketch" style={{ padding: '0.35rem 0.5rem', fontSize: '0.82rem' }}>
            <option value="">— витрина —</option>
            {showcases.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
        <button onClick={assign} className="btn-primary" style={{ fontSize: '0.82rem' }}>Назначить</button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
        {staff.length === 0 && <span className="label-sm" style={{ opacity: 0.6 }}>Сотрудников нет.</span>}
        {staff.map((s, i) => (
          <div key={i} className="card" style={{ padding: '0.35rem 0.7rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <div style={{ flex: 1 }}><PersonChip size="M" userId={s.userId} firstName={s.name} /></div>
            <span className="label-sm" style={{ opacity: 0.6, fontSize: '0.72rem' }}>{s.scope === 'shop' ? 'магазин' : s.showcaseName ?? 'витрина'}</span>
            <button onClick={() => revoke(s)} className="btn-secondary" style={{ fontSize: '0.72rem', padding: '0.2rem 0.5rem', color: 'var(--danger)' }}>Снять</button>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 'var(--spacing-4)', textAlign: 'right' }}>
        <button onClick={onClose} className="btn-secondary" style={{ fontSize: '0.85rem' }}>Готово</button>
      </div>
    </Overlay>
  );
}

function OrdersView({ onError }: { onError: (m: string) => void }) {
  const router = useRouter();
  const [incoming, setIncoming] = useState<Order[]>([]);
  const [mine, setMine] = useState<Order[]>([]);
  // Open (get-or-create) the order's context chat, then jump to the messenger.
  const discuss = async (orderId: string) => {
    try {
      const chat = await getOrderChat(orderId);
      router.push(`/messenger?chat=${chat.id}`);
    } catch (e) { onError(errMsg(e)); }
  };
  const load = useCallback(async () => {
    try {
      const [inc, my] = await Promise.all([api.get('/shop/orders/incoming'), api.get('/shop/orders')]);
      setIncoming(inc.data.data);
      setMine(my.data.data);
    } catch (e) { onError(errMsg(e)); }
  }, [onError]);
  useEffect(() => { load(); }, [load]);

  const act = async (id: string, action: 'confirm' | 'reject' | 'cancel' | 'refund' | 'withdraw') => {
    try { await api.post(`/shop/orders/${id}/${action}`); await load(); } catch (e) { onError(errMsg(e)); }
  };
  const statusLabel: Record<string, string> = {
    funding: 'Идёт сбор', pending: 'Ждёт подтверждения', confirmed: 'В работе', settled: 'Завершён', rejected: 'Отклонён', cancelled: 'Отменён', refunded: 'Возвращён',
  };
  const fmtRaisedText = (o: Order) =>
    progressLines(o.prices, o.raised).map((l) => `${fmtAmount(l.raised, l.scale)}/${fmtAmount(l.amount, l.scale)} ${l.currencyIcon}`).join(' · ');
  const row = (o: Order, kind: 'incoming' | 'mine') => (
    <div key={o.id} className="card" style={{ padding: 'var(--spacing-3) var(--spacing-4)', display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)' }}>
      {o.listingCoverUrl && (
        // Живая обложка лота (движок файлов, публичный класс)
        // eslint-disable-next-line @next/next/no-img-element
        <img src={o.listingCoverUrl} alt="" style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 'var(--radius-md)', flexShrink: 0 }} />
      )}
      {kind === 'incoming' && o.buyerName && <PersonChip size="S" userId={o.buyerId} firstName={o.buyerName} />}
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 500, fontSize: '0.9rem' }}>{o.crowdfunding ? '🎯 ' : ''}{o.title}</div>
        <div className="label-sm" style={{ fontSize: '0.72rem', opacity: 0.6 }}>
          {kind === 'incoming' && o.crowdfunding ? 'Инициатор · ' : ''}{statusLabel[o.status] ?? o.status}
        </div>
      </div>
      <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--primary)', fontSize: o.crowdfunding ? '0.72rem' : undefined, textAlign: 'right' }}>
        {o.crowdfunding ? fmtRaisedText(o) : fmtPrices(o.prices)}
      </div>
      {kind === 'incoming' && o.status === 'pending' && (
        <>
          <button onClick={() => act(o.id, 'confirm')} className="btn-primary" style={{ fontSize: '0.72rem', padding: '0.2rem 0.6rem' }}>Подтвердить</button>
          <button onClick={() => act(o.id, 'reject')} className="btn-secondary" style={{ fontSize: '0.72rem', padding: '0.2rem 0.6rem', color: 'var(--danger)' }}>Отклонить</button>
        </>
      )}
      {kind === 'incoming' && o.crowdfunding && o.status === 'funding' && (
        <button onClick={() => act(o.id, 'reject')} className="btn-secondary" style={{ fontSize: '0.72rem', padding: '0.2rem 0.6rem', color: 'var(--danger)' }}>Отменить сбор</button>
      )}
      {kind === 'incoming' && o.status === 'confirmed' && (
        <button onClick={() => act(o.id, 'refund')} className="btn-secondary" style={{ fontSize: '0.72rem', padding: '0.2rem 0.6rem', color: 'var(--danger)' }}>Вернуть</button>
      )}
      {kind === 'mine' && o.crowdfunding && o.status === 'funding' && (
        <button onClick={() => act(o.id, 'withdraw')} className="btn-secondary" style={{ fontSize: '0.72rem', padding: '0.2rem 0.6rem', color: 'var(--danger)' }}>Отозвать</button>
      )}
      {kind === 'mine' && !o.crowdfunding && o.status === 'pending' && (
        <button onClick={() => act(o.id, 'cancel')} className="btn-secondary" style={{ fontSize: '0.72rem', padding: '0.2rem 0.6rem' }}>Отменить</button>
      )}
      {kind === 'mine' && o.status === 'confirmed' && o.withTask && (
        <Link href="/tasks" className="label-sm" style={{ fontSize: '0.7rem', color: 'var(--secondary)' }}>Принять в Задачнике →</Link>
      )}
      <button onClick={() => discuss(o.id)} className="btn-secondary" style={{ fontSize: '0.72rem', padding: '0.2rem 0.6rem' }} title="Открыть чат заказа">Обсудить</button>
    </div>
  );

  return (
    <div style={{ display: 'grid', gap: 'var(--spacing-8)' }}>
      <section>
        <h2 className="title-md" style={{ marginBottom: 'var(--spacing-3)' }}>Заказы на мои витрины</h2>
        {incoming.length === 0 ? <p className="label-md" style={{ opacity: 0.7 }}>Пока нет заказов.</p> :
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>{incoming.map((o) => row(o, 'incoming'))}</div>}
      </section>
      <section>
        <h2 className="title-md" style={{ marginBottom: 'var(--spacing-3)' }}>Мои покупки</h2>
        {mine.length === 0 ? <p className="label-md" style={{ opacity: 0.7 }}>Вы ещё ничего не покупали.</p> :
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>{mine.map((o) => row(o, 'mine'))}</div>}
      </section>
    </div>
  );
}

function WishlistView({ onError, onOk }: { onError: (m: string) => void; onOk: (m: string) => void }) {
  const [items, setItems] = useState<WishItem[]>([]);
  const [shares, setShares] = useState<ShowcaseShareDto[]>([]);
  const [accessible, setAccessible] = useState<AccessibleWishlistRef[]>([]);
  const [viewing, setViewing] = useState<string | null>(null); // null = mine; else ownerId
  const [their, setTheir] = useState<{ name: string; items: WishItem[] }>({ name: '', items: [] });
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [circles, setCircles] = useState<Circle[]>([]);
  const [form, setForm] = useState<{ editing?: WishItem } | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [copy, setCopy] = useState<WishItem | null>(null);

  const loadMine = useCallback(async () => {
    try { const r = await api.get('/shop/wishes'); setItems(r.data.data.items); setShares(r.data.data.shares); } catch (e) { onError(errMsg(e)); }
  }, [onError]);
  useEffect(() => {
    loadMine();
    api.get('/shop/wishlists/accessible').then((r) => setAccessible(r.data.data)).catch(() => {});
    api.get('/contacts').then((r) => setContacts(r.data.data)).catch(() => {});
    api.get('/circles').then((r) => setCircles(r.data.data)).catch(() => {});
  }, [loadMine]);
  useEffect(() => {
    if (!viewing) return;
    api.get(`/shop/wishlists/of/${viewing}`).then((r) => setTheir(r.data.data)).catch((e) => onError(errMsg(e)));
  }, [viewing, onError]);

  const del = async (w: WishItem) => { if (!window.confirm(`Удалить «${w.title}»?`)) return; try { await api.delete(`/shop/wishes/${w.id}`); loadMine(); } catch (e) { onError(errMsg(e)); } };
  const fulfill = async (w: WishItem) => { try { await api.post(`/shop/wishes/${w.id}/fulfill`); loadMine(); } catch (e) { onError(errMsg(e)); } };
  const shown = viewing ? their.items : items;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-4)', flexWrap: 'wrap' }}>
        <select value={viewing ?? 'me'} onChange={(e) => setViewing(e.target.value === 'me' ? null : e.target.value)} className="input-sketch" style={{ maxWidth: 280, fontSize: '0.85rem', padding: '0.4rem 0.8rem' }}>
          <option value="me">Мой вишлист</option>
          {accessible.map((a) => <option key={a.ownerId} value={a.ownerId}>{a.name} ({a.itemCount})</option>)}
        </select>
        {!viewing && (
          <>
            <button onClick={() => setShareOpen(true)} className="btn-secondary" style={{ fontSize: '0.8rem' }}>Поделиться</button>
            <button onClick={() => setForm({})} className="btn-primary" style={{ fontSize: '0.8rem', marginLeft: 'auto' }}>+ Хотелка</button>
          </>
        )}
      </div>

      {shown.length === 0 ? (
        <p className="label-md" style={{ opacity: 0.7 }}>{viewing ? 'В этом вишлисте пока пусто.' : 'Добавьте, что хотите — и поделитесь с окружением.'}</p>
      ) : (
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 'var(--spacing-4)' }}>
          {shown.map((w) => (
            <div key={w.id} className="card-elevated" style={{ padding: 'var(--spacing-4)', opacity: w.status === 'fulfilled' ? 0.55 : 1 }}>
              <div style={{ fontSize: '2rem', marginBottom: 'var(--spacing-2)' }}>{w.icon ?? '🎁'}</div>
              <div className="title-md" style={{ fontSize: '1rem', marginBottom: '0.2rem' }}>{w.title}{w.status === 'fulfilled' ? ' ✓' : ''}</div>
              {w.description && <p className="label-sm" style={{ fontSize: '0.75rem', opacity: 0.7, marginBottom: '0.3rem' }}>{w.description}</p>}
              <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', marginBottom: '0.4rem' }}>
                <span className="ghost-border" style={{ fontSize: '0.65rem', padding: '0.1rem 0.5rem' }}>{LISTING_ITEM_TYPE_LABELS[w.itemType]}</span>
              </div>
              {w.link && <a href={w.link.startsWith('http') ? w.link : `https://${w.link}`} target="_blank" rel="noreferrer" className="label-sm" style={{ fontSize: '0.72rem', color: 'var(--secondary)', wordBreak: 'break-all' }}>🔗 ссылка</a>}
              <div style={{ display: 'flex', gap: '0.4rem', marginTop: 'var(--spacing-2)', flexWrap: 'wrap' }}>
                {viewing ? (
                  <button onClick={() => setCopy(w)} className="btn-primary" style={{ fontSize: '0.72rem', padding: '0.2rem 0.6rem' }}>Добавить в витрину</button>
                ) : (
                  <>
                    <button onClick={() => setForm({ editing: w })} className="btn-secondary" style={{ fontSize: '0.72rem', padding: '0.2rem 0.5rem' }}>Изменить</button>
                    {w.status === 'active' && <button onClick={() => fulfill(w)} className="btn-secondary" style={{ fontSize: '0.72rem', padding: '0.2rem 0.5rem', color: 'var(--secondary)' }}>Исполнено</button>}
                    <button onClick={() => del(w)} className="btn-secondary" style={{ fontSize: '0.72rem', padding: '0.2rem 0.5rem', color: 'var(--danger)' }}>Удалить</button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {form && <WishForm init={form.editing} onClose={() => setForm(null)} onSaved={() => { setForm(null); loadMine(); }} onError={onError} />}
      {shareOpen && <WishSharePanel shares={shares} onClose={() => setShareOpen(false)} onChanged={setShares} onError={onError} />}
      {copy && <CopyWishModal wish={copy} onClose={() => setCopy(null)} onDone={() => { setCopy(null); onOk('Добавлено в витрину — она расшарена владельцу хотелки.'); setTimeout(() => onOk(''), 5000); }} onError={onError} />}
    </div>
  );
}

function WishForm({ init, onClose, onSaved, onError }: { init?: WishItem; onClose: () => void; onSaved: () => void; onError: (m: string) => void }) {
  const [title, setTitle] = useState(init?.title ?? '');
  const [icon, setIcon] = useState(init?.icon ?? '🎁');
  const [description, setDescription] = useState(init?.description ?? '');
  const [link, setLink] = useState(init?.link ?? '');
  const [itemType, setItemType] = useState<WishItem['itemType']>(init?.itemType ?? 'material');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!title.trim()) return onError('Введите название');
    setBusy(true);
    try {
      const body = { title: title.trim(), icon: icon || null, description: description.trim() || null, link: link.trim() || null, itemType };
      if (init) await api.patch(`/shop/wishes/${init.id}`, body);
      else await api.post('/shop/wishes', body);
      onSaved();
    } catch (e) { onError(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Overlay onClose={onClose}>
      <h3 className="title-md" style={{ marginBottom: 'var(--spacing-4)' }}>{init ? 'Изменить хотелку' : 'Новая хотелка'}</h3>
      <div style={{ display: 'flex', gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-3)' }}>
        <input value={icon} onChange={(e) => setIcon(e.target.value)} maxLength={8} className="input-sketch" style={{ width: 56, textAlign: 'center', fontSize: '1.3rem' }} />
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Что хочешь?" className="input-sketch" style={{ flex: 1 }} />
      </div>
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Описание (необязательно)" className="input-sketch" style={{ width: '100%', minHeight: 56, marginBottom: 'var(--spacing-3)' }} />
      <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="Ссылка (необязательно)" className="input-sketch" style={{ width: '100%', marginBottom: 'var(--spacing-3)' }} />
      <label className="label-sm" style={{ display: 'block', marginBottom: 'var(--spacing-4)' }}>Тип{' '}
        <select value={itemType} onChange={(e) => setItemType(e.target.value as WishItem['itemType'])} className="input-sketch" style={{ padding: '0.3rem 0.5rem' }}>
          <option value="material">Материальный</option>
          <option value="nonmaterial">Нематериальный</option>
        </select>
      </label>
      <div style={{ display: 'flex', gap: 'var(--spacing-2)', justifyContent: 'flex-end' }}>
        <button onClick={onClose} className="btn-secondary" style={{ fontSize: '0.85rem' }}>Отмена</button>
        <button onClick={save} disabled={busy} className="btn-primary" style={{ fontSize: '0.85rem' }}>{init ? 'Сохранить' : 'Создать'}</button>
      </div>
    </Overlay>
  );
}

function WishSharePanel({ shares, onClose, onChanged, onError }: {
  shares: ShowcaseShareDto[]; onClose: () => void; onChanged: (s: ShowcaseShareDto[]) => void; onError: (m: string) => void;
}) {
  const has = (type: 'user' | 'circle', id: string) => shares.some((s) => s.principalType === type && s.principalId === id);
  const toggle = async (type: 'user' | 'circle', id: string) => {
    try {
      const r = has(type, id) ? await api.delete(`/shop/wishes/shares/${type}/${id}`) : await api.post('/shop/wishes/shares', { principalType: type, principalId: id });
      onChanged(r.data.data);
    } catch (e) { onError(errMsg(e)); }
  };
  return (
    <Overlay onClose={onClose}>
      <h3 className="title-md" style={{ marginBottom: 'var(--spacing-1)' }}>Кому виден мой вишлист</h3>
      <p className="label-sm" style={{ opacity: 0.7, marginBottom: 'var(--spacing-4)' }}>Люди и Группы из окружения.</p>
      <EntitySelector
        types={['user', 'circle']}
        multi
        value={shares.map((s) => ({ type: s.principalType, id: s.principalId }))}
        onChange={(next) => {
          const nxt = new Set(next.map((p) => `${p.type}:${p.id}`));
          const cur = new Set(shares.map((s) => `${s.principalType}:${s.principalId}`));
          for (const p of next) if (!cur.has(`${p.type}:${p.id}`)) toggle(p.type as 'user' | 'circle', p.id);
          for (const s of shares) if (!nxt.has(`${s.principalType}:${s.principalId}`)) toggle(s.principalType as 'user' | 'circle', s.principalId);
        }}
        placeholder="Добавьте людей или Группы…"
      />
      <div style={{ marginTop: 'var(--spacing-4)', textAlign: 'right' }}><button onClick={onClose} className="btn-secondary" style={{ fontSize: '0.85rem' }}>Готово</button></div>
    </Overlay>
  );
}

function CopyWishModal({ wish, onClose, onDone, onError }: { wish: WishItem; onClose: () => void; onDone: () => void; onError: (m: string) => void }) {
  const [showcases, setShowcases] = useState<Showcase[]>([]);
  const [currencies, setCurrencies] = useState<AccessibleCurrencyDto[]>([]);
  const [target, setTarget] = useState('new'); // showcaseId | 'new'
  const [newName, setNewName] = useState('');
  const [lines, setLines] = useState<{ currencyId: string; amount: string }[]>([]);
  const [crowdfunding, setCrowdfunding] = useState(false);
  const [stock, setStock] = useState('');
  const [limitedDays, setLimitedDays] = useState('');
  const [discountPct, setDiscountPct] = useState('');
  const [discountDays, setDiscountDays] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get('/shop').then((r) => setShowcases(r.data.data.showcases ?? [])).catch(() => {});
    api.get('/shop/currencies').then((r) => { const cs: AccessibleCurrencyDto[] = r.data.data; setCurrencies(cs); if (cs.length) setLines([{ currencyId: cs[0].id, amount: '100' }]); }).catch(() => {});
  }, []);
  const setLine = (idx: number, patch: Partial<{ currencyId: string; amount: string }>) => setLines((p) => p.map((l, i) => (i === idx ? { ...l, ...patch } : l)));

  const save = async () => {
    const prices = lines.map((l) => ({ currencyId: l.currencyId, amount: parseInt(l.amount, 10) })).filter((p) => p.currencyId && Number.isInteger(p.amount) && p.amount > 0);
    if (prices.length === 0) return onError('Укажите цену');
    if (target === 'new' && !newName.trim()) return onError('Введите название новой витрины');
    const dayMs = 86_400_000;
    setBusy(true);
    try {
      const body: Record<string, unknown> = { prices, crowdfunding };
      if (target === 'new') body.newShowcaseName = newName.trim(); else body.showcaseId = target;
      if (stock.trim()) body.stockLimit = Math.max(1, parseInt(stock, 10) || 1);
      if (parseInt(limitedDays, 10) > 0) body.availableUntil = new Date(Date.now() + parseInt(limitedDays, 10) * dayMs).toISOString();
      const pct = parseInt(discountPct, 10);
      if (pct > 0 && parseInt(discountDays, 10) > 0) { body.discountPercent = Math.min(99, pct); body.discountUntil = new Date(Date.now() + parseInt(discountDays, 10) * dayMs).toISOString(); }
      await api.post(`/shop/wishes/${wish.id}/copy`, body);
      onDone();
    } catch (e) { onError(errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <Overlay onClose={onClose}>
      <h3 className="title-md" style={{ marginBottom: 'var(--spacing-3)' }}>Добавить в витрину: {wish.title}</h3>
      <label className="label-sm" style={{ display: 'block', marginBottom: 'var(--spacing-3)' }}>Витрина{' '}
        <select value={target} onChange={(e) => setTarget(e.target.value)} className="input-sketch" style={{ padding: '0.3rem 0.5rem' }}>
          <option value="new">+ Новая витрина</option>
          {showcases.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      {target === 'new' && <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={`Название (напр. Wishlist «${wish.title}»)`} className="input-sketch" style={{ width: '100%', marginBottom: 'var(--spacing-3)' }} />}
      <div className="label-sm" style={{ marginBottom: '0.3rem', opacity: 0.7 }}>Цена</div>
      {currencies.length === 0 ? <p className="label-sm" style={{ opacity: 0.7, marginBottom: 'var(--spacing-3)' }}>Создайте свою валюту в «Кошельке».</p> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginBottom: 'var(--spacing-3)' }}>
          {lines.map((line, idx) => (
            <div key={idx} style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
              <input type="number" min={1} value={line.amount} onChange={(e) => setLine(idx, { amount: e.target.value })} className="input-sketch" style={{ width: 90, padding: '0.3rem 0.5rem' }} />
              <select value={line.currencyId} onChange={(e) => setLine(idx, { currencyId: e.target.value })} className="input-sketch" style={{ flex: 1, padding: '0.3rem 0.5rem', fontSize: '0.82rem' }}>
                {currencies.map((c) => <option key={c.id} value={c.id}>{c.icon} {c.name}{c.isOwn ? '' : ` · ${c.issuerName}`}</option>)}
              </select>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 'var(--spacing-3)', flexWrap: 'wrap', alignItems: 'center', marginBottom: 'var(--spacing-3)' }}>
        <label className="label-sm" style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
          <input type="checkbox" checked={crowdfunding} onChange={(e) => setCrowdfunding(e.target.checked)} /> Краудфандинг
        </label>
        <label className="label-sm">Запас{' '}<input type="number" min={1} value={stock} onChange={(e) => setStock(e.target.value)} placeholder="∞" className="input-sketch" style={{ width: 70, padding: '0.3rem 0.5rem' }} /></label>
        <label className="label-sm">Срок, дней{' '}<input type="number" min={1} value={limitedDays} onChange={(e) => setLimitedDays(e.target.value)} placeholder="—" className="input-sketch" style={{ width: 70, padding: '0.3rem 0.5rem' }} /></label>
      </div>
      <div style={{ display: 'flex', gap: 'var(--spacing-3)', flexWrap: 'wrap', alignItems: 'center', marginBottom: 'var(--spacing-4)' }}>
        <label className="label-sm">Скидка %{' '}<input type="number" min={0} max={99} value={discountPct} onChange={(e) => setDiscountPct(e.target.value)} placeholder="0" className="input-sketch" style={{ width: 64, padding: '0.3rem 0.5rem' }} /></label>
        {parseInt(discountPct, 10) > 0 && <label className="label-sm">дней скидки{' '}<input type="number" min={1} value={discountDays} onChange={(e) => setDiscountDays(e.target.value)} placeholder="3" className="input-sketch" style={{ width: 70, padding: '0.3rem 0.5rem' }} /></label>}
      </div>
      <p className="label-sm" style={{ opacity: 0.6, fontSize: '0.72rem', marginBottom: 'var(--spacing-3)' }}>Тип «{LISTING_ITEM_TYPE_LABELS[wish.itemType]}» берётся из хотелки. Витрина будет расшарена владельцу хотелки.</p>
      <div style={{ display: 'flex', gap: 'var(--spacing-2)', justifyContent: 'flex-end' }}>
        <button onClick={onClose} className="btn-secondary" style={{ fontSize: '0.85rem' }}>Отмена</button>
        <button onClick={save} disabled={busy} className="btn-primary" style={{ fontSize: '0.85rem' }}>Добавить</button>
      </div>
    </Overlay>
  );
}

function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(56,57,45,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60, padding: '1rem' }}>
      <div onClick={(e) => e.stopPropagation()} className="card-elevated" style={{ background: 'var(--surface-container-lowest, #fff)', padding: 'var(--spacing-6)', maxWidth: 460, width: '100%', maxHeight: '85vh', overflowY: 'auto' }}>
        {children}
      </div>
    </div>
  );
}
