'use client';

// Факт по смене: вышел / опоздал N мин / не вышел + фактическое время.
// Смысл несёт ФОРМА: исход — сегментированный выбор, действие — кнопка.
//
// НОЧНАЯ СМЕНА. Моменты собираются в поясе ОБЪЕКТА и от даты НАЧАЛА смены:
// у смены 22:00–06:00 «до 06:00» — это следующие сутки. Раньше оба момента
// вешались на один день, и конец оказывался на 16 часов РАНЬШЕ начала (сервер
// такой факт теперь отвергает — 400 «Фактическое окончание раньше начала»).

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ATTENDANCE_OUTCOMES, type ShiftDto } from '@superapp/shared';
import { Button, Input, Modal, SegmentedControl, Textarea } from '@/components/ui';
import { apiErrorMessage } from '@/lib/api';
import { toastError } from '@/lib/toast';
import { localToIso, timeIn } from '@/lib/objects-time';
import { shiftsApi } from '../objects-api';

/** «09:05» → минуты от полуночи; неразборчивое — null */
function minutesOf(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Следующие сутки календарной даты (арифметика на строке, без пояса браузера) */
function addDays(dateIso: string, n: number): string {
  const d = new Date(`${dateIso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function AttendanceModal({
  workspaceId,
  shift,
  timeZone,
  open,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  shift: ShiftDto;
  /** Пояс ОБЪЕКТА: время смены и факт живут в нём, а не в поясе браузера */
  timeZone: string;
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [outcome, setOutcome] = useState<string>(shift.attendance?.outcome ?? 'worked');
  const [lateMin, setLateMin] = useState(String(shift.attendance?.lateMin ?? 0));
  const [startAt, setStartAt] = useState(
    shift.attendance?.actualStartAt
      ? timeIn(shift.attendance.actualStartAt, timeZone)
      : timeIn(shift.startsAt, timeZone),
  );
  const [endAt, setEndAt] = useState(
    shift.attendance?.actualEndAt ? timeIn(shift.attendance.actualEndAt, timeZone) : timeIn(shift.endsAt, timeZone),
  );
  const [note, setNote] = useState(shift.attendance?.note ?? '');

  const startMin = minutesOf(startAt);
  const endMin = minutesOf(endAt);
  const overnight = startMin !== null && endMin !== null && endMin < startMin;

  const save = useMutation({
    mutationFn: async () => {
      const late = Number(lateMin) || 0;
      let actualStartAt: string | null = null;
      let actualEndAt: string | null = null;

      if (outcome !== 'absent') {
        if (startMin === null) throw new Error('Фактическое начало — в формате 09:00');
        if (endMin === null) throw new Error('Фактическое окончание — в формате 18:00');
        actualStartAt = localToIso(shift.localDate, startAt, timeZone);
        // Конец РАНЬШЕ начала = смена перевалила за полночь → следующие сутки.
        actualEndAt = localToIso(endMin < startMin ? addDays(shift.localDate, 1) : shift.localDate, endAt, timeZone);
      }

      return shiftsApi.markAttendance(workspaceId, shift.id, {
        outcome,
        lateMin: outcome === 'late' ? late : 0,
        actualStartAt,
        actualEndAt,
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
    <Modal open={open} onClose={onClose} title={`Факт выхода · ${shift.localDate}`}>
      <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        <SegmentedControl
          value={outcome}
          onChange={setOutcome}
          items={ATTENDANCE_OUTCOMES.map((o) => ({ key: o.value, label: o.label }))}
        />
        {outcome === 'late' && (
          <Input
            label="Опоздание, мин"
            inputMode="numeric"
            value={lateMin}
            onChange={(e) => setLateMin(e.target.value)}
          />
        )}
        {outcome !== 'absent' && (
          <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-3)' }}>
            <Input label="Фактически с" placeholder="09:00" value={startAt} onChange={(e) => setStartAt(e.target.value)} />
            <Input
              label="Фактически до"
              placeholder="18:00"
              value={endAt}
              hint={overnight ? 'Следующие сутки — смена через полночь' : undefined}
              onChange={(e) => setEndAt(e.target.value)}
            />
          </div>
        )}
        <Textarea label="Комментарий" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Сохранить
          </Button>
        </div>
      </div>
    </Modal>
  );
}
