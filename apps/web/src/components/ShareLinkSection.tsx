'use client';

// ============================================================
// «Гостевая ссылка» — переиспользуемый блок управления ссылками наружу.
//
// Один и тот же блок встраивается в ЛЮБОЙ сервис: достаточно передать пару
// {refType, refId}. Сегодня это Диск и документы, завтра — счета и витрины;
// стоимость подключения на стороне интерфейса = одна строка.
// ============================================================

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  SHARE_LINK_LIMITS,
  SHARE_LINK_STATUS_LABELS,
  type ShareLinkDto,
  type ShareLinkStatus,
} from '@superapp/shared';
import { Button, Chip, Icon, Input, LoadingBlock, Select, Toggle, useConfirm } from '@/components/ui';
import type { Tone } from '@/components/ui/tones';
import { apiErrorMessage } from '@/lib/api';
import { toastError } from '@/lib/toast';
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

const EXPIRY_OPTIONS = [
  { value: '', label: 'Бессрочно' },
  { value: '7', label: '7 дней' },
  { value: '30', label: '30 дней' },
  { value: '90', label: '90 дней' },
];

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

export function ShareLinkSection({ refType, refId }: { refType: string; refId: string }) {
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
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => revokeShareLink(id),
    onSuccess: () => void invalidate(),
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const copy = async (link: ShareLinkDto) => {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(link.id);
      setTimeout(() => setCopied((c) => (c === link.id ? null : c)), 2000);
    } catch {
      toastError('Не удалось скопировать — выделите адрес вручную');
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
        По ссылке смогут открыть и скачать даже те, у кого нет аккаунта SuperApp6.
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
                title: 'Отозвать ссылку?',
                message: 'Открыть её больше не получится. Уже скачанные файлы это не вернёт.',
                confirmLabel: 'Отозвать',
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
          label="Для кого (необязательно)"
          placeholder="Например: подрядчик Асхат"
          value={label}
          maxLength={SHARE_LINK_LIMITS.maxLabelLength}
          onChange={(e) => setLabel(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 160px' }}>
            <Select label="Срок действия" value={expiry} options={EXPIRY_OPTIONS} onChange={setExpiry} />
          </div>
          <div style={{ flex: '1 1 160px' }}>
            <Input
              label="Лимит открытий"
              placeholder="без лимита"
              inputMode="numeric"
              value={maxOpens}
              onChange={(e) => setMaxOpens(e.target.value.replace(/\D/g, ''))}
            />
          </div>
        </div>

        <Toggle
          checked={allowDownload}
          onChange={setAllowDownload}
          label="Разрешить скачивание"
          // Обещать больше нельзя честно: если гость видит файл, байты уже у него в
          // браузере. Настройка убирает кнопки и отдаёт уменьшенную копию вместо
          // оригинала — так же осторожно её описывают Google Drive и Dropbox.
          description={
            allowDownload ? undefined : 'Гость увидит уменьшенную копию, но не скачает оригинал'
          }
        />
        <Toggle checked={notifyOnOpen} onChange={setNotifyOnOpen} label="Уведомлять об открытиях" />
        <Toggle
          checked={requireIdentity}
          onChange={setRequireIdentity}
          label="Запрашивать подтверждение номера"
          // Обещание точное: имя вводится гостем и не проверяется, подтверждается НОМЕР.
          description={
            requireIdentity
              ? 'Гость назовёт имя и подтвердит номер SMS-кодом — в журнале будет видно, кто открывал'
              : undefined
          }
        />
        <Toggle checked={withPassword} onChange={setWithPassword} label="Защитить паролем" />
        {withPassword && (
          <Input
            label="Пароль"
            type="password"
            value={password}
            autoComplete="new-password"
            minLength={SHARE_LINK_LIMITS.passwordMinLength}
            onChange={(e) => setPassword(e.target.value)}
            hint={`Минимум ${SHARE_LINK_LIMITS.passwordMinLength} символа — передайте его отдельно от ссылки`}
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
            Создать ссылку
          </Button>
        </div>
      </div>

      {past.length > 0 && (
        <details style={{ marginTop: 'var(--spacing-5)' }}>
          <summary className="label-sm" style={{ cursor: 'pointer', color: 'var(--on-surface-variant)' }}>
            Недействующие ссылки ({past.length}
            {hiddenPast > 0 ? ` из ${past.length + hiddenPast}` : ''})
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
                Показаны последние {past.length} — раньше было ещё {hiddenPast}.
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
        <Chip tone={STATUS_TONE[link.status]}>{SHARE_LINK_STATUS_LABELS[link.status]}</Chip>
        {link.label && <span className="label-md">{link.label}</span>}
        {link.hasPassword && (
          <span className="meta" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Icon name="lock" size={13} /> с паролем
          </span>
        )}
        {link.requireIdentity && (
          <span className="meta" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Icon name="user" size={13} /> по номеру
          </span>
        )}
        <span style={{ flex: 1 }} />
        {onCopy && (
          <Button size="sm" variant="ghost" icon={copied ? 'check' : 'copy'} onClick={onCopy}>
            {copied ? 'Скопировано' : 'Копировать'}
          </Button>
        )}
        {onToggleEdit && (
          <Button size="sm" variant="ghost" icon="edit" onClick={onToggleEdit}>
            {editing ? 'Свернуть' : 'Настроить'}
          </Button>
        )}
        {onRevoke && (
          <Button size="sm" variant="ghost" tone="danger" onClick={onRevoke}>
            Отозвать
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
          Открытий: {link.openCount}
          {link.maxOpens ? ` из ${link.maxOpens}` : ''}
        </button>
        {link.lastOpenedAt && (
          <span className="meta">последнее — {new Date(link.lastOpenedAt).toLocaleString('ru-RU')}</span>
        )}
        {link.expiresAt && (
          <span className="meta">до {new Date(link.expiresAt).toLocaleDateString('ru-RU')}</span>
        )}
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
    ? [
        { value: 'keep', label: `Оставить (до ${new Date(link.expiresAt).toLocaleDateString('ru-RU')})` },
        ...EXPIRY_OPTIONS,
      ]
    : EXPIRY_OPTIONS;

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
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  /**
   * Смена адреса. Ссылка остаётся той же — с журналом визитов, настройками и подписью,
   * меняется только адрес. Прежний умирает мгновенно вместе с уже открытыми сессиями:
   * ради этого смена и нужна.
   */
  const rotate = useMutation({
    mutationFn: () => rotateShareLink(link.id),
    onSuccess: onDone,
    onError: (e) => toastError(apiErrorMessage(e)),
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
      <Input label="Для кого" value={label} maxLength={SHARE_LINK_LIMITS.maxLabelLength} onChange={(e) => setLabel(e.target.value)} />
      <div style={{ display: 'flex', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 160px' }}>
          <Select label="Срок действия" value={expiry} options={expiryOptions} onChange={setExpiry} />
        </div>
        <div style={{ flex: '1 1 160px' }}>
          <Input
            label="Лимит открытий"
            placeholder="без лимита"
            inputMode="numeric"
            value={maxOpens}
            onChange={(e) => setMaxOpens(e.target.value.replace(/\D/g, ''))}
          />
        </div>
      </div>

      <Toggle
        checked={allowDownload}
        onChange={setAllowDownload}
        label="Разрешить скачивание"
        description={allowDownload ? undefined : 'Гость увидит уменьшенную копию, но не скачает оригинал'}
      />
      <Toggle checked={notifyOnOpen} onChange={setNotifyOnOpen} label="Уведомлять об открытиях" />
      <Toggle
        checked={requireIdentity}
        onChange={setRequireIdentity}
        label="Запрашивать подтверждение номера"
        description={
          requireIdentity && !link.requireIdentity
            ? 'Уже открытые анонимные сессии закроются — дальше только с подтверждением номера'
            : requireIdentity
              ? 'Гость называет имя и подтверждает номер SMS-кодом'
              : undefined
        }
      />

      <Select
        label="Пароль"
        value={pwdAction}
        options={[
          { value: 'keep', label: link.hasPassword ? 'Оставить прежний' : 'Без пароля' },
          { value: 'set', label: link.hasPassword ? 'Задать новый' : 'Поставить пароль' },
          ...(link.hasPassword ? [{ value: 'clear', label: 'Снять пароль' }] : []),
        ]}
        onChange={(v) => setPwdAction(v as 'keep' | 'clear' | 'set')}
      />
      {pwdAction === 'set' && (
        <Input
          label="Новый пароль"
          type="password"
          value={password}
          autoComplete="new-password"
          onChange={(e) => setPassword(e.target.value)}
          hint={`Минимум ${SHARE_LINK_LIMITS.passwordMinLength} символов — передайте его отдельно от ссылки`}
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
          Сохранить
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon="refresh"
          loading={rotate.isPending}
          onClick={() =>
            confirm(
              {
                title: 'Сменить адрес ссылки?',
                message:
                  'Прежний адрес перестанет работать сразу — у всех, кому вы его отправляли. Настройки, пароль и журнал открытий сохранятся; новый адрес нужно будет разослать заново.',
                confirmLabel: 'Сменить адрес',
              },
              () => rotate.mutateAsync().then(() => undefined),
            )
          }
        >
          Сменить адрес
        </Button>
        {link.tokenRotatedAt && (
          <span className="meta">адрес менялся {new Date(link.tokenRotatedAt).toLocaleDateString('ru-RU')}</span>
        )}
      </div>
      {confirmUI}
    </div>
  );
}

function VisitsList({ linkId }: { linkId: string }) {
  const { data, isPending } = useQuery({
    queryKey: shareLinkVisitsKey(linkId),
    queryFn: () => fetchShareLinkVisits(linkId),
  });

  if (isPending) return <LoadingBlock />;
  const visits = data?.items ?? [];
  if (!visits.length) {
    return (
      <p className="meta" style={{ margin: '0.5rem 0 0' }}>
        Ссылку ещё не открывали.
      </p>
    );
  }

  return (
    <ul style={{ margin: '0.5rem 0 0', padding: 0, listStyle: 'none' }}>
      {visits.map((v) => (
        <li key={v.id} className="meta" style={{ display: 'flex', gap: 'var(--spacing-3)', padding: '2px 0', flexWrap: 'wrap' }}>
          <span>{new Date(v.openedAt).toLocaleString('ru-RU')}</span>
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
