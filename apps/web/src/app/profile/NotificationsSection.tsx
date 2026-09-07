'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import {
  NOTIFICATION_PERSONAL_CONTEXT,
  type NotificationPreferencesDto,
  type NotificationQuietRule,
  type NotificationServicePrefDto,
  type NotificationTypePrefDto,
} from '@superapp/shared';
import {
  Button, Card, CardHeader, Checkbox, Chip, Divider, EmptyState, Icon, IconButton, Input, LoadingBlock, Tabs, Toggle, Tooltip, useConfirm,
} from '@/components/ui';
import { useFormatters } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { apiErrorMessage } from '@/lib/api';
import {
  fetchWorkspaces, notificationDevicesKey, notificationPreferencesKey, notificationQuietKey, notificationsRootKey, workspacesKey,
} from '@/lib/queries';
import {
  copyNotificationPreferences,
  fetchNotificationDevices,
  fetchNotificationPreferences,
  fetchNotificationQuiet,
  putNotificationPreferences,
  putNotificationQuiet,
  removeNotificationDevice,
} from '@/lib/notifications-api';
import { PushToggle } from '@/components/notifications/PushToggle';

// ============================================================
// /profile/notifications: сверху — личные СКВОЗНЫЕ блоки («Тишина», «Устройства»),
// ниже — вкладки контекстов (Личное / каждая организация), в каждой три блока:
// матрица «сервисы × В приложении / Push» (раскрывается до типов, замок политики —
// Chip), «SMS для важного» (только при живом SMS-драйвере), «Всегда приходят».
// Email нигде не показывается (канала нет — UI несуществующих фич не рисуем).
// ============================================================

export function NotificationsSection() {
  const t = useTranslations('notifications');
  const shell = useTranslations('shell');
  const { data: workspaces = [] } = useQuery({ queryKey: workspacesKey, queryFn: fetchWorkspaces, staleTime: 60_000 });
  const [context, setContext] = useState<string>(NOTIFICATION_PERSONAL_CONTEXT);

  const tabs = useMemo(
    () => [{ key: NOTIFICATION_PERSONAL_CONTEXT, label: shell('context.personal') }, ...workspaces.map((w) => ({ key: w.id, label: w.name }))],
    [workspaces, shell],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-5)' }}>
      <QuietBlock />
      <DevicesBlock />
      <Card>
        <CardHeader title={t('settings.contexts.title')} subtitle={t('settings.contexts.description')} />
        {tabs.length > 1 && (
          <div style={{ marginBottom: 'var(--spacing-4)' }}>
            <Tabs items={tabs} value={context} onChange={setContext} aria-label={t('settings.contexts.title')} />
          </div>
        )}
        <PreferencesMatrix context={context} otherWorkspaces={workspaces.length - (context === NOTIFICATION_PERSONAL_CONTEXT ? 0 : 1)} />
      </Card>
    </div>
  );
}

// ---------- Тишина ----------

const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];
const WEEKEND = [6, 7];

