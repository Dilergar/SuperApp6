'use client';

// ============================================================
// Исходящие вебхуки (core/webhooks): endpoint'ы организации, события по сервисам,
// секрет подписи show-once (Standard Webhooks), ротация с перекрытием, проверочный
// пинг, доставки с повтором. Создание/ротация — под step-up (провайдер на странице).
// ============================================================

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { WEBHOOK_LIMITS, type WebhookDeliveryDto, type WebhookEndpointCreatedDto, type WebhookEndpointDto, type WebhookEventKey, type WebhookSigning } from '@superapp/shared';
import { apiErrorMessage } from '@/lib/api';
import { useFormatters } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { createWebhookEndpoint, deleteWebhookEndpoint, fetchWebhookDeliveries, fetchWebhookEndpoints, fetchWebhookEvents, probeWebhookEndpoint, redeliverWebhook, rotateWebhookSecret, updateWebhookEndpoint } from '@/lib/keys-api';
import { keysRegistryRootKey, webhooksDeliveriesKey, webhooksEndpointsKey, webhooksEventsKey } from '@/lib/queries';
import { KeyRevealOnce, KeyStatusChip, useKeysStepUp } from '@/components/keys';
import { EntitlementLock, useEntitlementGate } from '@/components/entitlements';
import { Alert, Button, Card, Checkbox, Chip, EmptyState, Field, Input, LoadingBlock, Menu, Modal, Select, Skeleton, Tooltip, useConfirm } from '@/components/ui';

