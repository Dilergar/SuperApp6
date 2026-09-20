'use client';

// ============================================================
// Диалоги ключей: личный ключ (для собственных данных или данных организации),
// второй ключ бота, ротация с перекрытием, отзыв с причиной. Общие поля: срок и
// IP-список. Секрет после создания — KeyRevealOnce (show-once).
// ============================================================

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  API_KEY_REVOKE_REASONS,
  KEYS_LIMITS,
  isValidCidr,
  type ApiKeyCreateInput,
  type ApiKeyCreatedDto,
  type ApiKeyDto,
  type ApiKeyRevokeReason,
  type BotKeyCreateInput,
  type KeyScopes,
} from '@superapp/shared';

import { Button, Checkbox, Field, Input, Modal, Select, Textarea } from '@/components/ui';
import { KeyRevealOnce } from './KeyRevealOnce';
import { ScopeMatrix } from './ScopeMatrix';

import { toastApiError } from '@/lib/api-errors';
/** Причины отзыва, которые выбирает человек (остальные ставит система). */
const MANUAL_REVOKE_REASONS: ApiKeyRevokeReason[] = API_KEY_REVOKE_REASONS.filter((r) => r === 'owner' || r === 'leaked' || r === 'policy');

// ---- Срок ----
export function ExpiryFields({
  days,
  noExpiry,
  onDays,
  onNoExpiry,
  allowNoExpiry,
  maxDays,
}: {
  days: number;
  noExpiry: boolean;
  onDays: (d: number) => void;
  onNoExpiry: (v: boolean) => void;
  /** Только владелец, только с IP-списком, только без потолка политики */
  allowNoExpiry: boolean;
  maxDays: number | null;
}) {
  const t = useTranslations('keys');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)' }}>
      <Input
        type="number"
        min={1}
        max={maxDays ?? KEYS_LIMITS.patMaxDays * 10}
        label={t('key.expiryDays')}
        hint={maxDays ? t('key.expiryMax', { days: maxDays }) : undefined}
        value={noExpiry ? '' : String(days)}
        disabled={noExpiry}
        onChange={(e) => onDays(Math.max(1, Number(e.target.value) || 1))}
      />
      {allowNoExpiry && <Checkbox checked={noExpiry} onChange={onNoExpiry} label={t('key.noExpiry')} />}
      {allowNoExpiry && noExpiry && <p className="label-sm">{t('key.noExpiryHint')}</p>}
    </div>
  );
}

