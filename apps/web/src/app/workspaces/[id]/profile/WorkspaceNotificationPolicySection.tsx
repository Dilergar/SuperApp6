'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import {
  NOTIFICATION_REGISTRY,
  defaultChannelsOf,
  type NotificationPolicyMode,
  type NotificationPrefChannel,
  type WorkspaceNotificationPolicyRuleDto,
  type WorkspaceNotificationPolicyServiceDto,
} from '@superapp/shared';
import { Alert, Button, Card, CardHeader, Icon, IconButton, LoadingBlock, SegmentedControl, useConfirm } from '@/components/ui';
import { toast, toastError } from '@/lib/toast';
import { apiErrorDetails, apiErrorMessage } from '@/lib/api';
import { workspaceNotificationPolicyKey } from '@/lib/queries';
import { fetchWorkspaceNotificationPolicy, putWorkspaceNotificationPolicy } from '@/lib/notifications-api';

// ============================================================
// Политика уведомлений организации (Salesforce Delivery Settings + Courier REQUIRED):
// только B2B-сервисы, строка = сервис (раскрывается до типов), ячейка = сегментный
// контрол «Вкл по умолчанию / Выкл по умолчанию / Обязательно»; «Обязательно» —
// только для lockable-типов и только в колонках «В приложении»/«Push». Сохранение —
// явной кнопкой; замки — с подтверждением («Сотрудники не смогут отключить…»).
// ============================================================

type RuleKey = `${'service' | 'type'}:${string}:${NotificationPrefChannel}`;
const keyOf = (kind: 'service' | 'type', key: string, channel: NotificationPrefChannel): RuleKey => `${kind}:${key}:${channel}`;

/**
 * Дефолт реестра для типа. Считается от ДЕКЛАРАЦИИ (`defaultChannelsOf`), а не от одного
 * приоритета: тип вправе переопределить каналы (`defaultChannels`), и сегментный контрол
 * показывал бы тогда чужое значение как «по умолчанию».
 */
const defaultsOf = (type: string) => defaultChannelsOf(NOTIFICATION_REGISTRY[type as keyof typeof NOTIFICATION_REGISTRY]);

