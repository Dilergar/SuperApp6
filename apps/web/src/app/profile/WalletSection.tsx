'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Chip, Glyph, GlyphField, Input, Toggle, useConfirm } from '@/components/ui';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api';
import { formatWalletAmount } from '@/lib/wallet-format';
import {
  currencyBadgeKey, walletCardsKey, walletCurrencyKey, walletHistoryKey, walletHoldersKey, walletOverviewKey,
} from '@/lib/queries';
import {
  WALLET_LIMITS,
  LEDGER_ENTRY_LABELS,
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

function errMsg(e: unknown, fallback = 'Ошибка'): string {
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

  const flash = (m: string) => {
    setOk(m);
    setError('');
    setTimeout(() => setOk(''), 2500);
  };

  const run = async (fn: () => Promise<void>, keys: ReadonlyArray<readonly unknown[]>, success?: string) => {
    setError('');
    setBusy(true);
    try {
      await fn();
      await Promise.all(keys.map((k) => qc.invalidateQueries({ queryKey: k })));
      if (success) flash(success);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const createCurrency = () => {
    if (!cName.trim()) return setError('Введите название');
    return run(async () => {
      await apiPost('/wallet/currency', { name: cName.trim(), icon: cIcon });
      setCName('');
    }, [walletCurrencyKey, walletOverviewKey, currencyBadgeKey], 'Валюта создана');
  };

  const mint = () => {
    const n = parseInt(mintAmt, 10);
    if (!Number.isInteger(n) || n <= 0) return setError('Введите целое число больше 0');
    return run(async () => {
      await apiPost('/wallet/currency/mint', { amount: n });
      setMintAmt('');
    }, [walletOverviewKey, walletHistoryKey, walletHoldersKey, currencyBadgeKey], `Выпущено ${fmt(n)}`);
  };

  const saveEdit = () =>
    run(async () => {
      await apiPatch('/wallet/currency', { name: eName.trim(), icon: eIcon });
      setEditing(false);
    }, [walletCurrencyKey, walletHistoryKey, currencyBadgeKey], 'Сохранено');

  const del = () =>
    run(async () => {
      await apiDelete('/wallet/currency');
      setConfirmDel(false);
    }, [walletCurrencyKey, walletOverviewKey, walletHistoryKey, walletHoldersKey, currencyBadgeKey], 'Валюта удалена');

  const burnCoins = (currencyId: string) => {
    const n = parseInt(burnAmt, 10);
    if (!Number.isInteger(n) || n <= 0) return setError('Введите целое число больше 0');
    return run(async () => {
      await apiPost('/wallet/burn', { currencyId, amount: n });
      setBurnId(null);
      setBurnAmt('');
    }, [walletOverviewKey, walletHistoryKey], 'Сожжено');
  };

  if (loading) return <p className="label-md">Загрузка кошелька…</p>;
  if (loadError && wallet.length === 0) {
    return <p style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>{errMsg(loadError, 'Не удалось загрузить кошелёк')}</p>;
  }

  const own = wallet.find((w) => w.isOwn);
  const foreign = wallet.filter((w) => !w.isOwn);
  const renameLocked = !!currency?.renameAvailableAt && new Date(currency.renameAvailableAt).getTime() > Date.now();

  return (
    <div>
      <h2 className="title-lg" style={{ marginBottom: 'var(--spacing-2)' }}>Кошелёк</h2>
      <p className="label-sm" style={{ marginBottom: 'var(--spacing-6)', opacity: 0.7 }}>
        Своя валюта, которой вы награждаете людей за задачи, и монеты, заработанные у других.
      </p>

      {error && <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginBottom: 'var(--spacing-4)' }}>{error}</p>}
      {ok && <p style={{ color: 'var(--secondary)', fontSize: '0.85rem', marginBottom: 'var(--spacing-4)' }}>{ok}</p>}

      {/* ===== Мои карты (реквизит для выплат) ===== */}
      <PaymentCardsBlock />

      {/* ===== Моя валюта ===== */}
      <h3 className="title-md" style={{ marginBottom: 'var(--spacing-3)' }}>Моя валюта</h3>
      {!currency ? (
        <div className="card" style={{ padding: 'var(--spacing-6)', maxWidth: '460px', marginBottom: 'var(--spacing-8)' }}>
          <p className="label-md" style={{ marginBottom: 'var(--spacing-4)', lineHeight: 1.5 }}>
            У вас ещё нет своей валюты. Придумайте название и иконку — ею вы будете награждать людей из окружения за задачи.
          </p>
          <div style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <GlyphField label="Иконка" value={cIcon} onChange={(v) => setCIcon(v ?? '')} suggest={cName} />
            <Input
              label="Название"
              value={cName}
              onChange={(e) => setCName(e.target.value)}
              maxLength={WALLET_LIMITS.maxCurrencyNameLength}
              placeholder="Напр. Монеты Мамы"
              wrapClassName="wallet-name-field"
            />
            <button className="btn-success" disabled={busy} onClick={createCurrency} style={{ fontSize: '0.85rem' }}>Создать</button>
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
                    Баланс: <b style={{ color: 'var(--primary)' }}>{fmt(own?.balance ?? 0, own?.scale)}</b>
                    {!!own && own.held > 0 && <> · заморожено {fmt(own.held, own.scale)} · доступно {fmt(own.available, own.scale)}</>}
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'flex-end', marginBottom: 'var(--spacing-4)' }}>
                <Input
                  label="Выпустить себе"
                  type="number"
                  min={1}
                  value={mintAmt}
                  onChange={(e) => setMintAmt(e.target.value)}
                  placeholder="Сколько монет"
                  wrapClassName="wallet-name-field"
                />
                <button className="btn-success" disabled={busy} onClick={mint} style={{ fontSize: '0.85rem' }}>Выпустить</button>
              </div>
              <p className="label-sm" style={{ fontSize: '0.7rem', opacity: 0.55, marginBottom: 'var(--spacing-4)' }}>
                Лимит эмиссии — 10 000 000 монет «на руках» (баланс + заморожено).
              </p>

              <div style={{ display: 'flex', gap: 'var(--spacing-3)' }}>
                <button
                  className="btn-secondary"
                  disabled={busy || renameLocked}
                  onClick={() => { setEName(currency.name); setEIcon(currency.icon); setEditing(true); }}
                  style={{ fontSize: '0.8rem', opacity: renameLocked ? 0.5 : 1, cursor: renameLocked ? 'not-allowed' : 'pointer' }}
                  title={renameLocked ? `Менять можно раз в 3 месяца — после ${new Date(currency.renameAvailableAt!).toLocaleDateString('ru-RU')}` : undefined}
                >
                  Изменить
                </button>
                {!confirmDel ? (
                  <button onClick={() => setConfirmDel(true)} disabled={busy} style={{ fontSize: '0.8rem', fontWeight: 500, color: 'var(--danger)', background: 'none', border: 'none', cursor: 'pointer' }}>
                    Удалить валюту
                  </button>
                ) : (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)' }}>
                    <span className="label-sm" style={{ color: 'var(--danger)' }}>Сгорит у всех. Точно?</span>
                    <button onClick={del} disabled={busy} style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--on-primary)', background: 'var(--danger)', border: 'none', borderRadius: '8px', padding: '0.25rem 0.7rem', cursor: 'pointer' }}>Да</button>
                    <button onClick={() => setConfirmDel(false)} disabled={busy} className="btn-ghost-inline" style={{ fontSize: '0.8rem', padding: '0.25rem 0.7rem' }}>Нет</button>
                  </span>
                )}
              </div>
              {renameLocked && (
                <p className="label-sm" style={{ fontSize: '0.7rem', opacity: 0.55, marginTop: 'var(--spacing-2)' }}>
                  Следующее изменение названия/иконки — после {new Date(currency.renameAvailableAt!).toLocaleDateString('ru-RU')}.
                </p>
              )}
            </>
          ) : (
            <div style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <GlyphField label="Иконка" value={eIcon} onChange={(v) => setEIcon(v ?? '')} suggest={eName} />
              <Input
                label="Название"
                value={eName}
                onChange={(e) => setEName(e.target.value)}
                maxLength={WALLET_LIMITS.maxCurrencyNameLength}
                wrapClassName="wallet-name-field"
              />
              <button className="btn-success" disabled={busy} onClick={saveEdit} style={{ fontSize: '0.85rem' }}>Сохранить</button>
              <button className="btn-ghost-inline" disabled={busy} onClick={() => setEditing(false)} style={{ fontSize: '0.85rem' }}>Отмена</button>
            </div>
          )}
        </div>
      )}

      {/* ===== Заработанные валюты ===== */}
      <h3 className="title-md" style={{ marginBottom: 'var(--spacing-3)' }}>Заработанные валюты</h3>
      {foreign.length === 0 ? (
        <p className="label-md" style={{ marginBottom: 'var(--spacing-8)', opacity: 0.7 }}>Вы ещё не заработали чужих валют.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)', maxWidth: '460px', marginBottom: 'var(--spacing-8)' }}>
          {foreign.map((w) => (
            <div key={w.currencyId} className="card" style={{ padding: 'var(--spacing-3) var(--spacing-4)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)' }}>
                <Glyph value={w.icon} size={24} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500, fontSize: '0.9rem' }}>{w.name}</div>
                  <div className="label-sm" style={{ opacity: 0.6, fontSize: '0.72rem' }}>от {w.issuerName}</div>
                </div>
                <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: w.balance < 0 ? 'var(--danger)' : 'var(--on-surface)' }}>{fmt(w.balance, w.scale)}</div>
                {w.balance > 0 && (
                  <button
                    onClick={() => { setBurnId(burnId === w.currencyId ? null : w.currencyId); setBurnAmt(''); }}
                    title="Сжечь монеты"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1rem', opacity: 0.6 }}
                  >
                    🔥
                  </button>
                )}
              </div>
              {burnId === w.currencyId && (
                <div style={{ marginTop: 'var(--spacing-2)', display: 'flex', gap: 'var(--spacing-2)', alignItems: 'center' }}>
                  <Input
                    aria-label={`Сколько монет «${w.name}» сжечь`}
                    type="number"
                    min={1}
                    value={burnAmt}
                    onChange={(e) => setBurnAmt(e.target.value)}
                    placeholder="Сколько сжечь"
                    wrapClassName="wallet-name-field"
                    style={{ padding: '0.3rem 0.6rem', fontSize: '0.8rem' }}
                  />
                  <button onClick={() => burnCoins(w.currencyId)} disabled={busy} style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--on-primary)', background: 'var(--danger)', border: 'none', borderRadius: '8px', padding: '0.3rem 0.7rem', cursor: 'pointer' }}>Сжечь</button>
                  <button onClick={() => setBurnId(null)} className="btn-ghost-inline" style={{ fontSize: '0.78rem', padding: '0.3rem 0.7rem' }}>Отмена</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ===== Держатели моей валюты ===== */}
      {currency && (
        <>
          <h3 className="title-md" style={{ marginBottom: 'var(--spacing-3)' }}>Держатели моей валюты</h3>
          {holders.length === 0 ? (
            <p className="label-md" style={{ marginBottom: 'var(--spacing-8)', opacity: 0.7 }}>Пока никто не держит вашу валюту.</p>
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
      <h3 className="title-md" style={{ marginBottom: 'var(--spacing-3)' }}>История транзакций</h3>
      {history.length === 0 ? (
        <p className="label-md" style={{ opacity: 0.7 }}>Пока нет операций.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-1)', maxWidth: '460px' }}>
          {history.map((h) => (
            <div key={h.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', padding: 'var(--spacing-2) 0', borderBottom: '1px dashed rgba(0, 0, 0, 0.12)' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 500 }}>{LEDGER_ENTRY_LABELS[h.entryType] ?? h.entryType}</div>
                <div className="label-sm" style={{ fontSize: '0.7rem', opacity: 0.55 }}>{new Date(h.createdAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
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
    onError: (e) => toastError(errMsg(e, 'Не удалось добавить карту')),
  });

  const setPrimary = useMutation({
    mutationFn: (id: string) => apiPatch(`/wallet/cards/${id}`, { isPrimary: true }),
    onSuccess: () => void invalidate(),
    onError: (e) => toastError(errMsg(e)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => apiDelete(`/wallet/cards/${id}`),
    onSuccess: () => void invalidate(),
    onError: (e) => toastError(errMsg(e)),
  });

  return (
    <div style={{ marginBottom: 'var(--spacing-8)' }}>
      <h3 className="title-md" style={{ marginBottom: 'var(--spacing-1)' }}>Мои карты</h3>
      <p className="label-sm" style={{ marginBottom: 'var(--spacing-3)', opacity: 0.7, maxWidth: '460px', lineHeight: 1.5 }}>
        Реквизиты для выплат — зарплаты и возвратов. CVV не запрашивается и не хранится:
        платежи через карту не проводятся. Основную карту видят управляющие организаций,
        где вы работаете.
      </p>

      {cards.map((c) => (
        <div key={c.id} className="card" style={{ padding: 'var(--spacing-4)', maxWidth: '460px', marginBottom: 'var(--spacing-3)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, letterSpacing: '0.05em' }}>
              {revealed === c.id ? c.pan.replace(/(\d{4})(?=\d)/g, '$1 ') : c.panMasked}
            </span>
            {c.isPrimary && <Chip tone="success">Основная</Chip>}
            <span style={{ flex: 1 }} />
            <Button size="sm" variant="ghost" onClick={() => setRevealed((r) => (r === c.id ? null : c.id))}>
              {revealed === c.id ? 'Скрыть' : 'Показать'}
            </Button>
          </div>
          <div className="label-sm" style={{ marginTop: 'var(--spacing-2)', opacity: 0.75 }}>
            {c.holderName} · до {String(c.expMonth).padStart(2, '0')}/{String(c.expYear % 100).padStart(2, '0')}
            {c.iban && revealed === c.id && <> · {c.iban}</>}
          </div>
          <div style={{ display: 'flex', gap: 'var(--spacing-2)', marginTop: 'var(--spacing-2)' }}>
            {!c.isPrimary && (
              <Button size="sm" variant="ghost" loading={setPrimary.isPending} onClick={() => setPrimary.mutate(c.id)}>
                Сделать основной
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              tone="danger"
              onClick={() =>
                confirm(
                  {
                    title: 'Удалить карту?',
                    message: `Карта ${c.panMasked} будет удалена из реквизитов.`,
                    confirmLabel: 'Удалить',
                    danger: true,
                  },
                  () => remove.mutateAsync(c.id).then(() => undefined),
                )
              }
            >
              Удалить
            </Button>
          </div>
        </div>
      ))}

      {!adding ? (
        <Button variant="outline" size="sm" icon="add" onClick={() => setAdding(true)}>
          Добавить карту
        </Button>
      ) : (
        <div className="card-elevated" style={{ padding: 'var(--spacing-5)', maxWidth: '460px', display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)' }}>
          <Input
            label="Номер карты"
            inputMode="numeric"
            placeholder="0000 0000 0000 0000"
            value={pan}
            onChange={(e) => setPan(e.target.value.replace(/[^\d\s]/g, '').slice(0, 23))}
            error={panNorm && !isValidCardPan(panNorm) ? 'Проверьте номер — не сходится контрольная сумма' : undefined}
          />
          <Input
            label="IBAN карт-счёта (необязательно)"
            placeholder="KZ00 0000 0000 0000 0000"
            value={iban}
            onChange={(e) => setIban(e.target.value)}
            error={ibanNorm && !isValidKzIban(ibanNorm) ? 'Проверьте номер счёта (KZ + 18 знаков)' : undefined}
            hint="Kaspi показывает его в реквизитах карты — на счёт идут переводы из банков"
          />
          <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-3)' }}>
            <Input
              label="Имя как на карте"
              value={holder}
              onChange={(e) => setHolder(e.target.value.toUpperCase())}
              placeholder="ASSEL NUROVA"
            />
            <Input
              label="Срок (ММ/ГГ)"
              inputMode="numeric"
              placeholder="08/29"
              value={exp}
              onChange={(e) => {
                const digits = e.target.value.replace(/\D/g, '').slice(0, 4);
                setExp(digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits);
              }}
            />
          </div>
          <Toggle checked={makePrimary} onChange={setMakePrimary} label="Сделать основной" />
          <div style={{ display: 'flex', gap: 'var(--spacing-3)' }}>
            <Button variant="primary" size="sm" loading={create.isPending} disabled={!formOk} onClick={() => create.mutate()}>
              Сохранить карту
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
              Отмена
            </Button>
          </div>
        </div>
      )}
      {confirmUI}
    </div>
  );
}
