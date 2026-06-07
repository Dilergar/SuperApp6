'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '@/lib/api';
import {
  resolveCardVisibility,
  SKIN_RARITY_META,
  type CardSkinCatalogItem,
  type CardSkinInstanceDto,
  type CardSkinWallet,
  type CardSkinEquipState,
  type CardSkinRender,
  type Circle,
} from '@superapp/shared';
import { PersonCard } from '../circles/PersonCard';
import { GroupChip } from '../circles/EntityChip';
import { DEFAULT_SKIN } from '../circles/card-skin';
import { invalidatePersonSkins } from '@/lib/person-skins';

function errMsg(e: unknown, fallback = 'Ошибка'): string {
  const ax = e as { response?: { data?: { message?: string; error?: string } } };
  return ax?.response?.data?.message || ax?.response?.data?.error || fallback;
}
const fmt = (n: number) => n.toLocaleString('ru-RU');

interface SkinsSectionProps {
  // The signed-in user's profile (for the live preview). Shape is loose on purpose.
  profile: {
    id?: string;
    firstName?: string;
    lastName?: string | null;
    phone?: string;
    dateOfBirth?: string | null;
    bio?: string | null;
    city?: string | null;
    email?: string | null;
    maritalStatus?: string | null;
    socialLinks?: { telegram?: string; instagram?: string } | null;
    cardVisibility?: unknown;
  } | null;
}

/**
 * Profile → «Скины карточки». Buy platform-currency skins, see your inventory,
 * equip a default skin, and (premium) assign a different skin per group.
 */