function QuietBlock() {
  const t = useTranslations('notifications');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: notificationQuietKey, queryFn: fetchNotificationQuiet });
  const [enabled, setEnabled] = useState(false);
  const [from, setFrom] = useState('22:00');
  const [to, setTo] = useState('08:00');
  const [weekends, setWeekends] = useState(false);

  useEffect(() => {
    const rules = q.data?.schedule ?? [];
    const nightly = rules.find((r) => !(r.from === '00:00' && r.to === '00:00'));
    const wk = rules.find((r) => r.from === '00:00' && r.to === '00:00');
    setEnabled(!!nightly);
    if (nightly) {
      setFrom(nightly.from);
      setTo(nightly.to);
    }
    setWeekends(!!wk);
  }, [q.data]);

  const save = useMutation({
    mutationFn: () => {
      const schedule: NotificationQuietRule[] = [];
      if (enabled) schedule.push({ days: ALL_DAYS, from, to });
      if (weekends) schedule.push({ days: WEEKEND, from: '00:00', to: '00:00' });
      return putNotificationQuiet({ schedule: schedule.length ? schedule : null });
    },
    onSuccess: () => {
      toast(t('settings.quiet.saved'), 'success');
      void qc.invalidateQueries({ queryKey: notificationQuietKey });
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  return (
    <Card>
      <CardHeader
        title={t('settings.quiet.title')}
        subtitle={t('settings.quiet.description')}
        actions={q.data?.activeNow ? <Chip tone="waiting" icon="moon">{t('settings.quiet.activeNow')}</Chip> : undefined}
      />
      {q.isLoading ? (
        <LoadingBlock />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
          <Toggle checked={enabled} onChange={setEnabled} label={t('settings.quiet.enable')} description={t('settings.quiet.timezone', { tz: q.data?.timezone ?? '' })} />
          {enabled && (
            <div style={{ display: 'flex', gap: 'var(--spacing-4)', flexWrap: 'wrap' }}>
              <Input type="time" label={t('settings.quiet.from')} value={from} onChange={(e) => setFrom(e.target.value)} wrapClassName="ntf-time" />
              <Input type="time" label={t('settings.quiet.to')} value={to} onChange={(e) => setTo(e.target.value)} wrapClassName="ntf-time" />
            </div>
          )}
          <Checkbox checked={weekends} onChange={setWeekends} label={t('settings.quiet.weekends')} />
          <div>
            <Button variant="primary" tone="success" size="sm" loading={save.isPending} onClick={() => save.mutate()}>
              {t('settings.quiet.save')}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

// ---------- Устройства ----------

function DevicesBlock() {
  const t = useTranslations('notifications');
  const f = useFormatters();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: notificationDevicesKey, queryFn: fetchNotificationDevices });
  const remove = useMutation({
    mutationFn: (id: string) => removeNotificationDevice({ id }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: notificationDevicesKey }),
    onError: (e) => toastError(apiErrorMessage(e)),
  });
  const devices = q.data ?? [];
  return (
    <Card>
      <CardHeader title={t('settings.devices.title')} subtitle={t('settings.devices.description')} />
      <PushToggle />
      <Divider />
      {q.isLoading ? (
        <LoadingBlock />
      ) : devices.length === 0 ? (
        <EmptyState icon="device" title={t('settings.devices.empty')} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {devices.map((d) => (
            <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', padding: '0.5rem 0', borderBottom: '1px solid var(--divider)' }}>
              <Icon name={d.platform === 'web' ? 'globe' : 'device'} size={18} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="label-md" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t(`settings.devices.platform.${d.platform}`)}
                  {d.userAgent ? ` · ${d.userAgent.slice(0, 60)}` : ''}
                </div>
                <div className="meta" style={{ color: 'var(--on-surface-variant)' }}>
                  {t('settings.devices.lastSeen', { time: f.dateTime(d.lastSeenAt) })}
                </div>
              </div>
              {d.disabledAt && <Chip size="sm">{t('settings.devices.disabled')}</Chip>}
              <IconButton icon="delete" label={t('settings.devices.remove')} size={32} onClick={() => remove.mutate(d.id)} />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ---------- Матрица «сервис × канал» ----------

function PreferencesMatrix({ context, otherWorkspaces }: { context: string; otherWorkspaces: number }) {
  const t = useTranslations('notifications');
  const qc = useQueryClient();
  const [confirm, confirmUI] = useConfirm();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showAlways, setShowAlways] = useState(false);
  const q = useQuery({ queryKey: notificationPreferencesKey(context), queryFn: () => fetchNotificationPreferences(context) });

  const put = useMutation({
    mutationFn: (overrides: { subjectKind: 'service' | 'type'; subjectKey: string; channel: 'inapp' | 'push' | 'sms'; enabled: boolean | null }[]) =>
      putNotificationPreferences({ context, overrides }),
    onSuccess: (data) => {
      qc.setQueryData(notificationPreferencesKey(context), data);
      void qc.invalidateQueries({ queryKey: notificationsRootKey, exact: false, predicate: (qk) => qk.queryKey[1] !== 'preferences' });
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });
  const copy = useMutation({
    mutationFn: () => copyNotificationPreferences({ fromContext: context }),
    onSuccess: (r) => {
      toast(r.copiedTo.length ? t('settings.copy.done', { n: r.copiedTo.length }) : t('settings.copy.none'), 'success');
      void qc.invalidateQueries({ queryKey: notificationsRootKey });
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  if (q.isLoading || !q.data) return <LoadingBlock />;
  const data: NotificationPreferencesDto = q.data;
  const toggleExpanded = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const cell = (kind: 'service' | 'type', key: string, channel: 'inapp' | 'push', c: { enabled: boolean; locked: boolean }, label: string) =>
    c.locked ? (
      <Tooltip content={t('settings.matrix.lockedHint')}>
        <span>
          <Chip size="sm" tone="accent" icon="lock">{t('settings.matrix.locked')}</Chip>
        </span>
      </Tooltip>
    ) : (
      <Toggle checked={c.enabled} onChange={(v) => put.mutate([{ subjectKind: kind, subjectKey: key, channel, enabled: v }])} aria-label={label} />
    );

  const smsEligible = data.critical.filter((c) => c.smsEligible);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-5)' }}>
      {data.services.length === 0 ? (
        <EmptyState icon="bell" title={t('settings.matrix.empty')} />
      ) : (
        <div className="ntf-matrix">
          <div className="ntf-matrix-head label-caps">
            <span>{t('settings.matrix.service')}</span>
            <span className="ntf-matrix-cell">{t('settings.matrix.inapp')}</span>
            <span className="ntf-matrix-cell">{t('settings.matrix.push')}</span>
          </div>
          {data.services.map((s: NotificationServicePrefDto) => {
            const open = expanded.has(s.service);
            const name = t(`service.${s.service}`);
            return (
              <div key={s.service}>
                <div className="ntf-matrix-row">
                  <div className="ntf-matrix-name">
                    <IconButton
                      icon={open ? 'caretUp' : 'caretDown'}
                      label={open ? t('settings.matrix.collapse') : t('settings.matrix.expand')}
                      size={28}
                      onClick={() => toggleExpanded(s.service)}
                      aria-expanded={open}
                    />
                    <span className="title-sm">{name}</span>
                  </div>
                  <div className="ntf-matrix-cell">{cell('service', s.service, 'inapp', s.channels.inapp, `${name} · ${t('settings.matrix.inapp')}`)}</div>
                  <div className="ntf-matrix-cell">{cell('service', s.service, 'push', s.channels.push, `${name} · ${t('settings.matrix.push')}`)}</div>
                </div>
                {open &&
                  s.types.map((ty: NotificationTypePrefDto) => {
                    const label = t(`${ty.type}.label`);
                    return (
                      <div key={ty.type} className="ntf-matrix-row ntf-matrix-row--type">
                        <div className="ntf-matrix-name">
                          <Icon name={(ty.icon || 'bell') as never} size={16} />
                          <span className="label-md">{label}</span>
                        </div>
                        <div className="ntf-matrix-cell">{cell('type', ty.type, 'inapp', ty.channels.inapp, `${label} · ${t('settings.matrix.inapp')}`)}</div>
                        <div className="ntf-matrix-cell">{cell('type', ty.type, 'push', ty.channels.push, `${label} · ${t('settings.matrix.push')}`)}</div>
                      </div>
                    );
                  })}
              </div>
            );
          })}
        </div>
      )}

      {data.smsLive && smsEligible.length > 0 && (
        <div>
          <CardHeader title={t('settings.sms.title')} subtitle={t('settings.sms.description')} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
            {smsEligible.map((c) => (
              <Toggle
                key={c.type}
                checked={c.smsOptIn}
                onChange={(v) => put.mutate([{ subjectKind: 'type', subjectKey: c.type, channel: 'sms', enabled: v }])}
                label={t(`${c.type}.label`)}
              />
            ))}
          </div>
        </div>
      )}

      {data.critical.length > 0 && (
        <div>
          <CardHeader
            title={t('settings.always.title')}
            subtitle={t('settings.always.description')}
            actions={
              <Button variant="ghost" size="sm" onClick={() => setShowAlways((v) => !v)}>
                {showAlways ? t('settings.always.hide') : t('settings.always.show')}
              </Button>
            }
          />
          {showAlways && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem' }}>
              {data.critical.map((c) => (
                <Chip key={c.type} icon={(c.icon || 'bell') as never}>{t(`${c.type}.label`)}</Chip>
              ))}
            </div>
          )}
        </div>
      )}

      {context !== NOTIFICATION_PERSONAL_CONTEXT && otherWorkspaces > 0 && (
        <div>
          <Button
            variant="outline"
            size="sm"
            icon="copy"
            loading={copy.isPending}
            onClick={() => confirm({ title: t('settings.copy.confirmTitle'), message: t('settings.copy.confirmMessage') }, () => copy.mutate())}
          >
            {t('settings.copy.button')}
          </Button>
        </div>
      )}
      {confirmUI}
    </div>
  );
}
