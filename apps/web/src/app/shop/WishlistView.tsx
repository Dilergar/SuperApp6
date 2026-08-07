'use client';

// ============================================================
// «Вишлист»: свои хотелки + чужие (кому открыт доступ) и перенос чужой
// хотелки в свою витрину («Добавить в витрину» → лот с ценой).
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { apiDelete, apiErrorMessage, apiGet, apiPatch, apiPost } from '@/lib/api';
import { EntitySelector } from '@/components/EntitySelector';
import {
  Alert, BentoGrid, Button, Card, CardHeader, Checkbox, Chip, ConfirmDialog, Divider, EmojiIcon,
  EmptyState, Field, GlyphField, Icon, Input, Modal, Select, Textarea,
} from '@/components/ui';
import {
  LISTING_ITEM_TYPE_LABELS,
  type AccessibleCurrencyDto,
  type AccessibleWishlistRef,
  type Showcase,
  type ShowcaseShareDto,
  type WishItem,
  type ShopOverviewDto,
} from '@superapp/shared';
import { PriceLinesEditor, type PriceLine } from './shop-modals';
import { daysFromNow } from './shop-lib';

export function WishlistView({ onError, onOk }: { onError: (m: string) => void; onOk: (m: string) => void }) {
  const [items, setItems] = useState<WishItem[]>([]);
  const [shares, setShares] = useState<ShowcaseShareDto[]>([]);
  const [accessible, setAccessible] = useState<AccessibleWishlistRef[]>([]);
  const [viewing, setViewing] = useState<string | null>(null); // null = мой вишлист; иначе ownerId
  const [their, setTheir] = useState<{ name: string; items: WishItem[] }>({ name: '', items: [] });
  const [form, setForm] = useState<{ editing?: WishItem } | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [copy, setCopy] = useState<WishItem | null>(null);
  const [removing, setRemoving] = useState<WishItem | null>(null);

  const loadMine = useCallback(async () => {
    try {
      const r = await apiGet<{ items: WishItem[]; shares: ShowcaseShareDto[] }>('/shop/wishes');
      setItems(r.items);
      setShares(r.shares);
    } catch (e) {
      onError(apiErrorMessage(e));
    }
  }, [onError]);

  useEffect(() => {
    loadMine();
    apiGet<AccessibleWishlistRef[]>('/shop/wishlists/accessible').then(setAccessible).catch(() => {});
  }, [loadMine]);

  useEffect(() => {
    if (!viewing) return;
    apiGet<{ name: string; items: WishItem[] }>(`/shop/wishlists/of/${viewing}`)
      .then(setTheir)
      .catch((e) => onError(apiErrorMessage(e)));
  }, [viewing, onError]);

  const del = async () => {
    if (!removing) return;
    try {
      await apiDelete(`/shop/wishes/${removing.id}`);
      setRemoving(null);
      loadMine();
    } catch (e) {
      setRemoving(null);
      onError(apiErrorMessage(e));
    }
  };
  const fulfill = async (w: WishItem) => {
    try {
      await apiPost(`/shop/wishes/${w.id}/fulfill`);
      loadMine();
    } catch (e) {
      onError(apiErrorMessage(e));
    }
  };

  const shown = viewing ? their.items : items;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: 'var(--gap-grid)', flexWrap: 'wrap' }}>
        <Select
          aria-label="Чей вишлист"
          value={viewing ?? 'me'}
          onChange={(v) => setViewing(v === 'me' ? null : v)}
          width={280}
          options={[
            { value: 'me', label: 'Мой вишлист', icon: 'heart' },
            ...accessible.map((a) => ({ value: a.ownerId, label: a.name, hint: String(a.itemCount), icon: 'user' as const })),
          ]}
        />
        {!viewing && (
          <>
            <Button variant="matte" tone="accent" size="sm" icon="share" onClick={() => setShareOpen(true)}>Поделиться</Button>
            <Button variant="primary" tone="success" size="sm" icon="add" onClick={() => setForm({})} style={{ marginLeft: 'auto' }}>
              Хотелка
            </Button>
          </>
        )}
      </div>

      <BentoGrid>
        <Card span={12}>
          <CardHeader
            title={viewing ? `Вишлист: ${their.name}` : 'Мои хотелки'}
            subtitle={
              viewing
                ? 'Можно «Добавить в витрину» — витрина сама расшарится владельцу хотелки'
                : 'Что хочется получить в подарок. Кому видно — решаете вы'
            }
          />
          {shown.length === 0 ? (
            <EmptyState
              icon="gift"
              title={viewing ? 'В этом вишлисте пусто' : 'Хотелок пока нет'}
              description={viewing ? 'Владелец ещё ничего не добавил.' : 'Добавьте, что хотите — и поделитесь с окружением.'}
              action={!viewing ? <Button variant="primary" tone="success" icon="add" onClick={() => setForm({})}>Добавить хотелку</Button> : undefined}
            />
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 'var(--gap-grid)' }}>
              {shown.map((w) => (
                <Card key={w.id} small style={{ opacity: w.status === 'fulfilled' ? 0.6 : 1 }}>
                  {/* Эмодзи хотелки — выбор человека, это данные */}
                  <EmojiIcon emoji={w.icon} size={44} square tone="accent" fallback="gift" />
                  <div className="title-sm" style={{ marginTop: 'var(--spacing-3)', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                    {w.title}
                    {w.status === 'fulfilled' && <Icon name="checkCircle" size={16} style={{ color: 'var(--success)' }} />}
                  </div>
                  {w.description && <p className="label-sm" style={{ margin: '0.25rem 0 0' }}>{w.description}</p>}

                  <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap', margin: 'var(--spacing-3) 0' }}>
                    <Chip size="sm" tone="neutral">{LISTING_ITEM_TYPE_LABELS[w.itemType]}</Chip>
                    {w.status === 'fulfilled' && <Chip size="sm" tone="success">исполнено</Chip>}
                  </div>

                  {w.link && (
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="link"
                      href={w.link.startsWith('http') ? w.link : `https://${w.link}`}
                    >
                      Ссылка
                    </Button>
                  )}

                  <div style={{ display: 'flex', gap: '0.375rem', marginTop: 'var(--spacing-3)', flexWrap: 'wrap' }}>
                    {viewing ? (
                      <Button variant="primary" tone="success" size="sm" icon="shop" onClick={() => setCopy(w)}>
                        Добавить в витрину
                      </Button>
                    ) : (
                      <>
                        <Button variant="outline" size="sm" icon="edit" onClick={() => setForm({ editing: w })}>Изменить</Button>
                        {w.status === 'active' && (
                          <Button variant="ghost" size="sm" icon="check" onClick={() => fulfill(w)}>Исполнено</Button>
                        )}
                        <Button variant="ghost" size="sm" tone="danger" icon="delete" onClick={() => setRemoving(w)}>Удалить</Button>
                      </>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </Card>
      </BentoGrid>

      {form && (
        <WishForm
          init={form.editing}
          onClose={() => setForm(null)}
          onSaved={() => { setForm(null); loadMine(); }}
        />
      )}
      {shareOpen && (
        <WishSharePanel shares={shares} onClose={() => setShareOpen(false)} onChanged={setShares} />
      )}
      {copy && (
        <CopyWishModal
          wish={copy}
          onClose={() => setCopy(null)}
          onDone={() => {
            setCopy(null);
            onOk('Добавлено в витрину — она расшарена владельцу хотелки.');
            setTimeout(() => onOk(''), 5000);
          }}
        />
      )}

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={del}
        title={removing ? `Удалить «${removing.title}»?` : 'Удалить хотелку?'}
        message="Хотелка исчезнет из вашего вишлиста и у тех, кому он открыт."
        confirmLabel="Удалить"
        danger
      />
    </>
  );
}

// ============================================================
// Форма хотелки
// ============================================================

function WishForm({ init, onClose, onSaved }: { init?: WishItem; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(init?.title ?? '');
  const [icon, setIcon] = useState(init?.icon ?? '🎁');
  const [description, setDescription] = useState(init?.description ?? '');
  const [link, setLink] = useState(init?.link ?? '');
  const [itemType, setItemType] = useState<WishItem['itemType']>(init?.itemType ?? 'material');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!title.trim()) { setError('Введите название'); return; }
    setBusy(true);
    setError(null);
    try {
      const body = {
        title: title.trim(),
        icon: icon || null,
        description: description.trim() || null,
        link: link.trim() || null,
        itemType,
      };
      if (init) await apiPatch(`/shop/wishes/${init.id}`, body);
      else await apiPost('/shop/wishes', body);
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
      title={init ? 'Изменить хотелку' : 'Новая хотелка'}
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
      <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        {error && <Alert tone="danger" onClose={() => setError(null)}>{error}</Alert>}
        <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: 'var(--spacing-3)', alignItems: 'start' }}>
          <GlyphField value={icon} onChange={(v) => setIcon(v ?? '')} suggest={title} />
          <Input label="Название" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Что хочешь?" autoFocus />
        </div>
        <Textarea
          label="Описание"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Необязательно"
          style={{ minHeight: 56 }}
        />
        <Input label="Ссылка" value={link} onChange={(e) => setLink(e.target.value)} placeholder="Необязательно" icon="link" />
        <Select
          label="Тип"
          value={itemType}
          onChange={(v) => setItemType(v as WishItem['itemType'])}
          options={[
            { value: 'material', label: 'Материальный', icon: 'gift' },
            { value: 'nonmaterial', label: 'Нематериальный', icon: 'spark' },
          ]}
        />
      </div>
    </Modal>
  );
}

// ============================================================
// Кому виден вишлист
// ============================================================

function WishSharePanel({
  shares,
  onClose,
  onChanged,
}: {
  shares: ShowcaseShareDto[];
  onClose: () => void;
  onChanged: (s: ShowcaseShareDto[]) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const has = (type: 'user' | 'circle', id: string) => shares.some((s) => s.principalType === type && s.principalId === id);

  const toggle = async (type: 'user' | 'circle', id: string) => {
    try {
      const next = has(type, id)
        ? await apiDelete<ShowcaseShareDto[]>(`/shop/wishes/shares/${type}/${id}`)
        : await apiPost<ShowcaseShareDto[]>('/shop/wishes/shares', { principalType: type, principalId: id });
      onChanged(next);
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Кому виден мой вишлист"
      subtitle="Люди и Группы из окружения"
      size="sm"
      footer={<Button variant="ghost" onClick={onClose}>Готово</Button>}
    >
      <div className="ui-stack" style={{ gap: 'var(--spacing-3)' }}>
        {error && <Alert tone="danger" onClose={() => setError(null)}>{error}</Alert>}
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
      </div>
    </Modal>
  );
}

// ============================================================
// Чужая хотелка → лот в моей витрине
// ============================================================

function CopyWishModal({ wish, onClose, onDone }: { wish: WishItem; onClose: () => void; onDone: () => void }) {
  const [showcases, setShowcases] = useState<Showcase[]>([]);
  const [currencies, setCurrencies] = useState<AccessibleCurrencyDto[]>([]);
  const [target, setTarget] = useState('new'); // showcaseId | 'new'
  const [newName, setNewName] = useState('');
  const [lines, setLines] = useState<PriceLine[]>([]);
  const [crowdfunding, setCrowdfunding] = useState(false);
  const [stock, setStock] = useState('');
  const [limitedDays, setLimitedDays] = useState('');
  const [discountPct, setDiscountPct] = useState('');
  const [discountDays, setDiscountDays] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<ShopOverviewDto>('/shop').then((r) => setShowcases(r.showcases)).catch(() => {});
    apiGet<AccessibleCurrencyDto[]>('/shop/currencies').then((cs) => {
      setCurrencies(cs);
      if (cs.length) setLines([{ currencyId: cs[0].id, amount: '100' }]);
    }).catch(() => {});
  }, []);

  const save = async () => {
    const prices = lines
      .map((l) => ({ currencyId: l.currencyId, amount: parseInt(l.amount, 10) }))
      .filter((p) => p.currencyId && Number.isInteger(p.amount) && p.amount > 0);
    if (prices.length === 0) { setError('Укажите цену'); return; }
    if (target === 'new' && !newName.trim()) { setError('Введите название новой витрины'); return; }
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { prices, crowdfunding };
      if (target === 'new') body.newShowcaseName = newName.trim();
      else body.showcaseId = target;
      if (stock.trim()) body.stockLimit = Math.max(1, parseInt(stock, 10) || 1);
      if (parseInt(limitedDays, 10) > 0) body.availableUntil = daysFromNow(parseInt(limitedDays, 10));
      const pct = parseInt(discountPct, 10);
      if (pct > 0 && parseInt(discountDays, 10) > 0) {
        body.discountPercent = Math.min(99, pct);
        body.discountUntil = daysFromNow(parseInt(discountDays, 10));
      }
      await apiPost(`/shop/wishes/${wish.id}/copy`, body);
      onDone();
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
      title={`Добавить в витрину: ${wish.title}`}
      subtitle={`Тип «${LISTING_ITEM_TYPE_LABELS[wish.itemType]}» берётся из хотелки; витрина расшарится её владельцу`}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Отмена</Button>
          <Button variant="primary" tone="success" icon="add" loading={busy} onClick={save}>Добавить</Button>
        </>
      }
    >
      <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        {error && <Alert tone="danger" onClose={() => setError(null)}>{error}</Alert>}

        <Select
          label="Витрина"
          value={target}
          onChange={setTarget}
          options={[
            { value: 'new', label: 'Новая витрина', icon: 'add' },
            ...showcases.map((s) => ({ value: s.id, label: s.name, emoji: s.icon })),
          ]}
        />
        {target === 'new' && (
          <Input
            label="Название витрины"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={`Например: Подарки для «${wish.title}»`}
          />
        )}

        <PriceLinesEditor currencies={currencies} lines={lines} onChange={setLines} />

        <Divider style={{ margin: 0 }} />

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 'var(--spacing-3)' }}>
          <Input label="Запас, штук" type="number" min={1} value={stock} onChange={(e) => setStock(e.target.value)} placeholder="∞" />
          <Input label="Срок, дней" type="number" min={1} value={limitedDays} onChange={(e) => setLimitedDays(e.target.value)} placeholder="—" />
          <Input label="Скидка, %" type="number" min={0} max={99} value={discountPct} onChange={(e) => setDiscountPct(e.target.value)} placeholder="0" />
          {parseInt(discountPct, 10) > 0 && (
            <Input label="Скидка, дней" type="number" min={1} value={discountDays} onChange={(e) => setDiscountDays(e.target.value)} placeholder="3" />
          )}
        </div>

        <Field label="Как собирать">
          <Checkbox checked={crowdfunding} onChange={setCrowdfunding} label="Краудфандинг — скидываются несколько человек" />
        </Field>
      </div>
    </Modal>
  );
}
