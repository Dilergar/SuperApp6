'use client';

// ============================================================
// Окна Магазина: форма лота, вклад в сбор, доступ к витрине, сотрудники.
// Все — на ките (Modal/Input/Select/Checkbox/Button), без своей вёрстки окон.
// ============================================================

import { useEffect, useState } from 'react';
import { api, apiErrorMessage } from '@/lib/api';
import { EntitySelector } from '@/components/EntitySelector';
import { PersonChip } from '../circles/PersonCard';
import {
  Alert, Button, Checkbox, Chip, Divider, EmptyState, Field, IconButton, Input, Modal,
  Select, Textarea, type SelectOption,
} from '@/components/ui';
import {
  SHOP_LIMITS,
  type AccessibleCurrencyDto,
  type Contact,
  type Listing,
  type ShopStaffDto,
  type Showcase,
} from '@superapp/shared';
import { CampaignBars, ListingPhotosSection } from './shop-ui';
import { daysFromNow, fmtAmount, personName, progressLines } from './shop-lib';

export interface PriceLine {
  currencyId: string;
  amount: string;
}

const currencyOptions = (currencies: AccessibleCurrencyDto[], allowed: (c: AccessibleCurrencyDto) => boolean): SelectOption[] =>
  currencies.filter(allowed).map((c) => ({
    value: c.id,
    label: c.name,
    emoji: c.icon,
    hint: c.isOwn ? 'своя' : c.issuerName,
  }));

