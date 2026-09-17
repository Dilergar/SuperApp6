'use client';

// ============================================================
// «Ключи и приложения» профиля (core/keys): личные ключи для СОБСТВЕННЫХ данных
// человека (без организации). Ключ работает лично и отвергается с X-Workspace-Id;
// ключи для данных организации живут в её разделе «Интеграции и ключи».
// Создание/ротация — под step-up (пароль + SMS-код).
// ============================================================

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KEYS_LIMITS, type ApiKeyDto, type ApiKeyRevokeReason } from '@superapp/shared';
import { useFormatters } from '@/lib/format';
import { createPersonalKey, fetchPersonalKeys, revokePersonalKey, rotatePersonalKey } from '@/lib/keys-api';
import { keysPersonalKey } from '@/lib/queries';
import { KeyStatusChip, KeysStepUpProvider, PersonalKeyDialog, RevokeKeyDialog, RotateKeyDialog, ScopeSummary, StepUpWindowChip, useKeysStepUp } from '@/components/keys';
import { EntitlementLock, useEntitlementGate } from '@/components/entitlements';
import { Button, Card, EmptyState, LoadingBlock, Menu } from '@/components/ui';

export function KeysSection() {
  return (
    <KeysStepUpProvider>
      <KeysSectionBody />
    </KeysStepUpProvider>
  );
}

function KeysSectionBody() {
  const t = useTranslations('keys');
  const fmt = useFormatters();
  const qc = useQueryClient();
  const stepUp = useKeysStepUp();
  const [createOpen, setCreateOpen] = useState(false);
  const [rotate, setRotate] = useState<ApiKeyDto | null>(null);
  const [revoke, setRevoke] = useState<ApiKeyDto | null>(null);
  const gate = useEntitlementGate('keys.maxPersonalTokens', null);
  const q = useQuery({ queryKey: keysPersonalKey, queryFn: fetchPersonalKeys });
  const invalidate = () => void qc.invalidateQueries({ queryKey: keysPersonalKey });
  const keys = (q.data ?? []).filter((k) => k.status !== 'revoked' && k.status !== 'expired');
  const dead = (q.data ?? []).filter((k) => k.status === 'revoked' || k.status === 'expired');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-5)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
        <div>
          <h2 className="title-lg" style={{ marginBottom: 'var(--spacing-2)' }}>{t('personal.title')}</h2>
          <p className="label-md" style={{ lineHeight: 1.55, maxWidth: '44rem' }}>{t('personal.subtitle')}</p>
        </div>
        <span style={{ display: 'inline-flex', gap: 'var(--spacing-2)', alignItems: 'center', flexWrap: 'wrap' }}>
          <StepUpWindowChip />
          <EntitlementLock keyName="keys.maxPersonalTokens" workspaceId={null} id={gate.lockId} />
          <Button variant="primary" icon="key" onClick={() => setCreateOpen(true)} disabled={gate.blocked} aria-describedby={gate.describedBy}>{t('personal.create')}</Button>
        </span>
      </div>

      {q.isPending ? (
        <LoadingBlock />
      ) : keys.length === 0 ? (
        <Card><EmptyState icon="key" title={t('personal.empty.title')} description={t('personal.empty.body')} /></Card>
      ) : (
        <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
          {keys.map((k) => <KeyCard key={k.id} k={k} onRotate={() => setRotate(k)} onRevoke={() => setRevoke(k)} fmt={fmt} />)}
        </div>
      )}
      {dead.length > 0 && (
        <details>
          <summary className="label-sm" style={{ cursor: 'pointer' }}>{t('personal.deadCount', { count: dead.length })}</summary>
          <div style={{ display: 'grid', gap: 'var(--spacing-3)', marginTop: 'var(--spacing-3)', opacity: 0.75 }}>
            {dead.map((k) => <KeyCard key={k.id} k={k} fmt={fmt} />)}
          </div>
        </details>
      )}

      <PersonalKeyDialog open={createOpen} onClose={() => setCreateOpen(false)} maxDays={KEYS_LIMITS.patMaxDays} onCreate={(input) => stepUp.withStepUp(() => createPersonalKey(input))} onCreated={invalidate} />
      <RotateKeyDialog open={!!rotate} onClose={() => { setRotate(null); invalidate(); }} keyName={rotate?.name ?? ''} onRotate={(graceHours) => stepUp.withStepUp(() => rotatePersonalKey(rotate!.id, { graceHours }))} />
      <RevokeKeyDialog open={!!revoke} onClose={() => setRevoke(null)} keyName={revoke?.name ?? ''} onRevoke={async (reason: ApiKeyRevokeReason, note) => { await revokePersonalKey(revoke!.id, { reason, ...(note ? { note } : {}) }); invalidate(); }} />
    </div>
  );
}

function KeyCard({ k, onRotate, onRevoke, fmt }: { k: ApiKeyDto; onRotate?: () => void; onRevoke?: () => void; fmt: ReturnType<typeof useFormatters> }) {
  const t = useTranslations('keys');
  const live = k.status === 'active' || k.status === 'expiring';
  return (
    <Card small>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 500 }}>{k.name}</span>
            <span className="label-sm" style={{ fontFamily: 'ui-monospace, monospace' }}>{k.prefix}…{k.last4}</span>
            <KeyStatusChip status={k.status} days={k.expiresAt ? Math.max(0, Math.ceil((Date.parse(k.expiresAt) - Date.now()) / 86_400_000)) : null} />
          </div>
          <p style={{ margin: 'var(--spacing-2) 0', fontSize: '0.9rem' }}>{k.purpose}</p>
          <div style={{ marginBottom: 'var(--spacing-2)' }}><ScopeSummary scopes={k.scopes} max={4} /></div>
          <span className="label-sm">
            {t('registry.createdAt', { date: fmt.date(k.createdAt) })}
            {' · '}{k.lastUsedAt ? t('registry.lastUsed', { date: fmt.dateTime(k.lastUsedAt, 'short') }) : t('registry.never')}{[k.lastUsedLocation, k.lastUsedIp].filter(Boolean).length ? ` (${[k.lastUsedLocation, k.lastUsedIp].filter(Boolean).join(' ')})` : ''}
            {' · '}{k.expiresAt ? t('registry.expires', { date: fmt.date(k.expiresAt) }) : t('registry.noExpiry')}
            {k.storedHint ? ` · ${t('key.storedHintShort', { hint: k.storedHint })}` : ''}
          </span>
        </div>
        {live && onRotate && onRevoke && (
          <Menu items={[
            { key: 'rotate', label: t('actions.rotate'), icon: 'refresh', onClick: onRotate },
            { key: 'revoke', label: t('actions.revoke'), icon: 'lock', danger: true, separatorBefore: true, onClick: onRevoke },
          ]} />
        )}
      </div>
    </Card>
  );
}
