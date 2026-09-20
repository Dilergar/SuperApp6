'use client';

// ============================================================
// «My Wish & Shop» — витрины за коины, вишлист, заказы.
// Экран: PageHeader + вкладки + бенто (витрины слева, товары справа).
// Формы и панели — окна кита (shop-modals), карточки — shop-ui.
// ============================================================

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiErrorMessage, apiGet, apiPatch, apiPost } from '@/lib/api';
import { apiErrorCode, isOutcomeUnknown, toastApiError } from '@/lib/api-errors';
import { useIdempotencyIntent } from '@/lib/useIdempotencyKey';
import { OutcomeUnknownAlert, SlowRequestNote } from '@/components/idempotency/OutcomeUnknownAlert';
import { EntitlementGauge, EntitlementLock, useEntitlementGate } from '@/components/entitlements';
import { contactsKey, fetchAllContacts, shopAccessibleKey, shopListingsKey, shopMineKey, shopOfKey } from '@/lib/queries';
import { executeRichCardAction } from '@/lib/messenger-api';
import { ShareCardModal } from '../messenger/ShareCardModal';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import {
  Alert, BentoGrid, Button, Card, CardHeader, Chip, ConfirmDialog, EmojiIcon, EmptyState,
  GlyphField, Icon, IconButton, Input, LoadingBlock, Modal, PageHeader, Select, SegmentedControl, type TabItem,
} from '@/components/ui';
import {
  type Shop, type Showcase, type Listing, type AccessibleShopRef, type Contact,
  type ShopOverviewDto,
} from '@superapp/shared';
import { ListingCard } from './shop-ui';
import { ContributeModal, ListingForm, SharePanel, StaffPanel } from './shop-modals';
import { OrdersView } from './OrdersView';
import { WishlistView } from './WishlistView';

type Tab = 'shops' | 'wishlist' | 'orders';

