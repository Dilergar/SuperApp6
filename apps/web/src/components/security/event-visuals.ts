// Как событие журнала безопасности выглядит в ленте: значок и тон. Смысл несёт сервер
// (категория, серьёзность, исход); здесь — только соответствие смыслу рисунка кита.
// Тон: обычное — нейтральный; блокировка/отклонённый вход — предупреждение; заморозка,
// повтор токена и критичное — опасность (DESIGN.md: красный — только опасное).
import type { AuditCategory, AuditDeviceClass, SecurityEventDto } from '@superapp/shared';
import type { IconName, Tone } from '@/components/ui';

const CATEGORY_ICON: Record<AuditCategory, IconName> = {
  auth: 'signIn',
  session: 'device',
  account: 'user',
  org: 'workspace',
  keys: 'key',
  platform: 'shield',
  pii: 'eye',
  pd: 'database',
  consents: 'checkCircle',
  data: 'download',
  detect: 'shieldWarning',
  audit: 'history',
};

/** Ключи с собственным рисунком (важнее категории) */
const KEY_ICON: Partial<Record<string, IconName>> = {
  'auth.login.locked': 'lock',
  'auth.login.failed': 'lock',
  'auth.session.refresh_reuse': 'shieldWarning',
  'auth.session.new_device': 'device',
  'auth.session.new_country': 'mapPin',
  'auth.otp.locked': 'lock',
  'auth.password.changed': 'fingerprint',
  'auth.password.reset_completed': 'fingerprint',
  'auth.phone.changed': 'device',
  'auth.logout': 'signOut',
  'auth.logout_all': 'signOut',
  'account.frozen': 'snowflake',
  'account.unfrozen': 'lockOpen',
};

export function eventIcon(e: Pick<SecurityEventDto, 'key' | 'category'>): IconName {
  return KEY_ICON[e.key] ?? CATEGORY_ICON[e.category] ?? 'shield';
}

export function eventTone(e: Pick<SecurityEventDto, 'key' | 'severity' | 'outcome'>): Tone {
  if (e.key === 'account.frozen' || e.key === 'auth.session.refresh_reuse' || e.severity === 'critical') return 'danger';
  if (e.outcome === 'failure' || e.outcome === 'denied' || e.key === 'auth.login.locked') return 'warning';
  return 'neutral';
}

/** Исход — чипом: успех зелёный, отказ предупреждением, неизвестное — нейтральным. */
export function outcomeTone(outcome: SecurityEventDto['outcome']): Tone {
  if (outcome === 'success') return 'success';
  if (outcome === 'failure' || outcome === 'denied') return 'warning';
  return 'neutral';
}

export function deviceIcon(cls: AuditDeviceClass | null | undefined): IconName {
  switch (cls) {
    case 'desktop':
      return 'desktop';
    case 'tablet':
      return 'tablet';
    case 'mobile':
      return 'device';
    default:
      return 'laptop';
  }
}
