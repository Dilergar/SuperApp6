'use client';

// ============================================================
// Мастер бота — три шага: карточка (имя, значок, «для чего», ранг, ответственный) →
// права (матрица скоупов, IP-список, срок) → секрет (show-once). «Для чего» обязательно:
// реестр без цели бесполезен через полгода. Создание — под step-up (страница оборачивает).
// ============================================================

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  KEYS_LIMITS,
  type BotCreateInput,
  type BotCreatedDto,
  type BotRank,
  type KeyScopes,
  type WorkspaceKeyPolicyDto,
} from '@superapp/shared';

import type { Principal } from '@/lib/entities';
import { EntitySelector } from '@/components/EntitySelector';
import { Button, Field, GlyphField, Input, Modal, Select, TickBar } from '@/components/ui';
import { KeyRevealOnce } from './KeyRevealOnce';
import { ScopeMatrix } from './ScopeMatrix';
import { AllowlistField, ContactAccessField, ExpiryFields } from './KeyDialogs';

import { toastApiError } from '@/lib/api-errors';
type Step = 1 | 2 | 3;

export function BotWizard({
  open,
  onClose,
  workspaceId,
  isOwner,
  policy,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  isOwner: boolean;
  policy: WorkspaceKeyPolicyDto | null;
  onCreate: (input: BotCreateInput) => Promise<BotCreatedDto | undefined>;
}) {
  const t = useTranslations('keys');
  const common = useTranslations('common');
  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState('');
  const [glyph, setGlyph] = useState<string | null>(null);
  const [purpose, setPurpose] = useState('');
  const [rank, setRank] = useState<BotRank>('member');
  const [responsible, setResponsible] = useState<Principal[]>([]);
  const [scopes, setScopes] = useState<KeyScopes>({});
  const [allowlist, setAllowlist] = useState<string[]>([]);
  const [contactAccess, setContactAccess] = useState(false);
  const maxDays = policy ? policy.maxBotKeyDays : KEYS_LIMITS.botKeyDefaultDays;
  const [days, setDays] = useState(Math.min(KEYS_LIMITS.botKeyDefaultDays, maxDays ?? KEYS_LIMITS.botKeyDefaultDays));
  const [noExpiry, setNoExpiry] = useState(false);
  const [storedHint, setStoredHint] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<BotCreatedDto | null>(null);

  const reset = () => {
    setStep(1); setName(''); setGlyph(null); setPurpose(''); setRank('member'); setResponsible([]); setScopes({}); setAllowlist([]); setContactAccess(false);
    setDays(Math.min(KEYS_LIMITS.botKeyDefaultDays, maxDays ?? KEYS_LIMITS.botKeyDefaultDays)); setNoExpiry(false); setStoredHint(''); setCreated(null);
  };
  const close = () => { if (busy) return; reset(); onClose(); };

  const step1Ok = name.trim().length > 0 && purpose.trim().length >= KEYS_LIMITS.purposeMinLength;
  const requireAllowlist = !!policy?.requireIpAllowlist || noExpiry;
  const step2Ok = Object.keys(scopes).length > 0 && (!requireAllowlist || allowlist.length > 0);
  // Бессрочно: только владелец, только с IP-списком, только без потолка политики
  const allowNoExpiry = isOwner && maxDays === null;

  const submit = async () => {
    setBusy(true);
    try {
      const input: BotCreateInput = {
        name: name.trim(),
        purpose: purpose.trim(),
        rank,
        scopes,
        ipAllowlist: allowlist,
        contactAccess,
        ...(glyph ? { glyph } : {}),
        ...(responsible[0] ? { responsibleUserId: responsible[0].id } : {}),
        ...(storedHint.trim() ? { storedHint: storedHint.trim() } : {}),
        ...(noExpiry ? { noExpiry: true } : { expiresInDays: days }),
      };
      const res = await onCreate(input);
      if (res) {
        setCreated(res);
        setStep(3);
      }
    } catch (err) {
      toastApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const footer = step === 3 ? null : (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--spacing-3)', width: '100%' }}>
      <Button variant="ghost" onClick={step === 1 ? close : () => setStep(1)} disabled={busy}>
        {step === 1 ? common('actions.cancel') : t('bot.back')}
      </Button>
      {step === 1 ? (
        <Button variant="primary" onClick={() => setStep(2)} disabled={!step1Ok} iconRight="arrowRight">{t('bot.next')}</Button>
      ) : (
        <Button variant="primary" onClick={() => void submit()} disabled={!step2Ok || busy} loading={busy} icon="robot">{t('bot.create')}</Button>
      )}
    </div>
  );

  return (
    <Modal open={open} onClose={close} title={step === 3 ? undefined : t('bot.wizardTitle')} subtitle={step === 1 ? t('bot.step1') : step === 2 ? t('bot.step2') : t('bot.step3')} size="lg" footer={footer} hideClose={step === 3} closeOnBackdrop={step !== 3}>
      {step !== 3 && <div style={{ marginBottom: 'var(--spacing-4)' }}><TickBar value={Math.round((step / 3) * 100)} label={t('bot.progress', { step, total: 3 })} /></div>}

      {step === 1 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 'var(--spacing-4)', alignItems: 'end' }}>
            <GlyphField label={t('bot.glyph')} value={glyph} onChange={setGlyph} suggest="ph:robot" />
            <Input label={t('bot.name')} value={name} onChange={(e) => setName(e.target.value)} required maxLength={KEYS_LIMITS.nameMaxLength} autoFocus placeholder={t('bot.namePlaceholder')} />
          </div>
          <Input label={t('key.purpose')} hint={t('bot.purposeHint')} value={purpose} onChange={(e) => setPurpose(e.target.value)} required minLength={KEYS_LIMITS.purposeMinLength} maxLength={KEYS_LIMITS.purposeMaxLength} placeholder={t('bot.purposePlaceholder')} />
          <Select
            label={t('bot.rankLabel')}
            hint={t('bot.rankHint')}
            value={rank}
            onChange={(v) => setRank(v)}
            options={[
              { value: 'member', label: t('bot.rank.member'), hint: t('bot.rankMemberHint') },
              { value: 'manager', label: t('bot.rank.manager'), hint: t('bot.rankManagerHint') },
            ]}
          />
          <Field label={t('bot.responsible')} hint={t('bot.responsibleHint')}>
            <EntitySelector types={['user']} multi={false} value={responsible} onChange={setResponsible} context={{ workspaceId }} placeholder={t('bot.responsiblePlaceholder')} />
          </Field>
        </div>
      )}

      {step === 2 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
          <Field label={t('key.scopes')} hint={t('bot.scopesHint')}>
            <ScopeMatrix value={scopes} onChange={setScopes} forBot />
          </Field>
          <ExpiryFields days={days} noExpiry={noExpiry} onDays={setDays} onNoExpiry={setNoExpiry} allowNoExpiry={allowNoExpiry} maxDays={maxDays} />
          <AllowlistField value={allowlist} onChange={setAllowlist} required={requireAllowlist} />
          <ContactAccessField value={contactAccess} onChange={setContactAccess} />
          <Input label={t('key.storedHint')} hint={t('key.storedHintHint')} value={storedHint} onChange={(e) => setStoredHint(e.target.value)} maxLength={KEYS_LIMITS.storedHintMaxLength} />
        </div>
      )}

      {step === 3 && created && (
        <KeyRevealOnce secret={created.secret} title={t('bot.createdTitle', { name: created.bot.name })} note={t('bot.createdNote')} onDone={close} />
      )}
    </Modal>
  );
}
