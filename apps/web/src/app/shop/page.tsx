'use client';

// ============================================================
// «My Wish & Shop» — витрины за коины, вишлист, заказы.
// Экран: PageHeader + вкладки + бенто (витрины слева, товары справа).
// Формы и панели — окна кита (shop-modals), карточки — shop-ui.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { api, apiErrorMessage } from '@/lib/api';
import { executeRichCardAction } from '@/lib/messenger-api';
import { ShareCardModal } from '../messenger/ShareCardModal';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import {
  Alert, BentoGrid, Button, Card, CardHeader, Chip, ConfirmDialog, EmojiIcon, EmptyState,
  Icon, IconButton, Input, LoadingBlock, Modal, PageHeader, Select, Tabs, type TabItem,
} from '@/components/ui';
import {
  pluralRu,
  type Shop, type Showcase, type Listing, type AccessibleShopRef, type Contact,
} from '@superapp/shared';
import { ListingCard } from './shop-ui';
import { ContributeModal, ListingForm, SharePanel, StaffPanel } from './shop-modals';
import { OrdersView } from './OrdersView';
import { WishlistView } from './WishlistView';

type Tab = 'shops' | 'wishlist' | 'orders';

export default function ShopPage() {
  const { isReady } = useRequireAuth();
  const router = useRouter();

  const [tab, setTab] = useState<Tab>('shops');
  const [viewOwnerId, setViewOwnerId] = useState<string | null>(null); // null = мой магазин
  const [accessible, setAccessible] = useState<AccessibleShopRef[]>([]);
  const [shop, setShop] = useState<Shop | null>(null);
  const [showcases, setShowcases] = useState<Showcase[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [listings, setListings] = useState<Listing[]>([]);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [loading, setLoading] = useState(true);

  // пикеры владельца
  const [contacts, setContacts] = useState<Contact[]>([]);

  // ui
  const [showcaseModal, setShowcaseModal] = useState<{ editing?: Showcase } | null>(null);
  const [listingModal, setListingModal] = useState<{ showcaseId: string; editing?: Listing } | null>(null);
  const [sharePanel, setSharePanel] = useState<Showcase | null>(null);
  const [staffOpen, setStaffOpen] = useState(false);
  const [contributeModal, setContributeModal] = useState<Listing | null>(null);
  const [forwardListing, setForwardListing] = useState<Listing | null>(null);
  const [removingShowcase, setRemovingShowcase] = useState<Showcase | null>(null);
  const [removingListing, setRemovingListing] = useState<Listing | null>(null);

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
      setError(apiErrorMessage(e));
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

  // товары выбранной витрины
  useEffect(() => {
    if (!selectedId) { setListings([]); return; }
    api.get(`/shop/showcases/${selectedId}/listings`)
      .then((r) => setListings(r.data.data))
      .catch((e) => setError(apiErrorMessage(e)));
  }, [selectedId]);

  // пикер людей нужен только в своём магазине (назначение сотрудников)
  useEffect(() => {
    if (!isReady || viewOwnerId || !canManage) return;
    api.get('/contacts').then((r) => setContacts(r.data.data)).catch(() => {});
  }, [isReady, viewOwnerId, canManage]);

  const reload = async () => {
    await loadShop();
    if (selectedId) {
      try {
        const r = await api.get(`/shop/showcases/${selectedId}/listings`);
        setListings(r.data.data);
      } catch { /* витрина могла исчезнуть — список перечитает loadShop */ }
    }
  };

  const deleteShowcase = async () => {
    if (!removingShowcase) return;
    try {
      await api.delete(`/shop/showcases/${removingShowcase.id}`);
      if (selectedId === removingShowcase.id) setSelectedId(null);
      setRemovingShowcase(null);
      await loadShop();
    } catch (e) {
      setRemovingShowcase(null);
      setError(apiErrorMessage(e));
    }
  };
  const deleteListing = async () => {
    if (!removingListing) return;
    try {
      await api.delete(`/shop/listings/${removingListing.id}`);
      setRemovingListing(null);
      await reload();
    } catch (e) {
      setRemovingListing(null);
      setError(apiErrorMessage(e));
    }
  };
  const buy = async (l: Listing) => {
    setError(''); setOk('');
    try {
      await api.post(`/shop/listings/${l.id}/buy`);
      setOk(`Заказ оформлен: «${l.title}». Коины заморожены до подтверждения продавцом (вкладка «Заказы»).`);
      setTimeout(() => setOk(''), 5000);
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  };
  // «Поговорить» — DM покупатель↔продавец с карточкой лота, затем переход в мессенджер.
  const talk = async (l: Listing) => {
    setError('');
    try {
      await executeRichCardAction('listing.talk', { type: 'listing', id: l.id });
    } catch (e) {
      setError(apiErrorMessage(e));
      return;
    }
    router.push(viewOwnerId ? `/messenger?dm=${viewOwnerId}` : '/messenger');
  };

  if (!isReady || loading) return <LoadingBlock />;

  const selected = showcases.find((s) => s.id === selectedId) ?? null;

  const tabs: TabItem<Tab>[] = [
    { key: 'shops', label: 'Магазины', icon: 'shop' },
    { key: 'wishlist', label: 'Вишлист', icon: 'heart' },
    { key: 'orders', label: 'Заказы', icon: 'receipt' },
  ];

  return (
    <>
      <PageHeader
        breadcrumb="My Wish & Shop"
        title={viewOwnerId ? shop?.name ?? 'Магазин' : 'Мой магазин'}
        description={viewOwnerId ? 'Витрины, которыми с вами поделились' : 'Витрины подарков за коины и списки желаний'}
        actions={
          <>
            {/* Переключатель «чей магазин смотрю» — навигация, поэтому Select, не EntitySelector */}
            {accessible.length > 0 && tab === 'shops' && (
              <Select
                aria-label="Чей магазин"
                value={viewOwnerId ?? 'me'}
                onChange={(v) => setViewOwnerId(v === 'me' ? null : v)}
                width={230}
                options={[
                  { value: 'me', label: 'Мой магазин', icon: 'shop' },
                  ...accessible.map((a) => ({ value: a.ownerId, label: a.name, icon: 'user' as const })),
                ]}
              />
            )}
            {canManage && tab === 'shops' && (
              <Button variant="matte" tone="accent" icon="people" onClick={() => setStaffOpen(true)}>
                Сотрудники
              </Button>
            )}
          </>
        }
      />

      <div style={{ marginBottom: 'var(--gap-grid)' }}>
        <Tabs aria-label="Разделы магазина" items={tabs} value={tab} onChange={setTab} />
      </div>

      {(error || ok) && (
        <div style={{ marginBottom: 'var(--gap-grid)' }}>
          {error && <Alert tone="danger" onClose={() => setError('')}>{error}</Alert>}
          {ok && <Alert tone="success" onClose={() => setOk('')}>{ok}</Alert>}
        </div>
      )}

      {tab === 'wishlist' ? (
        <WishlistView onError={setError} onOk={setOk} />
      ) : tab === 'orders' ? (
        <OrdersView onError={setError} />
      ) : (
        <BentoGrid>
          {/* ---------- Витрины ---------- */}
          <Card span={3}>
            <CardHeader
              title="Витрины"
              actions={
                canManage ? (
                  <IconButton icon="add" label="Новая витрина" size={30} onClick={() => setShowcaseModal({})} />
                ) : undefined
              }
            />
            {showcases.length === 0 ? (
              <EmptyState
                icon="folder"
                title="Витрин нет"
                description={canManage ? 'Создайте первую — например «Подарки».' : 'Владелец пока ничем не поделился.'}
                action={canManage ? <Button variant="matte" size="sm" icon="add" onClick={() => setShowcaseModal({})}>Витрина</Button> : undefined}
              />
            ) : (
              <div style={{ display: 'grid', gap: '0.25rem' }}>
                {showcases.map((s) => {
                  const active = selectedId === s.id;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setSelectedId(s.id)}
                      aria-pressed={active}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%',
                        padding: '0.4375rem 0.5rem', borderRadius: 'var(--radius-md)', cursor: 'pointer',
                        textAlign: 'left', color: 'var(--on-surface)',
                        background: active ? 'var(--active)' : 'transparent',
                        border: `1px solid ${active ? 'var(--border)' : 'transparent'}`,
                      }}
                    >
                      {/* Эмодзи витрины выбирает владелец — это данные */}
                      <EmojiIcon emoji={s.icon} size={26} fallback="folder" tone={active ? 'accent' : 'neutral'} />
                      <span className="title-sm" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {s.name}
                      </span>
                      <span className="label-sm">{s.listingCount}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </Card>

          {/* ---------- Товары витрины ---------- */}
          <Card span={9}>
            {selected ? (
              <CardHeader
                title={
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
                    <EmojiIcon emoji={selected.icon} size={30} fallback="folder" tone="accent" />
                    <span className="title-md">{selected.name}</span>
                  </span>
                }
                subtitle={`${listings.length} ${pluralRu(listings.length, ['товар', 'товара', 'товаров'])}`}
                actions={
                  canManage ? (
                    <>
                      <Button variant="ghost" size="sm" icon="share" onClick={() => setSharePanel(selected)}>Поделиться</Button>
                      <IconButton icon="edit" label="Переименовать витрину" size={30} onClick={() => setShowcaseModal({ editing: selected })} />
                      <IconButton icon="delete" label="Удалить витрину" size={30} onClick={() => setRemovingShowcase(selected)} />
                      <Button variant="primary" tone="success" size="sm" icon="add" onClick={() => setListingModal({ showcaseId: selected.id })}>
                        Товар
                      </Button>
                    </>
                  ) : undefined
                }
              />
            ) : (
              <CardHeader title="Товары" subtitle="Выберите витрину слева" />
            )}

            {!selected ? (
              <EmptyState icon="shop" title="Витрина не выбрана" description="Слева — список витрин этого магазина." />
            ) : listings.length === 0 ? (
              <EmptyState
                icon="gift"
                title="В витрине нет товаров"
                description={canManage ? 'Добавьте первый — цену можно назначить в своей и чужих валютах.' : 'Владелец ещё не выложил товары.'}
                action={
                  canManage ? (
                    <Button variant="primary" tone="success" icon="add" onClick={() => setListingModal({ showcaseId: selected.id })}>
                      Новый товар
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 'var(--gap-grid)' }}>
                {listings.map((l) => (
                  <ListingCard
                    key={l.id}
                    l={l}
                    canManage={canManage}
                    onEdit={() => setListingModal({ showcaseId: l.showcaseId, editing: l })}
                    onDelete={() => setRemovingListing(l)}
                    onBuy={!canManage && viewOwnerId ? () => buy(l) : undefined}
                    onTalk={!canManage && viewOwnerId ? () => talk(l) : undefined}
                    onForward={() => setForwardListing(l)}
                    onContribute={!canManage && viewOwnerId ? () => setContributeModal(l) : undefined}
                  />
                ))}
              </div>
            )}
          </Card>
        </BentoGrid>
      )}

      {showcaseModal && (
        <ShowcaseModal
          init={showcaseModal.editing}
          onClose={() => setShowcaseModal(null)}
          onSaved={async () => { setShowcaseModal(null); await loadShop(); }}
        />
      )}
      {listingModal && (
        <ListingForm
          init={listingModal.editing}
          showcaseId={listingModal.showcaseId}
          onClose={() => setListingModal(null)}
          onSaved={async () => { setListingModal(null); await reload(); }}
        />
      )}
      {sharePanel && (
        <SharePanel showcase={sharePanel} onClose={() => setSharePanel(null)} onChanged={loadShop} />
      )}
      {staffOpen && (
        <StaffPanel contacts={contacts} showcases={showcases} onClose={() => setStaffOpen(false)} />
      )}
      {contributeModal && (
        <ContributeModal
          listing={contributeModal}
          onClose={() => setContributeModal(null)}
          onDone={async () => { setContributeModal(null); await reload(); }}
        />
      )}
      {forwardListing && (
        <ShareCardModal
          refType={forwardListing.crowdfunding ? 'crowdfunding' : 'listing'}
          refId={forwardListing.id}
          title={forwardListing.title}
          onClose={() => setForwardListing(null)}
        />
      )}

      <ConfirmDialog
        open={!!removingShowcase}
        onClose={() => setRemovingShowcase(null)}
        onConfirm={deleteShowcase}
        title={removingShowcase ? `Удалить витрину «${removingShowcase.name}»?` : 'Удалить витрину?'}
        message="Вместе с витриной исчезнут её товары. Товар с активным заказом удалить нельзя."
        confirmLabel="Удалить"
        danger
      />
      <ConfirmDialog
        open={!!removingListing}
        onClose={() => setRemovingListing(null)}
        onConfirm={deleteListing}
        title={removingListing ? `Удалить «${removingListing.title}»?` : 'Удалить товар?'}
        message="Если по товару есть активный заказ — удалить не получится."
        confirmLabel="Удалить"
        danger
      />
    </>
  );
}

/** Создание и переименование витрины (было window.prompt). */
function ShowcaseModal({
  init,
  onClose,
  onSaved,
}: {
  init?: Showcase;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(init?.name ?? '');
  const [icon, setIcon] = useState(init?.icon ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!name.trim()) { setError('Введите название'); return; }
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), ...(icon.trim() ? { icon: icon.trim() } : init ? { icon: null } : {}) };
      if (init) await api.patch(`/shop/showcases/${init.id}`, body);
      else await api.post('/shop/showcases', body);
      onSaved();
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={init ? 'Переименовать витрину' : 'Новая витрина'}
      subtitle="Витрина — папка товаров со своим доступом"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Отмена</Button>
          <Button variant="primary" tone="success" icon={init ? 'save' : 'add'} loading={busy} onClick={save}>
            {init ? 'Сохранить' : 'Создать'}
          </Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
        {error && <Alert tone="danger" onClose={() => setError(null)}>{error}</Alert>}
        <div style={{ display: 'grid', gridTemplateColumns: '5rem 1fr', gap: 'var(--spacing-3)' }}>
          <Input
            label="Значок"
            value={icon}
            onChange={(e) => setIcon(e.target.value)}
            maxLength={8}
            placeholder="🎁"
            style={{ textAlign: 'center', fontSize: '1.15rem' }}
          />
          <Input
            label="Название"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Подарки"
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter' && name.trim() && !busy) save(); }}
          />
        </div>
      </div>
    </Modal>
  );
}
