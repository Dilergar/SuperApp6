'use client';

// Политика ключей организации: потолки сроков и обязательность IP-списка. Меняет только владелец.

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KEYS_LIMITS } from '@superapp/shared';

import { toastApiError } from '@/lib/api-errors';
import { toast } from '@/lib/toast';
import { fetchKeysPolicy, updateKeysPolicy } from '@/lib/keys-api';
import { keysPolicyKey } from '@/lib/queries';
import { Alert, Button, Card, CardHeader, Checkbox, Input, LoadingBlock, Toggle } from '@/components/ui';

export function PolicyTab({ workspaceId, isOwner }: { workspaceId: string; isOwner: boolean }) {
  const t = useTranslations('keys');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: keysPolicyKey(workspaceId), queryFn: () => fetchKeysPolicy(workspaceId) });
  const [maxPatDays, setMaxPatDays] = useState<number>(KEYS_LIMITS.patDefaultDays);
  const [botCeiling, setBotCeiling] = useState(true);
  const [maxBotKeyDays, setMaxBotKeyDays] = useState<number>(KEYS_LIMITS.botKeyDefaultDays);
  const [requireAllowlist, setRequireAllowlist] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!q.data) return;
    setMaxPatDays(q.data.maxPatDays);
    setBotCeiling(q.data.maxBotKeyDays !== null);
    setMaxBotKeyDays(q.data.maxBotKeyDays ?? KEYS_LIMITS.botKeyDefaultDays);
    setRequireAllowlist(q.data.requireIpAllowlist);
  }, [q.data]);

  const save = async () => {
    setBusy(true);
    try {
      const res = await updateKeysPolicy(workspaceId, { maxPatDays, maxBotKeyDays: botCeiling ? maxBotKeyDays : null, requireIpAllowlist: requireAllowlist });
      qc.setQueryData(keysPolicyKey(workspaceId), res);
      toast(t('policy.saved'), 'success');
    } catch (err) {
      toastApiError(err);
    } finally {
      setBusy(false);
    }
  };

  if (q.isPending) return <LoadingBlock />;

  const dirty = !!q.data && (q.data.maxPatDays !== maxPatDays || (q.data.maxBotKeyDays ?? null) !== (botCeiling ? maxBotKeyDays : null) || q.data.requireIpAllowlist !== requireAllowlist);

  return (
    <Card>
      <CardHeader title={t('policy.title')} subtitle={t('policy.body')} />
      {!isOwner && <Alert tone="neutral" icon="info">{t('policy.ownerOnly')}</Alert>}
      <div style={{ display: 'grid', gap: 'var(--spacing-5)', maxWidth: '36rem', marginTop: 'var(--spacing-4)' }}>
        <Input
          type="number"
          min={1}
          max={KEYS_LIMITS.patMaxDays}
          label={t('policy.maxPatDays')}
          hint={t('policy.maxPatDaysHint', { max: KEYS_LIMITS.patMaxDays })}
          value={String(maxPatDays)}
          disabled={!isOwner}
          onChange={(e) => setMaxPatDays(Math.min(KEYS_LIMITS.patMaxDays, Math.max(1, Number(e.target.value) || 1)))}
        />
        <div style={{ display: 'grid', gap: 'var(--spacing-2)' }}>
          <Input
            type="number"
            min={1}
            max={KEYS_LIMITS.patMaxDays * 10}
            label={t('policy.maxBotKeyDays')}
            hint={t('policy.maxBotKeyDaysHint')}
            value={botCeiling ? String(maxBotKeyDays) : ''}
            disabled={!isOwner || !botCeiling}
            onChange={(e) => setMaxBotKeyDays(Math.max(1, Number(e.target.value) || 1))}
          />
          <Checkbox checked={!botCeiling} onChange={(v) => setBotCeiling(!v)} label={t('policy.noCeiling')} disabled={!isOwner} />
          {!botCeiling && <p className="label-sm">{t('policy.noCeilingHint')}</p>}
        </div>
        <Toggle checked={requireAllowlist} onChange={setRequireAllowlist} disabled={!isOwner} label={t('policy.requireIpAllowlist')} description={t('policy.requireIpAllowlistHint')} />
        {isOwner && (
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button variant="primary" onClick={() => void save()} disabled={!dirty || busy} loading={busy} icon="check">{t('policy.save')}</Button>
          </div>
        )}
      </div>
    </Card>
  );
}
