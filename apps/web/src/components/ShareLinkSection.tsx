'use client';

// ============================================================
// «Гостевая ссылка» — переиспользуемый блок управления ссылками наружу.
//
// Один и тот же блок встраивается в ЛЮБОЙ сервис: достаточно передать пару
// {refType, refId}. Сегодня это Диск и документы, завтра — счета и витрины;
// стоимость подключения на стороне интерфейса = одна строка.
// ============================================================

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SHARE_LINK_LIMITS, type ShareLinkDto, type ShareLinkStatus } from '@superapp/shared';
import { Button, Chip, Icon, Input, LoadingBlock, Select, Toggle, useConfirm } from '@/components/ui';
import type { Tone } from '@/components/ui/tones';

import { toastApiError } from '@/lib/api-errors';
import { toastError } from '@/lib/toast';
import { useFormatters } from '@/lib/format';
import { shareLinkVisitsKey, shareLinksKey } from '@/lib/queries';
import {
  createShareLink,
  fetchShareLinkVisits,
  fetchShareLinks,
  revokeShareLink,
  rotateShareLink,
  updateShareLink,
} from '@/lib/share-links-api';

const STATUS_TONE: Record<ShareLinkStatus, Tone> = {
  active: 'success',
  revoked: 'danger',
  expired: 'neutral',
  exhausted: 'neutral',
};

/** Значения сроков; слова к ним собирает `useExpiryOptions` в языке зрителя. */
const EXPIRY_DAYS = [7, 30, 90] as const;

function useExpiryOptions(): { value: string; label: string }[] {
  const t = useTranslations('share');
  return [
    { value: '', label: t('expiry.never') },
    ...EXPIRY_DAYS.map((n) => ({ value: String(n), label: t('expiry.days', { n }) })),
  ];
}

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

