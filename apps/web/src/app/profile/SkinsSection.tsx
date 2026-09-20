'use client';

import { useState, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Input, Select } from '@/components/ui';
import { EntitlementLock } from '@/components/entitlements';
import { apiGet, apiPost, apiPut } from '@/lib/api';
import {
  cardSkinsCatalogKey, cardSkinsEquipKey, cardSkinsInventoryKey, cardSkinsWalletKey,
  circlesKey, fetchCircles,
} from '@/lib/queries';
import {
  resolveCardVisibility,
  type CardSkinCatalogItem,
  type CardSkinInstanceDto,
  type CardSkinWallet,
  type CardSkinEquipState,
  type CardSkinRender,
  type Circle,
  type UserProfile,
} from '@superapp/shared';
import { PersonCard } from '../circles/PersonCard';
import { GroupChip } from '../circles/EntityChip';
import { DEFAULT_SKIN, RARITY_META } from '../circles/card-skin';
import { invalidatePersonSkins } from '@/lib/person-skins';
import { useTranslations } from 'next-intl';
import { useFormatters } from '@/lib/format';
import { apiErrorCode, isOutcomeUnknown, toastApiError } from '@/lib/api-errors';
import { useIdempotencyIntent } from '@/lib/useIdempotencyKey';
import { OutcomeUnknownAlert, SlowRequestNote } from '@/components/idempotency/OutcomeUnknownAlert';

/** Тестовое пополнение есть только в development: в остальных средах маршрута API нет. */
const DEV_TOPUP = process.env.NODE_ENV === 'development';

function errMsg(e: unknown, fallback: string): string {
  const ax = e as { response?: { data?: { message?: string; error?: string } } };
  return ax?.response?.data?.message || ax?.response?.data?.error || fallback;
}

interface SkinsSectionProps {
  /**
   * Профиль вошедшего (для живого превью карточки) — ОДИН тип с сервером.
   * Раньше здесь лежала ТРЕТЬЯ копия полей профиля («форма свободная»), и
   * вызывающий передавал `profile as never` — каст, глушивший проверку целиком.
   */
  profile: UserProfile | null;
}

/**
 * Profile → «Скины карточки». Buy platform-currency skins, see your inventory,
 * equip a default skin, and (premium) assign a different skin per group.
 */
