'use client';

import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api';
import {
  WALLET_LIMITS,
  LEDGER_ENTRY_LABELS,
  type Currency,
  type WalletEntry,
  type LedgerEntryDto,
  type CurrencyHolder,
} from '@superapp/shared';

function errMsg(e: unknown, fallback = 'Ошибка'): string {
  const ax = e as { response?: { data?: { message?: string; error?: string } } };
  return ax?.response?.data?.message || ax?.response?.data?.error || fallback;
}
const fmt = (n: number) => n.toLocaleString('ru-RU');

/**
 * Profile → «Кошелёк». Manage your own issued currency (create / mint / rename once-per-3mo
 * / delete), see your multi-currency balances, transaction history and who holds your coins.
 */
export function WalletSection() {
  const [currency, setCurrency] = useState<Currency | null>(null);
  const [wallet, setWallet] = useState<WalletEntry[]>([]);
  const [history, setHistory] = useState<LedgerEntryDto[]>([]);
  const [holders, setHolders] = useState<CurrencyHolder[]>([]);
  const [loading, setLoading] = useState(true);
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

  const load = useCallback(async () => {
    try {
      const [cur, w, h] = await Promise.all([
        api.get('/wallet/currency'),
        api.get('/wallet'),
        api.get('/wallet/history'),
      ]);
      const c: Currency | null = cur.data.data;
      setCurrency(c);
      setWallet(w.data.data);
      setHistory(h.data.data);
      if (c) {
        const ho = await api.get('/wallet/currency/holders');
        setHolders(ho.data.data);
      } else {
        setHolders([]);
      }
    } catch (e) {
      setError(errMsg(e, 'Не удалось загрузить кошелёк'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const flash = (m: string) => {
    setOk(m);
    setError('');
    setTimeout(() => setOk(''), 2500);
  };

  const run = async (fn: () => Promise<void>, success?: string) => {
    setError('');
    setBusy(true);
    try {
      await fn();
      await load();
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
      await api.post('/wallet/currency', { name: cName.trim(), icon: cIcon });
      setCName('');
    }, 'Валюта создана');
  };

  const mint = () => {
    const n = parseInt(mintAmt, 10);
    if (!Number.isInteger(n) || n <= 0) return setError('Введите целое число больше 0');
    return run(async () => {
      await api.post('/wallet/currency/mint', { amount: n });
      setMintAmt('');
    }, `Выпущено ${fmt(n)}`);
  };

  const saveEdit = () =>
    run(async () => {
      await api.patch('/wallet/currency', { name: eName.trim(), icon: eIcon });
      setEditing(false);
    }, 'Сохранено');

  const del = () =>
    run(async () => {
      await api.delete('/wallet/currency');
      setConfirmDel(false);
    }, 'Валюта удалена');

  const burnCoins = (currencyId: string) => {
    const n = parseInt(burnAmt, 10);
    if (!Number.isInteger(n) || n <= 0) return setError('Введите целое число больше 0');
    return run(async () => {
      await api.post('/wallet/burn', { currencyId, amount: n });
      setBurnId(null);
      setBurnAmt('');
    }, 'Сожжено');
  };

  if (loading) return <p className="label-md">Загрузка кошелька…</p>;

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

      {/* ===== Моя валюта ===== */}
      <h3 className="title-md" style={{ marginBottom: 'var(--spacing-3)' }}>Моя валюта</h3>
      {!currency ? (
        <div className="card" style={{ padding: 'var(--spacing-6)', maxWidth: '460px', marginBottom: 'var(--spacing-8)' }}>
          <p className="label-md" style={{ marginBottom: 'var(--spacing-4)', lineHeight: 1.5 }}>
            У вас ещё нет своей валюты. Придумайте название и иконку — ею вы будете награждать людей из окружения за задачи.
          </p>
          <div style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ width: '64px' }}>
              <label className="label-sm" style={{ display: 'block', marginBottom: 'var(--spacing-1)' }}>Иконка</label>
              <input value={cIcon} onChange={(e) => setCIcon(e.target.value)} maxLength={WALLET_LIMITS.maxIconLength} className="input-sketch" style={{ textAlign: 'center', fontSize: '1.3rem' }} />
            </div>
            <div style={{ flex: 1, minWidth: '180px' }}>
              <label className="label-sm" style={{ display: 'block', marginBottom: 'var(--spacing-1)' }}>Название</label>
              <input value={cName} onChange={(e) => setCName(e.target.value)} maxLength={WALLET_LIMITS.maxCurrencyNameLength} placeholder="Напр. Монеты Мамы" className="input-sketch" />
            </div>
            <button className="btn-primary" disabled={busy} onClick={createCurrency} style={{ fontSize: '0.85rem' }}>Создать</button>
          </div>
        </div>
      ) : (
        <div className="card-elevated" style={{ padding: 'var(--spacing-6)', maxWidth: '460px', marginBottom: 'var(--spacing-8)' }}>
          {!editing ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', marginBottom: 'var(--spacing-4)' }}>
                <span style={{ fontSize: '2.2rem', lineHeight: 1 }}>{currency.icon}</span>
                <div style={{ flex: 1 }}>
                  <div className="title-md">{currency.name}</div>
                  <div className="label-sm" style={{ opacity: 0.7 }}>
                    Баланс: <b style={{ color: 'var(--primary)' }}>{fmt(own?.balance ?? 0)}</b>
                    {!!own && own.held > 0 && <> · заморожено {fmt(own.held)} · доступно {fmt(own.available)}</>}
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'flex-end', marginBottom: 'var(--spacing-4)' }}>
                <div style={{ flex: 1 }}>
                  <label className="label-sm" style={{ display: 'block', marginBottom: 'var(--spacing-1)' }}>Выпустить себе</label>
                  <input type="number" min={1} value={mintAmt} onChange={(e) => setMintAmt(e.target.value)} placeholder="Сколько монет" className="input-sketch" />
                </div>
                <button className="btn-primary" disabled={busy} onClick={mint} style={{ fontSize: '0.85rem' }}>Выпустить</button>
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
                    <button onClick={del} disabled={busy} style={{ fontSize: '0.8rem', fontWeight: 600, color: '#fff', background: 'var(--danger)', border: 'none', borderRadius: '8px', padding: '0.25rem 0.7rem', cursor: 'pointer' }}>Да</button>
                    <button onClick={() => setConfirmDel(false)} disabled={busy} className="btn-secondary" style={{ fontSize: '0.8rem', padding: '0.25rem 0.7rem' }}>Нет</button>
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
              <div style={{ width: '64px' }}>
                <label className="label-sm" style={{ display: 'block', marginBottom: 'var(--spacing-1)' }}>Иконка</label>
                <input value={eIcon} onChange={(e) => setEIcon(e.target.value)} maxLength={WALLET_LIMITS.maxIconLength} className="input-sketch" style={{ textAlign: 'center', fontSize: '1.3rem' }} />
              </div>
              <div style={{ flex: 1, minWidth: '160px' }}>
                <label className="label-sm" style={{ display: 'block', marginBottom: 'var(--spacing-1)' }}>Название</label>
                <input value={eName} onChange={(e) => setEName(e.target.value)} maxLength={WALLET_LIMITS.maxCurrencyNameLength} className="input-sketch" />
              </div>
              <button className="btn-primary" disabled={busy} onClick={saveEdit} style={{ fontSize: '0.85rem' }}>Сохранить</button>
              <button className="btn-secondary" disabled={busy} onClick={() => setEditing(false)} style={{ fontSize: '0.85rem' }}>Отмена</button>
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
                <span style={{ fontSize: '1.5rem', lineHeight: 1 }}>{w.icon}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500, fontSize: '0.9rem' }}>{w.name}</div>
                  <div className="label-sm" style={{ opacity: 0.6, fontSize: '0.72rem' }}>от {w.issuerName}</div>
                </div>
                <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: w.balance < 0 ? 'var(--danger)' : 'var(--on-surface)' }}>{fmt(w.balance)}</div>
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
                  <input type="number" min={1} value={burnAmt} onChange={(e) => setBurnAmt(e.target.value)} placeholder="Сколько сжечь" className="input-sketch" style={{ flex: 1, padding: '0.3rem 0.6rem', fontSize: '0.8rem' }} />
                  <button onClick={() => burnCoins(w.currencyId)} disabled={busy} style={{ fontSize: '0.78rem', fontWeight: 600, color: '#fff', background: 'var(--danger)', border: 'none', borderRadius: '8px', padding: '0.3rem 0.7rem', cursor: 'pointer' }}>Сжечь</button>
                  <button onClick={() => setBurnId(null)} className="btn-secondary" style={{ fontSize: '0.78rem', padding: '0.3rem 0.7rem' }}>Отмена</button>
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
                  <span style={{ fontFamily: 'var(--font-display)', fontWeight: 600 }}>{fmt(h.balance)} {currency.icon}</span>
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
            <div key={h.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', padding: 'var(--spacing-2) 0', borderBottom: '1px dashed rgba(56,57,45,0.12)' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 500 }}>{LEDGER_ENTRY_LABELS[h.entryType] ?? h.entryType}</div>
                <div className="label-sm" style={{ fontSize: '0.7rem', opacity: 0.55 }}>{new Date(h.createdAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
              </div>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: h.amount < 0 ? 'var(--danger)' : 'var(--secondary)' }}>
                {h.amount > 0 ? '+' : ''}{fmt(h.amount)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