export function WorkspaceNotificationPolicySection({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('notifications');
  const qc = useQueryClient();
  const [confirm, confirmUI] = useConfirm();
  const q = useQuery({ queryKey: workspaceNotificationPolicyKey(workspaceId), queryFn: () => fetchWorkspaceNotificationPolicy(workspaceId), retry: false });
  const [rules, setRules] = useState<Map<RuleKey, NotificationPolicyMode>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!q.data) return;
    setRules(new Map(q.data.rules.map((r) => [keyOf(r.subjectKind, r.subjectKey, r.channel), r.mode])));
  }, [q.data]);

  const savedLocks = useMemo(() => new Set((q.data?.rules ?? []).filter((r) => r.mode === 'locked_on').map((r) => keyOf(r.subjectKind, r.subjectKey, r.channel))), [q.data]);

  const save = useMutation({
    mutationFn: () => {
      const out: WorkspaceNotificationPolicyRuleDto[] = [];
      for (const [k, mode] of rules) {
        const [subjectKind, subjectKey, channel] = k.split(':') as ['service' | 'type', string, NotificationPrefChannel];
        out.push({ subjectKind, subjectKey, channel, mode });
      }
      return putWorkspaceNotificationPolicy(workspaceId, { rules: out });
    },
    onSuccess: (data) => {
      qc.setQueryData(workspaceNotificationPolicyKey(workspaceId), data);
      toast(t('policy.saved'), 'success');
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  if (q.isLoading) return <LoadingBlock />;
  if (q.isError) {
    const code = apiErrorDetails(q.error)?.code;
    return <Alert tone="warning">{code === 'notification.policy.noAccess' ? t('policy.noAccess') : apiErrorMessage(q.error)}</Alert>;
  }
  if (!q.data) return null;

  const onSave = () => {
    const newLocks = [...rules].some(([k, mode]) => mode === 'locked_on' && !savedLocks.has(k));
    if (newLocks) confirm({ title: t('policy.confirmTitle'), message: t('policy.confirmMessage') }, () => save.mutate());
    else save.mutate();
  };

  const setRule = (k: RuleKey, mode: NotificationPolicyMode | null) =>
    setRules((prev) => {
      const next = new Map(prev);
      if (mode === null) next.delete(k);
      else next.set(k, mode);
      return next;
    });

  const toggleExpanded = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const cellFor = (kind: 'service' | 'type', key: string, channel: NotificationPrefChannel, lockable: boolean, registryDefault: boolean, label: string) => {
    const k = keyOf(kind, key, channel);
    const rule = rules.get(k);
    const value: NotificationPolicyMode = rule ?? (registryDefault ? 'default_on' : 'default_off');
    const items = [
      { key: 'default_on' as const, label: t('policy.mode.default_on') },
      { key: 'default_off' as const, label: t('policy.mode.default_off') },
      ...(lockable ? [{ key: 'locked_on' as const, label: t('policy.mode.locked_on') }] : []),
    ];
    return (
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
        <SegmentedControl items={items} value={value} onChange={(m) => setRule(k, m)} aria-label={label} />
        {rule && <IconButton icon="undo" label={t('policy.reset')} size={28} onClick={() => setRule(k, null)} />}
      </div>
    );
  };

  return (
    <Card>
      <CardHeader
        title={t('policy.title')}
        subtitle={t('policy.description')}
        actions={<Button variant="primary" tone="success" size="sm" loading={save.isPending} onClick={onSave}>{t('policy.save')}</Button>}
      />
      <div className="meta" style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', color: 'var(--on-surface-variant)', marginBottom: 'var(--spacing-4)' }}>
        <span>{t('policy.legend.default_on')}</span>
        <span>{t('policy.legend.default_off')}</span>
        <span>{t('policy.legend.locked_on')}</span>
      </div>
      <div className="ntf-matrix">
        <div className="ntf-matrix-head ntf-policy-row label-caps">
          <span>{t('settings.matrix.service')}</span>
          <span className="ntf-matrix-cell">{t('settings.matrix.inapp')}</span>
          <span className="ntf-matrix-cell">{t('settings.matrix.push')}</span>
        </div>
        {q.data.services.map((s: WorkspaceNotificationPolicyServiceDto) => {
          const open = expanded.has(s.service);
          const name = t(`service.${s.service}`);
          const anyLockable = s.types.some((ty) => ty.lockable);
          const anyPushDefault = s.types.some((ty) => defaultsOf(ty.type).push);
          return (
            <div key={s.service}>
              <div className="ntf-matrix-row ntf-policy-row">
                <div className="ntf-matrix-name">
                  <IconButton icon={open ? 'caretUp' : 'caretDown'} label={open ? t('settings.matrix.collapse') : t('settings.matrix.expand')} size={28} onClick={() => toggleExpanded(s.service)} aria-expanded={open} />
                  <span className="title-sm">{name}</span>
                </div>
                <div className="ntf-matrix-cell">{cellFor('service', s.service, 'inapp', anyLockable, true, `${name} · ${t('settings.matrix.inapp')}`)}</div>
                <div className="ntf-matrix-cell">{cellFor('service', s.service, 'push', anyLockable, anyPushDefault, `${name} · ${t('settings.matrix.push')}`)}</div>
              </div>
              {open &&
                s.types.map((ty) => {
                  const label = t(`${ty.type}.label`);
                  const defaults = defaultsOf(ty.type);
                  return (
                    <div key={ty.type} className="ntf-matrix-row ntf-policy-row ntf-matrix-row--type">
                      <div className="ntf-matrix-name">
                        <Icon name={(ty.icon || 'bell') as never} size={16} />
                        <span className="label-md">{label}</span>
                      </div>
                      <div className="ntf-matrix-cell">{cellFor('type', ty.type, 'inapp', ty.lockable, defaults.inapp, `${label} · ${t('settings.matrix.inapp')}`)}</div>
                      <div className="ntf-matrix-cell">{cellFor('type', ty.type, 'push', ty.lockable, defaults.push, `${label} · ${t('settings.matrix.push')}`)}</div>
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
      {confirmUI}
    </Card>
  );
}
