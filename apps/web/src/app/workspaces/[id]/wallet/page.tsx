'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { api, apiErrorMessage } from '@/lib/api';
import { EntitySelector } from '@/components/EntitySelector';
import {
  Alert, BentoGrid, Button, Card, CardHeader, EmptyState, Input, LoadingBlock, PageHeader, StatTile,
} from '@/components/ui';
import { PersonChip } from '../../../circles/PersonCard';
import type { Currency, WalletEntry, CurrencyHolder } from '@superapp/shared';

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
  const [busy, setBusy] = useState(false);

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
      if (st === 403) setDenied(true); else setError(apiErrorMessage(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (!isReady) return;
    load();
    api.get(`/workspaces/${id}/members`).then((r) => setMembers(r.data.data)).catch(() => {});
  }, [isReady, id, load]);

  const flash = (m: string) => { setOk(m); setTimeout(() => setOk(''), 4000); };
  const run = async (fn: () => Promise<void>) => {
    setError('');
    setBusy(true);
    try { await fn(); } catch (e) { setError(apiErrorMessage(e)); } finally { setBusy(false); }
  };

  const createCurrency = () => run(async () => {
    if (!name.trim()) return setError('Введите название');
    await api.post('/wallet/company/currency', { name: name.trim(), icon: icon || '🏢' }, cfg);
    flash('Валюта компании создана'); await load();
  });
  const mint = () => run(async () => {
    const amount = parseInt(mintAmt, 10);
    if (!(amount > 0)) return setError('Сумма — целое число больше нуля');
    await api.post('/wallet/company/currency/mint', { amount }, cfg);
    setMintAmt(''); flash(`Выпущено ${amount} в казну`); await load();
  });
  const pay = () => run(async () => {
    const amount = parseInt(payAmt, 10);
    if (!payUser) return setError('Выберите сотрудника');
    if (!(amount > 0)) return setError('Сумма — целое число больше нуля');
    await api.post('/wallet/company/pay', { userId: payUser, amount }, cfg);
    setPayAmt(''); flash('Начислено сотруднику'); await load();
  });

  const memberName = (m: Member) => m.name || `${m.firstName ?? ''} ${m.lastName ?? ''}`.trim() || m.userId.slice(0, 8);

  if (!isReady || loading) return <LoadingBlock />;

  if (denied) {
    return (
      <>
        <PageHeader breadcrumb="Организация" title="Кошелёк компании" />
        <BentoGrid>
          <Card span={12}>
            <EmptyState
              icon="lock"
              title="Только для владельца"
              description="Кошельком компании управляет владелец организации."
              action={<Button variant="matte" icon="arrowLeft" href={`/workspaces/${id}`}>К организации</Button>}
            />
          </Card>
        </BentoGrid>
      </>
    );
  }

  return (
    <>
      <PageHeader
        breadcrumb="Организация"
        title="Кошелёк компании"
        description="Внутренняя валюта для наград сотрудникам и магазина компании"
      />

      {(error || ok) && (
        <div style={{ marginBottom: 'var(--gap-grid)' }}>
          {error && <Alert tone="danger" onClose={() => setError('')}>{error}</Alert>}
          {ok && <Alert tone="success" onClose={() => setOk('')}>{ok}</Alert>}
        </div>
      )}

      {!currency ? (
        <BentoGrid>
          <Card span={12}>
            <CardHeader
              title="Создайте валюту компании"
              subtitle="Ею платят награды за задачи и покупают в магазине организации"
            />
            <div style={{ display: 'grid', gridTemplateColumns: '5rem 1fr', gap: 'var(--spacing-3)', maxWidth: 460 }}>
              <Input
                label="Значок"
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                maxLength={8}
                style={{ textAlign: 'center', fontSize: '1.15rem' }}
              />
              <Input label="Название" value={name} onChange={(e) => setName(e.target.value)} placeholder="Например, БонусКоин" />
            </div>
            <div style={{ marginTop: 'var(--spacing-4)' }}>
              <Button variant="primary" tone="success" icon="add" onClick={createCurrency} loading={busy}>Создать</Button>
            </div>
          </Card>
        </BentoGrid>
      ) : (
        <BentoGrid>
          {/* ---------- Казна ---------- */}
          <StatTile
            span={4}
            label="Казна"
            value={fmt(treasury?.balance ?? 0, currency.scale)}
            emoji={currency.icon}
            tone="accent"
          />
          <StatTile
            span={4}
            label="Заморожено"
            value={fmt(treasury?.held ?? 0, currency.scale)}
            icon="lock"
            tone={(treasury?.held ?? 0) > 0 ? 'warning' : 'neutral'}
          />
          <StatTile
            span={4}
            label="Держателей"
            value={holders.length}
            icon="people"
            tone={holders.length ? 'success' : 'neutral'}
          />

          {/* ---------- Выпуск в казну ---------- */}
          <Card span={6}>
            <CardHeader title="Выпустить в казну" subtitle={`${currency.icon} ${currency.name} — эмитент организация`} />
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div style={{ width: 160 }}>
                <Input
                  label="Сумма"
                  type="number"
                  min={1}
                  value={mintAmt}
                  onChange={(e) => setMintAmt(e.target.value)}
                  placeholder="1 000"
                />
              </div>
              <Button variant="primary" tone="success" icon="spark" onClick={mint} loading={busy}>Выпустить</Button>
            </div>
          </Card>

          {/* ---------- Начислить сотруднику ---------- */}
          <Card span={6}>
            <CardHeader title="Начислить сотруднику" subtitle="Списывается из казны организации" />
            <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
              <EntitySelector
                types={['user']}
                options={members.map((m) => ({
                  type: 'user',
                  id: m.userId,
                  title: memberName(m),
                  firstName: m.firstName ?? m.name ?? memberName(m),
                  lastName: m.lastName ?? null,
                }))}
                value={payUser ? [{ type: 'user', id: payUser }] : []}
                onChange={(next) => setPayUser(next[next.length - 1]?.id ?? '')}
                placeholder="Выберите сотрудника…"
              />
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div style={{ width: 160 }}>
                  <Input
                    label="Сумма"
                    type="number"
                    min={1}
                    value={payAmt}
                    onChange={(e) => setPayAmt(e.target.value)}
                    placeholder="100"
                  />
                </div>
                <Button variant="primary" tone="success" icon="send" onClick={pay} loading={busy}>Начислить</Button>
              </div>
            </div>
          </Card>

          {/* ---------- Держатели ---------- */}
          <Card span={12}>
            <CardHeader title="Держатели" subtitle="У кого на руках валюта организации" />
            {holders.length === 0 ? (
              <EmptyState
                icon="people"
                title="Пока ни у кого нет коинов"
                description="Начислите первому сотруднику — он появится здесь."
              />
            ) : (
              <div style={{ display: 'grid', gap: '0.375rem' }}>
                {holders.map((h) => (
                  <div
                    key={h.userId}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--spacing-3)',
                      padding: '0.5rem 0.75rem', border: '1px solid var(--divider)', borderRadius: 'var(--radius-md)',
                    }}
                  >
                    <PersonChip size="S" userId={h.userId} firstName={h.name} />
                    <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700 }}>
                      {fmt(h.balance, currency.scale)} <span aria-hidden>{currency.icon}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </BentoGrid>
      )}
    </>
  );
}
