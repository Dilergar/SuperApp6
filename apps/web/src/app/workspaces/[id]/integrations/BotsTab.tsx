'use client';

// Боты организации: карточки с правами и ключами; мастер создания; заморозка/разморозка;
// второй ключ; правка; архив. Разморозка — только владелец (кнопка не предлагается админу).

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KEYS_LIMITS, type ApiKeyDto, type ApiKeyRevokeReason, type BotDto, type BotRank, type BotUpdateInput, type KeyScopes } from '@superapp/shared';
import { PersonChip } from '@/app/circles/PersonCard';
import { apiErrorMessage } from '@/lib/api';
import { useFormatters } from '@/lib/format';
import type { Principal } from '@/lib/entities';
import { toast, toastError } from '@/lib/toast';
import { archiveBot, createBot, createBotKey, fetchBot, fetchBots, fetchKeysPolicy, freezeBot, revokeWorkspaceKey, rotateWorkspaceKey, unfreezeBot, updateBot } from '@/lib/keys-api';
import { keysBotKey, keysBotsKey, keysPolicyKey, keysRegistryRootKey } from '@/lib/queries';
import { AllowlistField, BotChip, BotKeyDialog, BotWizard, KeyStatusChip, RevokeKeyDialog, RotateKeyDialog, ScopeMatrix, ScopeSummary, useKeysStepUp } from '@/components/keys';
import { EntitySelector } from '@/components/EntitySelector';
import { EntitlementLock, useEntitlementGate } from '@/components/entitlements';
import { Button, Card, Chip, EmptyState, Field, Input, LoadingBlock, Menu, Modal, Select, Skeleton, useConfirm } from '@/components/ui';