export function ShareLinkSection({ refType, refId }: { refType: string; refId: string }) {
  const t = useTranslations('share');
  const expiryOptions = useExpiryOptions();
  const qc = useQueryClient();
  const [confirm, confirmUI] = useConfirm();
  const [label, setLabel] = useState('');
  const [expiry, setExpiry] = useState('');
  const [withPassword, setWithPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [maxOpens, setMaxOpens] = useState('');
  // Умолчания повторяют серверные: скачивать можно, об открытиях уведомляем,
  // подтверждение номера выключено.
  const [allowDownload, setAllowDownload] = useState(true);
  const [notifyOnOpen, setNotifyOnOpen] = useState(true);
  const [requireIdentity, setRequireIdentity] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [openVisits, setOpenVisits] = useState<string | null>(null);

  const [editing, setEditing] = useState<string | null>(null);

  const { data, isPending } = useQuery({
    queryKey: shareLinksKey(refType, refId),
    queryFn: () => fetchShareLinks(refType, refId),
  });
  const links = data?.items ?? [];

  const invalidate = () => qc.invalidateQueries({ queryKey: shareLinksKey(refType, refId) });

  const create = useMutation({
    mutationFn: () =>
      createShareLink({
        refType,
        refId,
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(expiry ? { expiresAt: inDays(Number(expiry)) } : {}),
        ...(withPassword && password ? { password } : {}),
        // Именно > 0, а не «строка непустая»: «0» — истинная строка, и сервер отвечал
        // на неё 400 вместо очевидного человеку «без лимита».
        ...(Number(maxOpens) > 0 ? { maxOpens: Number(maxOpens) } : {}),
        allowDownload,
        notifyOnOpen,
        requireIdentity,
      }),
    onSuccess: () => {
      setLabel('');
      setExpiry('');
      setWithPassword(false);
      setPassword('');
      setMaxOpens('');
      setAllowDownload(true);
      setNotifyOnOpen(true);
      setRequireIdentity(false);
      void invalidate();
    },
    onError: (e) => toastApiError(e),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => revokeShareLink(id),
    onSuccess: () => void invalidate(),
    onError: (e) => toastApiError(e),
  });

  const copy = async (link: ShareLinkDto) => {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(link.id);
      setTimeout(() => setCopied((c) => (c === link.id ? null : c)), 2000);
    } catch {
      toastError(t('copyFailed'));
    }
  };

  const active = links.filter((l) => l.status === 'active');
  const past = links.filter((l) => l.status !== 'active');
  // Сервер отдаёт последние listPageSize записей: действующие всегда целиком, история
  // может не поместиться. Молчать об этом нельзя — «недействующих 100» читалось бы как
  // «их всего 100».
  const hiddenPast = Math.max(0, (data?.total ?? links.length) - links.length);

  return (
    <div>
      <p className="body-sm" style={{ margin: '0 0 var(--spacing-4)', color: 'var(--on-surface-variant)' }}>
        {t('section.intro')}
      </p>

      {isPending && <LoadingBlock />}

      {active.map((link) => (
        <LinkRow
          key={link.id}
          link={link}
          copied={copied === link.id}
          visitsOpen={openVisits === link.id}
          editing={editing === link.id}
          onCopy={() => void copy(link)}
          onToggleVisits={() => setOpenVisits((v) => (v === link.id ? null : link.id))}
          onToggleEdit={() => setEditing((v) => (v === link.id ? null : link.id))}
          onEdited={() => {
            setEditing(null);
            void invalidate();
          }}
          onRevoke={() =>
            confirm(
              {
                title: t('revoke.title'),
                message: t('revoke.message'),
                confirmLabel: t('revoke.confirm'),
                danger: true,
              },
              () => revoke.mutateAsync(link.id).then(() => undefined),
            )
          }
        />
      ))}

      {/* Создание */}
      <div
        style={{
          marginTop: active.length ? 'var(--spacing-5)' : 0,
          paddingTop: active.length ? 'var(--spacing-5)' : 0,
          borderTop: active.length ? '1px solid var(--divider)' : 'none',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--spacing-3)',
        }}
      >
        <Input
          label={t('form.label')}
          placeholder={t('form.labelPlaceholder')}
          value={label}
          maxLength={SHARE_LINK_LIMITS.maxLabelLength}
          onChange={(e) => setLabel(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 160px' }}>
            <Select label={t('form.expiry')} value={expiry} options={expiryOptions} onChange={setExpiry} />
          </div>
          <div style={{ flex: '1 1 160px' }}>
            <Input
              label={t('form.maxOpens')}
              placeholder={t('form.maxOpensPlaceholder')}
              inputMode="numeric"
              value={maxOpens}
              onChange={(e) => setMaxOpens(e.target.value.replace(/\D/g, ''))}
            />
          </div>
        </div>

        <Toggle
          checked={allowDownload}
          onChange={setAllowDownload}
          label={t('form.allowDownload')}
          // Обещать больше нельзя честно: если гость видит файл, байты уже у него в
          // браузере. Настройка убирает кнопки и отдаёт уменьшенную копию вместо
          // оригинала — так же осторожно её описывают Google Drive и Dropbox.
          description={allowDownload ? undefined : t('form.allowDownloadOff')}
        />
        <Toggle checked={notifyOnOpen} onChange={setNotifyOnOpen} label={t('form.notifyOnOpen')} />
        <Toggle
          checked={requireIdentity}
          onChange={setRequireIdentity}
          label={t('form.requireIdentity')}
          // Обещание точное: имя вводится гостем и не проверяется, подтверждается НОМЕР.
          description={requireIdentity ? t('form.requireIdentityOn') : undefined}
        />
        <Toggle checked={withPassword} onChange={setWithPassword} label={t('form.withPassword')} />
        {withPassword && (
          <Input
            label={t('form.password')}
            type="password"
            value={password}
            autoComplete="new-password"
            minLength={SHARE_LINK_LIMITS.passwordMinLength}
            onChange={(e) => setPassword(e.target.value)}
            hint={t('form.passwordHint', { min: SHARE_LINK_LIMITS.passwordMinLength })}
          />
        )}

        <div>
          <Button
            icon="link"
            variant="primary"
            loading={create.isPending}
            disabled={withPassword && password.length < SHARE_LINK_LIMITS.passwordMinLength}
            onClick={() => create.mutate()}
          >
            {t('form.create')}
          </Button>
        </div>
      </div>

      {past.length > 0 && (
        <details style={{ marginTop: 'var(--spacing-5)' }}>
          <summary className="label-sm" style={{ cursor: 'pointer', color: 'var(--on-surface-variant)' }}>
            {hiddenPast > 0
              ? t('past.summaryOf', { n: past.length, total: past.length + hiddenPast })
              : t('past.summary', { n: past.length })}
          </summary>
          <div style={{ marginTop: 'var(--spacing-3)' }}>
            {past.map((link) => (
              <LinkRow
                key={link.id}
                link={link}
                copied={false}
                visitsOpen={openVisits === link.id}
                editing={false}
                onToggleVisits={() => setOpenVisits((v) => (v === link.id ? null : link.id))}
              />
            ))}
            {hiddenPast > 0 && (
              <p className="meta" style={{ margin: '0.5rem 0 0' }}>
                {t('past.hidden', { n: past.length, hidden: hiddenPast })}
              </p>
            )}
          </div>
        </details>
      )}

      {confirmUI}
    </div>
  );
}

function LinkRow({
  link,
  copied,
  visitsOpen,
  editing,
  onCopy,
  onToggleVisits,
  onToggleEdit,
  onEdited,
  onRevoke,
}: {
  link: ShareLinkDto;
  copied: boolean;
  visitsOpen: boolean;
  editing: boolean;
  onCopy?: () => void;
  onToggleVisits: () => void;
  onToggleEdit?: () => void;
  onEdited?: () => void;
  onRevoke?: () => void;
}) {
  const t = useTranslations('share');
  const f = useFormatters();
  const dead = link.status !== 'active';
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--spacing-3)',
        marginBottom: 'var(--spacing-3)',
        opacity: dead ? 0.7 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
        <Chip tone={STATUS_TONE[link.status]}>{t(`status.${link.status}`)}</Chip>
        {link.label && <span className="label-md">{link.label}</span>}
        {link.hasPassword && (
          <span className="meta" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Icon name="lock" size={13} /> {t('row.withPassword')}
          </span>
        )}
        {link.requireIdentity && (
          <span className="meta" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Icon name="user" size={13} /> {t('row.byNumber')}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {onCopy && (
          <Button size="sm" variant="ghost" icon={copied ? 'check' : 'copy'} onClick={onCopy}>
            {copied ? t('row.copied') : t('row.copy')}
          </Button>
        )}
        {onToggleEdit && (
          <Button size="sm" variant="ghost" icon="edit" onClick={onToggleEdit}>
            {editing ? t('row.collapse') : t('row.settings')}
          </Button>
        )}
        {onRevoke && (
          <Button size="sm" variant="ghost" tone="danger" onClick={onRevoke}>
            {t('revoke.confirm')}
          </Button>
        )}
      </div>

      {!dead && (
        <p className="meta" style={{ margin: '0.5rem 0 0', wordBreak: 'break-all' }}>
          {link.url}
        </p>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', marginTop: '0.5rem', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="meta"
          onClick={onToggleVisits}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textDecoration: 'underline' }}
        >
          {link.maxOpens
            ? t('row.opensOf', { n: link.openCount, max: link.maxOpens })
            : t('row.opens', { n: link.openCount })}
        </button>
        {link.lastOpenedAt && (
          <span className="meta">{t('row.lastOpened', { when: f.dateTime(link.lastOpenedAt) })}</span>
        )}
        {link.expiresAt && <span className="meta">{t('row.until', { date: f.date(link.expiresAt) })}</span>}
      </div>

      {editing && onEdited && <EditLinkForm link={link} onDone={onEdited} />}
      {visitsOpen && <VisitsList linkId={link.id} />}
    </div>
  );
}

/**
 * Правка выданной ссылки: продлить срок, снять или сменить пароль, поправить лимит.
 *
 * Раньше ручка PATCH существовала, а кнопки не было — и единственным способом продлить
 * срок или убрать пароль оставалось пересоздать ссылку, то есть разослать новый адрес
 * всем, кому уже отдали старый.
 *
 * Контракт движка: null очищает поле, ОТСУТСТВИЕ ключа сохраняет как было. Поэтому
 * пароль отправляется только когда его осознанно меняют — своего значения мы не знаем и
 * знать не можем, в базе лежит хэш.
 */
function EditLinkForm({ link, onDone }: { link: ShareLinkDto; onDone: () => void }) {
  const t = useTranslations('share');
  const f = useFormatters();
  const baseExpiryOptions = useExpiryOptions();
  const [label, setLabel] = useState(link.label ?? '');
  const [expiry, setExpiry] = useState(link.expiresAt ? 'keep' : '');
  const [maxOpens, setMaxOpens] = useState(link.maxOpens ? String(link.maxOpens) : '');
  const [pwdAction, setPwdAction] = useState<'keep' | 'clear' | 'set'>('keep');
  const [password, setPassword] = useState('');
  const [allowDownload, setAllowDownload] = useState(link.allowDownload);
  const [notifyOnOpen, setNotifyOnOpen] = useState(link.notifyOnOpen);
  const [requireIdentity, setRequireIdentity] = useState(link.requireIdentity);
  const [confirm, confirmUI] = useConfirm();

  const expiryOptions = link.expiresAt
    ? [{ value: 'keep', label: t('expiry.keep', { date: f.date(link.expiresAt) }) }, ...baseExpiryOptions]
    : baseExpiryOptions;

  const save = useMutation({
    mutationFn: () =>
      updateShareLink(link.id, {
        label: label.trim() || null,
        ...(expiry === 'keep' ? {} : { expiresAt: expiry ? inDays(Number(expiry)) : null }),
        maxOpens: Number(maxOpens) > 0 ? Number(maxOpens) : null,
        ...(pwdAction === 'keep' ? {} : { password: pwdAction === 'clear' ? null : password }),
        allowDownload,
        notifyOnOpen,
        requireIdentity,
      }),
    onSuccess: onDone,
    onError: (e) => toastApiError(e),
  });

  /**
   * Смена адреса. Ссылка остаётся той же — с журналом визитов, настройками и подписью,
   * меняется только адрес. Прежний умирает мгновенно вместе с уже открытыми сессиями:
   * ради этого смена и нужна.
   */
  const rotate = useMutation({
    mutationFn: () => rotateShareLink(link.id),
    onSuccess: onDone,
    onError: (e) => toastApiError(e),
  });

  return (
    <div
      style={{
        marginTop: 'var(--spacing-3)',
        paddingTop: 'var(--spacing-3)',
        borderTop: '1px solid var(--divider)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--spacing-3)',
      }}
    >
      <Input
        label={t('form.labelShort')}
        value={label}
        maxLength={SHARE_LINK_LIMITS.maxLabelLength}
        onChange={(e) => setLabel(e.target.value)}
      />
      <div style={{ display: 'flex', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 160px' }}>
          <Select label={t('form.expiry')} value={expiry} options={expiryOptions} onChange={setExpiry} />
        </div>
        <div style={{ flex: '1 1 160px' }}>
          <Input
            label={t('form.maxOpens')}
            placeholder={t('form.maxOpensPlaceholder')}
            inputMode="numeric"
            value={maxOpens}
            onChange={(e) => setMaxOpens(e.target.value.replace(/\D/g, ''))}
          />
        </div>
      </div>

      <Toggle
        checked={allowDownload}
        onChange={setAllowDownload}
        label={t('form.allowDownload')}
        description={allowDownload ? undefined : t('form.allowDownloadOff')}
      />
      <Toggle checked={notifyOnOpen} onChange={setNotifyOnOpen} label={t('form.notifyOnOpen')} />
      <Toggle
        checked={requireIdentity}
        onChange={setRequireIdentity}
        label={t('form.requireIdentity')}
        description={
          requireIdentity && !link.requireIdentity
            ? t('form.requireIdentityTurnOn')
            : requireIdentity
              ? t('form.requireIdentityKept')
              : undefined
        }
      />

      <Select
        label={t('form.password')}
        value={pwdAction}
        options={[
          { value: 'keep', label: link.hasPassword ? t('form.passwordKeep') : t('form.passwordNone') },
          { value: 'set', label: link.hasPassword ? t('form.passwordSetNew') : t('form.passwordSet') },
          ...(link.hasPassword ? [{ value: 'clear', label: t('form.passwordClear') }] : []),
        ]}
        onChange={(v) => setPwdAction(v as 'keep' | 'clear' | 'set')}
      />
      {pwdAction === 'set' && (
        <Input
          label={t('form.newPassword')}
          type="password"
          value={password}
          autoComplete="new-password"
          onChange={(e) => setPassword(e.target.value)}
          hint={t('form.passwordHint', { min: SHARE_LINK_LIMITS.passwordMinLength })}
        />
      )}

      <div style={{ display: 'flex', gap: 'var(--spacing-3)', alignItems: 'center', flexWrap: 'wrap' }}>
        <Button
          variant="primary"
          size="sm"
          loading={save.isPending}
          disabled={pwdAction === 'set' && password.length < SHARE_LINK_LIMITS.passwordMinLength}
          onClick={() => save.mutate()}
        >
          {t('edit.save')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon="refresh"
          loading={rotate.isPending}
          onClick={() =>
            confirm(
              {
                title: t('edit.rotateTitle'),
                message: t('edit.rotateMessage'),
                confirmLabel: t('edit.rotate'),
              },
              () => rotate.mutateAsync().then(() => undefined),
            )
          }
        >
          {t('edit.rotate')}
        </Button>
        {link.tokenRotatedAt && (
          <span className="meta">{t('edit.rotatedAt', { date: f.date(link.tokenRotatedAt) })}</span>
        )}
      </div>
      {confirmUI}
    </div>
  );
}

function VisitsList({ linkId }: { linkId: string }) {
  const t = useTranslations('share');
  const f = useFormatters();
  const { data, isPending } = useQuery({
    queryKey: shareLinkVisitsKey(linkId),
    queryFn: () => fetchShareLinkVisits(linkId),
  });

  if (isPending) return <LoadingBlock />;
  const visits = data?.items ?? [];
  if (!visits.length) {
    return (
      <p className="meta" style={{ margin: '0.5rem 0 0' }}>
        {t('visits.empty')}
      </p>
    );
  }

  return (
    <ul style={{ margin: '0.5rem 0 0', padding: 0, listStyle: 'none' }}>
      {visits.map((v) => (
        <li key={v.id} className="meta" style={{ display: 'flex', gap: 'var(--spacing-3)', padding: '2px 0', flexWrap: 'wrap' }}>
          <span>{f.dateTime(v.openedAt)}</span>
          {/* Кто открывал — у ссылок с подтверждением номера; имя вводит сам гость */}
          {v.guestName && (
            <span>
              {v.guestName}
              {v.guestPhone ? ` · ${v.guestPhone}` : ''}
            </span>
          )}
          {v.ip && <span style={{ color: 'var(--on-surface-variant)' }}>{v.ip}</span>}
        </li>
      ))}
    </ul>
  );
}