export function SkinsSection({ profile }: SkinsSectionProps) {
  const t = useTranslations('profile');
  const common = useTranslations('common');
  // Ступени редкости живут в неймспейсе «Окружения» — там же, где карточка,
  // которую они украшают; layout профиля кладёт его в провайдер.
  const tCircles = useTranslations('circles');
  // Числа — через форматтеры платформы (разделители профиля региона).
  const { number: fmt } = useFormatters();
  // Данные — в общем кэше React Query: повторный заход в секцию рисуется из
  // кэша мгновенно, а каждое действие обновляет ТОЛЬКО затронутые ключи
  // (раньше любой клик «Купить/Надеть» перезапрашивал все 5 эндпоинтов).
  const qc = useQueryClient();
  const walletQ = useQuery({
    queryKey: cardSkinsWalletKey,
    queryFn: async () => await apiGet<CardSkinWallet>('/card-skins/wallet'),
    staleTime: 60_000,
  });
  const catalogQ = useQuery({
    queryKey: cardSkinsCatalogKey,
    queryFn: async () => await apiGet<CardSkinCatalogItem[]>('/card-skins/catalog'),
    staleTime: 60_000,
  });
  const inventoryQ = useQuery({
    queryKey: cardSkinsInventoryKey,
    queryFn: async () => await apiGet<CardSkinInstanceDto[]>('/card-skins/inventory'),
    staleTime: 60_000,
  });
  const equipQ = useQuery({
    queryKey: cardSkinsEquipKey,
    queryFn: async () => await apiGet<CardSkinEquipState>('/card-skins/equip'),
    staleTime: 60_000,
  });
  // Группы — ОБЩИЙ ключ приложения: список уже загружен «Окружением»/пикерами
  const groupsQ = useQuery({ queryKey: circlesKey, queryFn: fetchCircles, staleTime: 60_000 });

  const wallet = walletQ.data ?? null;
  const catalog: CardSkinCatalogItem[] = catalogQ.data ?? [];
  const inventory: CardSkinInstanceDto[] = inventoryQ.data ?? [];
  const equip = equipQ.data ?? null;
  const groups: Circle[] = groupsQ.data ?? [];
  const loading = walletQ.isPending || catalogQ.isPending || inventoryQ.isPending || equipQ.isPending;
  const loadError = walletQ.error ?? catalogQ.error ?? inventoryQ.error ?? equipQ.error;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [topAmt, setTopAmt] = useState('1000');
  const inFlight = useRef(false);
  // Покупка скина — платформенная валюта, то есть деньги: ключ намерения на ЛОТ
  // (двойной клик = одна покупка), а не на клик.
  const buyIntent = useIdempotencyIntent();
  // «Исход неизвестен» за кнопкой покупки тостом не показывают
  const [unknownOutcome, setUnknownOutcome] = useState<unknown>(null);

  const flash = (m: string) => { setOk(m); setError(''); setTimeout(() => setOk(''), 2500); };
  const run = async (fn: () => Promise<void>, keys: ReadonlyArray<readonly unknown[]>, success?: string) => {
    if (inFlight.current) return; // synchronous guard — blocks double-click double-submit (e.g. buying twice)
    inFlight.current = true;
    setError(''); setUnknownOutcome(null); setBusy(true);
    try {
      await fn();
      await Promise.all(keys.map((k) => qc.invalidateQueries({ queryKey: k })));
      if (success) flash(success);
    } catch (e) {
      // «Операция могла пройти» — это не ошибка формы, а повод сходить в инвентарь
      if (isOutcomeUnknown(e)) setUnknownOutcome(e);
      // Прочие исходы движка повторов несут СВОЙ тон: «уже куплено» — успех, а не
      // беда. Красная строка соврала бы и толкнула купить второй раз.
      else if (apiErrorCode(e)?.startsWith('idempotency.')) toastApiError(e);
      else setError(errMsg(e, common('state.error')));
    }
    finally { setBusy(false); inFlight.current = false; }
  };

  const topUp = () => {
    const n = parseInt(topAmt, 10);
    if (!Number.isInteger(n) || n <= 0) return setError(t('skins.integerError'));
    return run(async () => { await apiPost('/card-skins/wallet/topup', { amount: n }); }, [cardSkinsWalletKey], t('skins.toppedUp', { amount: fmt(n) }));
  };
  const buy = (id: string) =>
    run(async () => {
      await apiPost(`/card-skins/${id}/buy`, undefined, { idempotencyKey: buyIntent.keyFor('skin', id) });
      buyIntent.reset();
    }, [cardSkinsWalletKey, cardSkinsCatalogKey, cardSkinsInventoryKey], t('skins.bought'));
  const equipDefault = (instanceId: string | null) =>
    run(async () => { await apiPut('/card-skins/equip/default', { instanceId }); invalidatePersonSkins(); }, [cardSkinsEquipKey], instanceId ? t('skins.putOnDone') : t('skins.takenOff'));
  const equipGroup = (circleId: string, instanceId: string | null) =>
    run(async () => { await apiPut('/card-skins/equip/group', { circleId, instanceId }); invalidatePersonSkins(); }, [cardSkinsEquipKey], common('actions.done'));

  if (loading) return <p className="label-md">{t('skins.loading')}</p>;
  if (loadError && !wallet) return <p style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>{errMsg(loadError, t('skins.loadFailed'))}</p>;

  const defaultInst = inventory.find((i) => i.id === equip?.defaultInstanceId) || null;
  const previewSkin: CardSkinRender = defaultInst ? defaultInst.skin : DEFAULT_SKIN;

  return (
    <div>
      <h2 className="title-lg" style={{ marginBottom: 'var(--spacing-2)' }}>{t('skins.title')}</h2>
      <p className="label-sm" style={{ marginBottom: 'var(--spacing-6)', opacity: 0.7 }}>
        {t('skins.subtitle')}
      </p>

      {unknownOutcome != null && (
        <div style={{ marginBottom: 'var(--spacing-4)' }}>
          {/* Покупка МОГЛА пройти: смотреть надо в «Мои скины», а не жать «Купить» */}
          <OutcomeUnknownAlert error={unknownOutcome} onDismiss={() => setUnknownOutcome(null)} />
        </div>
      )}
      {error && <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginBottom: 'var(--spacing-4)' }}>{error}</p>}
      {ok && <p style={{ color: 'var(--secondary)', fontSize: '0.85rem', marginBottom: 'var(--spacing-4)' }}>{ok}</p>}
      <SlowRequestNote pending={busy} />

      {/* ===== Wallet ===== */}
      <div className="card" style={{ padding: 'var(--spacing-4) var(--spacing-6)', maxWidth: 520, marginBottom: 'var(--spacing-8)', display: 'flex', alignItems: 'center', gap: 'var(--spacing-4)', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 160 }}>
          <div className="label-sm" style={{ opacity: 0.7 }}>{t('skins.balance')}</div>
          <div className="title-md">{wallet?.icon} {fmt(wallet?.balance ?? 0)} <span style={{ fontSize: '0.8rem', opacity: 0.6 }}>{wallet?.name}</span></div>
        </div>
        {/* Тестовое пополнение: маршрут существует только в development (в проде 404) —
            UI несуществующей фичи не показываем. Настоящее пополнение придёт с платёжным рельсом. */}
        {DEV_TOPUP && <div style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'flex-end' }}>
          <Input
            label={t('skins.topUpLabel')}
            type="number"
            min={1}
            value={topAmt}
            onChange={(e) => setTopAmt(e.target.value)}
            wrapClassName="skin-topup-field"
            style={{ padding: '0.3rem 0.5rem', fontSize: '0.85rem' }}
          />
          <button className="btn-success" disabled={busy} onClick={topUp} style={{ fontSize: '0.8rem' }}>{t('skins.topUp')}</button>
        </div>}
      </div>

      {/* ===== Live preview ===== */}
      {profile && (
        <div style={{ marginBottom: 'var(--spacing-8)' }}>
          <h3 className="title-md" style={{ marginBottom: 'var(--spacing-3)' }}>{t('skins.preview')}</h3>
          <PersonCard
            mode="full"
            initialSize="L"
            skin={previewSkin}
            profile={{
              firstName: profile.firstName ?? common('labels.dash'),
              lastName: profile.lastName ?? null,
              phone: profile.phone ?? '',
              avatar: null,
              dateOfBirth: profile.dateOfBirth ?? null,
              bio: profile.bio ?? null,
              city: profile.city ?? null,
              email: profile.email ?? null,
              maritalStatus: profile.maritalStatus ?? null,
              socialLinks: profile.socialLinks ?? null,
              cardVisibility: resolveCardVisibility(profile.cardVisibility),
            }}
          />
        </div>
      )}

      {/* ===== Shop ===== */}
      <h3 className="title-md" style={{ marginBottom: 'var(--spacing-3)' }}>{t('skins.shop')}</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 'var(--spacing-4)', marginBottom: 'var(--spacing-8)' }}>
        {catalog.map((s) => {
          const r = RARITY_META[s.rarity];
          return (
            <div key={s.id} className="card" style={{ padding: 'var(--spacing-3)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--spacing-2)' }}>
              <SkinSwatch skin={s} />
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '0.9rem' }}>{s.name}</div>
                <div style={{ fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: r.color }}>{tCircles(`rarity.${s.rarity}`)}</div>
              </div>
              <div className="label-sm" style={{ fontSize: '0.78rem' }}>
                {s.priceAmount > 0 ? <>{wallet?.icon} {fmt(s.priceAmount)}</> : t('skins.free')}
              </div>
              {s.supply !== null && (
                <div className="label-sm" style={{ fontSize: '0.66rem', opacity: 0.7 }}>
                  {s.soldOut ? t('skins.soldOut') : t('skins.remaining', { left: fmt(s.remaining ?? 0), total: fmt(s.supply) })}
                </div>
              )}
              <button
                className="btn-primary"
                disabled={busy || !s.available}
                onClick={() => buy(s.id)}
                style={{ fontSize: '0.78rem', padding: '0.3rem 0.9rem', opacity: s.available ? 1 : 0.5, cursor: s.available ? 'pointer' : 'not-allowed' }}
              >
                {s.soldOut ? t('skins.soldOut') : s.owned ? t('skins.buyMore') : t('skins.buy')}
              </button>
            </div>
          );
        })}
      </div>

      {/* ===== Inventory ===== */}
      <h3 className="title-md" style={{ marginBottom: 'var(--spacing-3)' }}>{t('skins.mine')}</h3>
      {inventory.length === 0 ? (
        <p className="label-md" style={{ marginBottom: 'var(--spacing-8)', opacity: 0.7 }}>{t('skins.noneBought')}</p>
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
                  <div style={{ fontSize: '0.66rem', fontWeight: 700, textTransform: 'uppercase', color: RARITY_META[i.skin.rarity].color }}>
                    {tCircles(`rarity.${i.skin.rarity}`)}
                  </div>
                </div>
                {isDefault ? (
                  <>
                    <span className="label-sm" style={{ color: 'var(--secondary)', fontWeight: 600 }}>{t('skins.equipped')}</span>
                    <button onClick={() => equipDefault(null)} disabled={busy} className="btn-ghost-inline" style={{ fontSize: '0.75rem', padding: '0.25rem 0.7rem' }}>{t('skins.takeOff')}</button>
                  </>
                ) : (
                  <button onClick={() => equipDefault(i.id)} disabled={busy} className="btn-primary" style={{ fontSize: '0.75rem', padding: '0.25rem 0.8rem' }}>{t('skins.putOn')}</button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ===== Per-group skins (premium) ===== */}
      <h3 className="title-md" style={{ marginBottom: 'var(--spacing-2)' }}>
        {t('skins.perGroup')}
      </h3>
      {/* Замок тарифа вместо надписи «premium»: объясняет, на какой ступени доступно */}
      <div style={{ marginBottom: 'var(--spacing-2)' }}>
        <EntitlementLock keyName="skins.perGroup" />
      </div>
      <p className="label-sm" style={{ marginBottom: 'var(--spacing-3)', opacity: 0.7 }}>
        {t('skins.perGroupText')}
      </p>
      {groups.length === 0 ? (
        <p className="label-md" style={{ opacity: 0.7 }}>{t('skins.noGroups')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)', maxWidth: 520 }}>
          {groups.map((g) => {
            const cur = equip?.perGroup.find((p) => p.circleId === g.id)?.instanceId ?? '';
            return (
              <div key={g.id} className="card" style={{ padding: 'var(--spacing-2) var(--spacing-4)', display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <GroupChip size="M" icon={g.icon} name={g.name} color={g.color} count={g.membersCount} />
                </div>
                <Select
                  aria-label={t('skins.groupAria', { name: g.name })}
                  value={cur}
                  disabled={busy || !equip?.premium}
                  onChange={(v) => equipGroup(g.id, v || null)}
                  width={180}
                  options={[
                    { value: '', label: t('skins.default') },
                    ...inventory.map((i) => ({
                      value: i.id,
                      label: `${i.skin.name}${i.serial !== null ? ` #${i.serial}` : ''}`,
                    })),
                  ]}
                />
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
      }}>{'A'}</div>
      {!mini && <div style={{ color: t.nameColor, fontFamily: t.nameFont, fontWeight: 700, fontSize: '0.72rem', letterSpacing: '0.04em' }}>{'NAME'}</div>}
    </div>
  );
}
