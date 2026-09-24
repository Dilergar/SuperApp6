'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Chip, Glyph, GlyphField, Input, Toggle, useConfirm } from '@/components/ui';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api';
import { apiErrorCode, isOutcomeUnknown, toastApiError } from '@/lib/api-errors';
import { useIdempotencyKey } from '@/lib/useIdempotencyKey';
import { OutcomeUnknownAlert, SlowRequestNote } from '@/components/idempotency/OutcomeUnknownAlert';
import { formatWalletAmount } from '@/lib/wallet-format';
import {
  currencyBadgeKey, walletCardsKey, walletCurrencyKey, walletHistoryKey, walletHoldersKey, walletOverviewKey,
} from '@/lib/queries';
import {
  WALLET_LIMITS,
  isValidCardPan,
  isValidKzIban,
  normalizeCardPan,
  normalizeIban,
  type Currency,
  type WalletEntry,
  type CursorPage,
  type LedgerEntryDto,
  type CurrencyHolder,
  type UserPaymentCardDto,
} from '@superapp/shared';
import { toastError } from '@/lib/toast';
import { useTranslations } from 'next-intl';
import { useFormatters } from '@/lib/format';

function errMsg(e: unknown, fallback: string): string {
  const ax = e as { response?: { data?: { message?: string; error?: string } } };
  return ax?.response?.data?.message || ax?.response?.data?.error || fallback;
}
// Масштаб валюты приходит с проводом (WalletEntry.scale) — форматирует общий хелпер.
// Свой `fmt` про scale не знал: у личных валют он 0, поэтому мина была невидима.
const fmt = (n: number, scale = 0) => formatWalletAmount(n, scale);

/**
 * Profile → «Кошелёк». Manage your own issued currency (create / mint / rename once-per-3mo
 * / delete), see your multi-currency balances, transaction history and who holds your coins.
 */
