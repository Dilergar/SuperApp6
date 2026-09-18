'use client';

// Реестр ключей организации: таблица + фильтры + «ждут решения» + действия по строке.

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { KEY_REGISTRY_FILTERS, KEY_REGISTRY_KINDS, KEYS_LIMITS, type ApiKeyRevokeReason, type KeyRegistryFilter, type KeyRegistryKind, type KeyRegistryRowDto } from '@superapp/shared';
import { PersonChip } from '@/app/circles/PersonCard';
import { useFormatters } from '@/lib/format';
import { useAuthStore } from '@/lib/stores/auth';
import { createWorkspacePersonalKey, fetchKeysPending, fetchKeysPolicy, fetchKeysRegistry, revokeWorkspaceKey, rotateWorkspaceKey } from '@/lib/keys-api';
import { keysPendingKey, keysPolicyKey, keysRegistryKey, keysRegistryRootKey } from '@/lib/queries';
import { BotChip, KeyStatusChip, PersonalKeyDialog, RevokeKeyDialog, RotateKeyDialog, ScopeSummary, useKeysStepUp } from '@/components/keys';
import { EntitlementLock, useEntitlementGate } from '@/components/entitlements';
import { Alert, Button, Card, Chip, EmptyState, LoadingBlock, Menu, Table, TableCell, TableRow, type TableColumn } from '@/components/ui';