// ---- IP-список ----
export function AllowlistField({ value, onChange, required }: { value: string[]; onChange: (v: string[]) => void; required?: boolean }) {
  const t = useTranslations('keys');
  const [text, setText] = useState(value.join('\n'));
  const invalid = text
    .split(/[\n,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !isValidCidr(s));
  return (
    <Textarea
      label={t('key.allowlist')}
      hint={t('key.allowlistHint')}
      required={required}
      rows={3}
      value={text}
      error={invalid.length ? t('key.allowlistInvalid', { value: invalid[0]! }) : null}
      placeholder="10.0.0.0/8&#10;203.0.113.7"
      onChange={(e) => {
        setText(e.target.value);
        const list = e.target.value.split(/[\n,;\s]+/).map((s) => s.trim()).filter(Boolean);
        if (list.every((s) => isValidCidr(s))) onChange(list);
      }}
    />
  );
}

// ---- Личный ключ (собственные данные или данные организации) ----
export function PersonalKeyDialog({
  open,
  onClose,
  onCreate,
  onCreated,
  maxDays,
  requireAllowlist,
  forWorkspace,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (input: ApiKeyCreateInput) => Promise<ApiKeyCreatedDto | undefined>;
  onCreated?: (key: ApiKeyDto) => void;
  maxDays: number;
  requireAllowlist?: boolean;
  /** Ключ для данных организации (иначе — для собственных данных) */
  forWorkspace?: boolean;
}) {
  const t = useTranslations('keys');
  const common = useTranslations('common');
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [scopes, setScopes] = useState<KeyScopes>({});
  const [days, setDays] = useState(Math.min(KEYS_LIMITS.patDefaultDays, maxDays));
  const [allowlist, setAllowlist] = useState<string[]>([]);
  const [storedHint, setStoredHint] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<ApiKeyCreatedDto | null>(null);

  const reset = () => {
    setName(''); setPurpose(''); setScopes({}); setDays(Math.min(KEYS_LIMITS.patDefaultDays, maxDays)); setAllowlist([]); setStoredHint(''); setCreated(null);
  };
  const close = () => { if (busy) return; reset(); onClose(); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await onCreate({ name: name.trim(), purpose: purpose.trim(), scopes, ipAllowlist: allowlist, expiresInDays: days, ...(storedHint.trim() ? { storedHint: storedHint.trim() } : {}) });
      if (res) {
        setCreated(res);
        onCreated?.(res.key);
      }
    } catch (err) {
      toastApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = name.trim().length > 0 && purpose.trim().length >= KEYS_LIMITS.purposeMinLength && Object.keys(scopes).length > 0 && (!requireAllowlist || allowlist.length > 0);

  return (
    <Modal open={open} onClose={close} title={created ? undefined : forWorkspace ? t('personal.createForOrg') : t('personal.create')} size="lg" hideClose={!!created} closeOnBackdrop={!created}>
      {created ? (
        <KeyRevealOnce secret={created.secret} onDone={close} />
      ) : (
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
          <p className="label-md" style={{ lineHeight: 1.55 }}>{forWorkspace ? t('personal.orgNote') : t('personal.ownNote')}</p>
          <Input label={t('key.name')} value={name} onChange={(e) => setName(e.target.value)} required maxLength={KEYS_LIMITS.nameMaxLength} autoFocus />
          <Input label={t('key.purpose')} hint={t('key.purposeHint')} value={purpose} onChange={(e) => setPurpose(e.target.value)} required minLength={KEYS_LIMITS.purposeMinLength} maxLength={KEYS_LIMITS.purposeMaxLength} placeholder={t('key.purposePlaceholder')} />
          <Field label={t('key.scopes')} hint={t('key.scopesHint')}>
            <ScopeMatrix value={scopes} onChange={setScopes} forBot={false} />
          </Field>
          <ExpiryFields days={days} noExpiry={false} onDays={setDays} onNoExpiry={() => undefined} allowNoExpiry={false} maxDays={maxDays} />
          <AllowlistField value={allowlist} onChange={setAllowlist} required={requireAllowlist} />
          <Input label={t('key.storedHint')} hint={t('key.storedHintHint')} value={storedHint} onChange={(e) => setStoredHint(e.target.value)} maxLength={KEYS_LIMITS.storedHintMaxLength} />
          <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end' }}>
            <Button type="button" variant="ghost" onClick={close} disabled={busy}>{common('actions.cancel')}</Button>
            <Button type="submit" variant="primary" disabled={!canSubmit || busy} loading={busy} icon="key">{t('key.create')}</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// ---- Второй ключ бота ----
export function BotKeyDialog({
  open,
  onClose,
  botName,
  onCreate,
  maxDays,
  allowNoExpiry,
}: {
  open: boolean;
  onClose: () => void;
  botName: string;
  onCreate: (input: BotKeyCreateInput) => Promise<ApiKeyCreatedDto | undefined>;
  maxDays: number | null;
  allowNoExpiry: boolean;
}) {
  const t = useTranslations('keys');
  const common = useTranslations('common');
  const [name, setName] = useState('');
  const [days, setDays] = useState(Math.min(KEYS_LIMITS.botKeyDefaultDays, maxDays ?? KEYS_LIMITS.botKeyDefaultDays));
  const [noExpiry, setNoExpiry] = useState(false);
  const [storedHint, setStoredHint] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<ApiKeyCreatedDto | null>(null);
  const close = () => { if (busy) return; setCreated(null); setName(''); onClose(); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await onCreate({ ...(name.trim() ? { name: name.trim() } : {}), ...(storedHint.trim() ? { storedHint: storedHint.trim() } : {}), ...(noExpiry ? { noExpiry: true } : { expiresInDays: days }) });
      if (res) setCreated(res);
    } catch (err) {
      toastApiError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={close} title={created ? undefined : t('bot.newKeyTitle', { name: botName })} size="md" hideClose={!!created} closeOnBackdrop={!created}>
      {created ? (
        <KeyRevealOnce secret={created.secret} onDone={close} />
      ) : (
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
          <p className="label-md" style={{ lineHeight: 1.55 }}>{t('bot.newKeyNote')}</p>
          <Input label={t('key.name')} value={name} onChange={(e) => setName(e.target.value)} placeholder={botName} maxLength={KEYS_LIMITS.nameMaxLength} autoFocus />
          <ExpiryFields days={days} noExpiry={noExpiry} onDays={setDays} onNoExpiry={setNoExpiry} allowNoExpiry={allowNoExpiry} maxDays={maxDays} />
          <Input label={t('key.storedHint')} hint={t('key.storedHintHint')} value={storedHint} onChange={(e) => setStoredHint(e.target.value)} maxLength={KEYS_LIMITS.storedHintMaxLength} />
          <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end' }}>
            <Button type="button" variant="ghost" onClick={close} disabled={busy}>{common('actions.cancel')}</Button>
            <Button type="submit" variant="primary" disabled={busy} loading={busy} icon="key">{t('key.create')}</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// ---- Ротация с перекрытием ----
export function RotateKeyDialog({
  open,
  onClose,
  keyName,
  onRotate,
}: {
  open: boolean;
  onClose: () => void;
  keyName: string;
  onRotate: (graceHours: number) => Promise<ApiKeyCreatedDto | undefined>;
}) {
  const t = useTranslations('keys');
  const common = useTranslations('common');
  const [grace, setGrace] = useState<'0' | '1' | '24' | '72' | '168'>('24');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<ApiKeyCreatedDto | null>(null);
  const close = () => { if (busy) return; setCreated(null); onClose(); };
  const submit = async () => {
    setBusy(true);
    try {
      const res = await onRotate(Number(grace));
      if (res) setCreated(res);
    } catch (err) {
      toastApiError(err);
    } finally {
      setBusy(false);
    }
  };
  const options = (['0', '1', '24', '72', '168'] as const).map((h) => ({ value: h, label: t(`key.grace.${h}`) }));
  return (
    <Modal open={open} onClose={close} title={created ? undefined : t('key.rotateTitle', { name: keyName })} size="md" hideClose={!!created} closeOnBackdrop={!created}>
      {created ? (
        <KeyRevealOnce secret={created.secret} title={t('key.rotatedTitle')} note={t('key.rotatedNote')} onDone={close} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
          <p className="label-md" style={{ lineHeight: 1.55 }}>{t('key.rotateNote')}</p>
          <Select label={t('key.graceLabel')} value={grace} onChange={(v) => setGrace(v)} options={options} />
          <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={close} disabled={busy}>{common('actions.cancel')}</Button>
            <Button variant="primary" onClick={() => void submit()} disabled={busy} loading={busy} icon="refresh">{t('actions.rotate')}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---- Отзыв ----
export function RevokeKeyDialog({
  open,
  onClose,
  keyName,
  onRevoke,
}: {
  open: boolean;
  onClose: () => void;
  keyName: string;
  onRevoke: (reason: ApiKeyRevokeReason, note?: string) => Promise<unknown>;
}) {
  const t = useTranslations('keys');
  const common = useTranslations('common');
  const [reason, setReason] = useState<ApiKeyRevokeReason>('owner');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const close = () => { if (busy) return; setNote(''); setReason('owner'); onClose(); };
  const submit = async () => {
    setBusy(true);
    try {
      await onRevoke(reason, note.trim() || undefined);
      close();
    } catch (err) {
      toastApiError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={close} title={t('key.revokeTitle', { name: keyName })} size="sm">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
        <p className="label-md" style={{ lineHeight: 1.55 }}>{t('key.revokeNote')}</p>
        <Select label={t('key.revokeReason')} value={reason} onChange={(v) => setReason(v)} options={MANUAL_REVOKE_REASONS.map((r) => ({ value: r, label: t(`revokeReason.${r}`) }))} />
        <Input label={t('key.revokeNoteLabel')} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
        <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={close} disabled={busy}>{common('actions.cancel')}</Button>
          <Button variant="matte" tone="danger" onClick={() => void submit()} disabled={busy} loading={busy} icon="lock">{t('actions.revoke')}</Button>
        </div>
      </div>
    </Modal>
  );
}
