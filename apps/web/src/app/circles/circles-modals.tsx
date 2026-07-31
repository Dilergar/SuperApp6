'use client';

// ============================================================
// «Моё окружение» — модальные окна: правка Группы и принятие приглашения.
// ============================================================

import { useMemo, useState } from 'react';
import { Button, GlyphField, Input, Modal } from '@/components/ui';
import { api } from '@/lib/api';
import type { AcceptInvitationRequest, Circle, IncomingInvitation } from '@superapp/shared';
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
      await api.patch(`/circles/${group.id}`, { name: trimmed, icon, color });
      // Порядок применяется ОДНИМ запросом на весь список: сервер ждёт полную
      // раскладку, а не «подвинь одну» — иначе соседние sortOrder разъезжаются.
      if (index !== startIndex) {
        const next = [...ordered];
        const [moved] = next.splice(startIndex, 1);
        next.splice(index, 0, moved);
        await api.post('/circles/reorder', {
          circles: next.map((g, i) => ({ id: g.id, sortOrder: i })),
        });
      }
    }, 'Группа обновлена');
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
      title={`Настройки группы «${group.name}»`}
      subtitle="Название, значок, цвет и место в списке фильтров"
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Отмена</Button>
          <Button variant="primary" tone="success" loading={saving} disabled={!name.trim()} onClick={() => void save()}>
            Сохранить
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
        <div style={{ display: 'flex', gap: 'var(--spacing-3)', alignItems: 'flex-end' }}>
          <GlyphField value={icon} onChange={setIcon} suggest={name} size={44} />
          <Input
            label="Название группы"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Семья, Родственники…"
            autoFocus
            wrapClassName="flex-1"
          />
        </div>

        <div>
          <div className="ui-field-label">Цвет</div>
          <ColorPalette value={color} onChange={setColor} />
        </div>

        <div>
          <div className="ui-field-label">Место в списке</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)' }}>
            <Button
              size="sm"
              variant="outline"
              icon="caretUp"
              disabled={index === 0}
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
            >
              Выше
            </Button>
            <Button
              size="sm"
              variant="outline"
              icon="caretDown"
              disabled={index >= ordered.length - 1}
              onClick={() => setIndex((i) => Math.min(ordered.length - 1, i + 1))}
            >
              Ниже
            </Button>
            <span className="label-sm" aria-live="polite">
              {index + 1} из {ordered.length}
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
 * Смысл полей — по контракту `AcceptInvitationRequest`:
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
  const senderName = invitation.from?.firstName || 'Отправитель';
  const [myRole, setMyRole] = useState(invitation.proposedRoleForSender ?? '');
  const [theirRole, setTheirRole] = useState(invitation.proposedRoleForRecipient ?? '');
  const [circleIds, setCircleIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const accept = async () => {
    setBusy(true);
    const ok = await runAction(async () => {
      const payload: AcceptInvitationRequest = {};
      // Пустые поля НЕ отправляем: у роли на сервере минимальная длина, и «»
      // вернулось бы 400 вместо «роли просто нет».
      if (myRole.trim()) payload.myRole = myRole.trim();
      if (theirRole.trim()) payload.theirRole = theirRole.trim();
      if (circleIds.length > 0) payload.autoAddToCircleIds = circleIds;
      await api.post(`/contacts/invitations/${invitation.id}/accept`, payload);
    }, 'Приглашение принято');
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
      title={`Принять приглашение от ${senderName}`}
      subtitle="Роль — это подпись на карточке человека. Её можно изменить и позже."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Отмена</Button>
          <Button variant="primary" tone="success" loading={busy} onClick={() => void accept()}>
            Принять
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
        <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-4)' }}>
          <RolePicker
            label={`Как я называю ${senderName}`}
            value={myRole}
            onChange={setMyRole}
          />
          <RolePicker
            label={`Как ${senderName} называет меня`}
            value={theirRole}
            onChange={setTheirRole}
          />
        </div>

        <GroupSelectField
          label="Сразу добавить в мои группы"
          hint="Необязательно — человека всегда можно разложить по группам позже."
          groups={groups}
          value={circleIds}
          onChange={setCircleIds}
        />
      </div>
    </Modal>
  );
}
