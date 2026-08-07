'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { apiErrorMessage, apiGet, apiPost } from '@/lib/api';
import { formatWalletAmount } from '@/lib/wallet-format';
import { companyHoldersKey, companyWalletKey, workspaceMembersKey } from '@/lib/queries';
import { EntitySelector } from '@/components/EntitySelector';
import {
  Alert, BentoGrid, Button, Card, CardHeader, EmptyState, Glyph, GlyphField, Input, LoadingBlock, PageHeader, StatTile,
} from '@/components/ui';
import { PersonChip } from '../../../circles/PersonCard';
import type { CompanyWalletDto, CurrencyHolder, WorkspaceMember } from '@superapp/shared';

// Локального `type Member` здесь БОЛЬШЕ НЕТ. Он объявлял поля `name/firstName/lastName`,
// которых на ручке `/workspaces/:id/members` НЕ СУЩЕСТВОВАЛО НИКОГДА (имя приезжает в
// `userName`), — и все три ветки `memberName` промахивались, из-за чего пикер
// «Начислить сотруднику» с 31.05.2026 подписывал людей первыми 8 символами UUID.
// Тот же ключ кэша читают ещё шесть файлов как `WorkspaceMember[]`.

/**
 * Company wallet (B2B, Phase 9) — owner-only. Issue the company currency, mint into the treasury,
 * pay employees, see holders. Every request carries the X-Workspace-Id context header.
 */
export default function CompanyWalletPage() {
  const { isReady } = useRequireAuth();
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const cfg = { headers: { 'X-Workspace-Id': id } };

  // Данные — в общем кэше React Query: повторный заход мгновенный, действие
  // обновляет только затронутые ключи (раньше каждый mint/pay перезапрашивал всё).
  const companyQ = useQuery({
    queryKey: companyWalletKey(id),
    queryFn: () => apiGet<CompanyWalletDto>('/wallet/company', cfg),
    enabled: isReady,
    staleTime: 30_000,
  });
  const currency = companyQ.data?.currency ?? null;
  const treasury = companyQ.data?.treasury ?? null;
  const denied = (companyQ.error as { response?: { status?: number } } | null)?.response?.status === 403;

  const holdersQ = useQuery({
    queryKey: companyHoldersKey(id),
    queryFn: () => apiGet<CurrencyHolder[]>('/wallet/company/holders', cfg),
    enabled: isReady && !!currency,
    staleTime: 30_000,
  });
  const holders: CurrencyHolder[] = holdersQ.data ?? [];

  // Ростер — ОБЩИЙ ключ с сервисом «Сотрудники»: если человек заходил в ростер,
  // список уже в кэше и пикер заполняется без запроса.
  const membersQ = useQuery({
    queryKey: workspaceMembersKey(id),
    queryFn: () => apiGet<WorkspaceMember[]>(`/workspaces/${id}/members`),
    enabled: isReady,
    staleTime: 60_000,
  });
  const members: WorkspaceMember[] = membersQ.data ?? [];

  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);

  // forms
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('🏢');
  const [mintAmt, setMintAmt] = useState('');
  const [payUser, setPayUser] = useState('');
  const [payAmt, setPayAmt] = useState('');

  const flash = (m: string) => { setOk(m); setTimeout(() => setOk(''), 4000); };
  const run = async (fn: () => Promise<void>, keys: ReadonlyArray<readonly unknown[]>) => {
    setError('');
    setBusy(true);
    try {
      await fn();
      await Promise.all(keys.map((k) => qc.invalidateQueries({ queryKey: k })));
    } catch (e) { setError(apiErrorMessage(e)); } finally { setBusy(false); }
  };

  const createCurrency = () => run(async () => {
    if (!name.trim()) return setError('Введите название');
    await apiPost('/wallet/company/currency', { name: name.trim(), icon: icon || '🏢' }, cfg);
    flash('Валюта компании создана');
  }, [companyWalletKey(id)]);
  const mint = () => run(async () => {
    const amount = parseInt(mintAmt, 10);
    if (!(amount > 0)) return setError('Сумма — целое число больше нуля');
    await apiPost('/wallet/company/currency/mint', { amount }, cfg);
    setMintAmt(''); flash(`Выпущено ${amount} в казну`);
  }, [companyWalletKey(id)]);
  const pay = () => run(async () => {
    const amount = parseInt(payAmt, 10);
    if (!payUser) return setError('Выберите сотрудника');
    if (!(amount > 0)) return setError('Сумма — целое число больше нуля');
    await apiPost('/wallet/company/pay', { userId: payUser, amount }, cfg);
    setPayAmt(''); flash('Начислено сотруднику');
  }, [companyWalletKey(id), companyHoldersKey(id)]);

  const memberName = (m: WorkspaceMember) => m.userName || m.userId.slice(0, 8);

  const loadError = !denied && companyQ.error ? apiErrorMessage(companyQ.error) : '';
  const shownError = error || loadError;

  if (!isReady || companyQ.isPending) return <LoadingBlock />;

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

      {(shownError || ok) && (
        <div style={{ marginBottom: 'var(--gap-grid)' }}>
          {shownError && <Alert tone="danger" onClose={() => setError('')}>{shownError}</Alert>}
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
            <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: 'var(--spacing-3)', maxWidth: 460, alignItems: 'start' }}>
              <GlyphField value={icon} onChange={(v) => setIcon(v ?? '')} suggest={name} />
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
            value={formatWalletAmount(treasury?.balance ?? 0, currency.scale)}
            emoji={currency.icon}
            tone="accent"
          />
          <StatTile
            span={4}
            label="Заморожено"
            value={formatWalletAmount(treasury?.held ?? 0, currency.scale)}
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
            <CardHeader title="Выпустить в казну" subtitle={<span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}><Glyph value={currency.icon} size={14} />{currency.name} — эмитент организация</span>} />
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
            <div className="ui-stack" style={{ gap: 'var(--spacing-3)' }}>
              <EntitySelector
                types={['user']}
                options={members.map((m) => ({
                  type: 'user' as const,
                  id: m.userId,
                  title: memberName(m),
                  // Имя/фамилия — из карточки строки ростера (она уже приехала в ответе).
                  firstName: m.card?.firstName ?? memberName(m),
                  lastName: m.card?.lastName ?? null,
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
              <div className="ui-stack" style={{ gap: '0.375rem' }}>
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
                      {formatWalletAmount(h.balance, currency.scale)} <Glyph value={currency.icon} size={14} />
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