export function RegistryTab({ workspaceId, isOwner, onOpenBots, onOpenWebhooks, onOpenJournal }: { workspaceId: string; isOwner: boolean; onOpenBots: () => void; onOpenWebhooks: () => void; onOpenJournal: (row: KeyRegistryRowDto) => void }) {
  const t = useTranslations('keys');
  const fmt = useFormatters();
  const qc = useQueryClient();
  const stepUp = useKeysStepUp();
  const meId = useAuthStore((s) => s.user?.id ?? null);
  const [kind, setKind] = useState<KeyRegistryKind | null>(null);
  const [filter, setFilter] = useState<KeyRegistryFilter | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [rotate, setRotate] = useState<KeyRegistryRowDto | null>(null);
  const [revoke, setRevoke] = useState<KeyRegistryRowDto | null>(null);
  const patGate = useEntitlementGate('keys.maxPersonalTokens', null);

  const pending = useQuery({ queryKey: keysPendingKey(workspaceId), queryFn: () => fetchKeysPending(workspaceId), staleTime: 60_000 });
  const policy = useQuery({ queryKey: keysPolicyKey(workspaceId), queryFn: () => fetchKeysPolicy(workspaceId), staleTime: 60_000 });
  const registry = useInfiniteQuery({
    queryKey: keysRegistryKey(workspaceId, kind, filter),
    queryFn: ({ pageParam }) => fetchKeysRegistry(workspaceId, { ...(kind ? { kind } : {}), ...(filter ? { filter } : {}), ...(pageParam ? { cursor: pageParam as string } : {}), limit: KEYS_LIMITS.registryPageSize }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = useMemo(() => (registry.data?.pages ?? []).flatMap((p) => p.items), [registry.data]);
  const invalidate = () => void qc.invalidateQueries({ queryKey: keysRegistryRootKey(workspaceId) });

  const columns: TableColumn[] = [
    { key: 'name', label: t('registry.columns.name') },
    { key: 'holder', label: t('registry.columns.holder'), hideOnMobile: true },
    { key: 'purpose', label: t('registry.columns.purpose'), hideOnMobile: true },
    { key: 'scopes', label: t('registry.columns.scopes'), hideOnMobile: true },
    { key: 'status', label: t('registry.columns.status') },
    { key: 'lastUsed', label: t('registry.columns.lastUsed'), hideOnMobile: true },
    { key: 'expires', label: t('registry.columns.expires'), hideOnMobile: true },
    { key: 'actions', label: '', align: 'end', width: '3rem' },
  ];

  const holderOf = (r: KeyRegistryRowDto) => {
    if (r.holder.kind === 'bot') return <BotChip name={r.holder.name} glyph={r.holder.glyph} size="xs" status={r.status === 'frozen' ? 'frozen' : 'active'} frozenReason={r.frozenReason} />;
    if (r.holder.kind === 'personal' && r.holder.person) return <PersonChip size="XS" userId={r.holder.person.id} firstName={r.holder.person.firstName} lastName={r.holder.person.lastName} avatar={r.holder.person.avatar} />;
    if (r.holder.kind === 'webhook') return <Chip size="sm" tone="neutral" icon="webhook" title={r.holder.name}>{shortUrl(r.holder.name)}</Chip>;
    return <span className="label-sm">{r.holder.name || '—'}</span>;
  };

  const actionsOf = (r: KeyRegistryRowDto) => {
    const journal = { key: 'journal', label: t('actions.openJournal'), icon: 'journal' as const, onClick: () => onOpenJournal(r) };
    if (r.kind === 'webhook') return [{ key: 'open', label: t('actions.openWebhooks'), icon: 'webhook' as const, onClick: onOpenWebhooks }, journal];
    const live = r.status === 'active' || r.status === 'expiring' || r.status === 'frozen';
    return [
      ...(r.kind === 'bot' ? [{ key: 'bot', label: t('actions.openBot'), icon: 'robot' as const, onClick: onOpenBots }] : []),
      journal,
      // Чужой личный ключ можно только отозвать: перевыпуск отдал бы его новый секрет не держателю
      // (сервер отвечает `keys.holder_only`) — действие не предлагаем вовсе
      ...(r.kind === 'personal' && r.holder.id !== meId ? [] : [{ key: 'rotate', label: t('actions.rotate'), icon: 'refresh' as const, disabled: !live, onClick: () => setRotate(r) }]),
      { key: 'revoke', label: t('actions.revoke'), icon: 'lock' as const, danger: true, disabled: !live, separatorBefore: true, onClick: () => setRevoke(r) },
    ];
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
      {(pending.data?.frozenBots ?? 0) > 0 && (
        <Alert tone="waiting" icon="robot" action={<Button size="sm" variant="matte" onClick={() => { setKind(null); setFilter('frozen'); }}>{t('registry.showFrozen')}</Button>}>
          {t('registry.pending', { count: pending.data!.frozenBots })}
        </Alert>
      )}

      <Card>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-3)', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--spacing-4)' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem' }} role="group" aria-label={t('registry.kinds.aria')}>
            <Chip size="sm" tone="accent" selected={kind === null} onClick={() => setKind(null)}>{t('registry.kinds.all')}</Chip>
            {KEY_REGISTRY_KINDS.map((k) => (
              <Chip key={k} size="sm" tone="accent" selected={kind === k} onClick={() => setKind(kind === k ? null : k)}>{t(`registry.kinds.${k}`)}</Chip>
            ))}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem' }} role="group" aria-label={t('registry.filters.aria')}>
            {KEY_REGISTRY_FILTERS.map((f) => (
              <Chip key={f} size="sm" tone={f === 'frozen' ? 'waiting' : 'neutral'} icon="filter" selected={filter === f} onClick={() => setFilter(filter === f ? null : f)}>{t(`registry.filters.${f}`)}</Chip>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'center', flexWrap: 'wrap' }}>
            <EntitlementLock keyName="keys.maxPersonalTokens" workspaceId={null} id={patGate.lockId} />
            <Button variant="matte" icon="key" size="sm" onClick={() => setCreateOpen(true)} disabled={patGate.blocked} aria-describedby={patGate.describedBy}>{t('personal.createForOrg')}</Button>
            <Button variant="primary" icon="robot" size="sm" onClick={onOpenBots}>{t('actions.createBot')}</Button>
          </div>
        </div>

        {registry.isPending ? (
          <LoadingBlock />
        ) : rows.length === 0 ? (
          <EmptyState icon="key" title={t('registry.empty.title')} description={t('registry.empty.body')} />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <Table columns={columns} lines aria-label={t('registry.tableAria')}>
              {rows.map((r, i) => (
                <TableRow key={`${r.kind}:${r.id}`} rowIndex={i + 2}>
                  <TableCell>
                    <span style={{ display: 'inline-flex', flexDirection: 'column', minWidth: 0 }}>
                      <span style={{ fontWeight: 500 }}>{r.name}</span>
                      <span className="label-sm">{t(`registry.kinds.${r.kind}`)} · {t('registry.createdAt', { date: fmt.date(r.createdAt) })}{r.createdBy ? ` · ${[r.createdBy.firstName, r.createdBy.lastName].filter(Boolean).join(' ')}` : ''}</span>
                    </span>
                  </TableCell>
                  <TableCell hideOnMobile>{holderOf(r)}</TableCell>
                  <TableCell hideOnMobile><span style={{ display: 'inline-block', maxWidth: '18rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.purpose}>{r.purpose}</span></TableCell>
                  <TableCell hideOnMobile>{r.kind === 'webhook' ? <span className="label-sm">{t('registry.eventsCount', { count: r.scopeCount })}</span> : <ScopeSummary scopes={r.scopes} />}</TableCell>
                  <TableCell><KeyStatusChip status={r.status} days={r.expiresInDays} /></TableCell>
                  <TableCell hideOnMobile><span className="label-sm">{r.lastUsedAt ? fmt.dateTime(r.lastUsedAt, 'short') : t('registry.never')}{lastFrom(r) ? ` · ${lastFrom(r)}` : ''}</span></TableCell>
                  <TableCell hideOnMobile><span className="label-sm">{r.expiresAt ? fmt.date(r.expiresAt) : r.kind === 'webhook' ? '—' : t('registry.noExpiry')}</span></TableCell>
                  <TableCell align="end"><Menu items={actionsOf(r)} /></TableCell>
                </TableRow>
              ))}
            </Table>
          </div>
        )}
        {registry.hasNextPage && (
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: 'var(--spacing-4)' }}>
            <Button variant="ghost" onClick={() => void registry.fetchNextPage()} loading={registry.isFetchingNextPage}>{t('registry.loadMore')}</Button>
          </div>
        )}
      </Card>

      <PersonalKeyDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        forWorkspace
        maxDays={policy.data?.maxPatDays ?? KEYS_LIMITS.patDefaultDays}
        requireAllowlist={policy.data?.requireIpAllowlist}
        onCreate={(input) => stepUp.withStepUp(() => createWorkspacePersonalKey(workspaceId, input))}
        onCreated={invalidate}
      />
      <RotateKeyDialog
        open={!!rotate}
        onClose={() => { setRotate(null); invalidate(); }}
        keyName={rotate?.name ?? ''}
        onRotate={(graceHours) => stepUp.withStepUp(() => rotateWorkspaceKey(workspaceId, rotate!.id, { graceHours }))}
      />
      <RevokeKeyDialog
        open={!!revoke}
        onClose={() => setRevoke(null)}
        keyName={revoke?.name ?? ''}
        onRevoke={async (reason: ApiKeyRevokeReason, note) => { await revokeWorkspaceKey(workspaceId, revoke!.id, { reason, ...(note ? { note } : {}) }); invalidate(); }}
      />
      {isOwner && null}
    </div>
  );
}

/** «Откуда» последнего обращения: страна (гео-заголовок CDN) и IP — как «last used from» у GitHub. */
function lastFrom(r: { lastUsedLocation: string | null; lastUsedIp: string | null }): string {
  return [r.lastUsedLocation, r.lastUsedIp].filter(Boolean).join(' ');
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host + (u.pathname.length > 1 ? u.pathname.slice(0, 18) + (u.pathname.length > 18 ? '…' : '') : '');
  } catch {
    return url.slice(0, 32);
  }
}