export function BotsTab({ workspaceId, isOwner, focusBotId, onOpenJournal }: { workspaceId: string; isOwner: boolean; focusBotId: string | null; onOpenJournal?: (bot: BotDto) => void }) {
  const t = useTranslations('keys');
  const qc = useQueryClient();
  const stepUp = useKeysStepUp();
  const [confirm, confirmNode] = useConfirm();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(focusBotId);
  const [edit, setEdit] = useState<BotDto | null>(null);
  const [newKeyFor, setNewKeyFor] = useState<BotDto | null>(null);
  const botsGate = useEntitlementGate('keys.maxBots', workspaceId);

  const bots = useQuery({ queryKey: keysBotsKey(workspaceId), queryFn: () => fetchBots(workspaceId) });
  const policy = useQuery({ queryKey: keysPolicyKey(workspaceId), queryFn: () => fetchKeysPolicy(workspaceId), staleTime: 60_000 });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: keysRegistryRootKey(workspaceId) });
  };

  useEffect(() => {
    if (focusBotId) setOpenId(focusBotId);
  }, [focusBotId]);

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn();
      invalidate();
      if (done) toast(done, 'success');
    } catch (err) {
      toastError(apiErrorMessage(err));
    }
  };

  const onFreeze = (b: BotDto) =>
    confirm({ title: t('bot.freezeConfirm.title', { name: b.name }), message: t('bot.freezeConfirm.message'), confirmLabel: t('actions.freeze') }, () => act(() => freezeBot(workspaceId, b.id), t('bot.frozenToast')));
  const onUnfreeze = (b: BotDto) => act(() => stepUp.withStepUp(() => unfreezeBot(workspaceId, b.id)), t('bot.unfrozenToast'));
  const onArchive = (b: BotDto) =>
    confirm({ title: t('bot.archiveConfirm.title', { name: b.name }), message: t('bot.archiveConfirm.message'), confirmLabel: t('actions.archive'), danger: true }, () => act(() => stepUp.withStepUp(() => archiveBot(workspaceId, b.id)), t('bot.archivedToast')));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
        <p className="label-md" style={{ lineHeight: 1.55, maxWidth: '48rem' }}>{t('bot.intro')}</p>
        <span style={{ display: 'inline-flex', gap: 'var(--spacing-2)', alignItems: 'center' }}>
          <EntitlementLock keyName="keys.maxBots" workspaceId={workspaceId} id={botsGate.lockId} />
          <Button variant="primary" icon="robot" onClick={() => setWizardOpen(true)} disabled={botsGate.blocked} aria-describedby={botsGate.describedBy}>{t('actions.createBot')}</Button>
        </span>
      </div>

      {bots.isPending ? (
        <LoadingBlock />
      ) : (bots.data ?? []).length === 0 ? (
        <Card><EmptyState icon="robot" title={t('bot.empty.title')} description={t('bot.empty.body')} action={<Button variant="primary" icon="robot" onClick={() => setWizardOpen(true)} disabled={botsGate.blocked}>{t('actions.createBot')}</Button>} /></Card>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 22rem), 1fr))', gap: 'var(--spacing-4)' }}>
          {(bots.data ?? []).map((b) => {
            const menu = [
              { key: 'keys', label: t('actions.openKeys'), icon: 'key' as const, onClick: () => setOpenId(openId === b.id ? null : b.id) },
              { key: 'newKey', label: t('actions.newKey'), icon: 'add' as const, disabled: b.status !== 'active', onClick: () => setNewKeyFor(b) },
              { key: 'edit', label: t('actions.edit'), icon: 'edit' as const, disabled: b.status === 'archived', onClick: () => setEdit(b) },
              ...(onOpenJournal ? [{ key: 'journal', label: t('actions.openJournal'), icon: 'journal' as const, onClick: () => onOpenJournal(b) }] : []),
              ...(b.status === 'active' ? [{ key: 'freeze', label: t('actions.freeze'), icon: 'snowflake' as const, separatorBefore: true, onClick: () => onFreeze(b) }] : []),
              ...(b.status === 'frozen' && isOwner ? [{ key: 'unfreeze', label: t('actions.unfreeze'), icon: 'play' as const, separatorBefore: true, onClick: () => void onUnfreeze(b) }] : []),
              { key: 'archive', label: t('actions.archive'), icon: 'archive' as const, danger: true, separatorBefore: true, onClick: () => onArchive(b) },
            ];
            return (
              <Card key={b.id} id={`bot-${b.id}`} style={openId === b.id ? { outline: '2px solid var(--primary)', outlineOffset: 2 } : undefined}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 'var(--spacing-3)' }}>
                  <BotChip name={b.name} glyph={b.glyph} size="md" status={b.status} frozenReason={b.frozenReason} rank={b.rank} onClick={() => setOpenId(openId === b.id ? null : b.id)} />
                  <Menu items={menu} />
                </div>
                <p style={{ margin: 'var(--spacing-3) 0', fontSize: '0.9rem', lineHeight: 1.5 }}>{b.purpose}</p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem', alignItems: 'center' }}>
                  <KeyStatusChip status={b.status === 'frozen' ? 'frozen' : b.status === 'archived' ? 'revoked' : 'active'} />
                  <Chip size="sm" tone="neutral" icon="key">{t('bot.liveKeys', { count: b.liveKeys })}</Chip>
                  {b.ipAllowlist.length > 0 && <Chip size="sm" tone="neutral" icon="globe">{t('bot.allowlistCount', { count: b.ipAllowlist.length })}</Chip>}
                </div>
                <div style={{ marginTop: 'var(--spacing-3)' }}><ScopeSummary scopes={b.scopes} max={4} /></div>
                {b.status === 'frozen' && (
                  <p className="label-sm" style={{ marginTop: 'var(--spacing-3)', color: 'var(--waiting)' }}>
                    {t(`frozenReason.${b.frozenReason ?? 'owner'}`)}{isOwner ? '' : ` · ${t('bot.unfreezeOwnerOnly')}`}
                  </p>
                )}
                {b.responsibleUserId && (
                  <div style={{ marginTop: 'var(--spacing-3)', display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)' }}>
                    <span className="label-sm">{t('bot.responsible')}:</span>
                    <ResponsibleChip workspaceId={workspaceId} botId={b.id} userId={b.responsibleUserId} />
                  </div>
                )}
                {openId === b.id && <BotKeys workspaceId={workspaceId} bot={b} onChanged={invalidate} />}
              </Card>
            );
          })}
        </div>
      )}

      <BotWizard open={wizardOpen} onClose={() => { setWizardOpen(false); invalidate(); }} workspaceId={workspaceId} isOwner={isOwner} policy={policy.data ?? null} onCreate={(input) => stepUp.withStepUp(() => createBot(workspaceId, input))} />
      {newKeyFor && (
        <BotKeyDialog
          open
          onClose={() => { setNewKeyFor(null); invalidate(); }}
          botName={newKeyFor.name}
          maxDays={policy.data ? policy.data.maxBotKeyDays : KEYS_LIMITS.botKeyDefaultDays}
          allowNoExpiry={isOwner && policy.data?.maxBotKeyDays === null && newKeyFor.ipAllowlist.length > 0}
          onCreate={(input) => stepUp.withStepUp(() => createBotKey(workspaceId, newKeyFor.id, input))}
        />
      )}
      {edit && <BotEditDialog workspaceId={workspaceId} bot={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); invalidate(); }} />}
      {confirmNode}
    </div>
  );
}

