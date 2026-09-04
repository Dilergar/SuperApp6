'use client';

// Внеплановый выход: смены в плане не было (подмена, аврал). Отдельная запись
// факта без `shiftId` — сверка «план ≠ факт» обязана видеть и такие выходы.
//
// Дата по умолчанию — «сегодня» В ПОЯСЕ ОБЪЕКТА: до 05:00 по Алматы UTC-дата
// показывала вчерашний день, то есть ровно в ночную смену форма врала.

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ATTENDANCE_OUTCOMES } from '@superapp/shared';
import { Button, DatePicker, Input, Modal, SegmentedControl, Textarea } from '@/components/ui';
import { PersonChip } from '@/app/circles/PersonCard';
import { apiErrorMessage } from '@/lib/api';
import { toastError } from '@/lib/toast';
import { dateToIso, isoToDate, todayIn } from '@/lib/objects-time';
import { shiftsApi } from '../objects-api';

export function UnplannedAttendanceModal({
  workspaceId,
  objectId,
  people,
  timeZone,
  open,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  objectId: string;
  people: { userId: string; userName: string }[];
  /** Пояс ОБЪЕКТА — в нём считается «сегодня» */
  timeZone: string;
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [userId, setUserId] = useState(people[0]?.userId ?? '');
  const [localDate, setLocalDate] = useState<string | undefined>(todayIn(timeZone));
  const [outcome, setOutcome] = useState('worked');
  const [lateMin, setLateMin] = useState('0');
  const [note, setNote] = useState('');

  const save = useMutation({
    mutationFn: async () => {
      if (!userId) throw new Error('Выберите сотрудника');
      if (!localDate) throw new Error('Укажите дату');
      return shiftsApi.markUnplanned(workspaceId, objectId, {
        userId,
        localDate,
        outcome,
        lateMin: outcome === 'late' ? Number(lateMin) || 0 : 0,
        note: note.trim() || null,
      });
    },
    onSuccess: () => {
      onSaved?.();
      onClose();
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  return (
    <Modal open={open} onClose={onClose} title="Внеплановый выход">
      <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        <div>
          <span className="label-sm" style={{ display: 'block', marginBottom: 'var(--spacing-2)', fontWeight: 600 }}>
            Кто
          </span>
          {/* Человек в интерфейсе — КАРТОЧКА, а не строка выпадашки. Список — только
              люди этого объекта: пикер не предлагает того, кого сервер отвергнет. */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
            {people.map((p) => (
              <button
                key={p.userId}
                type="button"
                aria-pressed={userId === p.userId}
                onClick={() => setUserId(p.userId)}
                style={{
                  border: `1px solid ${userId === p.userId ? 'var(--primary)' : 'var(--outline-variant)'}`,
                  background: userId === p.userId ? 'var(--surface-container)' : 'transparent',
                  borderRadius: 'var(--radius-pill)',
                  padding: '0.15rem 0.35rem 0.15rem 0.15rem',
                  cursor: 'pointer',
                }}
              >
                <PersonChip size="S" userId={p.userId} firstName={p.userName} />
              </button>
            ))}
            {people.length === 0 && (
              <span className="label-sm">В объекте пока никто не работает — сначала назначьте людей.</span>
            )}
          </div>
        </div>
        <DatePicker label="Дата" value={isoToDate(localDate)} onChange={(d) => setLocalDate(dateToIso(d))} />
        <SegmentedControl
          value={outcome}
          onChange={setOutcome}
          items={ATTENDANCE_OUTCOMES.map((o) => ({ key: o.value, label: o.label }))}
        />
        {outcome === 'late' && (
          <Input label="Опоздание, мин" inputMode="numeric" value={lateMin} onChange={(e) => setLateMin(e.target.value)} />
        )}
        <Textarea label="Комментарий" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button variant="primary" loading={save.isPending} disabled={!userId} onClick={() => save.mutate()}>
            Записать
          </Button>
        </div>
      </div>
    </Modal>
  );
}
