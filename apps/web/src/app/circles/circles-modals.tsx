'use client';

// ============================================================
// «Моё окружение» — модальные окна: правка Группы и принятие приглашения.
// ============================================================

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, GlyphField, Input, Modal } from '@/components/ui';
import { apiPatch, apiPost } from '@/lib/api';
import type { AcceptInvitationInput, Circle, IncomingInvitation } from '@superapp/shared';
import { GROUP_COLORS, runAction, sortGroups } from './circles-lib';
import { ColorPalette, GroupSelectField, RolePicker } from './circles-ui';

// ============================================================
// Правка Группы
// ============================================================

export function GroupEditModal({
  group, groups, onClose, onSaved,
}: {
  group: Circle;
  /** Все мои Группы — нужны, чтобы посчитать позицию и переставить порядок. */
  groups: Circle[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations('circles');
  const tc = useTranslations('common');
  const [name, setName] = useState(group.name);
  const [icon, setIcon] = useState<string | null>(group.icon);
  const [color, setColor] = useState<string>(group.color ?? GROUP_COLORS[0].value);
  const [saving, setSaving] = useState(false);

  const ordered = useMemo(() => sortGroups(groups), [groups]);
  const startIndex = Math.max(0, ordered.findIndex((g) => g.id === group.id));
  const [index, setIndex] = useState(startIndex);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    const ok = await runAction(async () => {
      await apiPatch(`/circles/${group.id}`, { name: trimmed, icon, color });
      // Порядок применяется ОДНИМ запросом на весь список: сервер ждёт полную
      // раскладку, а не «подвинь одну» — иначе соседние sortOrder разъезжаются.
      if (index !== startIndex) {
        const next = [...ordered];
        const [moved] = next.splice(startIndex, 1);
        next.splice(index, 0, moved);
        await apiPost('/circles/reorder', {
          circles: next.map((g, i) => ({ id: g.id, sortOrder: i })),
        });
      }
    }, t('groupModal.saved'));
    setSaving(false);
    if (ok) {
      onSaved();
      onClose();
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t('groupModal.title', { name: group.name })}
      subtitle={t('groupModal.subtitle')}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{tc('actions.cancel')}</Button>
          <Button variant="primary" tone="success" loading={saving} disabled={!name.trim()} onClick={() => void save()}>
            {tc('actions.save')}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
        <div style={{ display: 'flex', gap: 'var(--spacing-3)', alignItems: 'flex-end' }}>
          <GlyphField value={icon} onChange={setIcon} suggest={name} size={44} />
          <Input
            label={t('groupModal.name')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('groupModal.namePlaceholder')}
            autoFocus
            wrapClassName="flex-1"
          />
        </div>

        <div>
          <div className="ui-field-label">{t('groupModal.colour')}</div>
          <ColorPalette value={color} onChange={setColor} />
        </div>

        <div>
          <div className="ui-field-label">{t('groupModal.place')}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)' }}>
            <Button
              size="sm"
              variant="outline"
              icon="caretUp"
              disabled={index === 0}
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
            >
              {t('groupModal.up')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              icon="caretDown"
              disabled={index >= ordered.length - 1}
              onClick={() => setIndex((i) => Math.min(ordered.length - 1, i + 1))}
            >
              {t('groupModal.down')}
            </Button>
            <span className="label-sm" aria-live="polite">
              {t('groupModal.position', { index: index + 1, total: ordered.length })}
            </span>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ============================================================
// Принятие приглашения
// ============================================================

/**
 * Диалог принятия. Раньше accept уходил с ПУСТЫМ телом, хотя сервер умеет и
 * переопределить обе роли, и сразу разложить человека по Группам: приглашение
 * без предложенных ролей оставляло связь с пустой подписью навсегда — своей
 * ручки «дать роль постфактум» на странице нет.
 *
 * Смысл полей — по контракту `AcceptInvitationInput`:
 *   myRole    — как Я называю отправителя (перекрывает proposedRoleForSender);
 *   theirRole — как ОТПРАВИТЕЛЬ называет меня (перекрывает proposedRoleForRecipient).
 */
export function AcceptInvitationModal({
  invitation, groups, onClose, onDone,
}: {
  invitation: IncomingInvitation;
  groups: Circle[];
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations('circles');
  const tc = useTranslations('common');
  const senderName = invitation.from?.firstName || t('acceptModal.sender');
  const [myRole, setMyRole] = useState(invitation.proposedRoleForSender ?? '');
  const [theirRole, setTheirRole] = useState(invitation.proposedRoleForRecipient ?? '');
  const [circleIds, setCircleIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const accept = async () => {
    setBusy(true);
    const ok = await runAction(async () => {
      const payload: AcceptInvitationInput = {};
      // Пустые поля НЕ отправляем: у роли на сервере минимальная длина, и «»
      // вернулось бы 400 вместо «роли просто нет».
      if (myRole.trim()) payload.myRole = myRole.trim();
      if (theirRole.trim()) payload.theirRole = theirRole.trim();
      if (circleIds.length > 0) payload.autoAddToCircleIds = circleIds;
      await apiPost(`/contacts/invitations/${invitation.id}/accept`, payload);
    }, t('acceptModal.accepted'));
    setBusy(false);
    if (ok) {
      onDone();
      onClose();
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t('acceptModal.title', { name: senderName })}
      subtitle={t('acceptModal.subtitle')}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{tc('actions.cancel')}</Button>
          <Button variant="primary" tone="success" loading={busy} onClick={() => void accept()}>
            {t('invite.accept')}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
        <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-4)' }}>
          <RolePicker
            label={t('acceptModal.myRoleFor', { name: senderName })}
            value={myRole}
            onChange={setMyRole}
          />
          <RolePicker
            label={t('acceptModal.theirRoleFor', { name: senderName })}
            value={theirRole}
            onChange={setTheirRole}
          />
        </div>

        <GroupSelectField
          label={t('acceptModal.addToGroups')}
          hint={t('acceptModal.addToGroupsHint')}
          groups={groups}
          value={circleIds}
          onChange={setCircleIds}
        />
      </div>
    </Modal>
  );
}
