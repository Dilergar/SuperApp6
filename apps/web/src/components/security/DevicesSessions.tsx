'use client';

// «Устройства и сессии» (core/audit): сессия = один вход (семейство refresh-цепочки), устройство —
// клиентский `X-Device-Id`. Активные — со статусом (это устройство / новое до подтверждения /
// подтверждено) и меню действий; вышедшие за 90 дней — свёрнутой группой с причиной словом.
// Завершить чужую сессию, выйти везде и забыть устройство сервер разрешает только
// подтверждённой сессии (cooling) — отказ открывает подтверждение по SMS.

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AUDIT_ERROR_CODES, type SecuritySessionDto, type UserDeviceDto } from '@superapp/shared';
import { Alert, Button, Card, CardHeader, Chip, EmojiIcon, Input, LoadingBlock, Menu, Modal, useConfirm, type MenuAction } from '@/components/ui';
import { apiErrorDetails } from '@/lib/api';
import { toastApiError } from '@/lib/api-errors';
import { toast } from '@/lib/toast';
import { endSecuritySession, fetchSecurityDevices, fetchSecuritySessions, forgetSecurityDevice, logoutEverywhere, renameSecurityDevice } from '@/lib/audit-api';
import { securityDevicesKey, securityRootKey, securitySessionsKey } from '@/lib/queries';
import { useFormatters } from '@/lib/format';
import { deviceIcon } from './event-visuals';

/** «5 минут назад» — словами каталога; старше суток — датой. */
export function useAgo(): (iso: string) => string {
  const tc = useTranslations('common');
  const fmt = useFormatters();
  return (iso: string) => {
    const min = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
    if (min < 1) return tc('presence.justNow');
    if (min < 60) return tc('presence.minutesAgo', { n: min });
    if (min < 24 * 60) return tc('presence.hoursAgo', { n: Math.floor(min / 60) });
    return fmt.date(iso);
  };
}

/** Сколько активных сессий видно сразу (текущая идёт первой); остальные — по «Показать все» */
const VISIBLE_ACTIVE = 5;

const hoursLeft = (iso: string) => Math.max(1, Math.ceil((Date.parse(iso) - Date.now()) / 3_600_000));