export function WebhooksTab({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('keys');
  const qc = useQueryClient();
  const stepUp = useKeysStepUp();
  const [confirm, confirmNode] = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);
  const [edit, setEdit] = useState<WebhookEndpointDto | null>(null);
  const [rotated, setRotated] = useState<WebhookEndpointCreatedDto | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const gate = useEntitlementGate('webhooks.maxEndpoints', workspaceId);

  const endpoints = useQuery({ queryKey: webhooksEndpointsKey(workspaceId), queryFn: () => fetchWebhookEndpoints(workspaceId) });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: webhooksEndpointsKey(workspaceId) });
    void qc.invalidateQueries({ queryKey: keysRegistryRootKey(workspaceId) });
  };
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn();
      invalidate();
      if (done) toast(done, 'success');
    } catch (err) {
      toastError(apiErrorMessage(err));
    }
  };

  const onRotate = (e: WebhookEndpointDto) =>
    confirm({ title: t('webhook.rotateConfirm.title'), message: t('webhook.rotateConfirm.message', { hours: WEBHOOK_LIMITS.prevSecretHours }), confirmLabel: t('actions.rotate') }, async () => {
      const res = await stepUp.withStepUp(() => rotateWebhookSecret(workspaceId, e.id, { prevHours: WEBHOOK_LIMITS.prevSecretHours }));
      if (res) { setRotated(res); invalidate(); }
    });
  const onDelete = (e: WebhookEndpointDto) =>
    confirm({ title: t('webhook.deleteConfirm.title'), message: t('webhook.deleteConfirm.message'), confirmLabel: t('actions.delete'), danger: true }, () => act(() => deleteWebhookEndpoint(workspaceId, e.id), t('webhook.deletedToast')));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
        <p className="label-md" style={{ lineHeight: 1.55, maxWidth: '48rem' }}>{t('webhook.intro')}</p>
        <span style={{ display: 'inline-flex', gap: 'var(--spacing-2)', alignItems: 'center' }}>
          <EntitlementLock keyName="webhooks.maxEndpoints" workspaceId={workspaceId} id={gate.lockId} />
          <Button variant="primary" icon="webhook" onClick={() => setCreateOpen(true)} disabled={gate.blocked} aria-describedby={gate.describedBy}>{t('actions.createWebhook')}</Button>
        </span>
      </div>

      {endpoints.isPending ? (
        <LoadingBlock />
      ) : (endpoints.data ?? []).length === 0 ? (
        <Card><EmptyState icon="webhook" title={t('webhook.empty.title')} description={t('webhook.empty.body')} action={<Button variant="primary" icon="webhook" onClick={() => setCreateOpen(true)} disabled={gate.blocked}>{t('actions.createWebhook')}</Button>} /></Card>
      ) : (
        <div style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
          {(endpoints.data ?? []).map((e) => {
            const menu = [
              { key: 'deliveries', label: t('webhook.deliveries'), icon: 'list' as const, onClick: () => setOpenId(openId === e.id ? null : e.id) },
              { key: 'probe', label: t('actions.probe'), icon: 'send' as const, onClick: () => act(() => probeWebhookEndpoint(workspaceId, e.id), t('webhook.probeToast')) },
              { key: 'edit', label: t('actions.edit'), icon: 'edit' as const, onClick: () => setEdit(e) },
              { key: 'rotate', label: t('webhook.rotateSecret'), icon: 'refresh' as const, separatorBefore: true, onClick: () => onRotate(e) },
              ...(e.status === 'disabled'
                ? [{ key: 'enable', label: t('actions.enable'), icon: 'play' as const, onClick: () => act(() => updateWebhookEndpoint(workspaceId, e.id, { enabled: true }), t('webhook.enabledToast')) }]
                : [{ key: 'disable', label: t('actions.disable'), icon: 'blocked' as const, onClick: () => act(() => updateWebhookEndpoint(workspaceId, e.id, { enabled: false }), t('webhook.disabledToast')) }]),
              { key: 'delete', label: t('actions.delete'), icon: 'delete' as const, danger: true, separatorBefore: true, onClick: () => onDelete(e) },
            ];
            return (
              <Card key={e.id}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.9rem', wordBreak: 'break-all' }}>{e.url}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem', marginTop: 'var(--spacing-2)', alignItems: 'center' }}>
                      <KeyStatusChip status={e.status} />
                      <Chip size="sm" tone="neutral" icon="shield">{t(`webhook.signing.${e.signing}`)}</Chip>
                      <Chip size="sm" tone="neutral">{t('registry.eventsCount', { count: e.events.length })}</Chip>
                      {e.failures > 0 && <Chip size="sm" tone="warning" icon="warning">{t('webhook.failures', { count: e.failures })}</Chip>}
                      {e.prevSecretUntil && Date.parse(e.prevSecretUntil) > Date.now() && <Chip size="sm" tone="accent" icon="hourglass">{t('webhook.prevSecretLive')}</Chip>}
                    </div>
                    {e.status === 'disabled' && e.disabledReason && <p className="label-sm" style={{ marginTop: 'var(--spacing-2)' }}>{t(`webhook.disabledReason.${e.disabledReason}`)}</p>}
                    {e.status === 'pending_verification' && <p className="label-sm" style={{ marginTop: 'var(--spacing-2)' }}>{t('webhook.pendingHint')}</p>}
                  </div>
                  <Menu items={menu} />
                </div>
                <EventChips events={e.events} />
                {e.publicKey && (
                  <Tooltip content={e.publicKey}>
                    <p className="label-sm" style={{ marginTop: 'var(--spacing-2)', fontFamily: 'ui-monospace, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t('webhook.publicKey')}: {e.publicKey}</p>
                  </Tooltip>
                )}
                {openId === e.id && <Deliveries workspaceId={workspaceId} endpointId={e.id} />}
              </Card>
            );
          })}
        </div>
      )}

      <EndpointDialog open={createOpen} onClose={() => setCreateOpen(false)} workspaceId={workspaceId} onCreate={(input) => stepUp.withStepUp(() => createWebhookEndpoint(workspaceId, input))} onCreated={invalidate} />
      {edit && <EndpointDialog open onClose={() => setEdit(null)} workspaceId={workspaceId} endpoint={edit} onUpdate={async (events) => { await updateWebhookEndpoint(workspaceId, edit.id, { events }); invalidate(); setEdit(null); }} />}
      <Modal open={!!rotated} onClose={() => setRotated(null)} hideClose closeOnBackdrop={false} size="md">
        {rotated && <KeyRevealOnce secret={rotated.secret} title={t('webhook.rotatedTitle')} note={t('webhook.rotatedNote', { hours: WEBHOOK_LIMITS.prevSecretHours })} onDone={() => setRotated(null)} />}
      </Modal>
      {confirmNode}
    </div>
  );
}