/** Ключи бота (раскрытие карточки): список с ротацией и отзывом. */
function BotKeys({ workspaceId, bot, onChanged }: { workspaceId: string; bot: BotDto; onChanged: () => void }) {
  const t = useTranslations('keys');
  const fmt = useFormatters();
  const stepUp = useKeysStepUp();
  const [rotate, setRotate] = useState<ApiKeyDto | null>(null);
  const [revoke, setRevoke] = useState<ApiKeyDto | null>(null);
  const q = useQuery({ queryKey: keysBotKey(workspaceId, bot.id), queryFn: () => fetchBot(workspaceId, bot.id) });
  if (q.isPending) return <Skeleton height={48} />;
  const keys = q.data?.keys ?? [];
  return (
    <div style={{ marginTop: 'var(--spacing-4)', borderTop: '1px solid var(--outline-variant)', paddingTop: 'var(--spacing-3)', display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
      <span className="label-sm">{t('bot.keysTitle')}</span>
      {keys.length === 0 && <span className="label-sm">{t('bot.noKeys')}</span>}
      {keys.map((k) => {
        const live = k.status === 'active' || k.status === 'expiring' || k.status === 'frozen';
        return (
          <div key={k.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
            <span style={{ display: 'inline-flex', flexDirection: 'column', minWidth: 0 }}>
              <span style={{ fontSize: '0.88rem', fontFamily: 'ui-monospace, monospace' }}>{k.prefix}…{k.last4}</span>
              <span className="label-sm">{k.lastUsedAt ? t('registry.lastUsed', { date: fmt.dateTime(k.lastUsedAt, 'short') }) : t('registry.never')}{k.expiresAt ? ` · ${t('registry.expires', { date: fmt.date(k.expiresAt) })}` : ` · ${t('registry.noExpiry')}`}</span>
            </span>
            <span style={{ display: 'inline-flex', gap: '0.375rem', alignItems: 'center' }}>
              <KeyStatusChip status={k.status} />
              {live && <Button size="sm" variant="ghost" icon="refresh" onClick={() => setRotate(k)} aria-label={t('actions.rotate')} />}
              {live && <Button size="sm" variant="ghost" icon="lock" onClick={() => setRevoke(k)} aria-label={t('actions.revoke')} />}
            </span>
          </div>
        );
      })}
      <RotateKeyDialog open={!!rotate} onClose={() => { setRotate(null); void q.refetch(); onChanged(); }} keyName={rotate?.name ?? ''} onRotate={(graceHours) => stepUp.withStepUp(() => rotateWorkspaceKey(workspaceId, rotate!.id, { graceHours }))} />
      <RevokeKeyDialog open={!!revoke} onClose={() => setRevoke(null)} keyName={revoke?.name ?? ''} onRevoke={async (reason: ApiKeyRevokeReason, note) => { await revokeWorkspaceKey(workspaceId, revoke!.id, { reason, ...(note ? { note } : {}) }); await q.refetch(); onChanged(); }} />
    </div>
  );
}

function ResponsibleChip({ workspaceId, botId, userId }: { workspaceId: string; botId: string; userId: string }) {
  // Имя ответственного приходит с карточкой бота (реестр обогащает людей); здесь — по id из бота
  const q = useQuery({ queryKey: keysBotKey(workspaceId, botId), queryFn: () => fetchBot(workspaceId, botId), staleTime: 60_000 });
  const person = q.data?.responsible ?? null;
  if (!person) return <span className="label-sm">…</span>;
  return <PersonChip size="XS" userId={userId} firstName={person.firstName} lastName={person.lastName} avatar={person.avatar} />;
}

function BotEditDialog({ workspaceId, bot, onClose, onSaved }: { workspaceId: string; bot: BotDto; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations('keys');
  const common = useTranslations('common');
  const [name, setName] = useState(bot.name);
  const [purpose, setPurpose] = useState(bot.purpose);
  const [rank, setRank] = useState<BotRank>(bot.rank);
  const [responsible, setResponsible] = useState<Principal[]>(bot.responsibleUserId ? [{ type: 'user', id: bot.responsibleUserId }] : []);
  const [scopes, setScopes] = useState<KeyScopes>(bot.scopes);
  const [allowlist, setAllowlist] = useState<string[]>(bot.ipAllowlist);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const input: BotUpdateInput = {
        ...(name.trim() !== bot.name ? { name: name.trim() } : {}),
        ...(purpose.trim() !== bot.purpose ? { purpose: purpose.trim() } : {}),
        ...(rank !== bot.rank ? { rank } : {}),
        responsibleUserId: responsible[0]?.id ?? null,
        scopes,
        ipAllowlist: allowlist,
      };
      await updateBot(workspaceId, bot.id, input);
      toast(t('bot.savedToast'), 'success');
      onSaved();
    } catch (err) {
      toastError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={() => !busy && onClose()} title={t('bot.editTitle', { name: bot.name })} size="lg" footer={
      <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end', width: '100%' }}>
        <Button variant="ghost" onClick={onClose} disabled={busy}>{common('actions.cancel')}</Button>
        <Button variant="primary" onClick={() => void save()} disabled={busy || !name.trim() || purpose.trim().length < KEYS_LIMITS.purposeMinLength || Object.keys(scopes).length === 0} loading={busy}>{common('actions.save')}</Button>
      </div>
    }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
        <Input label={t('bot.name')} value={name} onChange={(e) => setName(e.target.value)} maxLength={KEYS_LIMITS.nameMaxLength} required />
        <Input label={t('key.purpose')} value={purpose} onChange={(e) => setPurpose(e.target.value)} minLength={KEYS_LIMITS.purposeMinLength} maxLength={KEYS_LIMITS.purposeMaxLength} required />
        <Select label={t('bot.rankLabel')} value={rank} onChange={(v) => setRank(v)} options={[{ value: 'member', label: t('bot.rank.member') }, { value: 'manager', label: t('bot.rank.manager') }]} />
        <Field label={t('bot.responsible')}>
          <EntitySelector types={['user']} multi={false} value={responsible} onChange={setResponsible} context={{ workspaceId }} placeholder={t('bot.responsiblePlaceholder')} />
        </Field>
        <Field label={t('key.scopes')} hint={t('bot.scopesEditHint')}>
          <ScopeMatrix value={scopes} onChange={setScopes} forBot />
        </Field>
        <AllowlistField value={allowlist} onChange={setAllowlist} />
      </div>
    </Modal>
  );
}