export function DevicesSessions({ onNeedConfirm }: { onNeedConfirm: () => void }) {
  const t = useTranslations('audit');
  const tc = useTranslations('common');
  const fmt = useFormatters();
  const ago = useAgo();
  const qc = useQueryClient();
  const [confirm, confirmUI] = useConfirm();
  const [showEnded, setShowEnded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [renaming, setRenaming] = useState<UserDeviceDto | null>(null);
  const [busy, setBusy] = useState(false);

  const sessions = useQuery({ queryKey: securitySessionsKey, queryFn: fetchSecuritySessions });
  const devices = useQuery({ queryKey: securityDevicesKey, queryFn: fetchSecurityDevices });
  const deviceById = useMemo(() => new Map((devices.data ?? []).map((d) => [d.deviceId, d])), [devices.data]);

  const refresh = () => void qc.invalidateQueries({ queryKey: securityRootKey });
  /** Отказ cooling — не ошибка, а просьба подтвердить устройство. */
  const fail = (err: unknown) => {
    if (apiErrorDetails(err)?.code === AUDIT_ERROR_CODES.coolingPeriod) onNeedConfirm();
    else toastApiError(err);
  };

  const logoutAll = () =>
    confirm({ title: t('ui.devices.logoutAllTitle'), message: t('ui.devices.logoutAllText'), confirmLabel: t('ui.devices.logoutAll'), danger: true }, async () => {
      try {
        await logoutEverywhere();
        toast(t('ui.devices.loggedOutAll'), 'success');
        refresh();
      } catch (err) {
        fail(err);
      }
    });

  const endSession = (s: SecuritySessionDto) =>
    confirm({ title: t('ui.devices.endTitle'), message: t('ui.devices.endText'), confirmLabel: t('ui.devices.end'), danger: true }, async () => {
      try {
        await endSecuritySession(s.id);
        toast(t('ui.devices.ended'), 'success');
        refresh();
      } catch (err) {
        fail(err);
      }
    });

  const forget = (d: UserDeviceDto) =>
    confirm({ title: t('ui.devices.forgetTitle'), message: t('ui.devices.forgetText'), confirmLabel: t('ui.devices.forget'), danger: true }, async () => {
      try {
        await forgetSecurityDevice(d.id);
        toast(t('ui.devices.forgotten'), 'success');
        refresh();
      } catch (err) {
        fail(err);
      }
    });

  const menuFor = (s: SecuritySessionDto, ended: boolean): MenuAction[] => {
    const device = s.deviceId ? deviceById.get(s.deviceId) : undefined;
    const items: MenuAction[] = [];
    if (!ended && !s.isCurrent) items.push({ key: 'end', label: t('ui.devices.end'), icon: 'signOut', danger: true, onClick: () => endSession(s) });
    if (device) {
      items.push({ key: 'rename', label: t('ui.devices.rename'), icon: 'edit', onClick: () => setRenaming(device) });
      if (!device.isCurrent) items.push({ key: 'forget', label: t('ui.devices.forget'), icon: 'delete', danger: true, onClick: () => forget(device), separatorBefore: items.length > 0 });
    }
    return items;
  };

  const row = (s: SecuritySessionDto, ended: boolean) => {
    const label = s.device.label ?? t('unknownDevice');
    const meta = [
      s.country ? fmt.country(s.country) : null,
      ended ? (s.revokedAt ? t('ui.devices.endedAt', { date: fmt.date(s.revokedAt) }) : null) : t('ui.devices.active', { ago: ago(s.lastSeenAt) }),
      ended ? (s.revokedReason ? t(`revokeReasons.${s.revokedReason}`) : null) : t('ui.devices.signedIn', { date: fmt.dateTime(s.createdAt) }),
    ].filter((x): x is string => !!x);
    const items = menuFor(s, ended);
    return (
      <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', padding: 'var(--spacing-3) 0', opacity: ended ? 0.75 : 1 }}>
        <EmojiIcon emoji={deviceIcon(s.device.class)} tone="neutral" size={40} />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <span className="title-sm" style={{ overflowWrap: 'anywhere' }}>{label}</span>
            {!ended && s.isCurrent && <Chip tone="accent" size="sm">{t('ui.devices.thisDevice')}</Chip>}
            {!ended && !s.confirmedAt && s.confirmAt && <Chip tone="waiting" size="sm">{t('ui.devices.pending', { hours: hoursLeft(s.confirmAt) })}</Chip>}
            {!ended && s.confirmedAt && <Chip tone="success" size="sm">{t('ui.devices.confirmed')}</Chip>}
          </div>
          <span className="label-sm">{meta.join(' · ')}</span>
        </div>
        {items.length > 0 && <Menu items={items} label={t('ui.devices.menu')} />}
      </div>
    );
  };

  const active = sessions.data?.active ?? [];
  const ended = sessions.data?.ended ?? [];

  return (
    <Card span={12}>
      {confirmUI}
      <CardHeader
        title={t('ui.devices.title')}
        actions={
          active.length > 1 ? (
            <Button variant="matte" tone="danger" icon="signOut" size="sm" onClick={logoutAll}>{t('ui.devices.logoutAll')}</Button>
          ) : undefined
        }
      />
      {sessions.isPending ? (
        <LoadingBlock />
      ) : sessions.isError ? (
        <Alert tone="danger" action={<Button size="sm" variant="ghost" icon="refresh" onClick={() => void sessions.refetch()}>{tc('actions.retry')}</Button>}>
          {t('ui.devices.loadFailed')}
        </Alert>
      ) : (
        <>
          <div role="list">
            {(showAll ? active : active.slice(0, VISIBLE_ACTIVE)).map((s) => (
              <div role="listitem" key={s.id}>{row(s, false)}</div>
            ))}
          </div>
          {active.length > VISIBLE_ACTIVE && (
            <Button variant="ghost" size="sm" icon="list" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
              {showAll ? t('ui.devices.showLess') : t('ui.devices.showAll', { count: active.length })}
            </Button>
          )}
          {active.length <= 1 && <p className="label-sm">{t('ui.devices.onlyThis')}</p>}
          {ended.length > 0 && (
            <div style={{ marginTop: 'var(--spacing-3)' }}>
              <Button variant="ghost" size="sm" icon="history" aria-expanded={showEnded} onClick={() => setShowEnded((v) => !v)}>
                {t('ui.devices.showEnded', { count: ended.length })}
              </Button>
              {showEnded && <div role="list">{ended.slice(0, 50).map((s) => <div role="listitem" key={s.id}>{row(s, true)}</div>)}</div>}
            </div>
          )}
        </>
      )}
      {renaming && (
        <RenameDialog
          device={renaming}
          busy={busy}
          onClose={() => setRenaming(null)}
          onSave={async (label) => {
            setBusy(true);
            try {
              await renameSecurityDevice(renaming.id, label);
              toast(t('ui.devices.renamed'), 'success');
              setRenaming(null);
              refresh();
            } catch (err) {
              toastApiError(err);
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
    </Card>
  );
}

function RenameDialog({ device, busy, onClose, onSave }: { device: UserDeviceDto; busy: boolean; onClose: () => void; onSave: (label: string) => Promise<void> }) {
  const t = useTranslations('audit');
  const tc = useTranslations('common');
  const [label, setLabel] = useState(device.label);
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={t('ui.devices.rename')}
      footer={
        <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose} disabled={busy}>{tc('actions.cancel')}</Button>
          <Button variant="primary" tone="success" loading={busy} disabled={!label.trim()} onClick={() => void onSave(label.trim())}>{tc('actions.save')}</Button>
        </div>
      }
    >
      <Input label={t('ui.devices.renameLabel')} value={label} maxLength={64} onChange={(e) => setLabel(e.target.value)} autoFocus />
    </Modal>
  );
}