export function WalletSection() {
  const t = useTranslations('profile');
  const common = useTranslations('common');
  const walletT = useTranslations('wallet');
  // Даты — форматтеры платформы; суммы — formatWalletAmount (он знает scale валюты).
  const dfmt = useFormatters();
  // Общий кэш React Query: повторный заход рисуется мгновенно, действия
  // обновляют только затронутые ключи (раньше каждый клик перезапрашивал всё).
  const qc = useQueryClient();
  const currencyQ = useQuery({
    queryKey: walletCurrencyKey,
    queryFn: () => apiGet<Currency | null>('/wallet/currency'),
    staleTime: 60_000,
  });
  const walletQ = useQuery({
    queryKey: walletOverviewKey,
    queryFn: async () => await apiGet<WalletEntry[]>('/wallet'),
    staleTime: 60_000,
  });
  const historyQ = useQuery({
    queryKey: walletHistoryKey,
    queryFn: async () => (await apiGet<CursorPage<LedgerEntryDto>>('/wallet/history')).items,
    staleTime: 60_000,
  });
  const holdersQ = useQuery({
    queryKey: walletHoldersKey,
    queryFn: async () => await apiGet<CurrencyHolder[]>('/wallet/currency/holders'),
    enabled: !!currencyQ.data,
    staleTime: 60_000,
  });
  const currency = currencyQ.data ?? null;
  const wallet: WalletEntry[] = walletQ.data ?? [];
  const history: LedgerEntryDto[] = historyQ.data ?? [];
  const holders: CurrencyHolder[] = currency ? holdersQ.data ?? [] : [];
  const loading = currencyQ.isPending || walletQ.isPending || historyQ.isPending;
  const loadError = currencyQ.error ?? walletQ.error ?? historyQ.error;

  const [error, setError] = useState('');
  const [ok, setOk] = useState('');

  const [cName, setCName] = useState('');
  const [cIcon, setCIcon] = useState('🪙');
  const [mintAmt, setMintAmt] = useState('');
  const [editing, setEditing] = useState(false);
  const [eName, setEName] = useState('');
  const [eIcon, setEIcon] = useState('');
  const [confirmDel, setConfirmDel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [burnId, setBurnId] = useState<string | null>(null);
  const [burnAmt, setBurnAmt] = useState('');
  // Ключи НАМЕРЕНИЯ денежных форм: двойной клик и повтор после обрыва — одно дело,
  // а изменившаяся сумма — уже другое (ключ обновится сам).
  const mintKey = useIdempotencyKey([mintAmt]);
  const burnKey = useIdempotencyKey([burnId, burnAmt]);
  // Отказ «исход неизвестен» тостом не показывают: за этими кнопками деньги
  const [unknownOutcome, setUnknownOutcome] = useState<unknown>(null);

  const flash = (m: string) => {
    setOk(m);
    setError('');
    setTimeout(() => setOk(''), 2500);
  };

  const run = async (fn: () => Promise<void>, keys: ReadonlyArray<readonly unknown[]>, success?: string) => {
    setError('');
    setUnknownOutcome(null);
    setBusy(true);
    try {
      await fn();
      await Promise.all(keys.map((k) => qc.invalidateQueries({ queryKey: k })));
      if (success) flash(success);
    } catch (e) {
      // «Операция могла пройти» — это не ошибка формы, а повод сходить в историю
      if (isOutcomeUnknown(e)) setUnknownOutcome(e);
      // Прочие исходы движка повторов несут СВОЙ тон: «уже выполнено» — успех, а не
      // беда; «попытка ещё идёт» — спокойное сообщение. Красная строка формы соврала бы.
      else if (apiErrorCode(e)?.startsWith('idempotency.')) toastApiError(e);
      else setError(errMsg(e, common('state.error')));
    } finally {
      setBusy(false);
    }
  };

  const createCurrency = () => {
    if (!cName.trim()) return setError(t('wallet.nameRequired'));
    return run(async () => {
      await apiPost('/wallet/currency', { name: cName.trim(), icon: cIcon });
      setCName('');
    }, [walletCurrencyKey, walletOverviewKey, currencyBadgeKey], t('wallet.created'));
  };

  const mint = () => {
    const n = parseInt(mintAmt, 10);
    if (!Number.isInteger(n) || n <= 0) return setError(t('wallet.integerError'));
    return run(async () => {
      await apiPost('/wallet/currency/mint', { amount: n }, { idempotencyKey: mintKey.key });
      mintKey.reset();
      setMintAmt('');
    }, [walletOverviewKey, walletHistoryKey, walletHoldersKey, currencyBadgeKey], t('wallet.minted', { amount: fmt(n) }));
  };

  const saveEdit = () =>
    run(async () => {
      await apiPatch('/wallet/currency', { name: eName.trim(), icon: eIcon });
      setEditing(false);
    }, [walletCurrencyKey, walletHistoryKey, currencyBadgeKey], t('settings.saved'));

  const del = () =>
    run(async () => {
      await apiDelete('/wallet/currency');
      setConfirmDel(false);
    }, [walletCurrencyKey, walletOverviewKey, walletHistoryKey, walletHoldersKey, currencyBadgeKey], t('wallet.deleted'));

  const burnCoins = (currencyId: string) => {
    const n = parseInt(burnAmt, 10);
    if (!Number.isInteger(n) || n <= 0) return setError(t('wallet.integerError'));
    return run(async () => {
      await apiPost('/wallet/burn', { currencyId, amount: n }, { idempotencyKey: burnKey.key });
      burnKey.reset();
      setBurnId(null);
      setBurnAmt('');
    }, [walletOverviewKey, walletHistoryKey], t('wallet.burned'));
  };

  if (loading) return <p className="label-md">{t('wallet.loading')}</p>;
  if (loadError && wallet.length === 0) {
    return <p style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>{errMsg(loadError, t('wallet.loadFailed'))}</p>;
  }

  const own = wallet.find((w) => w.isOwn);
  const foreign = wallet.filter((w) => !w.isOwn);
  const renameLocked = !!currency?.renameAvailableAt && new Date(currency.renameAvailableAt).getTime() > Date.now();

  return (
    <div>
      <h2 className="title-lg" style={{ marginBottom: 'var(--spacing-2)' }}>{t('wallet.title')}</h2>
      <p className="label-sm" style={{ marginBottom: 'var(--spacing-6)', opacity: 0.7 }}>
        {t('wallet.subtitle')}
      </p>

      {unknownOutcome != null && (
        <div style={{ marginBottom: 'var(--spacing-4)' }}>
          <OutcomeUnknownAlert error={unknownOutcome} onDismiss={() => setUnknownOutcome(null)} />
        </div>
      )}
      {error && <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginBottom: 'var(--spacing-4)' }}>{error}</p>}
      {ok && <p style={{ color: 'var(--secondary)', fontSize: '0.85rem', marginBottom: 'var(--spacing-4)' }}>{ok}</p>}

      {/* ===== Мои карты (реквизит для выплат) ===== */}
      <PaymentCardsBlock />

      {/* ===== Моя валюта ===== */}
      <h3 className="title-md" style={{ marginBottom: 'var(--spacing-3)' }}>{t('wallet.mine')}</h3>
      {!currency ? (
        <div className="card" style={{ padding: 'var(--spacing-6)', maxWidth: '460px', marginBottom: 'var(--spacing-8)' }}>
          <p className="label-md" style={{ marginBottom: 'var(--spacing-4)', lineHeight: 1.5 }}>
            {t('wallet.noneText')}
          </p>
          <div style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <GlyphField label={t('wallet.icon')} value={cIcon} onChange={(v) => setCIcon(v ?? '')} suggest={cName} />
            <Input
              label={t('wallet.name')}
              value={cName}
              onChange={(e) => setCName(e.target.value)}
              maxLength={WALLET_LIMITS.maxCurrencyNameLength}
              placeholder={t('wallet.namePlaceholder')}
              wrapClassName="wallet-name-field"
            />
            <button className="btn-success" disabled={busy} onClick={createCurrency} style={{ fontSize: '0.85rem' }}>{t('wallet.create')}</button>
          </div>
        </div>
      ) : (
        <div className="card-elevated" style={{ padding: 'var(--spacing-6)', maxWidth: '460px', marginBottom: 'var(--spacing-8)' }}>
          {!editing ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', marginBottom: 'var(--spacing-4)' }}>
                <Glyph value={currency.icon} size={35} />
                <div style={{ flex: 1 }}>
                  <div className="title-md">{currency.name}</div>
                  <div className="label-sm" style={{ opacity: 0.7 }}>
                    {t('wallet.balance')} <b style={{ color: 'var(--primary)' }}>{fmt(own?.balance ?? 0, own?.scale)}</b>
                    {!!own && own.held > 0 && t('wallet.heldAvailable', { held: fmt(own.held, own.scale), available: fmt(own.available, own.scale) })}
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'flex-end', marginBottom: 'var(--spacing-4)' }}>
                <Input
                  label={t('wallet.mintLabel')}
                  type="number"
                  min={1}
                  value={mintAmt}
                  onChange={(e) => setMintAmt(e.target.value)}
                  placeholder={t('wallet.mintPlaceholder')}
                  wrapClassName="wallet-name-field"
                />
                <button className="btn-success" disabled={busy} onClick={mint} style={{ fontSize: '0.85rem' }}>{t('wallet.mint')}</button>
                <SlowRequestNote pending={busy} />
              </div>
              <p className="label-sm" style={{ fontSize: '0.7rem', opacity: 0.55, marginBottom: 'var(--spacing-4)' }}>
                {t('wallet.mintLimit')}
              </p>

              <div style={{ display: 'flex', gap: 'var(--spacing-3)' }}>
                <button
                  className="btn-secondary"
                  disabled={busy || renameLocked}
                  onClick={() => { setEName(currency.name); setEIcon(currency.icon); setEditing(true); }}
                  style={{ fontSize: '0.8rem', opacity: renameLocked ? 0.5 : 1, cursor: renameLocked ? 'not-allowed' : 'pointer' }}
                  title={renameLocked ? t('wallet.renameLocked', { date: dfmt.date(currency.renameAvailableAt!) }) : undefined}
                >
                  {t('wallet.edit')}
                </button>
                {!confirmDel ? (
                  <button onClick={() => setConfirmDel(true)} disabled={busy} style={{ fontSize: '0.8rem', fontWeight: 500, color: 'var(--danger)', background: 'none', border: 'none', cursor: 'pointer' }}>
                    {t('wallet.delete')}
                  </button>
                ) : (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)' }}>
                    <span className="label-sm" style={{ color: 'var(--danger)' }}>{t('wallet.deleteConfirm')}</span>
                    <button onClick={del} disabled={busy} style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--on-primary)', background: 'var(--danger)', border: 'none', borderRadius: '8px', padding: '0.25rem 0.7rem', cursor: 'pointer' }}>{common('actions.yes')}</button>
                    <button onClick={() => setConfirmDel(false)} disabled={busy} className="btn-ghost-inline" style={{ fontSize: '0.8rem', padding: '0.25rem 0.7rem' }}>{common('actions.no')}</button>
                  </span>
                )}
              </div>
              {renameLocked && (
                <p className="label-sm" style={{ fontSize: '0.7rem', opacity: 0.55, marginTop: 'var(--spacing-2)' }}>
                  {t('wallet.renameNext', { date: dfmt.date(currency.renameAvailableAt!) })}
                </p>
              )}
            </>
          ) : (
            <div style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <GlyphField label={t('wallet.icon')} value={eIcon} onChange={(v) => setEIcon(v ?? '')} suggest={eName} />
              <Input
                label={t('wallet.name')}
                value={eName}
                onChange={(e) => setEName(e.target.value)}
                maxLength={WALLET_LIMITS.maxCurrencyNameLength}
                wrapClassName="wallet-name-field"
              />
              <button className="btn-success" disabled={busy} onClick={saveEdit} style={{ fontSize: '0.85rem' }}>{common('actions.save')}</button>
              <button className="btn-ghost-inline" disabled={busy} onClick={() => setEditing(false)} style={{ fontSize: '0.85rem' }}>{common('actions.cancel')}</button>
            </div>
          )}
        </div>
      )}

      {/* ===== Заработанные валюты ===== */}
      <h3 className="title-md" style={{ marginBottom: 'var(--spacing-3)' }}>{t('wallet.earned')}</h3>
      {foreign.length === 0 ? (
        <p className="label-md" style={{ marginBottom: 'var(--spacing-8)', opacity: 0.7 }}>{t('wallet.earnedEmpty')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)', maxWidth: '460px', marginBottom: 'var(--spacing-8)' }}>
          {foreign.map((w) => (
            <div key={w.currencyId} className="card" style={{ padding: 'var(--spacing-3) var(--spacing-4)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)' }}>
                <Glyph value={w.icon} size={24} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500, fontSize: '0.9rem' }}>{w.name}</div>
                  <div className="label-sm" style={{ opacity: 0.6, fontSize: '0.72rem' }}>{t('wallet.from', { name: w.issuerName })}</div>
                </div>
                <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: w.balance < 0 ? 'var(--danger)' : 'var(--on-surface)' }}>{fmt(w.balance, w.scale)}</div>
                {w.balance > 0 && (
                  <button
                    onClick={() => { setBurnId(burnId === w.currencyId ? null : w.currencyId); setBurnAmt(''); }}
                    title={t('wallet.burnTitle')}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1rem', opacity: 0.6 }}
                  >
                    🔥
                  </button>
                )}
              </div>
              {burnId === w.currencyId && (
                <div style={{ marginTop: 'var(--spacing-2)', display: 'flex', gap: 'var(--spacing-2)', alignItems: 'center' }}>
                  <Input
                    aria-label={t('wallet.burnAria', { name: w.name })}
                    type="number"
                    min={1}
                    value={burnAmt}
                    onChange={(e) => setBurnAmt(e.target.value)}
                    placeholder={t('wallet.burnPlaceholder')}
                    wrapClassName="wallet-name-field"
                    style={{ padding: '0.3rem 0.6rem', fontSize: '0.8rem' }}
                  />
                  <button onClick={() => burnCoins(w.currencyId)} disabled={busy} style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--on-primary)', background: 'var(--danger)', border: 'none', borderRadius: '8px', padding: '0.3rem 0.7rem', cursor: 'pointer' }}>{t('wallet.burn')}</button>
                  <button onClick={() => setBurnId(null)} className="btn-ghost-inline" style={{ fontSize: '0.78rem', padding: '0.3rem 0.7rem' }}>{common('actions.cancel')}</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ===== Держатели моей валюты ===== */}
      {currency && (
        <>
          <h3 className="title-md" style={{ marginBottom: 'var(--spacing-3)' }}>{t('wallet.holders')}</h3>
          {holders.length === 0 ? (
            <p className="label-md" style={{ marginBottom: 'var(--spacing-8)', opacity: 0.7 }}>{t('wallet.holdersEmpty')}</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)', maxWidth: '460px', marginBottom: 'var(--spacing-8)' }}>
              {holders.map((h) => (
                <div key={h.userId} className="card" style={{ padding: 'var(--spacing-2) var(--spacing-4)', display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)' }}>
                  <span style={{ flex: 1, fontSize: '0.88rem' }}>{h.name}</span>
                  <span style={{ fontFamily: 'var(--font-display)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>{fmt(h.balance, currency.scale)} <Glyph value={currency.icon} size={14} /></span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ===== История ===== */}
      <h3 className="title-md" style={{ marginBottom: 'var(--spacing-3)' }}>{t('wallet.history')}</h3>
      {history.length === 0 ? (
        <p className="label-md" style={{ opacity: 0.7 }}>{t('wallet.historyEmpty')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-1)', maxWidth: '460px' }}>
          {history.map((h) => (
            <div key={h.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', padding: 'var(--spacing-2) 0', borderBottom: '1px dashed rgba(0, 0, 0, 0.12)' }}>
              <div style={{ flex: 1 }}>
                {/* Вид записи леджера: слово собирается по ЗНАЧЕНИЮ, словаря слов в коде нет. */}
                <div style={{ fontSize: '0.85rem', fontWeight: 500 }}>{walletT(`entryType.${h.entryType}`)}</div>
                <div className="label-sm" style={{ fontSize: '0.7rem', opacity: 0.55 }}>{dfmt.dateTime(h.createdAt)}</div>
              </div>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: h.amount < 0 ? 'var(--danger)' : 'var(--secondary)' }}>
                {h.amount > 0 ? '+' : ''}{fmt(h.amount, h.scale)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// «Мои карты» — реквизит для выплат (зарплата, возвраты). БЕЗ CVV:
// платежи через карту платформа не проводит, это данные «куда переводить».
// Основную карту видят управляющие ваших организаций (для выплат).
// ============================================================

function PaymentCardsBlock() {
  const t = useTranslations('profile');
  const common = useTranslations('common');
  const qc = useQueryClient();
  const [confirm, confirmUI] = useConfirm();
  const [adding, setAdding] = useState(false);
  const [pan, setPan] = useState('');
  const [iban, setIban] = useState('');
  const [holder, setHolder] = useState('');
  const [exp, setExp] = useState(''); // ММ/ГГ одной строкой — как на самой карте
  const [makePrimary, setMakePrimary] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);

  const cardsQ = useQuery({
    queryKey: walletCardsKey,
    queryFn: async () => await apiGet<UserPaymentCardDto[]>('/wallet/cards'),
    staleTime: 60_000,
  });
  const cards = cardsQ.data ?? [];
  const invalidate = () => qc.invalidateQueries({ queryKey: walletCardsKey });

  const panNorm = normalizeCardPan(pan);
  const ibanNorm = normalizeIban(iban);
  const expMatch = /^(\d{2})\s*\/\s*(\d{2})$/.exec(exp.trim());
  const formOk =
    isValidCardPan(panNorm) &&
    (!ibanNorm || isValidKzIban(ibanNorm)) &&
    holder.trim().length > 0 &&
    !!expMatch;

  const create = useMutation({
    mutationFn: async () => {
      await apiPost('/wallet/cards', {
        pan: panNorm,
        ...(ibanNorm ? { iban: ibanNorm } : {}),
        holderName: holder.trim(),
        expMonth: Number(expMatch![1]),
        expYear: 2000 + Number(expMatch![2]),
        ...(makePrimary ? { isPrimary: true } : {}),
      });
    },
    onSuccess: () => {
      setAdding(false);
      setPan(''); setIban(''); setHolder(''); setExp(''); setMakePrimary(false);
      void invalidate();
    },
    onError: (e) => toastError(errMsg(e, t('cards.addFailed'))),
  });

  const setPrimary = useMutation({
    mutationFn: (id: string) => apiPatch(`/wallet/cards/${id}`, { isPrimary: true }),
    onSuccess: () => void invalidate(),
    onError: (e) => toastError(errMsg(e, t('cards.genericError'))),
  });

  const remove = useMutation({
    mutationFn: (id: string) => apiDelete(`/wallet/cards/${id}`),
    onSuccess: () => void invalidate(),
    onError: (e) => toastError(errMsg(e, t('cards.genericError'))),
  });

  return (
    <div style={{ marginBottom: 'var(--spacing-8)' }}>
      <h3 className="title-md" style={{ marginBottom: 'var(--spacing-1)' }}>{t('cards.title')}</h3>
      <p className="label-sm" style={{ marginBottom: 'var(--spacing-3)', opacity: 0.7, maxWidth: '460px', lineHeight: 1.5 }}>
        {t('cards.subtitle')}
      </p>

      {cards.map((c) => (
        <div key={c.id} className="card" style={{ padding: 'var(--spacing-4)', maxWidth: '460px', marginBottom: 'var(--spacing-3)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, letterSpacing: '0.05em' }}>
              {c.panMasked}
            </span>
            {c.isPrimary && <Chip tone="success">{t('cards.primary')}</Chip>}
            <span style={{ flex: 1 }} />
            {/* Полного номера карты в продукте нет (PCI DSS 3.4.1) — «Показать» раскрывает только
                свой IBAN счёта карты */}
            {c.iban && (
              <Button size="sm" variant="ghost" onClick={() => setRevealed((r) => (r === c.id ? null : c.id))}>
                {revealed === c.id ? t('cards.hide') : t('cards.show')}
              </Button>
            )}
          </div>
          <div className="label-sm" style={{ marginTop: 'var(--spacing-2)', opacity: 0.75 }}>
            {c.holderName} · {t('cards.until')} {String(c.expMonth).padStart(2, '0')}/{String(c.expYear % 100).padStart(2, '0')}
            {c.iban && revealed === c.id && <> · {c.iban}</>}
          </div>
          <div style={{ display: 'flex', gap: 'var(--spacing-2)', marginTop: 'var(--spacing-2)' }}>
            {!c.isPrimary && (
              <Button size="sm" variant="ghost" loading={setPrimary.isPending} onClick={() => setPrimary.mutate(c.id)}>
                {t('cards.makePrimary')}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              tone="danger"
              onClick={() =>
                confirm(
                  {
                    title: t('cards.deleteTitle'),
                    message: t('cards.deleteText', { mask: c.panMasked }),
                    confirmLabel: common('actions.delete'),
                    danger: true,
                  },
                  () => remove.mutateAsync(c.id).then(() => undefined),
                )
              }
            >
              {common('actions.delete')}
            </Button>
          </div>
        </div>
      ))}

      {!adding ? (
        <Button variant="outline" size="sm" icon="add" onClick={() => setAdding(true)}>
          {t('cards.add')}
        </Button>
      ) : (
        <div className="card-elevated" style={{ padding: 'var(--spacing-5)', maxWidth: '460px', display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)' }}>
          <Input
            label={t('cards.pan')}
            inputMode="numeric"
            placeholder="0000 0000 0000 0000"
            value={pan}
            onChange={(e) => setPan(e.target.value.replace(/[^\d\s]/g, '').slice(0, 23))}
            error={panNorm && !isValidCardPan(panNorm) ? t('cards.panInvalid') : undefined}
          />
          <Input
            label={t('cards.iban')}
            placeholder="KZ00 0000 0000 0000 0000"
            value={iban}
            onChange={(e) => setIban(e.target.value)}
            error={ibanNorm && !isValidKzIban(ibanNorm) ? t('cards.ibanInvalid') : undefined}
            hint={t('cards.ibanHint')}
          />
          <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-3)' }}>
            <Input
              label={t('cards.holder')}
              value={holder}
              onChange={(e) => setHolder(e.target.value.toUpperCase())}
              placeholder="ASSEL NUROVA"
            />
            <Input
              label={t('cards.exp')}
              inputMode="numeric"
              placeholder="08/29"
              value={exp}
              onChange={(e) => {
                const digits = e.target.value.replace(/\D/g, '').slice(0, 4);
                setExp(digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits);
              }}
            />
          </div>
          <Toggle checked={makePrimary} onChange={setMakePrimary} label={t('cards.makePrimary')} />
          <div style={{ display: 'flex', gap: 'var(--spacing-3)' }}>
            <Button variant="primary" size="sm" loading={create.isPending} disabled={!formOk} onClick={() => create.mutate()}>
              {t('cards.save')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
              {common('actions.cancel')}
            </Button>
          </div>
        </div>
      )}
      {confirmUI}
    </div>
  );
}
