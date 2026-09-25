'use client';

import { useTranslations } from 'next-intl';
import { DELETED_USER_MARKER } from '@superapp/i18n/person-marker';
import { useFormatters } from '@/lib/format';

// Icon — напрямую из файла, не из барабана '@/components/ui': этот модуль сидит
// в корневом графе (аватар топбара), и барабан утащил бы туда весь кит.
import { Icon } from '@/components/ui/Icon';
import type { MessageDeliveryStatus, CardSkinRender } from '@superapp/shared';
import { usePersonSkin } from '@/lib/person-skins';
import type { LocalSendState } from './local-message';
import { ensureReadableInk } from '@/lib/contrast';

// ============================================================
// Small presentational helpers shared across the Messenger UI.
// Sketchbook look: warm paper layers, no 1px gray borders.
// ============================================================

/**
 * Initials/photo block — mirrors the circles Avatar. When a `skin` is given it
 * adopts the person's skin colors + frame ring (the small-size skin surface).
 */
export function Avatar({
  name,
  avatar,
  size = 'md',
  skin,
}: {
  name: string;
  avatar?: string | null;
  size?: 'sm' | 'md' | 'lg';
  skin?: CardSkinRender | null;
}) {
  const dims = size === 'lg' ? '3rem' : size === 'sm' ? '2rem' : '2.6rem';
  const fs = size === 'lg' ? '1.2rem' : size === 'sm' ? '0.8rem' : '1rem';
  const initial = (name || '?').charAt(0).toUpperCase();
  const t = skin?.tokens;
  const radius = t?.avatarRadius || 'var(--radius-sketch)';
  // Инициалы — функциональный текст: по ним человека узнают, когда фото нет.
  // Пара «фон + чернила» приезжает из ДАННЫХ скина, и живые скины давали 3.7:1
  // и 4.0:1 при требовании продукта ≥4.5:1 — гвард дотемняет ЧЕРНИЛА САМОГО СКИНА
  // (новый цвет не выдумывается), непонятный формат оставляет как есть.
  const inkColor = t?.avatarBg && t?.avatarColor ? ensureReadableInk(t.avatarBg, t.avatarColor) : t?.avatarColor;

  const inner = avatar ? (
    <img
      src={avatar}
      alt={name}
      style={{
        width: dims, height: dims, borderRadius: radius, objectFit: 'cover',
        flexShrink: 0, border: t?.avatarInnerBorder,
      }}
    />
  ) : (
    <div
      style={{
        width: dims, height: dims, borderRadius: radius,
        background: t?.avatarBg || 'var(--secondary-container)',
        color: inkColor || 'var(--secondary)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: fs,
        flexShrink: 0, border: t?.avatarInnerBorder,
      }}
    >
      {initial}
    </div>
  );

  // No skin → plain avatar. With a skin → wrap in the skin's frame ring.
  if (!t) return inner;
  return (
    <div style={{ display: 'inline-flex', padding: 2, borderRadius: radius, border: t.avatarRing, flexShrink: 0 }}>
      {inner}
    </div>
  );
}

/**
 * Reusable "person avatar" — resolves the person's equipped skin (batched +
 * cached) and renders the skin-aware Avatar. Use this anywhere a person is
 * shown so the skin is consistent everywhere. Falls back to the plain avatar
 * when there is no userId or no equipped skin.
 */
export function PersonAvatar({
  userId,
  name,
  avatar,
  size = 'md',
}: {
  userId?: string | null;
  name: string;
  avatar?: string | null;
  size?: 'sm' | 'md' | 'lg';
}) {
  const skin = usePersonSkin(userId);
  const tc = useTranslations('common');
  // Стёртый человек: имя-маркер томбстоуна → метка на языке зрителя
  const shown = name.trim() === DELETED_USER_MARKER ? tc('labels.deletedUser') : name;
  return <Avatar name={shown} avatar={avatar} size={size} skin={skin} />;
}

/** Галочки на МОИХ сообщениях: одна — отправлено, две — доставлено, две синие — прочитано. */
export function StatusTicks({ status }: { status?: MessageDeliveryStatus }) {
  const t = useTranslations('messenger');
  if (!status) return null;
  const read = status === 'read';
  const doubled = status === 'delivered' || status === 'read';
  return (
    <span
      title={t(status === 'sent' ? 'messages.sent' : status === 'delivered' ? 'messages.delivered' : 'messages.read')}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        marginLeft: '0.2rem',
        color: read ? 'var(--primary)' : 'rgba(255,255,255,0.75)',
      }}
    >
      <Icon name="check" size={12} />
      {doubled && <Icon name="check" size={12} style={{ marginLeft: -6 }} />}
    </span>
  );
}

/**
 * Состояние ОТПРАВКИ моего пузыря вместо галочек: «отправляется» — пока запрос в
 * пути, «Не отправлено · Повторить» — когда он не удался. Пузырь при этом НЕ
 * исчезает: повтор уходит с тем же ключом, и в чате окажется одно сообщение.
 */
export function SendState({ state, onRetry }: { state: LocalSendState; onRetry?: () => void }) {
  const t = useTranslations('messenger');
  if (state === 'pending') {
    return (
      <span
        className="label-sm"
        style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem', fontSize: '0.66rem', opacity: 0.7 }}
      >
        <Icon name="clock" size={11} />
        {t('messages.sending')}
      </span>
    );
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
      <span className="label-sm" style={{ fontSize: '0.66rem', color: 'var(--danger)' }}>
        {t('messages.notSent')}
      </span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="label-sm"
          style={{
            fontSize: '0.66rem',
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            color: 'var(--primary)',
            textDecoration: 'underline',
          }}
        >
          {t('messages.retrySend')}
        </button>
      )}
    </span>
  );
}

// ---- время: правила региона, слова языка зрителя ----

/**
 * Короткая отметка времени в списке чатов: сегодня — часы, вчера — «вчера»,
 * на этой неделе — день недели, дальше — дата. Всё через форматтеры языка:
 * `toLocaleDateString('ru-RU')` зашивал бы и язык, и страну навсегда.
 */
export function useListTime(): (iso: string) => string {
  const t = useTranslations('messenger');
  const f = useFormatters();
  return (iso: string) => {
    const d = new Date(iso);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return f.time(d);

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return t('messages.yesterday');

    const days = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
    return days < 7 ? f.weekday(d, 'short') : f.date(d, 'dayMonthLong');
  };
}

/** Часы под пузырём сообщения. */
export function useBubbleTime(): (iso: string) => string {
  const f = useFormatters();
  return (iso: string) => f.time(iso);
}