/** Ключ события → сегмент каталога: next-intl не допускает точку внутри ключа. */
const eventKeyToCatalog = (key: string) => key.replace(/\./g, '_');

function EventChips({ events }: { events: WebhookEventKey[] }) {
  const t = useTranslations('keys');
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem', marginTop: 'var(--spacing-3)' }}>
      {events.map((k) => (
        <Chip key={k} size="sm" tone="accent" title={k}>{t(`webhook.events.${eventKeyToCatalog(k)}`)}</Chip>
      ))}
    </div>
  );
}

function EndpointDialog({
  open,
  onClose,
  workspaceId,
  endpoint,
  onCreate,
  onCreated,
  onUpdate,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  endpoint?: WebhookEndpointDto;
  onCreate?: (input: { url: string; events: WebhookEventKey[]; signing: WebhookSigning }) => Promise<WebhookEndpointCreatedDto | undefined>;
  onCreated?: () => void;
  onUpdate?: (events: WebhookEventKey[]) => Promise<void>;
}) {
  const t = useTranslations('keys');
  const common = useTranslations('common');
  const catalog = useQuery({ queryKey: webhooksEventsKey, queryFn: fetchWebhookEvents, staleTime: Infinity });
  const [url, setUrl] = useState(endpoint?.url ?? '');
  const [signing, setSigning] = useState<WebhookSigning>(endpoint?.signing ?? 'hmac');
  const [events, setEvents] = useState<Set<WebhookEventKey>>(new Set(endpoint?.events ?? []));
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<WebhookEndpointCreatedDto | null>(null);
  const close = () => { if (busy) return; setCreated(null); setUrl(''); setEvents(new Set()); onClose(); };
  const toggle = (k: WebhookEventKey) => setEvents((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const urlOk = /^https:\/\//.test(url.trim());
  const submit = async () => {
    setBusy(true);
    try {
      if (endpoint && onUpdate) {
        await onUpdate([...events]);
        toast(t('webhook.savedToast'), 'success');
      } else if (onCreate) {
        const res = await onCreate({ url: url.trim(), events: [...events], signing });
        if (res) { setCreated(res); onCreated?.(); }
      }
    } catch (err) {
      toastError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const services = useMemo(() => catalog.data?.services ?? [], [catalog.data]);
  return (
    <Modal open={open} onClose={close} title={created ? undefined : endpoint ? t('webhook.editTitle') : t('webhook.createTitle')} size="lg" hideClose={!!created} closeOnBackdrop={!created} footer={created ? undefined : (
      <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end', width: '100%' }}>
        <Button variant="ghost" onClick={close} disabled={busy}>{common('actions.cancel')}</Button>
        <Button variant="primary" onClick={() => void submit()} disabled={busy || events.size === 0 || (!endpoint && !urlOk)} loading={busy} icon="webhook">{endpoint ? common('actions.save') : t('webhook.create')}</Button>
      </div>
    )}>
      {created ? (
        <KeyRevealOnce secret={created.secret} title={t('webhook.createdTitle')} note={t('webhook.createdNote')} onDone={close} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
          {!endpoint && <Alert tone="neutral" icon="info">{t('webhook.urlNote')}</Alert>}
          <Input label={t('webhook.url')} value={url} onChange={(e) => setUrl(e.target.value)} disabled={!!endpoint} placeholder="https://example.com/hooks/superapp" required error={url && !urlOk ? t('webhook.httpsOnly') : null} />
          {!endpoint && (
            <Select label={t('webhook.signingLabel')} hint={t('webhook.signingHint')} value={signing} onChange={(v) => setSigning(v)} options={[{ value: 'hmac', label: t('webhook.signing.hmac'), hint: t('webhook.signingHmacHint') }, { value: 'ed25519', label: t('webhook.signing.ed25519'), hint: t('webhook.signingEd25519Hint') }]} />
          )}
          <Field label={t('webhook.eventsLabel')} hint={t('webhook.eventsHint', { max: WEBHOOK_LIMITS.maxEventsPerEndpoint })}>
            {catalog.isPending ? <Skeleton height={80} /> : (
              <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
                {services.map((s) => (
                  <div key={s.service}>
                    <div className="label-sm" style={{ marginBottom: '0.25rem' }}>{t(`service.${s.service}`)}</div>
                    <div style={{ display: 'grid', gap: '0.25rem' }}>
                      {s.events.map((ev) => (
                        <Checkbox key={ev.key} checked={events.has(ev.key)} onChange={() => toggle(ev.key)} label={<span>{t(`webhook.events.${eventKeyToCatalog(ev.key)}`)} <span className="label-sm" style={{ fontFamily: 'ui-monospace, monospace' }}>{ev.key}</span></span>} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Field>
        </div>
      )}
    </Modal>
  );
}

function Deliveries({ workspaceId, endpointId }: { workspaceId: string; endpointId: string }) {
  const t = useTranslations('keys');
  const fmt = useFormatters();
  const q = useInfiniteQuery({
    queryKey: webhooksDeliveriesKey(workspaceId, endpointId),
    queryFn: ({ pageParam }) => fetchWebhookDeliveries(workspaceId, endpointId, pageParam ? { cursor: pageParam as string } : {}),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = useMemo(() => (q.data?.pages ?? []).flatMap((p) => p.items), [q.data]);
  const tone = (d: WebhookDeliveryDto) => (d.status === 'delivered' ? 'success' : d.status === 'pending' ? 'waiting' : d.status === 'failed' ? 'warning' : 'danger');
  const redeliver = async (d: WebhookDeliveryDto) => {
    try {
      await redeliverWebhook(workspaceId, endpointId, d.id);
      toast(t('webhook.redeliverToast'), 'success');
      void q.refetch();
    } catch (err) {
      toastError(apiErrorMessage(err));
    }
  };
  if (q.isPending) return <Skeleton height={48} />;
  return (
    <div style={{ marginTop: 'var(--spacing-4)', borderTop: '1px solid var(--outline-variant)', paddingTop: 'var(--spacing-3)', display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
      <span className="label-sm">{t('webhook.deliveries')}</span>
      {rows.length === 0 && <span className="label-sm">{t('webhook.noDeliveries')}</span>}
      {rows.map((d) => (
        <div key={d.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
          <span style={{ display: 'inline-flex', flexDirection: 'column', minWidth: 0 }}>
            <span style={{ fontSize: '0.88rem' }}>{t(`webhook.events.${eventKeyToCatalog(d.eventKey)}`)} <span className="label-sm" style={{ fontFamily: 'ui-monospace, monospace' }}>{d.eventKey}</span></span>
            <span className="label-sm">{fmt.dateTime(d.createdAt, 'short')} · {t('webhook.attempts', { count: d.attempts })}{d.lastStatus ? ` · HTTP ${d.lastStatus}` : ''}{d.lastError ? ` · ${d.lastError}` : ''}</span>
          </span>
          <span style={{ display: 'inline-flex', gap: '0.375rem', alignItems: 'center' }}>
            <Chip size="sm" tone={tone(d)}>{t(`webhook.delivery.${d.status}`)}</Chip>
            {(d.status === 'failed' || d.status === 'exhausted' || d.status === 'delivered') && <Button size="sm" variant="ghost" icon="refresh" onClick={() => void redeliver(d)} aria-label={t('webhook.redeliver')} />}
          </span>
        </div>
      ))}
      {q.hasNextPage && <Button size="sm" variant="ghost" onClick={() => void q.fetchNextPage()} loading={q.isFetchingNextPage}>{t('registry.loadMore')}</Button>}
    </div>
  );
}