/** Редактор кросс-валютной цены: строка = валюта + сумма (до SHOP_LIMITS.maxPriceLines). */
export function PriceLinesEditor({
  currencies,
  lines,
  onChange,
  label = 'Цена',
}: {
  currencies: AccessibleCurrencyDto[];
  lines: PriceLine[];
  onChange: (next: PriceLine[]) => void;
  label?: string;
}) {
  const usedElsewhere = (idx: number) => new Set(lines.filter((_, i) => i !== idx).map((l) => l.currencyId));
  const setLine = (idx: number, patch: Partial<PriceLine>) =>
    onChange(lines.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  const addLine = () => {
    const used = new Set(lines.map((l) => l.currencyId));
    const next = currencies.find((c) => !used.has(c.id));
    if (next) onChange([...lines, { currencyId: next.id, amount: '50' }]);
  };
  const removeLine = (idx: number) => onChange(lines.filter((_, i) => i !== idx));
  const canAdd = lines.length < Math.min(currencies.length, SHOP_LIMITS.maxPriceLines);

  if (currencies.length === 0) {
    return (
      <Alert tone="warning" icon="coins">
        Нет доступных валют. Создайте свою в «Кошельке» — тогда сможете назначить цену.
      </Alert>
    );
  }

  return (
    <Field label={label} hint="Можно назначить цену в нескольких валютах — покупатель платит по всем">
      <div className="ui-stack" style={{ gap: '0.375rem' }}>
        {lines.map((line, idx) => {
          const used = usedElsewhere(idx);
          return (
            <div key={idx} style={{ display: 'flex', gap: '0.375rem', alignItems: 'center' }}>
              <div style={{ width: 110 }}>
                <Input
                  type="number"
                  min={1}
                  value={line.amount}
                  onChange={(e) => setLine(idx, { amount: e.target.value })}
                  aria-label="Сумма"
                />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Select
                  aria-label="Валюта"
                  value={line.currencyId}
                  onChange={(v) => setLine(idx, { currencyId: v })}
                  options={currencyOptions(currencies, (c) => c.id === line.currencyId || !used.has(c.id))}
                  width="100%"
                />
              </div>
              {lines.length > 1 && (
                <IconButton icon="close" label="Убрать валюту" size={30} onClick={() => removeLine(idx)} />
              )}
            </div>
          );
        })}
        {canAdd && (
          <Button variant="ghost" size="sm" icon="add" onClick={addLine} style={{ alignSelf: 'flex-start' }}>
            Ещё валюта
          </Button>
        )}
      </div>
    </Field>
  );
}

// ============================================================
// Вклад в сбор
// ============================================================

export function ContributeModal({
  listing,
  onClose,
  onDone,
}: {
  listing: Listing;
  onClose: () => void;
  onDone: () => void;
}) {
  const mine = listing.campaign?.myContribution ?? [];
  const alreadyIn = mine.length > 0;
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pledge = async () => {
    const contributions = listing.prices
      .map((p) => ({ currencyId: p.currencyId, amount: parseInt(amounts[p.currencyId] || '0', 10) }))
      .filter((c) => Number.isInteger(c.amount) && c.amount > 0);
    if (contributions.length === 0) { setError('Введите сумму хотя бы по одной валюте'); return; }
    setBusy(true);
    setError(null);
    try {
      await api.post(`/shop/listings/${listing.id}/contribute`, { contributions });
      onDone();
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const withdraw = async () => {
    if (!listing.campaign) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/shop/orders/${listing.campaign.orderId}/withdraw`);
      onDone();
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const mineText = mine
    .map((m) => {
      const p = listing.prices.find((x) => x.currencyId === m.currencyId);
      return `${fmtAmount(m.amount, p?.scale ?? 0)} ${p?.currencyIcon ?? ''}`;
    })
    .join(' + ');

  return (
    <Modal
      open
      onClose={onClose}
      title={`Скинуться: ${listing.title}`}
      subtitle="Всё или ничего: пока цель не собрана, вклады заморожены и возвращаются при отмене"
      size="sm"
      footer={
        alreadyIn ? (
          <>
            <Button variant="ghost" onClick={onClose}>Закрыть</Button>
            <Button variant="primary" tone="danger" icon="undo" loading={busy} onClick={withdraw}>Отозвать вклад</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>Отмена</Button>
            <Button variant="primary" tone="success" icon="target" loading={busy} onClick={pledge}>Скинуться</Button>
          </>
        )
      }
    >
      <div className="ui-stack" style={{ gap: 'var(--spacing-3)' }}>
        {error && <Alert tone="danger" onClose={() => setError(null)}>{error}</Alert>}
        <CampaignBars prices={listing.prices} raised={listing.campaign?.raised} />

        {alreadyIn ? (
          <Alert tone="success" icon="checkCircle">
            Вы уже вложили <b>{mineText}</b>. Чтобы изменить — сначала отзовите вклад.
          </Alert>
        ) : (
          <div className="ui-stack" style={{ gap: 'var(--spacing-3)' }}>
            {progressLines(listing.prices, listing.campaign?.raised).map((l) => {
              const remaining = Math.max(0, l.amount - l.raised);
              return (
                <Input
                  key={l.currencyId}
                  label={`${l.currencyIcon} ${l.currencyName}`}
                  hint={`осталось ${fmtAmount(remaining, l.scale)}`}
                  type="number"
                  min={0}
                  max={remaining}
                  disabled={remaining <= 0}
                  value={amounts[l.currencyId] ?? ''}
                  onChange={(e) => setAmounts((s) => ({ ...s, [l.currencyId]: e.target.value }))}
                />
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}

// ============================================================
// Форма лота
// ============================================================

export function ListingForm({
  init,
  showcaseId,
  onClose,
  onSaved,
}: {
  init?: Listing;
  showcaseId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(init?.title ?? '');
  const [icon, setIcon] = useState(init?.icon ?? '🎁');
  const [description, setDescription] = useState(init?.description ?? '');
  const [itemType, setItemType] = useState<Listing['itemType']>(init?.itemType ?? 'material');
  const [withTask, setWithTask] = useState(init?.withTask ?? false);
  const [taskDays, setTaskDays] = useState(String(init?.taskDays ?? 7));
  const [crowdfunding, setCrowdfunding] = useState(init?.crowdfunding ?? false);
  const [currencies, setCurrencies] = useState<AccessibleCurrencyDto[]>([]);
  const [lines, setLines] = useState<PriceLine[]>(
    init?.prices.map((p) => ({ currencyId: p.currencyId, amount: String(p.amount) })) ?? [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stock, setStock] = useState(init?.stockLimit != null ? String(init.stockLimit) : '');
  const [limited, setLimited] = useState(!!init?.availableUntil);
  const [limitedDays, setLimitedDays] = useState('');
  const [discountPct, setDiscountPct] = useState(init?.discountPercent != null ? String(init.discountPercent) : '');
  const [discountDays, setDiscountDays] = useState('');

  // Валюты, в которых владелец может оценить лот (своя + окружение). Новому лоту
  // подставляем одну строку; уже назначенную валюту сохраняем в списке, даже если
  // доступ к ней потерян — иначе цена «пропала бы» при правке.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    if (!title.trim()) { setError('Введите название'); return; }
    if (lines.length === 0) { setError('Создайте свою валюту в «Кошельке», чтобы назначить цену'); return; }
    const prices = lines.map((l) => ({ currencyId: l.currencyId, amount: parseInt(l.amount, 10) }));
    if (prices.some((p) => !p.currencyId || !Number.isInteger(p.amount) || p.amount < 1)) {
      setError('Каждая цена — валюта и целое число ≥ 1');
      return;
    }
    if (new Set(prices.map((p) => p.currencyId)).size !== prices.length) {
      setError('Валюта повторяется — выберите разные');
      return;
    }
    // Лимиты/время/скидка (Фаза 7). Дни → срок от «сейчас»; пустые дни при правке = не менять.
    const stockLimit = stock.trim() === '' ? null : Math.max(1, parseInt(stock, 10) || 1);
    let availableUntil: string | null | undefined;
    if (!limited) availableUntil = null;
    else {
      const d = parseInt(limitedDays, 10);
      if (d > 0) availableUntil = daysFromNow(d);
      else if (init?.availableUntil) availableUntil = undefined; // оставить как было
      else { setError('Укажите срок «ограниченного времени» в днях'); return; }
    }
    const pct = parseInt(discountPct, 10);
    let discountPercent: number | null | undefined;
    let discountUntil: string | null | undefined;
    if (!(pct > 0)) { discountPercent = null; discountUntil = null; }
    else {
      discountPercent = Math.min(99, pct);
      const dd = parseInt(discountDays, 10);
      if (dd > 0) discountUntil = daysFromNow(dd);
      else if (init?.discountUntil) discountUntil = undefined; // оставить как было
      else { setError('Укажите срок скидки в днях'); return; }
    }
    setBusy(true);
    setError(null);
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
      title={init ? 'Изменить товар' : 'Новый товар'}
      size="md"
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

        <div style={{ display: 'grid', gridTemplateColumns: '5rem minmax(0, 1fr)', gap: 'var(--spacing-3)' }}>
          <Input
            label="Значок"
            value={icon}
            onChange={(e) => setIcon(e.target.value)}
            maxLength={8}
            style={{ textAlign: 'center', fontSize: '1.15rem' }}
          />
          <Input label="Название" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Что продаёте?" autoFocus />
        </div>

        <Textarea
          label="Описание"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Необязательно"
          style={{ minHeight: 64 }}
        />

        {/* Галерея фото (движок файлов; только при правке — у нового лота ещё нет id) */}
        {init ? (
          <ListingPhotosSection listingId={init.id} onError={setError} />
        ) : (
          <Alert tone="neutral" icon="image">
            Фото добавляются после создания товара — откройте его через «Изменить».
          </Alert>
        )}

        <Select
          label="Тип"
          value={itemType}
          onChange={(v) => setItemType(v as Listing['itemType'])}
          options={[
            { value: 'material', label: 'Материальный', icon: 'gift' },
            { value: 'nonmaterial', label: 'Нематериальный', icon: 'spark' },
          ]}
        />

        <PriceLinesEditor currencies={currencies} lines={lines} onChange={setLines} />

        <Divider style={{ margin: 0 }} />

        {/* Лимиты / время / FOMO-скидка (Фаза 7) */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--spacing-3)', alignItems: 'end' }}>
          <Input
            label="Запас, штук"
            hint="Пусто — без лимита"
            type="number"
            min={1}
            value={stock}
            onChange={(e) => setStock(e.target.value)}
            placeholder="∞"
          />
          {limited && (
            <Input
              label="Ограничение, дней"
              type="number"
              min={1}
              value={limitedDays}
              onChange={(e) => setLimitedDays(e.target.value)}
              placeholder={init?.availableUntil ? 'без изменений' : '7'}
            />
          )}
          <Input
            label="FOMO-скидка, %"
            type="number"
            min={0}
            max={99}
            value={discountPct}
            onChange={(e) => setDiscountPct(e.target.value)}
            placeholder="0"
          />
          {parseInt(discountPct, 10) > 0 && (
            <Input
              label="Скидка, дней"
              type="number"
              min={1}
              value={discountDays}
              onChange={(e) => setDiscountDays(e.target.value)}
              placeholder={init?.discountUntil ? 'без изменений' : '3'}
            />
          )}
        </div>

        <div className="ui-stack" style={{ gap: 'var(--spacing-3)' }}>
          <Checkbox checked={limited} onChange={setLimited} label="Ограниченное время" />
          <Checkbox checked={withTask} onChange={setWithTask} label="С задачей — исполнение оформится задачей в Задачнике" />
          {withTask && (
            <div style={{ width: 160 }}>
              <Input label="Дней на исполнение" type="number" min={1} value={taskDays} onChange={(e) => setTaskDays(e.target.value)} />
            </div>
          )}
          <Checkbox checked={crowdfunding} onChange={setCrowdfunding} label="Краудфандинг — скидываются несколько человек" />
        </div>
      </div>
    </Modal>
  );
}

// ============================================================
// Доступ к витрине
// ============================================================

export function SharePanel({
  showcase,
  onClose,
  onChanged,
}: {
  showcase: Showcase;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [shares, setShares] = useState(showcase.shares ?? []);
  const [error, setError] = useState<string | null>(null);
  const has = (type: 'user' | 'circle', id: string) => shares.some((s) => s.principalType === type && s.principalId === id);

  const toggle = async (type: 'user' | 'circle', id: string) => {
    try {
      const r = has(type, id)
        ? await api.delete(`/shop/showcases/${showcase.id}/shares/${type}/${id}`)
        : await api.post(`/shop/showcases/${showcase.id}/shares`, { principalType: type, principalId: id });
      setShares(r.data.data);
      onChanged();
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Доступ к «${showcase.name}»`}
      subtitle="Кому видна эта витрина — люди и Группы из вашего окружения"
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
// Сотрудники магазина
// ============================================================

export function StaffPanel({
  contacts,
  showcases,
  onClose,
}: {
  contacts: Contact[];
  showcases: Showcase[];
  onClose: () => void;
}) {
  const [staff, setStaff] = useState<ShopStaffDto[]>([]);
  const [userId, setUserId] = useState('');
  const [scope, setScope] = useState<'shop' | 'showcase'>('shop');
  const [showcaseId, setShowcaseId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    api.get('/shop/staff').then((r) => setStaff(r.data.data)).catch((e) => setError(apiErrorMessage(e)));
  };
  useEffect(load, []);

  const assign = async () => {
    if (!userId) { setError('Выберите человека'); return; }
    if (scope === 'showcase' && !showcaseId) { setError('Выберите витрину'); return; }
    setError(null);
    try {
      await api.post('/shop/staff', { userId, scope, ...(scope === 'showcase' ? { showcaseId } : {}) });
      setUserId('');
      load();
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  };
  const revoke = async (s: ShopStaffDto) => {
    try {
      await api.delete(`/shop/staff/${s.userId}?scope=${s.scope}${s.showcaseId ? `&showcaseId=${s.showcaseId}` : ''}`);
      load();
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Сотрудники магазина"
      subtitle="Сотрудник управляет товарами и заказами — как владелец"
      size="md"
      footer={<Button variant="ghost" onClick={onClose}>Готово</Button>}
    >
      <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        {error && <Alert tone="danger" onClose={() => setError(null)}>{error}</Alert>}

        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: 1, minWidth: 190 }}>
            <Field label="Человек">
              <EntitySelector
                types={['user']}
                multi={false}
                options={contacts.map((c) => ({
                  type: 'user',
                  id: c.them.id,
                  title: personName(c),
                  firstName: c.them.firstName,
                  lastName: c.them.lastName,
                  role: c.myRole,
                }))}
                value={userId ? [{ type: 'user', id: userId }] : []}
                onChange={(p) => setUserId(p[0]?.id ?? '')}
                placeholder="Из окружения…"
              />
            </Field>
          </div>
          <Select
            label="Область"
            value={scope}
            onChange={(v) => setScope(v as 'shop' | 'showcase')}
            width={180}
            options={[
              { value: 'shop', label: 'Весь магазин', icon: 'shop' },
              { value: 'showcase', label: 'Одна витрина', icon: 'folder' },
            ]}
          />
          {scope === 'showcase' && (
            <Select
              label="Витрина"
              value={showcaseId}
              onChange={setShowcaseId}
              width={190}
              placeholder="Выберите…"
              options={showcases.map((s) => ({ value: s.id, label: s.name, emoji: s.icon }))}
            />
          )}
          <Button variant="primary" tone="success" icon="userAdd" onClick={assign}>Назначить</Button>
        </div>

        <Divider style={{ margin: 0 }} />

        {staff.length === 0 ? (
          <EmptyState icon="people" title="Сотрудников нет" description="Назначьте того, кто будет вести витрины вместе с вами." />
        ) : (
          <div className="ui-stack" style={{ gap: '0.375rem' }}>
            {staff.map((s, i) => (
              <div
                key={i}
                style={{
                  display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)',
                  padding: '0.5rem 0.75rem', border: '1px solid var(--divider)', borderRadius: 'var(--radius-md)',
                }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  <PersonChip size="S" userId={s.userId} firstName={s.name} />
                </span>
                <Chip size="sm" tone="neutral" icon={s.scope === 'shop' ? 'shop' : 'folder'}>
                  {s.scope === 'shop' ? 'весь магазин' : s.showcaseName ?? 'витрина'}
                </Chip>
                <Button variant="ghost" size="sm" tone="danger" icon="close" onClick={() => revoke(s)}>Снять</Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
