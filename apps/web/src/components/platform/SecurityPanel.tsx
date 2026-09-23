'use client';

// Панели карточки 360 Кабинета (core/audit): `user.security` — заморозка, блокировка входа,
// сессии и устройства, открытые тревоги, последние события; `workspace.security` — окно
// журнала по тарифу, выгрузка/стрим, тревоги и последние события организации.
// «Открыть в журнале» ведёт в консоль «Безопасность» с фильтром по субъекту/организации.

import { useTranslations } from 'next-intl';
import type { PlatformUserSecurityPanelDto, PlatformWorkspaceSecurityPanelDto, SecurityEventDto } from '@superapp/shared';
import { Button, Chip, EmojiIcon } from '@/components/ui';
import { useFormatters } from '@/lib/format';
import { eventIcon, eventTone } from '@/components/security/event-visuals';

function RecentEvents({ items }: { items: SecurityEventDto[] }) {
  const t = useTranslations('platform');
  const fmt = useFormatters();
  if (!items.length) return <p className="label-sm">{t('card.empty')}</p>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
      {items.map((e) => (
        <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 }}>
          <EmojiIcon emoji={eventIcon(e)} tone={eventTone(e)} size={24} />
          <span className="body-sm" style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{e.title}</span>
          <span className="label-sm" style={{ whiteSpace: 'nowrap' }}>{fmt.dateTime(e.occurredAt, 'short')}</span>
        </div>
      ))}
    </div>
  );
}

export function UserSecurityPanel({ data, userId }: { data: PlatformUserSecurityPanelDto; userId: string }) {
  const t = useTranslations('platform');
  const fmt = useFormatters();
  return (
    <div className="ui-stack" style={{ gap: 'var(--spacing-3)' }}>
      <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap' }}>
        {data.frozenAt && <Chip tone="danger" icon="snowflake" size="sm">{t('security.panel.frozen', { date: fmt.date(data.frozenAt) })}</Chip>}
        {data.lockedUntil && <Chip tone="warning" icon="lock" size="sm">{t('security.panel.locked', { time: fmt.dateTime(data.lockedUntil, 'short') })}</Chip>}
        <Chip tone="neutral" icon="device" size="sm">{t('security.panel.sessions', { n: data.activeSessions })}</Chip>
        <Chip tone="neutral" icon="desktop" size="sm">{t('security.panel.devices', { n: data.devices })}</Chip>
        {data.openAlerts.length > 0 && <Chip tone="warning" icon="shieldWarning" size="sm">{t('security.panel.openAlerts', { n: data.openAlerts.length })}</Chip>}
      </div>
      <span className="label-caps">{t('security.panel.recent')}</span>
      <RecentEvents items={data.recent} />
      <div>
        <Button size="sm" variant="outline" icon="list" href={`/platform/audit?tab=events&subject=${userId}`}>{t('security.panel.openLog')}</Button>
      </div>
    </div>
  );
}

export function WorkspaceSecurityPanel({ data, workspaceId }: { data: PlatformWorkspaceSecurityPanelDto; workspaceId: string }) {
  const t = useTranslations('platform');
  return (
    <div className="ui-stack" style={{ gap: 'var(--spacing-3)' }}>
      <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap' }}>
        <Chip tone="neutral" icon="history" size="sm">{t('security.panel.window', { days: data.retentionDays })}</Chip>
        <Chip tone={data.canExport ? 'success' : 'neutral'} size="sm">{t(data.canExport ? 'security.panel.exportOn' : 'security.panel.exportOff')}</Chip>
        <Chip tone={data.canStream ? 'success' : 'neutral'} size="sm">{t(data.canStream ? 'security.panel.streamOn' : 'security.panel.streamOff')}</Chip>
        {data.openAlerts.length > 0 && <Chip tone="warning" icon="shieldWarning" size="sm">{t('security.panel.openAlerts', { n: data.openAlerts.length })}</Chip>}
      </div>
      <span className="label-caps">{t('security.panel.recent')}</span>
      <RecentEvents items={data.recent} />
      <div>
        <Button size="sm" variant="outline" icon="list" href={`/platform/audit?tab=events&workspace=${workspaceId}`}>{t('security.panel.openLog')}</Button>
      </div>
    </div>
  );
}