export function SkinsSection({ profile }: SkinsSectionProps) {
  const [wallet, setWallet] = useState<CardSkinWallet | null>(null);
  const [catalog, setCatalog] = useState<CardSkinCatalogItem[]>([]);
  const [inventory, setInventory] = useState<CardSkinInstanceDto[]>([]);
  const [equip, setEquip] = useState<CardSkinEquipState | null>(null);
  const [groups, setGroups] = useState<Circle[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [topAmt, setTopAmt] = useState('1000');
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    try {
      const [w, c, inv, eq, gr] = await Promise.all([
        api.get('/card-skins/wallet'),
        api.get('/card-skins/catalog'),
        api.get('/card-skins/inventory'),
        api.get('/card-skins/equip'),
        api.get('/circles'),
      ]);
      setWallet(w.data.data);
      setCatalog(c.data.data);
      setInventory(inv.data.data);
      setEquip(eq.data.data);
      setGroups(gr.data.data);
    } catch (e) {
      setError(errMsg(e, 'Не удалось загрузить скины'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const flash = (m: string) => { setOk(m); setError(''); setTimeout(() => setOk(''), 2500); };
  const run = async (fn: () => Promise<void>, success?: string) => {
    if (inFlight.current) return; // synchronous guard — blocks double-click double-submit (e.g. buying twice)
    inFlight.current = true;
    setError(''); setBusy(true);
    try { await fn(); await load(); if (success) flash(success); }
    catch (e) { setError(errMsg(e)); }
    finally { setBusy(false); inFlight.current = false; }
  };

  const topUp = () => {
    const n = parseInt(topAmt, 10);
    if (!Number.isInteger(n) || n <= 0) return setError('Введите целое число больше 0');
    return run(async () => { await api.post('/card-skins/wallet/topup', { amount: n }); }, `Пополнено на ${fmt(n)}`);
  };
  const buy = (id: string) => run(async () => { await api.post(`/card-skins/${id}/buy`); }, 'Скин куплен');
  const equipDefault = (instanceId: string | null) =>
    run(async () => { await api.put('/card-skins/equip/default', { instanceId }); invalidatePersonSkins(); }, instanceId ? 'Скин надет' : 'Скин снят');
  const equipGroup = (circleId: string, instanceId: string | null) =>
    run(async () => { await api.put('/card-skins/equip/group', { circleId, instanceId }); invalidatePersonSkins(); }, 'Готово');

  if (loading) return <p className="label-md">Загрузка скинов…</p>;

  const defaultInst = inventory.find((i) => i.id === equip?.defaultInstanceId) || null;
  const previewSkin: CardSkinRender = defaultInst ? defaultInst.skin : DEFAULT_SKIN;

  return (
    <div>
      <h2 className="title-lg" style={{ marginBottom: 'var(--spacing-2)' }}>Скины карточки</h2>
      <p className="label-sm" style={{ marginBottom: 'var(--spacing-6)', opacity: 0.7 }}>
        Оформление вашей карточки, которое видят люди из окружения. Купите скин, наденьте его —
        а на премиум-тарифе можно ставить разные скины для разных групп.
      </p>

      {error && <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginBottom: 'var(--spacing-4)' }}>{error}</p>}
      {ok && <p style={{ color: 'var(--secondary)', fontSize: '0.85rem', marginBottom: 'var(--spacing-4)' }}>{ok}</p>}

      {/* ===== Wallet ===== */}
      <div className="card" style={{ padding: 'var(--spacing-4) var(--spacing-6)', maxWidth: 520, marginBottom: 'var(--spacing-8)', display: 'flex', alignItems: 'center', gap: 'var(--spacing-4)', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 160 }}>
          <div className="label-sm" style={{ opacity: 0.7 }}>Баланс</div>
          <div className="title-md">{wallet?.icon} {fmt(wallet?.balance ?? 0)} <span style={{ fontSize: '0.8rem', opacity: 0.6 }}>{wallet?.name}</span></div>
        </div>
        <div style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'flex-end' }}>
          <div>
            <label className="label-sm" style={{ display: 'block', marginBottom: 2 }}>Пополнить (тест)</label>
            <input type="number" min={1} value={topAmt} onChange={(e) => setTopAmt(e.target.value)} className="input-sketch" style={{ width: 110, padding: '0.3rem 0.5rem', fontSize: '0.85rem' }} />
          </div>
          <button className="btn-secondary" disabled={busy} onClick={topUp} style={{ fontSize: '0.8rem' }}>Пополнить</button>
        </div>
      </div>

      {/* ===== Live preview ===== */}
      {profile && (
        <div style={{ marginBottom: 'var(--spacing-8)' }}>
          <h3 className="title-md" style={{ marginBottom: 'var(--spacing-3)' }}>Предпросмотр</h3>
          <PersonCard
            mode="full"
            initialSize="L"
            skin={previewSkin}
            profile={{
              firstName: profile.firstName ?? 'Имя',
              lastName: profile.lastName ?? null,
              phone: profile.phone ?? '',
              avatar: null,
              dateOfBirth: profile.dateOfBirth ?? null,
              bio: profile.bio ?? null,
              city: profile.city ?? null,
              email: profile.email ?? null,
              maritalStatus: profile.maritalStatus ?? null,
              socialLinks: profile.socialLinks ?? null,
              cardVisibility: resolveCardVisibility(profile.cardVisibility as never),
            }}
          />
        </div>
      )}

      {/* ===== Shop ===== */}
      <h3 className="title-md" style={{ marginBottom: 'var(--spacing-3)' }}>Магазин</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 'var(--spacing-4)', marginBottom: 'var(--spacing-8)' }}>
        {catalog.map((s) => {
          const r = SKIN_RARITY_META[s.rarity];
          return (
            <div key={s.id} className="card" style={{ padding: 'var(--spacing-3)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--spacing-2)' }}>
              <SkinSwatch skin={s} />
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '0.9rem' }}>{s.name}</div>
                <div style={{ fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: r.color }}>{r.label}</div>
              </div>
              <div className="label-sm" style={{ fontSize: '0.78rem' }}>
                {s.priceAmount > 0 ? <>{wallet?.icon} {fmt(s.priceAmount)}</> : 'Бесплатно'}
              </div>
              {s.supply !== null && (
                <div className="label-sm" style={{ fontSize: '0.66rem', opacity: 0.7 }}>
                  {s.soldOut ? 'Распродано' : `осталось ${fmt(s.remaining ?? 0)} из ${fmt(s.supply)}`}
                </div>
              )}
              <button
                className="btn-primary"
                disabled={busy || !s.available}
                onClick={() => buy(s.id)}
                style={{ fontSize: '0.78rem', padding: '0.3rem 0.9rem', opacity: s.available ? 1 : 0.5, cursor: s.available ? 'pointer' : 'not-allowed' }}
              >
                {s.soldOut ? 'Распродано' : s.owned ? 'Купить ещё' : 'Купить'}
              </button>
            </div>
          );
        })}
      </div>

      {/* ===== Inventory ===== */}
      <h3 className="title-md" style={{ marginBottom: 'var(--spacing-3)' }}>Мои скины</h3>
      {inventory.length === 0 ? (
        <p className="label-md" style={{ marginBottom: 'var(--spacing-8)', opacity: 0.7 }}>Пока нет купленных скинов.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)', maxWidth: 520, marginBottom: 'var(--spacing-8)' }}>
          {inventory.map((i) => {
            const isDefault = equip?.defaultInstanceId === i.id;
            return (
              <div key={i.id} className="card" style={{ padding: 'var(--spacing-2) var(--spacing-4)', display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)' }}>
                <SkinSwatch skin={i.skin} mini />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: '0.88rem' }}>
                    {i.skin.name}
                    {i.serial !== null && <span className="label-sm" style={{ marginLeft: 6, fontSize: '0.7rem' }}>#{i.serial}</span>}
                  </div>
                  <div style={{ fontSize: '0.66rem', fontWeight: 700, textTransform: 'uppercase', color: SKIN_RARITY_META[i.skin.rarity].color }}>
                    {SKIN_RARITY_META[i.skin.rarity].label}
                  </div>
                </div>
                {isDefault ? (
                  <>
                    <span className="label-sm" style={{ color: 'var(--secondary)', fontWeight: 600 }}>Надето ✓</span>
                    <button onClick={() => equipDefault(null)} disabled={busy} className="btn-secondary" style={{ fontSize: '0.75rem', padding: '0.25rem 0.7rem' }}>Снять</button>
                  </>
                ) : (
                  <button onClick={() => equipDefault(i.id)} disabled={busy} className="btn-primary" style={{ fontSize: '0.75rem', padding: '0.25rem 0.8rem' }}>Надеть</button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ===== Per-group skins (premium) ===== */}
      <h3 className="title-md" style={{ marginBottom: 'var(--spacing-2)' }}>
        Скины на группы {!equip?.premium && <span className="label-sm" style={{ fontSize: '0.7rem', color: 'var(--tertiary)' }}>🔒 премиум</span>}
      </h3>
      <p className="label-sm" style={{ marginBottom: 'var(--spacing-3)', opacity: 0.7 }}>
        Премиум-тариф позволяет показывать разным группам разные скины. Если человек в нескольких группах —
        выигрывает группа выше в списке окружения.
      </p>
      {groups.length === 0 ? (
        <p className="label-md" style={{ opacity: 0.7 }}>Сначала создайте группы на странице «Окружение».</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)', maxWidth: 520 }}>
          {groups.map((g) => {
            const cur = equip?.perGroup.find((p) => p.circleId === g.id)?.instanceId ?? '';
            return (
              <div key={g.id} className="card" style={{ padding: 'var(--spacing-2) var(--spacing-4)', display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <GroupChip size="M" icon={g.icon} name={g.name} color={g.color} count={g.membersCount} />
                </div>
                <select
                  value={cur}
                  disabled={busy || !equip?.premium}
                  onChange={(e) => equipGroup(g.id, e.target.value || null)}
                  className="input-sketch"
                  style={{ width: 180, padding: '0.25rem 0.5rem', fontSize: '0.8rem', cursor: equip?.premium ? 'pointer' : 'not-allowed', opacity: equip?.premium ? 1 : 0.5 }}
                >
                  <option value="">По умолчанию</option>
                  {inventory.map((i) => (
                    <option key={i.id} value={i.id}>{i.skin.name}{i.serial !== null ? ` #${i.serial}` : ''}</option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Small static preview of a skin (tokens only — no effects/motion).
function SkinSwatch({ skin, mini }: { skin: CardSkinRender; mini?: boolean }) {
  const t = skin.tokens;
  const size = mini ? 40 : 116;
  const av = mini ? 20 : 46;
  return (
    <div style={{
      background: skin.backgroundUrl ? `url(${skin.backgroundUrl}) center/cover, ${t.cardBg}` : t.cardBg,
      border: t.cardBorder, borderRadius: t.cardRadius, boxShadow: mini ? 'none' : t.cardShadow,
      width: mini ? size : '100%', height: size, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: mini ? 0 : 6, padding: mini ? 0 : 8, flexShrink: 0,
    }}>
      <div style={{
        width: av, height: av, borderRadius: t.avatarRadius, background: t.avatarBg, color: t.avatarColor,
        border: t.avatarInnerBorder, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: av * 0.42,
      }}>А</div>
      {!mini && <div style={{ color: t.nameColor, fontFamily: t.nameFont, fontWeight: 700, fontSize: '0.72rem', letterSpacing: '0.04em' }}>ИМЯ</div>}
    </div>
  );
}
