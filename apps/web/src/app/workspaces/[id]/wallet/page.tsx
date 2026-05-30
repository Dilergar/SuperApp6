'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { api } from '@/lib/api';
import type { Currency, WalletEntry, CurrencyHolder } from '@superapp/shared';

function errMsg(e: unknown, fallback = 'Ошибка'): string {
  const ax = e as { response?: { data?: { message?: string; error?: string }; status?: number } };
  const m = ax?.response?.data?.message || ax?.response?.data?.error;
  return Array.isArray(m) ? m.join(', ') : m || fallback;
}
const fmt = (amount: number, scale: number) => (scale > 0 ? amount / 10 ** scale : amount).toLocaleString('ru-RU');
type Member = { userId: string; name?: string; firstName?: string; lastName?: string };

/**
 * Company wallet (B2B, Phase 9) — owner-only. Issue the company currency, mint into the treasury,
 * pay employees, see holders. Every request carries the X-Workspace-Id context header.
 */
export default function CompanyWalletPage() {
  const { isReady } = useRequireAuth();
  const { id } = useParams<{ id: string }>();
  const cfg = { headers: { 'X-Workspace-Id': id } };

  const [currency, setCurrency] = useState<Currency | null>(null);
  const [treasury, setTreasury] = useState<WalletEntry | null>(null);
  const [holders, setHolders] = useState<CurrencyHolder[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');

  // forms
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('🏢');
  const [mintAmt, setMintAmt] = useState('');
  const [payUser, setPayUser] = useState('');
  const [payAmt, setPayAmt] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const r = await api.get('/wallet/company', cfg);
      setCurrency(r.data.data.currency);
      setTreasury(r.data.data.treasury);
      if (r.data.data.currency) api.get('/wallet/company/holders', cfg).then((h) => setHolders(h.data.data)).catch(() => {});
    } catch (e) {
      const st = (e as { response?: { status?: number } })?.response?.status;
      if (st === 403) setDenied(true); else setError(errMsg(e, 'Не удалось загрузить кошелёк компании'));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (!isReady) return;
    load();
    api.get(`/workspaces/${id}/members`).then((r) => setMembers(r.data.data)).catch(() => {});
  }, [isReady, id, load]);

  const flash = (m: string) => { setOk(m); setTimeout(() => setOk(''), 4000); };
  const run = async (fn: () => Promise<void>) => { setError(''); try { await fn(); } catch (e) { setError(errMsg(e)); } };

  const createCurrency = () => run(async () => {
    if (!name.trim()) return setError('Введите название');
    await api.post('/wallet/company/currency', { name: name.trim(), icon: icon || '🏢' }, cfg);
    flash('Валюта компании создана'); await load();
  });
  const mint = () => run(async () => {
    const amount = parseInt(mintAmt, 10);
    if (!(amount > 0)) return setError('Сумма — целое > 0');
    await api.post('/wallet/company/currency/mint', { amount }, cfg);
    setMintAmt(''); flash(`Выпущено ${amount} в казну`); await load();
  });
  const pay = () => run(async () => {
    const amount = parseInt(payAmt, 10);
    if (!payUser) return setError('Выберите сотрудника');
    if (!(amount > 0)) return setError('Сумма — целое > 0');
    await api.post('/wallet/company/pay', { userId: payUser, amount }, cfg);
    setPayAmt(''); flash('Начислено сотруднику'); await load();
  });

  const memberName = (m: Member) => m.name || `${m.firstName ?? ''} ${m.lastName ?? ''}`.trim() || m.userId.slice(0, 8);

  if (!isReady || loading) return <p className="label-md">Загрузка…</p>;
  if (denied) {
    return (
      <div className="card" style={{ padding: 'var(--spacing-8)', textAlign: 'center' }}>
        <div className="title-md" style={{ marginBottom: 'var(--spacing-2)' }}>Только для владельца</div>
        <p className="label-md" style={{ opacity: 0.7 }}>Кошельком компании управляет владелец организации.</p>
        <Link href={`/workspaces/${id}`} className="btn-secondary" style={{ marginTop: 'var(--spacing-4)', display: 'inline-block' }}>← Назад</Link>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', marginBottom: 'var(--spacing-6)' }}>
        <Link href={`/workspaces/${id}`} className="label-md" style={{ color: 'var(--secondary)' }}>← Организация</Link>
        <h1 className="display-md" style={{ fontSize: '1.8rem' }}>Кошелёк компании</h1>
      </div>
      {error && <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginBottom: 'var(--spacing-4)' }}>{error}</p>}
      {ok && <p style={{ color: 'var(--secondary)', fontSize: '0.85rem', marginBottom: 'var(--spacing-4)' }}>{ok}</p>}

      {!currency ? (
        <div className="card-elevated" style={{ padding: 'var(--spacing-6)', maxWidth: 460 }}>
          <div className="title-md" style={{ marginBottom: 'var(--spacing-2)' }}>Создайте валюту компании</div>
          <p className="label-sm" style={{ opacity: 0.7, marginBottom: 'var(--spacing-4)' }}>Внутренняя валюта для наград сотрудникам и магазина компании.</p>
          <div style={{ display: 'flex', gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-3)' }}>
            <input value={icon} onChange={(e) => setIcon(e.target.value)} maxLength={8} className="input-sketch" style={{ width: 56, textAlign: 'center', fontSize: '1.3rem' }} />
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Например, БонусКоин" className="input-sketch" style={{ flex: 1 }} />
          </div>
          <button onClick={createCurrency} className="btn-primary" style={{ fontSize: '0.85rem' }}>Создать</button>
        </div>
      ) : (
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 'var(--spacing-6)' }}>
          {/* Treasury */}
          <div className="card-elevated" style={{ padding: 'var(--spacing-5)' }}>
            <div className="label-sm" style={{ opacity: 0.6 }}>КАЗНА</div>
            <div className="display-md" style={{ color: 'var(--primary)', fontSize: '1.8rem' }}>
              {currency.icon} {fmt(treasury?.balance ?? 0, currency.scale)}
            </div>
            <div className="label-sm" style={{ opacity: 0.7 }}>{currency.name}{(treasury?.held ?? 0) > 0 ? ` · держит ${fmt(treasury!.held, currency.scale)}` : ''}</div>
            <div style={{ display: 'flex', gap: '0.4rem', marginTop: 'var(--spacing-3)' }}>
              <input type="number" min={1} value={mintAmt} onChange={(e) => setMintAmt(e.target.value)} placeholder="сумма" className="input-sketch" style={{ width: 110, padding: '0.3rem 0.5rem' }} />
              <button onClick={mint} className="btn-primary" style={{ fontSize: '0.8rem' }}>Выпустить в казну</button>
            </div>
          </div>

          {/* Pay an employee */}
          <div className="card-elevated" style={{ padding: 'var(--spacing-5)' }}>
            <div className="label-sm" style={{ opacity: 0.6, marginBottom: 'var(--spacing-2)' }}>НАЧИСЛИТЬ СОТРУДНИКУ</div>
            <select value={payUser} onChange={(e) => setPayUser(e.target.value)} className="input-sketch" style={{ width: '100%', padding: '0.35rem 0.5rem', fontSize: '0.85rem', marginBottom: '0.4rem' }}>
              <option value="">— сотрудник —</option>
              {members.map((m) => <option key={m.userId} value={m.userId}>{memberName(m)}</option>)}
            </select>
            <div style={{ display: 'flex', gap: '0.4rem' }}>
              <input type="number" min={1} value={payAmt} onChange={(e) => setPayAmt(e.target.value)} placeholder="сумма" className="input-sketch" style={{ width: 110, padding: '0.3rem 0.5rem' }} />
              <button onClick={pay} className="btn-primary" style={{ fontSize: '0.8rem' }}>Начислить</button>
            </div>
          </div>

          {/* Holders */}
          <div className="card-elevated" style={{ padding: 'var(--spacing-5)' }}>
            <div className="label-sm" style={{ opacity: 0.6, marginBottom: 'var(--spacing-2)' }}>ДЕРЖАТЕЛИ</div>
            {holders.length === 0 ? <p className="label-sm" style={{ opacity: 0.6 }}>Пока ни у кого нет коинов.</p> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                {holders.map((h) => (
                  <div key={h.userId} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
                    <span>{h.name}</span><span style={{ fontWeight: 600 }}>{fmt(h.balance, currency.scale)} {currency.icon}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