export default function ShopPage() {
  const { isReady } = useRequireAuth();
  const t = useTranslations('shop');
  const common = useTranslations('common');
  const router = useRouter();

  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('shops');
  const [viewOwnerId, setViewOwnerId] = useState<string | null>(null); // null = мой магазин
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');

  // ui
  const [showcaseModal, setShowcaseModal] = useState<{ editing?: Showcase } | null>(null);
  const [listingModal, setListingModal] = useState<{ showcaseId: string; editing?: Listing } | null>(null);
  const [sharePanel, setSharePanel] = useState<Showcase | null>(null);
  const [staffOpen, setStaffOpen] = useState(false);
  const [contributeModal, setContributeModal] = useState<Listing | null>(null);
  // Намерение покупки: живёт до успеха, поэтому повтор того же клика = тот же заказ
  // Ключ намерения покупки — на ЛОТ: двойное нажатие даёт ОДИН заказ, а не два
  const buyIntent = useIdempotencyIntent();
  const [buying, setBuying] = useState<string | null>(null);
  const [unknownOutcome, setUnknownOutcome] = useState<unknown>(null);
  const [forwardListing, setForwardListing] = useState<Listing | null>(null);
  const [removingShowcase, setRemovingShowcase] = useState<Showcase | null>(null);
  const [removingListing, setRemovingListing] = useState<Listing | null>(null);

  // Магазин и витрины — в общем кэше React Query (свой ключ на каждого владельца):
  // возврат на страницу и переключение магазинов рисуются из кэша, а мутации
  // инвалидируют точечно (раньше 4 разрозненных эффекта + полный reload на клик).
  const shopKey = viewOwnerId ? shopOfKey(viewOwnerId) : shopMineKey;
  const shopQ = useQuery({
    queryKey: shopKey,
    queryFn: () => apiGet<ShopOverviewDto>(viewOwnerId ? `/shop/of/${viewOwnerId}` : '/shop'),
    enabled: isReady,
    staleTime: 30_000,
  });
  const shop = shopQ.data?.shop ?? null;
  const showcases: Showcase[] = shopQ.data?.showcases ?? [];
  const canManage = shop?.canManage ?? false;
  // Замок тарифа на новую витрину (личный магазин — субъект человек)
  const showcaseGate = useEntitlementGate('shop.maxShowcases', null, 'ent-lock-showcases');

  // Выбор витрины следует за списком: пропала выбранная → первая доступная
  useEffect(() => {
    if (!shopQ.data) return;
    const sc = shopQ.data.showcases;
    setSelectedId((prev) => (prev && sc.some((s) => s.id === prev) ? prev : sc[0]?.id ?? null));
  }, [shopQ.data]);

  const accessibleQ = useQuery({
    queryKey: shopAccessibleKey,
    queryFn: async () => await apiGet<AccessibleShopRef[]>('/shop/accessible'),
    enabled: isReady,
    staleTime: 60_000,
  });
  const accessible: AccessibleShopRef[] = accessibleQ.data ?? [];

  const listingsQ = useQuery({
    queryKey: shopListingsKey(selectedId ?? 'none'),
    queryFn: async () => await apiGet<Listing[]>(`/shop/showcases/${selectedId}/listings`),
    enabled: isReady && !!selectedId,
    staleTime: 30_000,
  });
  const listings: Listing[] = selectedId ? listingsQ.data ?? [] : [];

  // Пикер людей нужен только в своём магазине (назначение сотрудников) —
  // ОБЩИЙ ключ Окружения: список, загруженный /circles, переиспользуется здесь
  const contactsQ = useQuery({
    queryKey: contactsKey,
    queryFn: fetchAllContacts,
    enabled: isReady && !viewOwnerId && canManage,
    staleTime: 60_000,
  });
  const contacts: Contact[] = contactsQ.data ?? [];

  // Имена сохранены (их зовут модалки ниже), семантика — точечная инвалидация
  const loadShop = async () => { await qc.invalidateQueries({ queryKey: shopKey }); };
  const reload = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: shopKey }),
      selectedId ? qc.invalidateQueries({ queryKey: shopListingsKey(selectedId) }) : Promise.resolve(),
    ]);
  };

  const deleteShowcase = async () => {
    if (!removingShowcase) return;
    try {
      await apiDelete(`/shop/showcases/${removingShowcase.id}`);
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
      await apiDelete(`/shop/listings/${removingListing.id}`);
      setRemovingListing(null);
      await reload();
    } catch (e) {
      setRemovingListing(null);
      setError(apiErrorMessage(e));
    }
  };
  const buy = async (l: Listing) => {
    setError(''); setOk(''); setUnknownOutcome(null); setBuying(l.id);
    try {
      // Покупка необратима (эскроу): ключ намерения — на лот, а не на клик, поэтому
      // двойное нажатие даёт ОДИН заказ, а не два
      await apiPost(`/shop/listings/${l.id}/buy`, undefined, { idempotencyKey: buyIntent.keyFor('buy', l.id) });
      buyIntent.reset();
      setOk(t('page.orderPlaced', { title: l.title }));
      setTimeout(() => setOk(''), 5000);
    } catch (e) {
      // «Могло пройти» — заказ мог создаться: веди в «Мои заказы», а не пугай красным
      if (isOutcomeUnknown(e)) setUnknownOutcome(e);
      // «Уже куплено» — это успех, а не беда: красная строка соврала бы и толкнула
      // нажать «Купить» второй раз
      else if (apiErrorCode(e)?.startsWith('idempotency.')) toastApiError(e);
      else setError(apiErrorMessage(e));
    } finally {
      setBuying(null);
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

  if (!isReady || shopQ.isPending) return <LoadingBlock />;

  const selected = showcases.find((s) => s.id === selectedId) ?? null;
  const shownError = error || (shopQ.error ? apiErrorMessage(shopQ.error) : '');

  const tabs: TabItem<Tab>[] = [
    { key: 'shops', label: t('page.tabShops'), icon: 'shop' },
    { key: 'wishlist', label: t('page.tabWishlist'), icon: 'heart' },
    { key: 'orders', label: t('page.tabOrders'), icon: 'receipt' },
  ];

  return (
    <>
      <PageHeader
        breadcrumb="My Wish & Shop"
        title={viewOwnerId ? shop?.name ?? t('defaultShopName') : t('page.myShop')}
        description={t(viewOwnerId ? 'page.sharedDescription' : 'page.myDescription')}
        actions={
          <>
            {/* Переключатель «чей магазин смотрю» — навигация, поэтому Select, не EntitySelector */}
            {accessible.length > 0 && tab === 'shops' && (
              <Select
                aria-label={t('page.whoseShop')}
                value={viewOwnerId ?? 'me'}
                onChange={(v) => setViewOwnerId(v === 'me' ? null : v)}
                width={230}
                options={[
                  { value: 'me', label: t('page.myShop'), icon: 'shop' },
                  ...accessible.map((a) => ({ value: a.ownerId, label: a.name, icon: 'user' as const })),
                ]}
              />
            )}
            {canManage && tab === 'shops' && (
              <Button variant="matte" tone="accent" icon="people" onClick={() => setStaffOpen(true)}>
                {t('page.staff')}
              </Button>
            )}
          </>
        }
      />

      <div style={{ marginBottom: 'var(--gap-grid)' }}>
        <SegmentedControl aria-label={t('page.sections')} items={tabs} value={tab} onChange={setTab} />
      </div>

      {(shownError || ok || unknownOutcome != null || buying !== null) && (
        <div style={{ marginBottom: 'var(--gap-grid)' }}>
          {unknownOutcome != null && (
            <OutcomeUnknownAlert error={unknownOutcome} onOpenHistory={() => { setTab('orders'); setUnknownOutcome(null); }} onDismiss={() => setUnknownOutcome(null)} />
          )}
          {/* Транспорт уже несколько секунд повторяет покупку сам — кнопка в это
              время заблокирована, и без подписи это выглядит как зависший экран. */}
          <SlowRequestNote pending={buying !== null} />
          {shownError && <Alert tone="danger" onClose={() => setError('')}>{shownError}</Alert>}
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
              title={t('page.showcases')}
              actions={
                canManage ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
                    <EntitlementGauge keyName="shop.maxShowcases" />
                    <EntitlementLock keyName="shop.maxShowcases" id="ent-lock-showcases" />
                    <IconButton icon="add" label={t('page.newShowcase')} size={30} disabled={showcaseGate.blocked} aria-describedby={showcaseGate.describedBy} onClick={() => setShowcaseModal({})} />
                  </span>
                ) : undefined
              }
            />
            {showcases.length === 0 ? (
              <EmptyState
                icon="folder"
                title={t('page.noShowcases')}
                description={t(canManage ? 'page.noShowcasesOwner' : 'page.noShowcasesGuest')}
                action={
                  canManage ? (
                    <Button variant="matte" size="sm" icon="add" disabled={showcaseGate.blocked} aria-describedby={showcaseGate.describedBy} onClick={() => setShowcaseModal({})}>
                      {t('page.showcase')}
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <div className="ui-stack" style={{ gap: '0.25rem' }}>
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
                subtitle={t('page.listingCount', { count: listings.length })}
                actions={
                  canManage ? (
                    <>
                      <Button variant="ghost" size="sm" icon="share" onClick={() => setSharePanel(selected)}>{t('page.share')}</Button>
                      <IconButton icon="edit" label={t('page.renameShowcase')} size={30} onClick={() => setShowcaseModal({ editing: selected })} />
                      <IconButton icon="delete" label={t('page.deleteShowcase')} size={30} onClick={() => setRemovingShowcase(selected)} />
                      <Button variant="primary" tone="success" size="sm" icon="add" onClick={() => setListingModal({ showcaseId: selected.id })}>
                        {t('page.listing')}
                      </Button>
                    </>
                  ) : undefined
                }
              />
            ) : (
              <CardHeader title={t('page.listings')} subtitle={t('page.pickShowcase')} />
            )}

            {!selected ? (
              <EmptyState icon="shop" title={t('page.noShowcaseSelected')} description={t('page.noShowcaseSelectedHint')} />
            ) : listings.length === 0 ? (
              <EmptyState
                icon="gift"
                title={t('page.showcaseEmpty')}
                description={t(canManage ? 'page.showcaseEmptyOwner' : 'page.showcaseEmptyGuest')}
                action={
                  canManage ? (
                    <Button variant="primary" tone="success" icon="add" onClick={() => setListingModal({ showcaseId: selected.id })}>
                      {t('page.newListing')}
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
        title={
          removingShowcase
            ? t('page.confirmDeleteShowcaseOf', { name: removingShowcase.name })
            : t('page.confirmDeleteShowcase')
        }
        message={t('page.confirmDeleteShowcaseMessage')}
        confirmLabel={common('actions.delete')}
        danger
      />
      <ConfirmDialog
        open={!!removingListing}
        onClose={() => setRemovingListing(null)}
        onConfirm={deleteListing}
        title={
          removingListing
            ? t('page.confirmDeleteListingOf', { title: removingListing.title })
            : t('page.confirmDeleteListing')
        }
        message={t('page.confirmDeleteListingMessage')}
        confirmLabel={common('actions.delete')}
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
  const t = useTranslations('shop');
  const common = useTranslations('common');
  const [name, setName] = useState(init?.name ?? '');
  const [icon, setIcon] = useState(init?.icon ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!name.trim()) { setError(t('page.nameRequired')); return; }
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), ...(icon.trim() ? { icon: icon.trim() } : init ? { icon: null } : {}) };
      if (init) await apiPatch(`/shop/showcases/${init.id}`, body);
      else await apiPost('/shop/showcases', body);
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
      title={t(init ? 'page.renameShowcase' : 'page.newShowcase')}
      subtitle={t('page.showcaseSubtitle')}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{common('actions.cancel')}</Button>
          <Button variant="primary" tone="success" icon={init ? 'save' : 'add'} loading={busy} onClick={save}>
            {common(init ? 'actions.save' : 'actions.create')}
          </Button>
        </>
      }
    >
      <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        {error && <Alert tone="danger" onClose={() => setError(null)}>{error}</Alert>}
        <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: 'var(--spacing-3)', alignItems: 'start' }}>
          <GlyphField value={icon} onChange={(v) => setIcon(v ?? '')} suggest={name} />
          <Input
            label={common('labels.name')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('page.showcasePlaceholder')}
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter' && name.trim() && !busy) save(); }}
          />
        </div>
      </div>
    </Modal>
  );
}
